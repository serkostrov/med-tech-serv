-- Несколько видов работ в одной задаче (встреча с заказчиком 16.11: «инсталляция и ремонт
-- в одной задаче запросто, нам вариативность нужна»).
--
-- Что делаем.
--   1. У задачи остаётся основной вид работ (work_type_code) — от него ничего не ломается:
--      фильтры, уведомления, акт. К нему добавляется список дополнительных видов
--      (extra_work_type_codes). Основной в список не попадает, повторы убираются сами.
--   2. Каждый вид из списка должен быть в справочнике «Виды работ» — иначе отказ по-русски.
--   3. Менять дополнительные виды может тот, кто ведёт задачи (tasks.write), — как основной.
--   4. Счёт: строка работы на каждый вид задачи, каждая по своей цене прайса.
--   5. Отчёт: задача считается в каждом своём виде работ.

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS extra_work_type_codes text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.tasks.extra_work_type_codes IS
  'Дополнительные виды работ задачи (0060), кроме основного work_type_code. Коды из справочника work_types, без повторов и без основного.';

-- ---------------------------------------------------------------------------
-- 1. Порядок в списке и проверка по справочнику
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.normalize_task_extra_work_types()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  unknown text;
BEGIN
  -- Пустые значения, повторы и основной вид убираем молча: это не ошибка человека,
  -- а то, как форма собирает список. Порядок — как выбирали.
  NEW.extra_work_type_codes := coalesce((
    SELECT array_agg(item.code ORDER BY item.first_position)
      FROM (
        SELECT btrim(source.code) AS code, min(source.position) AS first_position
          FROM unnest(coalesce(NEW.extra_work_type_codes, '{}')) WITH ORDINALITY AS source(code, position)
         WHERE nullif(btrim(source.code), '') IS NOT NULL
           AND btrim(source.code) <> NEW.work_type_code
         GROUP BY btrim(source.code)
      ) AS item
  ), '{}');

  -- Псевдоним обязателен: голое «code» внутри подзапроса взялось бы из work_types,
  -- и сравнение стало бы всегда истинным.
  SELECT item.code INTO unknown
    FROM unnest(NEW.extra_work_type_codes) AS item(code)
   WHERE NOT EXISTS (SELECT 1 FROM public.work_types AS kind WHERE kind.code = item.code)
   LIMIT 1;
  IF unknown IS NOT NULL THEN
    RAISE EXCEPTION 'Вида работ «%» нет в справочнике: выберите из списка', unknown
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.normalize_task_extra_work_types() IS
  'Дополнительные виды работ задачи (0060): без пустых, без повторов и без основного вида, каждый — из справочника work_types.';

DROP TRIGGER IF EXISTS tasks_extra_work_types_normalize ON public.tasks;
CREATE TRIGGER tasks_extra_work_types_normalize
  BEFORE INSERT OR UPDATE OF extra_work_type_codes, work_type_code ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.normalize_task_extra_work_types();

-- ---------------------------------------------------------------------------
-- 2. Кто меняет
-- ---------------------------------------------------------------------------

-- Основной вид работ координатору оставляет страж 0014. Дополнительные — тем же правилом,
-- отдельным триггером, чтобы не переписывать большой страж целиком.
CREATE OR REPLACE FUNCTION public.guard_task_extra_work_types()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NOT NULL
     AND NEW.extra_work_type_codes IS DISTINCT FROM OLD.extra_work_type_codes
     AND NOT public.app_has_permission('tasks.write') THEN
    RAISE EXCEPTION 'Недостаточно прав: виды работ задачи меняет координатор'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.guard_task_extra_work_types() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tasks_extra_work_types_guard ON public.tasks;
CREATE TRIGGER tasks_extra_work_types_guard
  BEFORE UPDATE OF extra_work_type_codes ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.guard_task_extra_work_types();

-- Отбор задач по виду работ находит и основной, и дополнительный.
CREATE INDEX IF NOT EXISTS tasks_extra_work_types_idx ON public.tasks USING gin (extra_work_type_codes);

-- ---------------------------------------------------------------------------
-- 3. Счёт: строка на каждый вид работ
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rebuild_invoice_items(p_invoice_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  invoice_row public.invoices%ROWTYPE;
  outer_flag text := coalesce(current_setting('app.invoice_chain', true), 'off');
  built integer;
BEGIN
  IF NOT public.app_has_permission('finance.write') THEN
    RAISE EXCEPTION 'Собирать позиции счёта может только тот, кто ведёт счета'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO invoice_row FROM public.invoices AS invoice WHERE invoice.id = p_invoice_id;
  IF invoice_row.id IS NULL THEN
    RAISE EXCEPTION 'Счёт не найден' USING ERRCODE = '23514';
  END IF;
  IF invoice_row.status <> 'draft' THEN
    RAISE EXCEPTION 'Пересобрать позиции можно только в черновике: счёт уже %. Исправление — отмена счёта и новый либо корректировка суммы с причиной.',
      public.invoice_status_label(invoice_row.status)
      USING ERRCODE = '23514';
  END IF;

  -- Флаг открывает стражу запись в invoice_items на время сборки и снимается в конце:
  -- наружу он не протекает, следующий прямой запрос снова получит отказ.
  PERFORM set_config('app.invoice_chain', 'on', true);

  DELETE FROM public.invoice_items AS item WHERE item.invoice_id = p_invoice_id;

  -- Строка работы на каждый вид работ задачи (0060): основной и дополнительные — у задачи
  -- «инсталляция и ремонт» две строки, каждая по своей цене. Количество — 1, а у видов
  -- работ с учётом часов (work_types.requires_hours) часы из задачи; часов не проставили —
  -- всё равно 1, иначе работа пропала бы из счёта. Цена — из прайса на дату окончания работ
  -- по категории гарантии прибора; цены на эту дату нет — ноль и пометка в описании.
  INSERT INTO public.invoice_items (
    invoice_id, item_type, task_id, work_type_code, description,
    quantity, unit_price, modifier, excluded_from_total)
  SELECT
    p_invoice_id,
    'work',
    task.id,
    kind.code,
    work_type.name
      || CASE WHEN price.amount IS NULL
              THEN format(' (цены в прайсе на %s нет)', to_char(moment.work_date, 'DD.MM.YYYY'))
              ELSE '' END,
    CASE WHEN work_type.requires_hours THEN coalesce(task.hours, 1) ELSE 1 END,
    coalesce(price.amount, 0),
    task.work_modifier,
    NOT public.invoice_work_billable(
      task.work_modifier, kind.code, equipment.guarantee_category_id, moment.work_date)
  FROM public.invoice_tasks AS link
  JOIN public.tasks AS task ON task.id = link.task_id
  CROSS JOIN LATERAL unnest(ARRAY[task.work_type_code] || task.extra_work_type_codes)
    WITH ORDINALITY AS kind(code, position)
  JOIN public.work_types AS work_type ON work_type.code = kind.code
  LEFT JOIN public.equipment AS equipment ON equipment.id = task.equipment_id
  CROSS JOIN LATERAL (
    SELECT (public.task_work_completed_at(
              task.work_finished_at, task.visit_date,
              coalesce(task.completed_at, task.updated_at)) AT TIME ZONE 'Europe/Moscow')::date AS work_date
  ) AS moment
  CROSS JOIN LATERAL (
    SELECT public.work_price_on(kind.code, equipment.guarantee_category_id, moment.work_date) AS amount
  ) AS price
  WHERE link.invoice_id = p_invoice_id;

  -- Запчасти: всё, что инженер отметил установленным (0028). Отметка живёт на резерве,
  -- а не в строке позиции задачи: одинаковых запчастей под задачу выдают двумя резервами.
  -- После закрытия задачи отмеченный резерв проведён и стал «установлен», до закрытия
  -- остаётся «выдан» — берём оба состояния. Состояние запчасти Г/Н/Б идёт в описание:
  -- колонка modifier по схеме только для работ (Г/Н), состояния Б в ней нет.
  INSERT INTO public.invoice_items (
    invoice_id, item_type, task_id, part_id, description,
    quantity, unit_price, modifier, excluded_from_total)
  SELECT
    p_invoice_id,
    'part',
    reservation.task_id,
    reservation.part_id,
    format('%s — %s (%s)',
      part.article_number, part.name,
      CASE reservation.part_condition WHEN 'G' THEN 'Г' WHEN 'N' THEN 'Н' ELSE 'Б' END)
      || CASE WHEN price.amount IS NULL THEN ', цены прихода нет' ELSE '' END,
    reservation.quantity,
    coalesce(price.amount, 0),
    NULL::public.work_modifier,
    false
  FROM public.invoice_tasks AS link
  JOIN public.stock_reservations AS reservation ON reservation.task_id = link.task_id
  JOIN public.parts AS part ON part.id = reservation.part_id
  CROSS JOIN LATERAL (
    SELECT public.invoice_part_unit_price(reservation.part_id, reservation.part_condition) AS amount
  ) AS price
  WHERE link.invoice_id = p_invoice_id
    AND reservation.install_marked
    AND reservation.status IN ('issued', 'installed');

  SELECT count(*) INTO built FROM public.invoice_items AS item WHERE item.invoice_id = p_invoice_id;

  PERFORM set_config('app.invoice_chain', outer_flag, true);
  RETURN built;
END
$$;

REVOKE ALL ON FUNCTION public.rebuild_invoice_items(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rebuild_invoice_items(uuid) TO authenticated;

COMMENT ON FUNCTION public.rebuild_invoice_items(uuid) IS
  'Сборка позиций черновика счёта (0040, 0060): строка работы на каждый вид работ задачи — основной и дополнительные — по прайсу на дату окончания работ, и строки запчастей, отмеченных инженером как установленные. Возвращает число строк. Работает от владельца схемы с проверкой finance.write внутри.';

-- ---------------------------------------------------------------------------
-- 4. Отчёт: задача в каждом своём виде работ
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.report_task_breakdown(p_from date, p_to date)
RETURNS TABLE (
  section text,
  item_code text,
  item_name text,
  task_count integer,
  closed_count integer,
  overdue_count integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH period AS (
    SELECT * FROM public.report_period_tasks(p_from, p_to)
  ), cuts AS (
    SELECT 'status' AS section, task.status_code AS item_code,
           coalesce(status.name, task.status_code) AS item_name,
           task.is_closed, task.is_overdue
      FROM period AS task
      LEFT JOIN public.task_statuses AS status ON status.code = task.status_code
    UNION ALL
    -- Задача с несколькими видами работ считается в каждом своём виде (0060): «инсталляция
    -- и ремонт» — одна заявка и в инсталляции, и в ремонте. Сумма разреза может быть
    -- больше числа заявок, доли интерфейс считает от числа заявок периода.
    SELECT 'work_type', kind.code,
           coalesce(work_type.name, kind.code),
           task.is_closed, task.is_overdue
      FROM period AS task
      JOIN public.tasks AS source ON source.id = task.task_id
      CROSS JOIN LATERAL unnest(ARRAY[source.work_type_code] || source.extra_work_type_codes) AS kind(code)
      LEFT JOIN public.work_types AS work_type ON work_type.code = kind.code
    UNION ALL
    SELECT 'month', task.created_month, task.created_month, task.is_closed, task.is_overdue
      FROM period AS task
    UNION ALL
    SELECT 'reason', coalesce(task.reason_code, 'unset'),
           CASE WHEN task.reason_code IS NULL THEN 'Причина не указана'
                ELSE coalesce(reason.name, 'Причина') END,
           task.is_closed, task.is_overdue
      FROM period AS task
      LEFT JOIN public.task_reasons AS reason ON reason.code = task.reason_code
    UNION ALL
    SELECT 'modifier', coalesce(task.work_modifier::text, 'unset'),
           CASE task.work_modifier
             WHEN 'G' THEN 'Г · гарантийные работы'
             WHEN 'N' THEN 'Н · вина пользователя'
             ELSE 'Не отмечено'
           END,
           task.is_closed, task.is_overdue
      FROM period AS task
    UNION ALL
    -- Названия: «не указан» говорим только тогда, когда ссылки в задаче и правда нет.
    -- Если ссылка есть, а строки не видно (правила строк справочника строже, чем задач),
    -- пишем родовое слово — сказать «не указан» значило бы соврать про данные.
    SELECT 'equipment', coalesce(task.equipment_id::text, 'unset'),
           CASE
             WHEN task.equipment_id IS NULL THEN 'Прибор не указан'
             ELSE coalesce(nullif(concat_ws(' · ',
                    nullif(concat_ws(' ', maker.name, model.name), ''),
                    equipment.serial_number), ''), 'Прибор')
           END,
           task.is_closed, task.is_overdue
      FROM period AS task
      LEFT JOIN public.equipment AS equipment ON equipment.id = task.equipment_id
      LEFT JOIN public.equipment_models AS model ON model.id = equipment.model_id
      LEFT JOIN public.manufacturers AS maker ON maker.id = equipment.manufacturer_id
    UNION ALL
    SELECT 'site', coalesce(task.site_id::text, 'unset'),
           CASE WHEN task.site_id IS NULL THEN 'Площадка не указана'
                ELSE coalesce(site.name, 'Площадка') END,
           task.is_closed, task.is_overdue
      FROM period AS task
      LEFT JOIN public.sites AS site ON site.id = task.site_id
    UNION ALL
    SELECT 'engineer', coalesce(task.engineer_id::text, 'unset'),
           CASE WHEN task.engineer_id IS NULL THEN 'Инженер не назначен'
                ELSE coalesce(engineer.full_name, 'Инженер') END,
           task.is_closed, task.is_overdue
      FROM period AS task
      LEFT JOIN public.users AS engineer ON engineer.id = task.engineer_id
  )
  SELECT
    cuts.section,
    cuts.item_code,
    cuts.item_name,
    count(*)::integer,
    count(*) FILTER (WHERE cuts.is_closed)::integer,
    count(*) FILTER (WHERE cuts.is_overdue)::integer
    FROM cuts
   GROUP BY cuts.section, cuts.item_code, cuts.item_name
   -- Сверху самые частые: интерфейс рисует полосы в этом порядке, месяцы он
   -- раскладывает сам по календарю.
   ORDER BY cuts.section, count(*) DESC, cuts.item_name
$$;

COMMENT ON FUNCTION public.report_task_breakdown(date, date) IS
  'Разбивки отчёта по задачам за период (0044, 0060): section = status | work_type | month | reason | modifier | equipment | site | engineer. В разрезе work_type задача считается в каждом своём виде работ — основном и дополнительных.';

NOTIFY pgrst, 'reload schema';
