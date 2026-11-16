-- История движений по позиции склада: что с запчастью происходило, когда и кто это сделал.
--
-- Что было не так. Движения пишутся в stock_movements с самого начала (0001, 0022, 0028),
-- но посмотреть их было негде: склад показывал только итоговые остатки. Откуда взялись
-- восемь штук и куда ушли четыре, кладовщик выяснить не мог, а спорный остаток без
-- истории нечем проверить — остаётся поверить числу на экране.
--
-- Что делаем. Функция inventory_part_movements отдаёт историю одной позиции: приход,
-- выдача, установка, возврат, списание и корректировка — с датой, количеством, остатком
-- после движения, автором, причиной и ссылкой на задачу, резерв и прибор.
--
-- Почему функция, а не представление, и почему от владельца схемы. Кладовщику движение
-- видно (warehouse.read), а задачу он по политикам видит только пока по ней есть
-- действующий резерв (0014). Через представление с правами вызывающего номер задачи
-- в старых строках истории пропадал бы, и выдача выглядела бы движением в никуда.
-- Номер задачи и имя автора — подписи к движению, которое человеку и так показано,
-- поэтому функция работает от владельца схемы с явной проверкой права на склад внутри —
-- как set_task_parts_installed (0028) и сборка позиций счёта (0040).
--
-- Цену прихода (0040) история не показывает и не запрашивает: кладовщику и инженеру
-- она закрыта, а от владельца схемы колонка была бы доступна — поэтому её здесь нет.
-- Миграцию можно применить повторно.

CREATE OR REPLACE FUNCTION public.inventory_part_movements(
  p_part_id uuid,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  movement_type public.stock_movement_type,
  part_condition public.part_condition,
  quantity numeric,
  on_hand_delta numeric,
  on_hand_after numeric,
  occurred_at timestamptz,
  comment text,
  performed_by_name text,
  task_id uuid,
  task_number text,
  reservation_number text,
  equipment_serial_number text,
  lot_code text,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  rows_wanted integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  rows_skipped integer := greatest(coalesce(p_offset, 0), 0);
BEGIN
  IF NOT public.app_has_any_permission(ARRAY['warehouse.read', 'warehouse.write', 'tasks.read_all']) THEN
    RAISE EXCEPTION 'История движений по запчасти доступна только складу' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.parts AS p WHERE p.id = p_part_id) THEN
    RAISE EXCEPTION 'Запчасть не найдена в справочнике' USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
  WITH ordered AS (
    -- Остаток после движения считаем по состоянию: Г, Н и Б лежат на складе отдельно,
    -- и общая сумма по позиции рядом со строкой «2 шт. · гарантийная» только путала бы.
    SELECT
      m.id,
      m.movement_type,
      m.part_condition,
      m.quantity,
      m.on_hand_delta,
      sum(m.on_hand_delta) OVER (
        PARTITION BY m.part_condition ORDER BY m.occurred_at, m.id
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS on_hand_after,
      m.occurred_at,
      m.comment,
      m.performed_by,
      m.task_id,
      m.reservation_id,
      m.equipment_id,
      m.lot_id
    FROM public.stock_movements AS m
    WHERE m.part_id = p_part_id
  )
  SELECT
    o.id,
    o.movement_type,
    o.part_condition,
    trim_scale(o.quantity),
    trim_scale(o.on_hand_delta),
    trim_scale(o.on_hand_after),
    o.occurred_at,
    o.comment,
    performer.full_name,
    o.task_id,
    task.number,
    reservation.number,
    device.serial_number,
    -- Партия по умолчанию одна на позицию и состояние: её код в истории не нужен.
    nullif(lot.lot_code, 'default'),
    count(*) OVER () AS total_count
  FROM ordered AS o
  LEFT JOIN public.users AS performer ON performer.id = o.performed_by
  LEFT JOIN public.tasks AS task ON task.id = o.task_id
  LEFT JOIN public.stock_reservations AS reservation ON reservation.id = o.reservation_id
  LEFT JOIN public.equipment AS device ON device.id = o.equipment_id
  LEFT JOIN public.stock_lots AS lot ON lot.id = o.lot_id
  -- Сначала свежее; при совпадении времени (приход партией одной командой) порядок
  -- задан целиком, иначе страницы истории перекрывались бы.
  ORDER BY o.occurred_at DESC, o.id DESC
  LIMIT rows_wanted OFFSET rows_skipped;
END
$$;

COMMENT ON FUNCTION public.inventory_part_movements(uuid, integer, integer) IS
  'История движений по позиции склада (0048): приход, выдача, установка, возврат, списание и корректировка с датой, автором, причиной, остатком после движения и ссылками на задачу, резерв и прибор. От владельца схемы с проверкой права на склад внутри: номер задачи остаётся виден и после её закрытия. Цену прихода не отдаёт.';

REVOKE ALL ON FUNCTION public.inventory_part_movements(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_part_movements(uuid, integer, integer) TO authenticated;

NOTIFY pgrst, 'reload schema';
