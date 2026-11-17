-- Документы склада: перемещение на склад инженера, возврат и списание (встреча 16.11.2026).
--
-- Что было не так. Запчасть по задаче проходит путь «выдали инженеру → поставил в прибор
-- → координатор закрыл задачу», и каждое движение пишется в stock_movements (0022, 0028,
-- 0049). Но бухгалтерии нужен документ: по нему в 1С проводят перемещение и списание.
-- Документов не было — бухгалтерия собирала их руками по истории склада.
--
-- Что договорились на встрече (25:10–25:44, 26:23–27:14, 35:52–37:06).
--   * Выдача инженеру — это не списание, а перемещение на склад инженера: запчасть ещё
--     принадлежит компании, инженер может вернуть её на склад.
--   * Списание — когда координатор закрывает задачу, а инженер отметил «установлено».
--     Документ на списание формируется сам, без ручного набора.
--   * Точный вид документов уточняет бухгалтерия. Поэтому здесь только содержание,
--     которое нужно в любом случае: номер, дата, основание, инженер, прибор, строки.
--
-- Что делаем.
--   1. stock_documents — документ: номер, вид, дата, задача, инженер, прибор.
--      Виды: transfer — перемещение на склад инженера (ПМ-), return — возврат на склад
--      (ВЗ-), writeoff — списание (СП-): установка в прибор при закрытии задачи или
--      брак и утеря кнопкой «Списать» в карточке позиции (0049).
--   2. stock_document_lines — какие движения склада вошли в документ. Движения
--      по-прежнему только добавляются: документ ссылается на них, а не правит их.
--   3. Документ создаётся сам при движении. Движения одного вида по одной задаче,
--      одному инженеру и за один день попадают в один документ: кладовщик выдал три
--      запчасти под задачу — перемещение одно, в нём три строки.
--   4. Прошлые движения раскладываются по документам здесь же, датой движения.
--   5. stock_document_list и stock_document_lines_for — список и строки для экрана.
--      Работают от владельца схемы с явной проверкой права, как история движений (0048):
--      кладовщик задачу видит не всегда, а номер задачи в документе нужен.
--
-- Документы видят те же, кто видит склад, и финансы. Писать в них напрямую нельзя
-- никому: только триггер движения. Цен в документах нет — цена прихода закрыта
-- от склада и инженера (0040), а стоимость списания считает 1С.
-- Миграцию можно применить повторно.

-- ---------------------------------------------------------------------------
-- 1. Таблицы
-- ---------------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS public.stock_transfer_number_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.stock_return_number_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.stock_writeoff_number_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS public.stock_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE CHECK (btrim(number) <> ''),
  kind text NOT NULL CHECK (kind IN ('transfer', 'return', 'writeoff')),
  document_date date NOT NULL,
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  engineer_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  equipment_id uuid REFERENCES public.equipment(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.stock_documents IS
  'Документы склада (0062): перемещение на склад инженера (ПМ-), возврат на склад (ВЗ-), списание (СП-). Создаются сами при движении запчасти, руками не пишутся.';

-- Один документ на вид, задачу, инженера и день. Пустые задача и инженер (списание брака)
-- тоже собираются в один документ за день, поэтому сравниваем через coalesce.
CREATE UNIQUE INDEX IF NOT EXISTS stock_documents_group_key ON public.stock_documents (
  kind,
  coalesce(task_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(engineer_id, '00000000-0000-0000-0000-000000000000'::uuid),
  document_date
);
CREATE INDEX IF NOT EXISTS stock_documents_task_idx ON public.stock_documents (task_id);
CREATE INDEX IF NOT EXISTS stock_documents_date_idx ON public.stock_documents (document_date DESC, number DESC);

CREATE TABLE IF NOT EXISTS public.stock_document_lines (
  document_id uuid NOT NULL REFERENCES public.stock_documents(id) ON DELETE RESTRICT,
  movement_id uuid PRIMARY KEY REFERENCES public.stock_movements(id) ON DELETE RESTRICT
);

COMMENT ON TABLE public.stock_document_lines IS
  'Строки документа склада (0062): движение склада, вошедшее в документ. Одно движение — в одном документе.';

CREATE INDEX IF NOT EXISTS stock_document_lines_document_idx ON public.stock_document_lines (document_id);

-- Читают склад и финансы. Записи через API нет вовсе: ни правила, ни права.
ALTER TABLE public.stock_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_document_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stock_documents_read ON public.stock_documents;
CREATE POLICY stock_documents_read ON public.stock_documents
  FOR SELECT TO authenticated
  USING ((SELECT public.app_has_any_permission(ARRAY['warehouse.read', 'warehouse.write', 'tasks.read_all', 'finance.read'])));

DROP POLICY IF EXISTS stock_document_lines_read ON public.stock_document_lines;
CREATE POLICY stock_document_lines_read ON public.stock_document_lines
  FOR SELECT TO authenticated
  USING ((SELECT public.app_has_any_permission(ARRAY['warehouse.read', 'warehouse.write', 'tasks.read_all', 'finance.read'])));

REVOKE ALL ON public.stock_documents, public.stock_document_lines FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stock_documents, public.stock_document_lines FROM authenticated;
GRANT SELECT ON public.stock_documents, public.stock_document_lines TO authenticated;
REVOKE ALL ON SEQUENCE public.stock_transfer_number_seq, public.stock_return_number_seq,
  public.stock_writeoff_number_seq FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Документ под движение
-- ---------------------------------------------------------------------------

-- Найти документ группы или завести новый. Номер берётся только у нового документа,
-- чтобы в нумерации не было дыр от уже существующих групп.
CREATE OR REPLACE FUNCTION public.stock_document_for(
  p_kind text,
  p_task_id uuid,
  p_engineer_id uuid,
  p_equipment_id uuid,
  p_day date
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  found uuid;
  next_number text;
BEGIN
  SELECT d.id INTO found
    FROM public.stock_documents AS d
   WHERE d.kind = p_kind
     AND d.task_id IS NOT DISTINCT FROM p_task_id
     AND d.engineer_id IS NOT DISTINCT FROM p_engineer_id
     AND d.document_date = p_day;
  IF found IS NOT NULL THEN
    RETURN found;
  END IF;

  next_number := CASE p_kind
    WHEN 'transfer' THEN 'ПМ-' || lpad(nextval('public.stock_transfer_number_seq')::text, 6, '0')
    WHEN 'return' THEN 'ВЗ-' || lpad(nextval('public.stock_return_number_seq')::text, 6, '0')
    ELSE 'СП-' || lpad(nextval('public.stock_writeoff_number_seq')::text, 6, '0')
  END;

  INSERT INTO public.stock_documents (number, kind, document_date, task_id, engineer_id, equipment_id)
  VALUES (next_number, p_kind, p_day, p_task_id, p_engineer_id, p_equipment_id)
  ON CONFLICT DO NOTHING
  RETURNING id INTO found;

  -- Параллельная транзакция успела завести тот же документ: берём его.
  IF found IS NULL THEN
    SELECT d.id INTO found
      FROM public.stock_documents AS d
     WHERE d.kind = p_kind
       AND d.task_id IS NOT DISTINCT FROM p_task_id
       AND d.engineer_id IS NOT DISTINCT FROM p_engineer_id
       AND d.document_date = p_day;
  END IF;
  RETURN found;
END
$$;

REVOKE EXECUTE ON FUNCTION public.stock_document_for(text, uuid, uuid, uuid, date) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.stock_document_for(text, uuid, uuid, uuid, date) IS
  'Документ склада для группы «вид, задача, инженер, день» (0062): существующий или новый со следующим номером.';

-- Вид документа по движению. Приход, резерв и корректировка документа здесь не дают:
-- приход идёт по накладной поставщика, корректировка — по инвентаризации.
CREATE OR REPLACE FUNCTION public.stock_document_kind(p_movement public.stock_movement_type)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_temp
AS $$
  SELECT CASE p_movement::text
    WHEN 'issue' THEN 'transfer'
    WHEN 'return' THEN 'return'
    WHEN 'install' THEN 'writeoff'
    WHEN 'writeoff' THEN 'writeoff'
  END
$$;

REVOKE EXECUTE ON FUNCTION public.stock_document_kind(public.stock_movement_type) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_document_kind(public.stock_movement_type) TO authenticated;

-- Инженер документа: кому выдали по резерву. У списания брака инженера нет.
CREATE OR REPLACE FUNCTION public.attach_stock_movement_to_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  doc_kind text := public.stock_document_kind(NEW.movement_type);
  engineer uuid;
  device uuid;
BEGIN
  IF doc_kind IS NULL THEN
    RETURN NULL;
  END IF;
  IF NEW.reservation_id IS NOT NULL THEN
    SELECT r.issued_to INTO engineer FROM public.stock_reservations AS r WHERE r.id = NEW.reservation_id;
  END IF;
  IF NEW.task_id IS NOT NULL THEN
    SELECT t.equipment_id INTO device FROM public.tasks AS t WHERE t.id = NEW.task_id;
  END IF;

  INSERT INTO public.stock_document_lines (document_id, movement_id)
  VALUES (
    public.stock_document_for(doc_kind, NEW.task_id, engineer, coalesce(device, NEW.equipment_id), public.company_today()),
    NEW.id
  )
  ON CONFLICT (movement_id) DO NOTHING;
  RETURN NULL;
END
$$;

REVOKE EXECUTE ON FUNCTION public.attach_stock_movement_to_document() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.attach_stock_movement_to_document() IS
  'Движение склада (0062): выдача, возврат, установка и списание попадают строкой в документ своего вида за сегодняшний день по Москве.';

DROP TRIGGER IF EXISTS stock_movements_document ON public.stock_movements;
CREATE TRIGGER stock_movements_document
  AFTER INSERT ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.attach_stock_movement_to_document();

-- ---------------------------------------------------------------------------
-- 3. Прошлые движения — по документам, датой самого движения
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  movement record;
BEGIN
  FOR movement IN
    SELECT m.id, m.movement_type, m.task_id, m.equipment_id, m.occurred_at, r.issued_to, t.equipment_id AS task_equipment
      FROM public.stock_movements AS m
      LEFT JOIN public.stock_reservations AS r ON r.id = m.reservation_id
      LEFT JOIN public.tasks AS t ON t.id = m.task_id
     WHERE public.stock_document_kind(m.movement_type) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.stock_document_lines AS l WHERE l.movement_id = m.id)
     ORDER BY m.occurred_at, m.id
  LOOP
    INSERT INTO public.stock_document_lines (document_id, movement_id)
    VALUES (
      public.stock_document_for(
        public.stock_document_kind(movement.movement_type), movement.task_id, movement.issued_to,
        coalesce(movement.task_equipment, movement.equipment_id),
        (movement.occurred_at AT TIME ZONE 'Europe/Moscow')::date),
      movement.id
    );
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. Список и строки для экрана
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.stock_document_list(
  p_kind text DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_task_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  number text,
  kind text,
  document_date date,
  task_id uuid,
  task_number text,
  task_title text,
  equipment_serial_number text,
  equipment_name text,
  site_name text,
  engineer_name text,
  line_count bigint,
  total_quantity numeric,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  rows_wanted integer := least(greatest(coalesce(p_limit, 50), 1), 1000);
  rows_skipped integer := greatest(coalesce(p_offset, 0), 0);
  needle text := nullif(btrim(coalesce(p_search, '')), '');
BEGIN
  IF NOT public.app_has_any_permission(ARRAY['warehouse.read', 'warehouse.write', 'tasks.read_all', 'finance.read']) THEN
    RAISE EXCEPTION 'Документы склада доступны складу, координатору и бухгалтерии' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    d.id,
    d.number,
    d.kind,
    d.document_date,
    d.task_id,
    task.number,
    task.title,
    device.serial_number,
    nullif(btrim(concat_ws(' ', maker.name, model.name)), ''),
    site.name,
    engineer.full_name,
    totals.line_count,
    trim_scale(totals.total_quantity),
    count(*) OVER () AS total_count
  FROM public.stock_documents AS d
  LEFT JOIN public.tasks AS task ON task.id = d.task_id
  LEFT JOIN public.equipment AS device ON device.id = d.equipment_id
  LEFT JOIN public.manufacturers AS maker ON maker.id = device.manufacturer_id
  LEFT JOIN public.equipment_models AS model ON model.id = device.model_id
  LEFT JOIN public.sites AS site ON site.id = coalesce(task.site_id, device.current_site_id)
  LEFT JOIN public.users AS engineer ON engineer.id = d.engineer_id
  CROSS JOIN LATERAL (
    SELECT count(*) AS line_count, coalesce(sum(m.quantity), 0) AS total_quantity
      FROM public.stock_document_lines AS l
      JOIN public.stock_movements AS m ON m.id = l.movement_id
     WHERE l.document_id = d.id
  ) AS totals
  WHERE (p_kind IS NULL OR p_kind = '' OR d.kind = p_kind)
    AND (p_from IS NULL OR d.document_date >= p_from)
    AND (p_to IS NULL OR d.document_date <= p_to)
    AND (p_task_id IS NULL OR d.task_id = p_task_id)
    AND (needle IS NULL
         OR d.number ILIKE '%' || needle || '%'
         OR task.number ILIKE '%' || needle || '%'
         OR device.serial_number ILIKE '%' || needle || '%'
         OR engineer.full_name ILIKE '%' || needle || '%'
         OR EXISTS (
           SELECT 1
             FROM public.stock_document_lines AS l
             JOIN public.stock_movements AS m ON m.id = l.movement_id
             JOIN public.parts AS part ON part.id = m.part_id
            WHERE l.document_id = d.id
              AND (part.article_number ILIKE '%' || needle || '%' OR part.name ILIKE '%' || needle || '%')))
  ORDER BY d.document_date DESC, d.created_at DESC, d.number DESC
  LIMIT rows_wanted OFFSET rows_skipped;
END
$$;

REVOKE ALL ON FUNCTION public.stock_document_list(text, text, date, date, uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_document_list(text, text, date, date, uuid, integer, integer) TO authenticated;
COMMENT ON FUNCTION public.stock_document_list(text, text, date, date, uuid, integer, integer) IS
  'Документы склада для экрана (0062): вид, период, поиск по номеру, задаче, S/N, инженеру и запчасти; сначала свежие.';

CREATE OR REPLACE FUNCTION public.stock_document_lines_for(p_document_ids uuid[])
RETURNS TABLE (
  document_id uuid,
  movement_id uuid,
  article_number text,
  part_name text,
  part_condition public.part_condition,
  quantity numeric,
  reservation_number text,
  occurred_at timestamptz,
  comment text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.app_has_any_permission(ARRAY['warehouse.read', 'warehouse.write', 'tasks.read_all', 'finance.read']) THEN
    RAISE EXCEPTION 'Документы склада доступны складу, координатору и бухгалтерии' USING ERRCODE = '42501';
  END IF;
  IF coalesce(cardinality(p_document_ids), 0) > 1000 THEN
    RAISE EXCEPTION 'За один раз — не больше 1000 документов' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    l.document_id,
    m.id,
    part.article_number,
    part.name,
    m.part_condition,
    trim_scale(m.quantity),
    reservation.number,
    m.occurred_at,
    m.comment
  FROM public.stock_document_lines AS l
  JOIN public.stock_movements AS m ON m.id = l.movement_id
  JOIN public.parts AS part ON part.id = m.part_id
  LEFT JOIN public.stock_reservations AS reservation ON reservation.id = m.reservation_id
  WHERE l.document_id = ANY (p_document_ids)
  ORDER BY l.document_id, m.occurred_at, part.article_number, m.id;
END
$$;

REVOKE ALL ON FUNCTION public.stock_document_lines_for(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_document_lines_for(uuid[]) TO authenticated;
COMMENT ON FUNCTION public.stock_document_lines_for(uuid[]) IS
  'Строки документов склада (0062): артикул, наименование, состояние, количество, резерв и причина списания.';
