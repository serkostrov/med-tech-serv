-- Возврат части выданной запчасти (аудит 17.11.2026, находка 94).
--
-- Что было не так. «Вернули на склад» возвращал резерв целиком. Инженеру выдали два
-- фильтра, один он поставил, второй вернул — провести это было нельзя: либо вернуть оба,
-- либо держать лишний фильтр на инженере.
--
-- Что делаем.
--   1. return_stock_reservation принимает количество. Всё выданное — как раньше: резерв
--      «Возвращена». Часть — резерв остаётся выданным с меньшим количеством, а на склад
--      проводится возврат этой части (движение return, оно же строка документа ВЗ-, 0062).
--   2. Страж резерва (0028) пропускает уменьшение количества выданного резерва, только
--      когда его делает сама цепочка склада (флаг app.warehouse_chain).
--   3. Если запчасть уже отмечена «установлено», строка в карточке задачи пересчитывается
--      по оставшемуся количеству — тем же триггером, что при полном возврате (0028).
-- Миграцию можно применить повторно.

CREATE OR REPLACE FUNCTION public.guard_reservation_task()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  -- (0066) Возврат части выданного уменьшает количество резерва: это делает только
  -- сама цепочка склада (return_stock_reservation с флагом app.warehouse_chain).
  IF auth.uid() IS NOT NULL
     AND OLD.status NOT IN ('created', 'warehouse_notified')
     AND NOT (coalesce(current_setting('app.warehouse_chain', true), 'off') = 'on'
              AND OLD.status = 'issued' AND NEW.status = 'issued'
              AND NEW.quantity < OLD.quantity AND NEW.quantity > 0
              AND NEW.part_id IS NOT DISTINCT FROM OLD.part_id
              AND NEW.part_condition IS NOT DISTINCT FROM OLD.part_condition)
     AND (NEW.quantity IS DISTINCT FROM OLD.quantity
          OR NEW.part_id IS DISTINCT FROM OLD.part_id
          OR NEW.part_condition IS DISTINCT FROM OLD.part_condition) THEN
    RAISE EXCEPTION 'После выдачи или отмены нельзя менять запчасть и количество резерва'
      USING ERRCODE = '42501';
  END IF;
  IF auth.uid() IS NOT NULL
     AND NEW.task_id IS NOT NULL
     AND NEW.task_id IS DISTINCT FROM OLD.task_id
     AND NOT public.app_task_accepts_reservations(NEW.task_id) THEN
    RAISE EXCEPTION 'Резерв можно привязать только к задаче в работе'
      USING ERRCODE = '42501';
  END IF;
  -- (0028) Отметку «установлено» ставит инженер в задаче через set_task_parts_installed.
  -- Прямой PATCH закрыт: иначе склад проставил бы отметку сам, и при закрытии задачи
  -- запчасть списалась бы на прибор без инженера. Флаг app.warehouse_chain ставит сама
  -- цепочка склада (её функции), снаружи его не задать. Снятие отметки вместе с уходом
  -- из «выдано» (возврат, снятие резерва) разрешено: это делает триггер цепочки.
  IF auth.uid() IS NOT NULL
     AND NEW.install_marked IS DISTINCT FROM OLD.install_marked
     AND coalesce(current_setting('app.warehouse_chain', true), 'off') <> 'on'
     AND NOT (NOT NEW.install_marked AND OLD.status = 'issued' AND NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION 'Отметку об установке ставит инженер в задаче, а не склад'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

-- Старую функцию с одним аргументом убираем: с двумя одноимёнными API не понял бы,
-- какую из них вызывать без количества.
DROP FUNCTION IF EXISTS public.return_stock_reservation(uuid);

CREATE OR REPLACE FUNCTION public.return_stock_reservation(
  p_reservation_id uuid,
  p_quantity numeric DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  reservation public.stock_reservations%ROWTYPE;
  issue_lot uuid;
  amount numeric(14, 3);
  outer_flag text := coalesce(current_setting('app.warehouse_chain', true), 'off');
BEGIN
  IF NOT public.app_has_permission('warehouse.write') THEN
    RAISE EXCEPTION 'Принимать запчасти на склад может только склад' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO reservation FROM public.stock_reservations WHERE id = p_reservation_id FOR UPDATE;
  IF reservation.id IS NULL THEN
    RAISE EXCEPTION 'Резерв не найден' USING ERRCODE = 'P0002';
  END IF;
  IF reservation.status <> 'issued' THEN
    RAISE EXCEPTION 'Вернуть на склад можно только выданную запчасть' USING ERRCODE = '23514';
  END IF;
  amount := round(coalesce(p_quantity, reservation.quantity), 3);
  IF amount <= 0 THEN
    RAISE EXCEPTION 'Укажите, сколько вернули: больше нуля' USING ERRCODE = '23514';
  END IF;
  IF amount > reservation.quantity THEN
    RAISE EXCEPTION 'Выдано %: вернуть больше нельзя', trim_scale(reservation.quantity) USING ERRCODE = '23514';
  END IF;
  SELECT m.lot_id INTO issue_lot
    FROM public.stock_movements AS m
   WHERE m.reservation_id = reservation.id AND m.movement_type = 'issue'
   ORDER BY m.occurred_at DESC
   LIMIT 1;
  IF issue_lot IS NULL THEN
    RAISE EXCEPTION 'Выдача этой запчасти не проведена по складу' USING ERRCODE = '23514';
  END IF;

  IF amount = reservation.quantity THEN
    INSERT INTO public.stock_movements (
      idempotency_key, movement_type, lot_id, part_id, part_condition, quantity, on_hand_delta,
      reservation_id, task_id, equipment_id, performed_by, comment
    ) VALUES (
      'return:' || reservation.id::text, 'return', issue_lot, reservation.part_id, reservation.part_condition,
      reservation.quantity, reservation.quantity, reservation.id, reservation.task_id, NULL,
      auth.uid(), 'Возврат на склад'
    );
    UPDATE public.stock_reservations SET status = 'returned' WHERE id = reservation.id;
    RETURN;
  END IF;

  -- Часть: остаток резерва остаётся у инженера, на склад приходит только возвращённое.
  INSERT INTO public.stock_movements (
    idempotency_key, movement_type, lot_id, part_id, part_condition, quantity, on_hand_delta,
    reservation_id, task_id, equipment_id, performed_by, comment
  ) VALUES (
    'return:' || reservation.id::text || ':' || gen_random_uuid()::text, 'return', issue_lot,
    reservation.part_id, reservation.part_condition, amount, amount, reservation.id, reservation.task_id, NULL,
    auth.uid(), format('Возврат на склад: %s из %s', trim_scale(amount), trim_scale(reservation.quantity))
  );
  PERFORM set_config('app.warehouse_chain', 'on', true);
  UPDATE public.stock_reservations SET quantity = reservation.quantity - amount WHERE id = reservation.id;
  PERFORM set_config('app.warehouse_chain', outer_flag, true);
END
$$;

REVOKE ALL ON FUNCTION public.return_stock_reservation(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.return_stock_reservation(uuid, numeric) TO authenticated;
COMMENT ON FUNCTION public.return_stock_reservation(uuid, numeric) IS
  'Возврат выданной запчасти на склад (0022, 0066): всё выданное — резерв «Возвращена»; часть — резерв остаётся у инженера с меньшим количеством, на склад проводится возврат этой части.';

-- Отмеченная «установлено» запчасть: после возврата части строка в задаче показывает остаток.
DROP TRIGGER IF EXISTS stock_reservations_refresh_task_part_quantity ON public.stock_reservations;
CREATE TRIGGER stock_reservations_refresh_task_part_quantity
  AFTER UPDATE OF quantity ON public.stock_reservations
  FOR EACH ROW
  WHEN (OLD.status = 'issued' AND NEW.status = 'issued' AND NEW.quantity < OLD.quantity AND NEW.install_marked)
  EXECUTE FUNCTION public.refresh_task_part_after_reservation_release();

NOTIFY pgrst, 'reload schema';
