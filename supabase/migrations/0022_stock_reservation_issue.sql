-- Склад: выдача резерва инженеру и возврат на склад одной операцией.
-- Статус резерва и складское движение меняются вместе: если записать только
-- статус, остаток на складе разойдётся с резервами. Функции выдачи и возврата
-- работают с правами вызывающего (SECURITY INVOKER): что можно, решают политики
-- склада (warehouse.write) и триггеры резерва, новых прав они не дают.
--
-- Ещё два исправления цепочки резерва:
-- 1. Статусы «выдано», «установлено», «возвращено» без движения по складу больше
--    не сохраняются (раньше их можно было поставить прямым запросом, и «доступно»
--    вырастало на количество резерва).
-- 2. В истории резерва автором шага записывается тот, кто его сделал (вход в CRM),
--    а не инженер или заказчик резерва. Триггер истории, как все служебные (0009),
--    работает от владельца схемы.

CREATE OR REPLACE FUNCTION public.issue_stock_reservation(p_reservation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  reservation public.stock_reservations%ROWTYPE;
  task_engineer uuid;
  task_equipment uuid;
  task_status text;
  lot uuid;
BEGIN
  IF NOT public.app_has_permission('warehouse.write') THEN
    RAISE EXCEPTION 'Выдавать запчасти может только склад' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO reservation FROM public.stock_reservations WHERE id = p_reservation_id FOR UPDATE;
  IF reservation.id IS NULL THEN
    RAISE EXCEPTION 'Резерв не найден' USING ERRCODE = 'P0002';
  END IF;
  IF reservation.status = 'created' THEN
    RAISE EXCEPTION 'Сначала отметьте, что запчасть собрана' USING ERRCODE = '23514';
  END IF;
  IF reservation.status <> 'warehouse_notified' THEN
    RAISE EXCEPTION 'Резерв уже выдан, снят или закрыт' USING ERRCODE = '23514';
  END IF;
  IF reservation.task_id IS NULL THEN
    RAISE EXCEPTION 'Резерв не привязан к задаче: выдавать некому' USING ERRCODE = '23514';
  END IF;
  -- Задачу кладовщик видит, пока по ней есть действующий резерв, поэтому читаем до смены статуса.
  SELECT t.engineer_id, t.equipment_id, t.status_code INTO task_engineer, task_equipment, task_status
    FROM public.tasks AS t WHERE t.id = reservation.task_id;
  IF task_status IN ('cancelled', 'closed') THEN
    RAISE EXCEPTION 'Задача закрыта или отменена: запчасть выдавать не нужно, снимите резерв' USING ERRCODE = '23514';
  END IF;
  IF task_engineer IS NULL THEN
    RAISE EXCEPTION 'В задаче не назначен инженер: выдавать некому' USING ERRCODE = '23514';
  END IF;
  -- Партия этой запчасти в этом состоянии, где сейчас больше всего штук.
  SELECT l.id INTO lot
    FROM public.stock_lots AS l
    LEFT JOIN public.stock_movements AS m ON m.lot_id = l.id
   WHERE l.part_id = reservation.part_id AND l.part_condition = reservation.part_condition
   GROUP BY l.id, l.lot_code
   ORDER BY coalesce(sum(m.on_hand_delta), 0) DESC, (l.lot_code = 'default') DESC, l.id
   LIMIT 1;
  IF lot IS NULL THEN
    RAISE EXCEPTION 'Этой запчасти нет на складе' USING ERRCODE = '23514';
  END IF;

  UPDATE public.stock_reservations
     SET status = 'issued', issued_to = task_engineer
   WHERE id = reservation.id;
  INSERT INTO public.stock_movements (
    idempotency_key, movement_type, lot_id, part_id, part_condition, quantity, on_hand_delta,
    reservation_id, task_id, equipment_id, performed_by, comment
  ) VALUES (
    'issue:' || reservation.id::text, 'issue', lot, reservation.part_id, reservation.part_condition,
    reservation.quantity, -reservation.quantity, reservation.id, reservation.task_id, task_equipment,
    auth.uid(), 'Выдано инженеру'
  );
END
$$;

CREATE OR REPLACE FUNCTION public.return_stock_reservation(p_reservation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  reservation public.stock_reservations%ROWTYPE;
  issue_lot uuid;
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
  -- Возвращаем в ту же партию, из которой выдали.
  SELECT m.lot_id INTO issue_lot
    FROM public.stock_movements AS m
   WHERE m.reservation_id = reservation.id AND m.movement_type = 'issue'
   ORDER BY m.occurred_at DESC
   LIMIT 1;
  IF issue_lot IS NULL THEN
    RAISE EXCEPTION 'Выдача этой запчасти не проведена по складу' USING ERRCODE = '23514';
  END IF;

  -- Сначала движение (возврат допустим, пока резерв выдан), потом статус.
  -- Прибор не пишем: запчасть вернулась на склад, а прибор в задаче могли сменить.
  INSERT INTO public.stock_movements (
    idempotency_key, movement_type, lot_id, part_id, part_condition, quantity, on_hand_delta,
    reservation_id, task_id, equipment_id, performed_by, comment
  ) VALUES (
    'return:' || reservation.id::text, 'return', issue_lot, reservation.part_id, reservation.part_condition,
    reservation.quantity, reservation.quantity, reservation.id, reservation.task_id, NULL,
    auth.uid(), 'Возврат на склад'
  );
  UPDATE public.stock_reservations SET status = 'returned' WHERE id = reservation.id;
END
$$;

REVOKE ALL ON FUNCTION public.issue_stock_reservation(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.return_stock_reservation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_stock_reservation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.return_stock_reservation(uuid) TO authenticated;

-- 1. Выдано, установлено, возвращено: только вместе с движением по складу.
-- Проверка в конце транзакции, поэтому порядок «статус, потом движение» в одной транзакции допустим.
-- Работает от владельца схемы, как остальные служебные триггеры (0009): иначе резерв и движения
-- читались бы с правами того, кто сохраняет, и при скрытой по правам строке проверка пропускалась бы.
CREATE OR REPLACE FUNCTION public.require_stock_reservation_movements()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_status public.reservation_status;
BEGIN
  -- Строку могли изменить ещё раз в той же транзакции: проверяем статус на момент проверки.
  SELECT status INTO current_status FROM public.stock_reservations WHERE id = NEW.id;
  IF current_status IN ('issued', 'installed', 'returned')
     AND NOT EXISTS (SELECT 1 FROM public.stock_movements WHERE reservation_id = NEW.id AND movement_type = 'issue') THEN
    RAISE EXCEPTION 'Выдачу запчасти отмечают кнопкой «Выдать инженеру»: так она спишется со склада'
      USING ERRCODE = '23514';
  END IF;
  IF current_status = 'returned'
     AND NOT EXISTS (SELECT 1 FROM public.stock_movements WHERE reservation_id = NEW.id AND movement_type = 'return') THEN
    RAISE EXCEPTION 'Возврат отмечают кнопкой «Вернули на склад»: так запчасть вернётся в остаток'
      USING ERRCODE = '23514';
  END IF;
  IF current_status = 'installed'
     AND NOT EXISTS (SELECT 1 FROM public.stock_movements WHERE reservation_id = NEW.id AND movement_type = 'install') THEN
    RAISE EXCEPTION 'Установку запчасти отмечают с привязкой к прибору задачи'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS stock_reservation_movements_required ON public.stock_reservations;
CREATE CONSTRAINT TRIGGER stock_reservation_movements_required
  AFTER INSERT OR UPDATE OF status ON public.stock_reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_stock_reservation_movements();

-- Вызывать её напрямую никому не нужно: только как триггер.
REVOKE EXECUTE ON FUNCTION public.require_stock_reservation_movements() FROM PUBLIC, anon, authenticated;

-- 2. История резерва: автор шага из входа в CRM. Без входа (служба, импорт), как раньше.
CREATE OR REPLACE FUNCTION public.record_stock_reservation_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.stock_reservation_history (reservation_id, from_status, to_status, changed_by)
    VALUES (NEW.id, NULL, NEW.status, coalesce(NEW.requested_by, auth.uid()));
  ELSIF NEW.status <> OLD.status THEN
    INSERT INTO public.stock_reservation_history (reservation_id, from_status, to_status, changed_by)
    VALUES (NEW.id, OLD.status, NEW.status, coalesce(auth.uid(), NEW.issued_to, NEW.requested_by));
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.record_stock_reservation_transition() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
