-- Списание и корректировка остатка: брак, утеря и пересчёт после инвентаризации.
--
-- Что было не так. Остаток менялся только приходом и выдачей. Разбитая лампа, утерянный
-- предохранитель и расхождение после инвентаризации списывать было нечем: тип движения
-- writeoff и adjustment в базе есть с 0001, но ни функции, ни кнопки под них не было.
-- Кладовщик «правил» остаток лишним приходом — и приход в истории перестал означать
-- поставку. Причину при этом записать было некуда: в комментарий движения её никто
-- не требовал.
--
-- Что делаем.
--   1. write_off_stock — списание с обязательной причиной: сколько и в каком состоянии.
--      Больше, чем лежит на складе, не списать; зарезервированное под задачи тоже:
--      иначе резерв остался бы без запчасти, и выдавать инженеру было бы нечего.
--   2. adjust_stock — корректировка после инвентаризации: кладовщик вводит не разницу,
--      а то, что фактически насчитал. Разницу считает база и проводит её встречным
--      движением adjustment в плюс или в минус.
--   3. Причина обязательна на уровне базы: движение writeoff или adjustment без
--      комментария не вставляется никаким запросом. Прежние строки не проверяются —
--      триггер смотрит только на новые.
--
-- Движения по-прежнему только добавляются: править и удалять их не даёт RLS (0014),
-- исправление ошибочного списания — встречный приход или корректировка. Обе функции
-- работают с правами вызывающего (SECURITY INVOKER), как выдача и возврат резерва (0022):
-- к записи и так пускают только политики склада, а понятный отказ по-русски даёт
-- проверка внутри. Снятая с учёта позиция списывается и корректируется: брак находят
-- и в ней, а инвентаризация считает всё, что лежит на полке.
-- Миграцию можно применить повторно.

-- ---------------------------------------------------------------------------
-- 1. Состояние запчасти по-русски: одно место на всю базу
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.part_condition_label(p_condition public.part_condition)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_temp
AS $$
  SELECT CASE p_condition WHEN 'G' THEN 'гарантийная' WHEN 'N' THEN 'новая' ELSE 'б/у' END
$$;

COMMENT ON FUNCTION public.part_condition_label(public.part_condition) IS
  'Состояние запчасти словом для сообщений базы (0049): гарантийная, новая, б/у.';

REVOKE ALL ON FUNCTION public.part_condition_label(public.part_condition) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.part_condition_label(public.part_condition) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Причина обязательна у списания и корректировки
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.require_stock_movement_reason()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.movement_type IN ('writeoff', 'adjustment')
     AND nullif(btrim(coalesce(NEW.comment, '')), '') IS NULL THEN
    RAISE EXCEPTION 'У списания и корректировки причина обязательна: без неё движение по складу не проводится'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.require_stock_movement_reason() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.require_stock_movement_reason() IS
  'Списание и корректировка склада без причины не проводятся (0049): остаток изменился бы, а почему — не узнать.';

DROP TRIGGER IF EXISTS stock_movements_reason_required ON public.stock_movements;
CREATE TRIGGER stock_movements_reason_required
  BEFORE INSERT ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.require_stock_movement_reason();

-- ---------------------------------------------------------------------------
-- 3. Партия, в которую пишем движение
-- ---------------------------------------------------------------------------

-- Партия этой запчасти в этом состоянии, где сейчас больше всего штук — как при выдаче
-- резерва (0022). Партии не существует вовсе: заводим партию по умолчанию (нужно
-- корректировке в плюс, когда позицию ни разу не приходовали). Цену прихода не пишем:
-- корректировка и списание не поставка.
CREATE OR REPLACE FUNCTION public.stock_lot_for_write(
  p_part_id uuid,
  p_condition public.part_condition,
  p_create_missing boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  lot uuid;
BEGIN
  SELECT l.id INTO lot
    FROM public.stock_lots AS l
    LEFT JOIN public.stock_movements AS m ON m.lot_id = l.id
   WHERE l.part_id = p_part_id AND l.part_condition = p_condition
   GROUP BY l.id, l.lot_code
   ORDER BY coalesce(sum(m.on_hand_delta), 0) DESC, (l.lot_code = 'default') DESC, l.id
   LIMIT 1;
  IF lot IS NULL AND p_create_missing THEN
    -- Партию по умолчанию могли завести в эту же секунду другим приходом: уникальный
    -- индекс (part_id, part_condition, lot_code) тогда отказал бы сырым английским
    -- текстом. ON CONFLICT молчит, и мы просто читаем ту партию, что уже есть.
    INSERT INTO public.stock_lots (part_id, part_condition, lot_code)
    VALUES (p_part_id, p_condition, 'default')
    ON CONFLICT (part_id, part_condition, lot_code) DO NOTHING
    RETURNING id INTO lot;
    IF lot IS NULL THEN
      SELECT l.id INTO lot
        FROM public.stock_lots AS l
       WHERE l.part_id = p_part_id AND l.part_condition = p_condition AND l.lot_code = 'default';
    END IF;
  END IF;
  RETURN lot;
END
$$;

COMMENT ON FUNCTION public.stock_lot_for_write(uuid, public.part_condition, boolean) IS
  'Партия запчасти в этом состоянии, куда писать движение (0049): где сейчас больше штук, как при выдаче резерва. Цену прихода не читает и не пишет. С правами вызывающего.';

REVOKE ALL ON FUNCTION public.stock_lot_for_write(uuid, public.part_condition, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_lot_for_write(uuid, public.part_condition, boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Списание
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.write_off_stock(
  p_part_id uuid,
  p_condition public.part_condition,
  p_quantity numeric,
  p_reason text
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  part_row public.parts%ROWTYPE;
  reason text := nullif(btrim(coalesce(p_reason, '')), '');
  wanted numeric(14, 3) := round(coalesce(p_quantity, 0), 3);
  on_hand numeric(14, 3);
  reserved numeric(14, 3);
  lot uuid;
BEGIN
  IF NOT public.app_has_permission('warehouse.write') THEN
    RAISE EXCEPTION 'Списывать запчасти со склада может только склад' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO part_row FROM public.parts AS p WHERE p.id = p_part_id;
  IF part_row.id IS NULL THEN
    RAISE EXCEPTION 'Запчасть не найдена в справочнике' USING ERRCODE = 'P0002';
  END IF;
  IF reason IS NULL THEN
    RAISE EXCEPTION 'Укажите причину списания: брак, утеря, бой — она останется в истории позиции'
      USING ERRCODE = '23514';
  END IF;
  IF wanted <= 0 THEN
    RAISE EXCEPTION 'Количество для списания должно быть больше нуля' USING ERRCODE = '23514';
  END IF;

  -- Тот же замок, что у assert_stock_capacity (0001) и заказа запчасти (0028):
  -- два одновременных списания не должны пройти проверку остатка вместе.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_part_id::text || ':' || p_condition::text, 0));
  SELECT coalesce(sum(m.on_hand_delta), 0) INTO on_hand
    FROM public.stock_movements AS m
   WHERE m.part_id = p_part_id AND m.part_condition = p_condition;
  SELECT coalesce(sum(r.quantity), 0) INTO reserved
    FROM public.stock_reservations AS r
   WHERE r.part_id = p_part_id AND r.part_condition = p_condition
     AND r.status IN ('created', 'warehouse_notified');

  IF on_hand <= 0 THEN
    RAISE EXCEPTION 'На складе нет этой запчасти в состоянии «%»: списывать нечего',
      public.part_condition_label(p_condition) USING ERRCODE = '23514';
  END IF;
  IF wanted > on_hand - reserved THEN
    RAISE EXCEPTION 'На складе % шт. в состоянии «%»%: списать можно не больше %',
      trim_scale(on_hand),
      public.part_condition_label(p_condition),
      CASE WHEN reserved > 0 THEN ', из них ' || trim_scale(reserved) || ' под задачи в резерве' ELSE '' END,
      trim_scale(on_hand - reserved)
      USING ERRCODE = '23514';
  END IF;

  lot := public.stock_lot_for_write(p_part_id, p_condition);
  IF lot IS NULL THEN
    RAISE EXCEPTION 'Этой запчасти нет на складе' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.stock_movements (
    idempotency_key, movement_type, lot_id, part_id, part_condition, quantity, on_hand_delta,
    performed_by, comment
  ) VALUES (
    'writeoff:' || gen_random_uuid()::text, 'writeoff', lot, p_part_id, p_condition,
    wanted, -wanted, public.current_app_user_id(), reason
  );
  RETURN trim_scale(on_hand - wanted);
END
$$;

COMMENT ON FUNCTION public.write_off_stock(uuid, public.part_condition, numeric, text) IS
  'Списание запчасти со склада (0049): брак, утеря, бой. Причина обязательна и попадает в историю позиции. Больше, чем лежит на складе, и зарезервированное под задачи списать нельзя. Возвращает остаток в этом состоянии после списания.';

-- ---------------------------------------------------------------------------
-- 5. Корректировка после инвентаризации
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.adjust_stock(
  p_part_id uuid,
  p_condition public.part_condition,
  p_counted_quantity numeric,
  p_reason text
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  part_row public.parts%ROWTYPE;
  reason text := nullif(btrim(coalesce(p_reason, '')), '');
  counted numeric(14, 3) := round(coalesce(p_counted_quantity, 0), 3);
  on_hand numeric(14, 3);
  reserved numeric(14, 3);
  difference numeric(14, 3);
  lot uuid;
BEGIN
  IF NOT public.app_has_permission('warehouse.write') THEN
    RAISE EXCEPTION 'Править остаток на складе может только склад' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO part_row FROM public.parts AS p WHERE p.id = p_part_id;
  IF part_row.id IS NULL THEN
    RAISE EXCEPTION 'Запчасть не найдена в справочнике' USING ERRCODE = 'P0002';
  END IF;
  IF reason IS NULL THEN
    RAISE EXCEPTION 'Укажите причину корректировки: номер инвентаризации или что именно разошлось'
      USING ERRCODE = '23514';
  END IF;
  IF counted < 0 THEN
    RAISE EXCEPTION 'Фактический остаток не может быть отрицательным' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_part_id::text || ':' || p_condition::text, 0));
  SELECT coalesce(sum(m.on_hand_delta), 0) INTO on_hand
    FROM public.stock_movements AS m
   WHERE m.part_id = p_part_id AND m.part_condition = p_condition;
  SELECT coalesce(sum(r.quantity), 0) INTO reserved
    FROM public.stock_reservations AS r
   WHERE r.part_id = p_part_id AND r.part_condition = p_condition
     AND r.status IN ('created', 'warehouse_notified');

  difference := counted - on_hand;
  IF difference = 0 THEN
    RAISE EXCEPTION 'В состоянии «%» на складе уже % шт.: корректировать нечего',
      public.part_condition_label(p_condition), trim_scale(on_hand) USING ERRCODE = '23514';
  END IF;
  IF counted < reserved THEN
    RAISE EXCEPTION 'Под задачи зарезервировано % шт. в состоянии «%», а по факту насчитали %: снимите лишние резервы или проверьте пересчёт',
      trim_scale(reserved), public.part_condition_label(p_condition), trim_scale(counted)
      USING ERRCODE = '23514';
  END IF;

  lot := public.stock_lot_for_write(p_part_id, p_condition, difference > 0);
  IF lot IS NULL THEN
    RAISE EXCEPTION 'Этой запчасти нет на складе' USING ERRCODE = '23514';
  END IF;
  -- Движение одно, встречное: в плюс, если насчитали больше учётного, в минус, если меньше.
  -- Прежние движения остаются как есть — исправлять их нельзя (0014).
  INSERT INTO public.stock_movements (
    idempotency_key, movement_type, lot_id, part_id, part_condition, quantity, on_hand_delta,
    performed_by, comment
  ) VALUES (
    'adjustment:' || gen_random_uuid()::text, 'adjustment', lot, p_part_id, p_condition,
    abs(difference), difference, public.current_app_user_id(),
    'Инвентаризация: было ' || trim_scale(on_hand) || ', стало ' || trim_scale(counted) || '. ' || reason
  );
  RETURN trim_scale(counted);
END
$$;

COMMENT ON FUNCTION public.adjust_stock(uuid, public.part_condition, numeric, text) IS
  'Корректировка остатка после инвентаризации (0049): кладовщик вводит фактическое количество, база проводит разницу встречным движением adjustment. Причина обязательна, ниже резерва опуститься нельзя. Возвращает остаток после корректировки.';

REVOKE ALL ON FUNCTION public.write_off_stock(uuid, public.part_condition, numeric, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.adjust_stock(uuid, public.part_condition, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.write_off_stock(uuid, public.part_condition, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.adjust_stock(uuid, public.part_condition, numeric, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
