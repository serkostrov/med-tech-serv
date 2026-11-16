-- Счёт собирается сам: работы по прайсу, установленные запчасти, суммы, жизнь счёта.
--
-- Что было не так. create_invoice (0015, 0024) заводил счёт и привязывал к нему закрытые
-- задачи — и на этом всё: позиций у счёта не было, subtotal и total_amount оставались
-- нулями, выставить и передать счёт было нечем. Раздел «Счета» показывал список задач
-- без строк и сумм, то есть не делал того, ради чего он есть (замечание аудита).
--
-- Что делаем.
--   1. Позиции счёта собираются сами: на каждую задачу строка работы по прайсу на дату
--      окончания работ и строки запчастей, которые инженер отметил установленными.
--   2. Два правила вынесены в отдельные функции — они ждут созвона с бухгалтерией
--      и меняются в одном месте: гарантийная работа в сумме (invoice_work_billable)
--      и цена запчасти в счёте (invoice_part_unit_price).
--   3. Суммы считает база: subtotal — сумма строк, total_amount — subtotal плюс
--      корректировка. Пересчёт висит на строках (триггер invoice_items_total из 0001).
--   4. Жизнь счёта: выставить, передать в 1С, скорректировать с причиной, пересобрать
--      черновик по прайсу. Переходы, которых нет в списке, отказываются по-русски.
--   5. Деньги по прибору за период и плоская выгрузка строк для 1С.
--   6. Страж: прямая запись в invoice_items закрыта, как склад в 0028 и прайс в 0031.
--
-- Правá. Функции жизни счёта работают с правами вызывающего (SECURITY INVOKER): к записи
-- и так пускают только правила строк по finance.write, а понятный отказ по-русски даёт
-- проверка внутри. Исключение — сборка позиций: она читает резервы склада и партии,
-- а роль настраивается, и роль с finance.write без warehouse.read завела бы счёт молча
-- без запчастей. Поэтому сборка работает от владельца схемы с явной проверкой прав
-- внутри — так же, как set_task_parts_installed в 0028.

-- ---------------------------------------------------------------------------
-- 1. Цена прихода партии
-- ---------------------------------------------------------------------------

-- Цены прихода в базе не было вообще: партия знала только, что и в каком состоянии
-- лежит. Храним её на самой партии — это цена той поставки, по которой партию завели.
ALTER TABLE public.stock_lots
  ADD COLUMN IF NOT EXISTS receipt_unit_price numeric(14, 2)
    CHECK (receipt_unit_price IS NULL OR receipt_unit_price >= 0);

COMMENT ON COLUMN public.stock_lots.receipt_unit_price IS
  'Цена единицы в приходе этой партии (0040). Пусто — цену при приходе не вписали: в счёт такая запчасть попадает строкой с нулём и пометкой, молча терять её нельзя. Колонка закрыта от ролей API: цены видны только через счёт.';

-- Складское окно открыто инженеру (warehouse.read), а цены ему по ТЗ не видны никаким
-- запросом. Колонку из табличного GRANT не вычесть — PostgreSQL умеет только обратное:
-- снять SELECT с таблицы и выдать его по колонкам. Писать цену прихода склад может,
-- читать её обратно — нет: это уже финансовые данные.
REVOKE SELECT ON TABLE public.stock_lots FROM anon, authenticated;
GRANT SELECT (id, part_id, part_condition, lot_code, source_document, created_at)
  ON TABLE public.stock_lots TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Два правила, которые ждут бухгалтерию
-- ---------------------------------------------------------------------------

-- ПРЕДПОЛОЖЕНИЕ № 1 (ждёт созвона с бухгалтерией).
-- Гарантийная работа (отметка «Г» в результате работ) попадает в счёт строкой, но
-- в сумму не идёт, если в прайсе у действующей цены include_guarantee_work = false.
-- Пока правило такое; когда бухгалтерия скажет иначе, меняется только тело этой функции,
-- и пересборка черновика (rebuild_invoice_items) приведёт счета к новому правилу.
CREATE OR REPLACE FUNCTION public.invoice_work_billable(
  p_modifier public.work_modifier,
  p_work_type_code text,
  p_guarantee_category_id uuid,
  p_on date
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  -- Негарантийная работа всегда в сумме. Для «Г» смотрим ту же строку прайса, по которой
  -- взята цена: сначала по категории гарантии прибора, если её нет — общую. Строки прайса
  -- нет совсем — считаем, что гарантийная работа не оплачивается (осторожная сторона:
  -- лишнюю строку в сумме заметят позже, чем недостающую).
  SELECT CASE
    WHEN p_modifier IS DISTINCT FROM 'G'::public.work_modifier THEN true
    ELSE coalesce(
      (SELECT exact.include_guarantee_work
         FROM public.price_list AS exact
        WHERE exact.work_type_code = p_work_type_code
          AND exact.scope_key = coalesce(p_guarantee_category_id::text, '*')
          AND exact.valid_from <= p_on
          AND (exact.valid_to IS NULL OR exact.valid_to > p_on)),
      (SELECT common.include_guarantee_work
         FROM public.price_list AS common
        WHERE common.work_type_code = p_work_type_code
          AND common.scope_key = '*'
          AND common.valid_from <= p_on
          AND (common.valid_to IS NULL OR common.valid_to > p_on)),
      false)
  END
$$;

REVOKE ALL ON FUNCTION public.invoice_work_billable(public.work_modifier, text, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_work_billable(public.work_modifier, text, uuid, date) TO authenticated;

COMMENT ON FUNCTION public.invoice_work_billable(public.work_modifier, text, uuid, date) IS
  'ПРЕДПОЛОЖЕНИЕ (0040, ждёт созвона с бухгалтерией): идёт ли работа в сумму счёта. Негарантийная — всегда; гарантийная («Г») — только если у действующей цены прайса include_guarantee_work = true. Правило живёт здесь одно на всю базу: менять его после созвона нужно только в этой функции. Права вызывающего: кому прайс не виден, для того гарантийная работа в сумму не идёт.';

-- ПРЕДПОЛОЖЕНИЕ № 2 (ждёт созвона с бухгалтерией).
-- Цена запчасти в счёте — последняя цена прихода партии этой запчасти в этом состоянии.
-- Цены нет — NULL: строка всё равно создаётся, с нулём и пометкой в описании.
-- Функция работает только изнутри сборки счёта (от владельца схемы): цена прихода
-- закрыта от ролей API, и открывать её отдельным вызовом незачем.
CREATE OR REPLACE FUNCTION public.invoice_part_unit_price(
  p_part_id uuid,
  p_condition public.part_condition
)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  -- Партию того же состояния берём в первую очередь: Б и Н стоят по-разному. Если
  -- в этом состоянии цены не записали ни разу — берём последнюю цену по самой запчасти,
  -- это ближе к правде, чем ноль. Порядок задан целиком, результат не зависит от плана.
  SELECT lot.receipt_unit_price
    FROM public.stock_lots AS lot
   WHERE lot.part_id = p_part_id
     AND lot.receipt_unit_price IS NOT NULL
   ORDER BY (lot.part_condition = p_condition) DESC, lot.created_at DESC, lot.id DESC
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.invoice_part_unit_price(uuid, public.part_condition) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.invoice_part_unit_price(uuid, public.part_condition) IS
  'ПРЕДПОЛОЖЕНИЕ (0040, ждёт созвона с бухгалтерией): цена запчасти в счёте — последняя цена прихода партии (сначала в том же состоянии, затем любая по этой запчасти). Пусто — цены прихода нет: строка счёта создаётся с нулём и пометкой. Правило живёт здесь одно на всю базу. Вызывается только сборкой позиций счёта, ролям API закрыта: цена прихода — финансовые данные.';

-- ---------------------------------------------------------------------------
-- 3. Страж: позиции счёта пишет только счёт
-- ---------------------------------------------------------------------------

-- Иначе интерфейс (или любой запрос с finance.write) дописал бы в счёт строку мимо
-- прайса и мимо правила гарантии, и счёт перестал бы сходиться с задачами. Сделано как
-- страж склада в 0028 и прайса в 0031: транзакционный флаг плюс отказ по-русски.
CREATE OR REPLACE FUNCTION public.guard_invoice_items_direct_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Без вошедшего пользователя идут миграции и перенос данных: им страж не мешает.
  -- Флаг app.invoice_chain ставит на время записи только сборка позиций; из браузера
  -- его не задать — PostgREST пускает к select и rpc, а set_config в public не лежит.
  IF auth.uid() IS NULL
     OR coalesce(current_setting('app.invoice_chain', true), 'off') = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '%',
    CASE TG_OP
      WHEN 'INSERT' THEN 'Позиции счёта собираются сами: дописать строку напрямую нельзя. Поправьте задачу или прайс и пересоберите черновик.'
      WHEN 'UPDATE' THEN 'Позиции счёта собираются сами: править строку напрямую нельзя. Поправьте задачу или прайс и пересоберите черновик, а сумму измените корректировкой с причиной.'
      ELSE 'Позиции счёта собираются сами: удалить строку напрямую нельзя. Уберите задачу из счёта и пересоберите черновик.'
    END
    USING ERRCODE = '42501';
END
$$;

REVOKE EXECUTE ON FUNCTION public.guard_invoice_items_direct_write() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.guard_invoice_items_direct_write() IS
  'Страж позиций счёта (0040): прямые INSERT, UPDATE и DELETE по invoice_items запрещены, писать можно только изнутри сборки позиций (флаг app.invoice_chain). Служебные операции без вошедшего пользователя страж пропускает.';

DROP TRIGGER IF EXISTS invoice_items_guard_direct_write ON public.invoice_items;
CREATE TRIGGER invoice_items_guard_direct_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_items_direct_write();

-- ---------------------------------------------------------------------------
-- 4. Сборка позиций счёта
-- ---------------------------------------------------------------------------

-- Собрать позиции заново по текущим задачам, прайсу и складу. Для черновика: выставленный,
-- переданный в 1С или отменённый счёт не перестраивается (0024) — исправление это отмена
-- и новый счёт либо корректировка суммы с причиной.
--
-- Работает от владельца схемы с явной проверкой прав внутри (как set_task_parts_installed
-- в 0028): читает резервы склада и цены прихода, а роль с finance.write может быть без
-- warehouse.read — тогда счёт собрался бы молча без запчастей.
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

  -- Строка работы на каждую задачу счёта. Количество — 1, а у видов работ с учётом часов
  -- (work_types.requires_hours) часы из задачи; часов не проставили — всё равно 1, иначе
  -- работа пропала бы из счёта. Цена — из прайса на дату окончания работ по категории
  -- гарантии прибора; цены на эту дату нет — ноль и пометка в описании.
  INSERT INTO public.invoice_items (
    invoice_id, item_type, task_id, work_type_code, description,
    quantity, unit_price, modifier, excluded_from_total)
  SELECT
    p_invoice_id,
    'work',
    task.id,
    task.work_type_code,
    work_type.name
      || CASE WHEN price.amount IS NULL
              THEN format(' (цены в прайсе на %s нет)', to_char(moment.work_date, 'DD.MM.YYYY'))
              ELSE '' END,
    CASE WHEN work_type.requires_hours THEN coalesce(task.hours, 1) ELSE 1 END,
    coalesce(price.amount, 0),
    task.work_modifier,
    NOT public.invoice_work_billable(
      task.work_modifier, task.work_type_code, equipment.guarantee_category_id, moment.work_date)
  FROM public.invoice_tasks AS link
  JOIN public.tasks AS task ON task.id = link.task_id
  JOIN public.work_types AS work_type ON work_type.code = task.work_type_code
  LEFT JOIN public.equipment AS equipment ON equipment.id = task.equipment_id
  CROSS JOIN LATERAL (
    SELECT (public.task_work_completed_at(
              task.work_finished_at, task.visit_date,
              coalesce(task.completed_at, task.updated_at)) AT TIME ZONE 'Europe/Moscow')::date AS work_date
  ) AS moment
  CROSS JOIN LATERAL (
    SELECT public.work_price_on(task.work_type_code, equipment.guarantee_category_id, moment.work_date) AS amount
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
  'Сборка позиций черновика счёта (0040): строка работы на каждую задачу по прайсу на дату окончания работ и строки запчастей, отмеченных инженером как установленные. Возвращает число строк. Работает от владельца схемы с проверкой finance.write внутри: читает резервы склада и цены прихода, которых у финансовой роли может не быть.';

-- ---------------------------------------------------------------------------
-- 5. Жизнь счёта
-- ---------------------------------------------------------------------------

-- Статус счёта человеческими словами: в отказах и в карточке.
CREATE OR REPLACE FUNCTION public.invoice_status_label(p_status public.invoice_status)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_status
    WHEN 'draft' THEN 'черновик'
    WHEN 'issued' THEN 'выставлен'
    WHEN 'transferred_to_1c' THEN 'передан в 1С'
    ELSE 'отменён'
  END
$$;

REVOKE ALL ON FUNCTION public.invoice_status_label(public.invoice_status) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_status_label(public.invoice_status) TO authenticated;

-- Переход, которого нет в списке, отказывается по-русски: прежний отказ показывал
-- коды статусов («draft -> transferred_to_1c») и ничего не говорил о том, что делать.
CREATE OR REPLACE FUNCTION public.enforce_invoice_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  allowed public.invoice_status[];
  names text;
BEGIN
  IF TG_OP <> 'UPDATE' OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status
    WHEN 'draft' THEN ARRAY['issued', 'cancelled']::public.invoice_status[]
    WHEN 'issued' THEN ARRAY['transferred_to_1c', 'cancelled']::public.invoice_status[]
    ELSE ARRAY[]::public.invoice_status[]
  END;
  IF NEW.status = ANY (allowed) THEN
    RETURN NEW;
  END IF;

  SELECT string_agg(format('«%s»', public.invoice_status_label(step.status)), ', ' ORDER BY step.ord)
    INTO names
    FROM unnest(allowed) WITH ORDINALITY AS step(status, ord);

  RAISE EXCEPTION 'Счёт в состоянии «%» нельзя перевести в «%». %',
    public.invoice_status_label(OLD.status),
    public.invoice_status_label(NEW.status),
    CASE WHEN names IS NULL
         THEN 'Отсюда счёт уже не меняется: если нужно исправить, выставьте новый.'
         ELSE 'Отсюда возможно только: ' || names || '.' END
    USING ERRCODE = '23514';
END
$$;

REVOKE EXECUTE ON FUNCTION public.enforce_invoice_status_transition() FROM PUBLIC, anon, authenticated;

-- Выставить счёт: из черновика. Дата выставления ставится здесь, руками её не задают.
CREATE OR REPLACE FUNCTION public.issue_invoice(p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_status public.invoice_status;
BEGIN
  IF NOT public.app_has_permission('finance.write') THEN
    RAISE EXCEPTION 'Выставить счёт может только тот, кто ведёт счета' USING ERRCODE = '42501';
  END IF;
  SELECT invoice.status INTO current_status FROM public.invoices AS invoice WHERE invoice.id = p_invoice_id;
  IF current_status IS NULL THEN
    RAISE EXCEPTION 'Счёт не найден' USING ERRCODE = '23514';
  END IF;
  IF current_status <> 'draft' THEN
    RAISE EXCEPTION 'Выставить можно только черновик: счёт уже %.', public.invoice_status_label(current_status)
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.invoices AS invoice
     SET status = 'issued', issued_at = now()
   WHERE invoice.id = p_invoice_id;
END
$$;

REVOKE ALL ON FUNCTION public.issue_invoice(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_invoice(uuid) TO authenticated;

-- Передать в 1С: из выставленного. После передачи счёт не меняется совсем.
CREATE OR REPLACE FUNCTION public.transfer_invoice_to_1c(p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_status public.invoice_status;
BEGIN
  IF NOT public.app_has_permission('finance.write') THEN
    RAISE EXCEPTION 'Передать счёт в 1С может только тот, кто ведёт счета' USING ERRCODE = '42501';
  END IF;
  SELECT invoice.status INTO current_status FROM public.invoices AS invoice WHERE invoice.id = p_invoice_id;
  IF current_status IS NULL THEN
    RAISE EXCEPTION 'Счёт не найден' USING ERRCODE = '23514';
  END IF;
  IF current_status <> 'issued' THEN
    RAISE EXCEPTION 'Передать в 1С можно только выставленный счёт: сейчас он %.', public.invoice_status_label(current_status)
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.invoices AS invoice
     SET status = 'transferred_to_1c', transferred_at = now()
   WHERE invoice.id = p_invoice_id;
END
$$;

REVOKE ALL ON FUNCTION public.transfer_invoice_to_1c(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_invoice_to_1c(uuid) TO authenticated;

-- Корректировка суммы: только пока счёт не передан в 1С и только с причиной. Причину
-- и автора пишет журнал корректировок (триггеры 0001 и 0024), здесь — понятные отказы
-- до того, как сработает ограничение.
CREATE OR REPLACE FUNCTION public.correct_invoice(
  p_invoice_id uuid,
  p_adjustment numeric,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  invoice_row public.invoices%ROWTYPE;
  reason text := nullif(btrim(coalesce(p_reason, '')), '');
  amount numeric(14, 2) := round(coalesce(p_adjustment, 0), 2);
BEGIN
  IF NOT public.app_has_permission('finance.write') THEN
    RAISE EXCEPTION 'Корректировать счёт может только тот, кто ведёт счета' USING ERRCODE = '42501';
  END IF;
  IF reason IS NULL THEN
    RAISE EXCEPTION 'Укажите причину корректировки: без неё сумму счёта изменить нельзя'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO invoice_row FROM public.invoices AS invoice WHERE invoice.id = p_invoice_id;
  IF invoice_row.id IS NULL THEN
    RAISE EXCEPTION 'Счёт не найден' USING ERRCODE = '23514';
  END IF;
  IF invoice_row.status IN ('transferred_to_1c', 'cancelled') THEN
    RAISE EXCEPTION 'Счёт % : сумму менять поздно. Договаривайтесь с бухгалтерией и выставляйте новый счёт.',
      public.invoice_status_label(invoice_row.status)
      USING ERRCODE = '23514';
  END IF;
  IF invoice_row.adjustment_amount = amount THEN
    RAISE EXCEPTION 'Корректировка уже равна % : менять нечего', trim_scale(amount)
      USING ERRCODE = '23514';
  END IF;
  -- Ограничение 0001 требует новую причину на каждую корректировку: иначе в журнале
  -- две записи с одним текстом и непонятно, за что вторая.
  IF invoice_row.correction_reason IS NOT DISTINCT FROM reason THEN
    RAISE EXCEPTION 'У этой корректировки должна быть своя причина: прошлая уже записана тем же текстом'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.invoices AS invoice
     SET adjustment_amount = amount, correction_reason = reason
   WHERE invoice.id = p_invoice_id;
END
$$;

REVOKE ALL ON FUNCTION public.correct_invoice(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_invoice(uuid, numeric, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Счёт с позициями одной операцией
-- ---------------------------------------------------------------------------

-- Тот же create_invoice, что в 0024, плюс сборка позиций в той же транзакции: счёт
-- без строк и сумм — это и есть замечание аудита, и появляться он не должен даже
-- на секунду. Права вызывающего, как и был.
CREATE OR REPLACE FUNCTION public.create_invoice(
  p_payer_id uuid,
  p_task_ids uuid[],
  p_payer_override_reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  source_equipment uuid;
  invoice_id uuid;
  reason text := nullif(btrim(coalesce(p_payer_override_reason, '')), '');
  busy text;
BEGIN
  IF p_payer_id IS NULL THEN
    RAISE EXCEPTION 'Выберите плательщика' USING ERRCODE = '23514';
  END IF;
  IF p_task_ids IS NULL OR cardinality(p_task_ids) = 0 THEN
    RAISE EXCEPTION 'Выберите хотя бы одну закрытую задачу' USING ERRCODE = '23514';
  END IF;
  IF (SELECT count(*) FROM public.tasks WHERE id = ANY (p_task_ids)) <> cardinality(ARRAY(SELECT DISTINCT unnest(p_task_ids))) THEN
    RAISE EXCEPTION 'Задачи счёта не найдены или недоступны' USING ERRCODE = '42501';
  END IF;

  -- Задача входит только в один действующий счёт: называем занятые задачи и их счета.
  SELECT string_agg(format('%s (счёт %s)', task.number, invoice.number), ', ' ORDER BY task.number)
    INTO busy
    FROM public.invoice_tasks AS link
    JOIN public.invoices AS invoice ON invoice.id = link.invoice_id
    JOIN public.tasks AS task ON task.id = link.task_id
   WHERE link.task_id = ANY (p_task_ids)
     AND link.invoice_active;
  IF busy IS NOT NULL THEN
    RAISE EXCEPTION 'Эти задачи уже есть в действующих счетах: %. Одна задача входит только в один счёт: чтобы выставить её заново, сначала отмените прежний счёт.', busy
      USING ERRCODE = '23505';
  END IF;

  -- Прибор-источник снимка: сначала тот, чей плательщик совпадает с выбранным,
  -- затем любой с плательщиком. Порядок задан, результат не зависит от запроса.
  SELECT task.equipment_id INTO source_equipment
    FROM public.tasks AS task
    JOIN public.equipment AS equipment ON equipment.id = task.equipment_id
   WHERE task.id = ANY (p_task_ids)
     AND equipment.current_payer_id IS NOT NULL
   ORDER BY (equipment.current_payer_id = p_payer_id) DESC, task.id
   LIMIT 1;
  IF source_equipment IS NULL THEN
    RAISE EXCEPTION 'У приборов выбранных задач не указан плательщик' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.invoices (payer_id, status, source_equipment_id, payer_override_reason, payer_overridden_by)
  VALUES (p_payer_id, 'draft', source_equipment, reason, CASE WHEN reason IS NULL THEN NULL ELSE auth.uid() END)
  RETURNING id INTO invoice_id;

  BEGIN
    INSERT INTO public.invoice_tasks (invoice_id, task_id)
    SELECT invoice_id, task_id FROM (SELECT DISTINCT unnest(p_task_ids) AS task_id) AS selected;
  EXCEPTION WHEN unique_violation THEN
    -- Другой сотрудник только что выставил счёт по этой же задаче.
    RAISE EXCEPTION 'Задачу только что включили в другой счёт. Выберите задачи заново.'
      USING ERRCODE = '23505';
  END;

  -- Отложенная проверка снимка срабатывает сейчас, а не при завершении запроса:
  -- ошибка откатит и счёт, и привязки, и придёт понятным сообщением.
  SET CONSTRAINTS invoice_tasks_payer_snapshot_valid IMMEDIATE;

  -- (0040) Позиции: работы по прайсу и установленные запчасти.
  PERFORM public.rebuild_invoice_items(invoice_id);
  RETURN invoice_id;
END
$$;

REVOKE ALL ON FUNCTION public.create_invoice(uuid, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invoice(uuid, uuid[], text) TO authenticated;

COMMENT ON FUNCTION public.create_invoice(uuid, uuid[], text) IS
  'Счёт по закрытым задачам одной транзакцией (0015, 0024, 0040): заводит счёт, привязывает задачи, следит, чтобы задача не попала в два действующих счёта, и сразу собирает позиции — работы по прайсу и установленные запчасти.';

-- ---------------------------------------------------------------------------
-- 7. Деньги по прибору за период
-- ---------------------------------------------------------------------------

-- Сколько по счетам потрачено на прибор: отдельно работы, отдельно запчасти. Отменённые
-- счета не считаем — их не платят. Дата счёта — день выставления, а у черновика день
-- создания: по дню выставления бухгалтерия и сверяет период.
CREATE OR REPLACE FUNCTION public.equipment_spend(
  p_equipment_id uuid,
  p_from date,
  p_to date
)
RETURNS TABLE (
  work_amount numeric,
  parts_amount numeric,
  total_amount numeric,
  invoice_count integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  -- Права вызывающего: без finance.read правила строк не отдадут ни счетов, ни позиций,
  -- и функция честно вернёт нули, а не чужие суммы.
  SELECT
    coalesce(sum(item.line_total) FILTER (WHERE item.item_type = 'work'), 0)::numeric(14, 2),
    coalesce(sum(item.line_total) FILTER (WHERE item.item_type = 'part'), 0)::numeric(14, 2),
    coalesce(sum(item.line_total), 0)::numeric(14, 2),
    count(DISTINCT invoice.id)::integer
    FROM public.invoice_items AS item
    JOIN public.invoices AS invoice ON invoice.id = item.invoice_id
    JOIN public.tasks AS task ON task.id = item.task_id
   WHERE task.equipment_id = p_equipment_id
     AND invoice.status <> 'cancelled'
     AND (p_from IS NULL
          OR (coalesce(invoice.issued_at, invoice.created_at) AT TIME ZONE 'Europe/Moscow')::date >= p_from)
     AND (p_to IS NULL
          OR (coalesce(invoice.issued_at, invoice.created_at) AT TIME ZONE 'Europe/Moscow')::date <= p_to)
$$;

REVOKE ALL ON FUNCTION public.equipment_spend(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_spend(uuid, date, date) TO authenticated;

COMMENT ON FUNCTION public.equipment_spend(uuid, date, date) IS
  'Деньги по прибору за период (0040): суммы строк неотменённых счетов по задачам этого прибора, отдельно работы и запчасти. Границы периода включительно, пустая граница — без ограничения. Дата счёта — день выставления, у черновика день создания. Права вызывающего: без finance.read вернутся нули.';

-- ---------------------------------------------------------------------------
-- 8. Выгрузка счёта для 1С
-- ---------------------------------------------------------------------------

-- Строки счёта одной плоской таблицей: интерфейсу остаётся собрать файл. Плательщик,
-- ИНН и КПП берутся из снимка счёта, а не из справочника: в справочнике их могли
-- поправить после выставления, а в выгрузке должно быть то, что в счёте.
CREATE OR REPLACE FUNCTION public.invoice_export_rows(p_invoice_id uuid)
RETURNS TABLE (
  invoice_number text,
  invoice_date date,
  payer_name text,
  payer_inn text,
  payer_kpp text,
  task_number text,
  item_type text,
  item_code text,
  description text,
  quantity numeric,
  unit_price numeric,
  line_total numeric,
  guarantee text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT
    invoice.number,
    (coalesce(invoice.issued_at, invoice.created_at) AT TIME ZONE 'Europe/Moscow')::date,
    invoice.payer_name,
    coalesce(invoice.payer_requisites ->> 'inn', ''),
    coalesce(invoice.payer_requisites ->> 'kpp', ''),
    coalesce(task.number, ''),
    CASE item.item_type WHEN 'work' THEN 'Работа' ELSE 'Запчасть' END,
    coalesce(work_type.name, part.article_number, ''),
    item.description,
    trim_scale(item.quantity),
    item.unit_price,
    item.line_total,
    -- Отметка гарантии: что в счёте строкой, но не в сумме, должно быть видно в файле.
    CASE
      WHEN item.excluded_from_total THEN 'Гарантия, в сумму не входит'
      WHEN item.modifier = 'G' THEN 'Гарантия'
      ELSE ''
    END
    FROM public.invoice_items AS item
    JOIN public.invoices AS invoice ON invoice.id = item.invoice_id
    LEFT JOIN public.tasks AS task ON task.id = item.task_id
    LEFT JOIN public.work_types AS work_type ON work_type.code = item.work_type_code
    LEFT JOIN public.parts AS part ON part.id = item.part_id
   WHERE item.invoice_id = p_invoice_id
   ORDER BY coalesce(task.number, ''), item.item_type DESC, item.description, item.id
$$;

REVOKE ALL ON FUNCTION public.invoice_export_rows(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_export_rows(uuid) TO authenticated;

COMMENT ON FUNCTION public.invoice_export_rows(uuid) IS
  'Плоская выгрузка строк счёта для 1С (0040): номер и дата счёта, плательщик с ИНН и КПП из снимка счёта, задача, вид работы или артикул, количество, цена, сумма и отметка гарантии. Файл собирает интерфейс. Права вызывающего: без finance.read строк не будет.';

NOTIFY pgrst, 'reload schema';
