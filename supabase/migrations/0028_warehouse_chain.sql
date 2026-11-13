-- Цепочка резерва склада до конца: заказ запчасти под задачу, отметка инженера
-- «установил» и проведение установки при закрытии задачи.
--
-- Что было не так. Резерв создавали прямым INSERT из интерфейса: нехватку на складе
-- ловила только отложенная assert_stock_capacity — в конце транзакции и сообщением
-- с id-шниками вместо человеческого текста, а почему отказ, пользователь не понимал.
-- Установку запчасти в прибор не проводил никто: движение install не появлялось,
-- резерв навсегда оставался «выдан», а в истории прибора замены не было.
-- Отмена задачи тоже не освобождала склад: количество висело в резерве.
--
-- Что делаем.
--   1. create_task_part_reservation — заказ запчасти под задачу с понятными отказами.
--   2. set_task_parts_installed — инженер отмечает, что из выданного он поставил.
--   3. При закрытии задачи отмеченное проводится по складу (install) и резерв
--      становится «установлено»; неотмеченное остаётся «выдано» — висит на инженере,
--      пока кладовщик не примет возврат.
--   4. При отмене задачи неотданные резервы (создан, собран) снимаются.
--
-- Обе RPC работают с правами вызывающего (SECURITY INVOKER): что можно, решают
-- политики склада и задач, новых прав функции не дают. Триггеры, как все служебные
-- (0009), работают от владельца схемы и напрямую никому не доступны.

-- ---------------------------------------------------------------------------
-- 1. Заказ запчасти под задачу
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_task_part_reservation(
  p_task_id uuid,
  p_part_id uuid,
  p_condition public.part_condition,
  p_quantity numeric
)
RETURNS TABLE (id uuid, number text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  part_row public.parts%ROWTYPE;
  created public.stock_reservations%ROWTYPE;
  wanted numeric(14, 3);
  available numeric(14, 3);
BEGIN
  IF NOT public.app_has_permission('warehouse.write') THEN
    RAISE EXCEPTION 'Заказать запчасть со склада может только склад или координатор'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO part_row FROM public.parts AS p WHERE p.id = p_part_id;
  IF part_row.id IS NULL THEN
    RAISE EXCEPTION 'Запчасть не найдена в справочнике' USING ERRCODE = '23514';
  END IF;
  IF NOT part_row.is_active THEN
    RAISE EXCEPTION 'Запчасть снята с учёта: резерв по ней создать нельзя' USING ERRCODE = '23514';
  END IF;

  -- Количество храним с тремя знаками: округляем здесь, иначе 0.0001 превратится
  -- в ноль уже в таблице и вместо понятного отказа будет ошибка ограничения.
  wanted := round(coalesce(p_quantity, 0), 3);
  IF wanted <= 0 THEN
    RAISE EXCEPTION 'Количество в резерве должно быть больше нуля' USING ERRCODE = '23514';
  END IF;

  -- Задачу берём через app_task_accepts_reservations: функция работает от владельца
  -- схемы и видит задачу даже до того, как кладовщику её откроет первый резерв.
  -- Несуществующая задача попадает сюда же — заказывать по ней нечего.
  IF NOT public.app_task_accepts_reservations(p_task_id) THEN
    RAISE EXCEPTION 'Резерв можно создать только для задачи, которая ещё в работе'
      USING ERRCODE = '23514';
  END IF;

  -- Тот же замок, что у assert_stock_capacity: два параллельных заказа не должны
  -- пройти проверку остатка одновременно и увести склад в минус.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_part_id::text || ':' || p_condition::text, 0));
  -- Доступно считаем как в stock_balances: что физически на складе минус активные резервы.
  SELECT coalesce((
           SELECT sum(m.on_hand_delta) FROM public.stock_movements AS m
            WHERE m.part_id = p_part_id AND m.part_condition = p_condition
         ), 0)
       - coalesce((
           SELECT sum(r.quantity) FROM public.stock_reservations AS r
            WHERE r.part_id = p_part_id AND r.part_condition = p_condition
              AND r.status IN ('created', 'warehouse_notified')
         ), 0)
    INTO available;
  IF available < wanted THEN
    RAISE EXCEPTION 'На складе доступно % шт. этой запчасти в состоянии %, а нужно %',
      trim_scale(available),
      CASE p_condition WHEN 'G' THEN 'Г' WHEN 'N' THEN 'Н' ELSE 'Б' END,
      trim_scale(wanted)
      USING ERRCODE = '23514';
  END IF;

  -- Заказчик резерва — вошедший сотрудник: по нему уведомление склада и история.
  INSERT INTO public.stock_reservations (part_id, part_condition, quantity, task_id, requested_by)
  VALUES (p_part_id, p_condition, wanted, p_task_id, public.current_app_user_id())
  RETURNING * INTO created;

  RETURN QUERY SELECT created.id, created.number;
END
$$;

COMMENT ON FUNCTION public.create_task_part_reservation(uuid, uuid, public.part_condition, numeric) IS
  'Заказ запчасти под задачу (0028): проверяет право склада, запчасть, количество, этап задачи и доступный остаток, отказы по-русски. Работает с правами вызывающего, событие складу ставит существующий триггер.';

-- ---------------------------------------------------------------------------
-- 2. Инженер отмечает, что из выданного установлено
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_task_parts_installed(
  p_task_id uuid,
  p_reservation_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  marked uuid[] := coalesce(p_reservation_ids, ARRAY[]::uuid[]);
  task_equipment uuid;
  task_found boolean;
  wrong_id uuid;
  reservation record;
  next_position integer;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NOT (public.app_is_task_engineer(p_task_id) OR public.app_has_permission('tasks.write')) THEN
      RAISE EXCEPTION 'Отметить установку может инженер задачи или координатор'
        USING ERRCODE = '42501';
    END IF;
    IF NOT public.app_can_write_task(p_task_id) THEN
      RAISE EXCEPTION 'Задача сдана, закрыта или отменена: отметки об установке больше не меняются'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT t.equipment_id, true INTO task_equipment, task_found
    FROM public.tasks AS t WHERE t.id = p_task_id;
  IF NOT coalesce(task_found, false) THEN
    RAISE EXCEPTION 'Задача не найдена' USING ERRCODE = '23514';
  END IF;
  -- Установка пишется в историю прибора: без прибора её некуда записать.
  IF task_equipment IS NULL THEN
    RAISE EXCEPTION 'Чтобы отметить установку, у задачи должен быть прибор' USING ERRCODE = '23514';
  END IF;

  -- Отмечать можно только то, что выдано инженеру по этой же задаче.
  SELECT given.id INTO wrong_id
    FROM unnest(marked) AS given(id)
   WHERE NOT EXISTS (
           SELECT 1 FROM public.stock_reservations AS r
            WHERE r.id = given.id AND r.task_id = p_task_id AND r.status = 'issued'
         )
   LIMIT 1;
  IF wrong_id IS NOT NULL THEN
    RAISE EXCEPTION 'Запчасть не выдана инженеру по этой задаче: отметить установку нельзя'
      USING ERRCODE = '23514';
  END IF;

  FOR reservation IN
    SELECT r.id, r.part_id, r.part_condition, r.quantity
      FROM public.stock_reservations AS r
     WHERE r.task_id = p_task_id AND r.status = 'issued'
     ORDER BY r.created_at, r.id
  LOOP
    IF reservation.id = ANY (marked) THEN
      SELECT coalesce(max(tp.position) + 1, 0) INTO next_position
        FROM public.task_parts AS tp WHERE tp.task_id = p_task_id;
      -- Такая запчасть в этом состоянии уже может быть в списке позиций задачи:
      -- тогда привязываем её к резерву, а не заводим вторую строку.
      INSERT INTO public.task_parts (
        task_id, part_id, reservation_id, part_condition,
        article_number_snapshot, name_snapshot, quantity, installed, position
      )
      SELECT p_task_id, p.id, reservation.id, reservation.part_condition,
             p.article_number, p.name, reservation.quantity, true, next_position
        FROM public.parts AS p
       WHERE p.id = reservation.part_id
      ON CONFLICT (task_id, part_id, part_condition) DO UPDATE
        SET reservation_id = excluded.reservation_id,
            installed = true,
            quantity = excluded.quantity;
    ELSE
      -- Сняли отметку: строка и связь с резервом остаются, установки нет.
      UPDATE public.task_parts AS tp
         SET installed = false
       WHERE tp.task_id = p_task_id AND tp.reservation_id = reservation.id AND tp.installed;
    END IF;
  END LOOP;
END
$$;

COMMENT ON FUNCTION public.set_task_parts_installed(uuid, uuid[]) IS
  'Отметка инженера «эти выданные запчасти установлены» (0028): создаёт или обновляет позиции задачи по выданным резервам. По складу ничего не проводит — установка проводится при закрытии задачи.';

-- ---------------------------------------------------------------------------
-- 3. Закрытие задачи: проводим установку отмеченных запчастей
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.install_task_parts_on_task_close()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  installed_part record;
  issue_lot uuid;
BEGIN
  -- Без прибора установку записывать некуда: закрытию задачи это не мешает.
  IF NEW.equipment_id IS NULL THEN
    RETURN NULL;
  END IF;

  FOR installed_part IN
    SELECT r.id AS reservation_id, r.part_id, r.part_condition, r.quantity, r.issued_to
      FROM public.task_parts AS tp
      JOIN public.stock_reservations AS r ON r.id = tp.reservation_id
     WHERE tp.task_id = NEW.id AND tp.installed AND r.status = 'issued'
     ORDER BY tp.position, tp.id
  LOOP
    -- Ставим в прибор ту же партию, из которой выдали.
    SELECT m.lot_id INTO issue_lot
      FROM public.stock_movements AS m
     WHERE m.reservation_id = installed_part.reservation_id AND m.movement_type = 'issue'
     ORDER BY m.occurred_at DESC
     LIMIT 1;
    -- Выдача без движения по складу невозможна (0022), но если такая строка
    -- всё же нашлась — закрытие задачи из-за неё не останавливаем, резерв
    -- остаётся выданным и его разберёт склад.
    IF issue_lot IS NULL THEN
      CONTINUE;
    END IF;

    INSERT INTO public.stock_movements (
      idempotency_key, movement_type, lot_id, part_id, part_condition, quantity, on_hand_delta,
      reservation_id, task_id, equipment_id, performed_by, occurred_at, comment
    ) VALUES (
      'install:' || installed_part.reservation_id::text, 'install', issue_lot,
      installed_part.part_id, installed_part.part_condition, installed_part.quantity, 0,
      installed_part.reservation_id, NEW.id, NEW.equipment_id, installed_part.issued_to,
      coalesce(NEW.work_finished_at, now()), 'Установлено в прибор'
    )
    ON CONFLICT (idempotency_key) DO NOTHING;

    UPDATE public.stock_reservations
       SET status = 'installed'
     WHERE id = installed_part.reservation_id AND status = 'issued';
  END LOOP;
  RETURN NULL;
END
$$;

-- Вызывать её напрямую никому не нужно: только как триггер.
REVOKE EXECUTE ON FUNCTION public.install_task_parts_on_task_close() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.install_task_parts_on_task_close() IS
  'Закрытие задачи (0028): отмеченные инженером выданные запчасти проводятся по складу движением install с прибором задачи, резерв становится «установлено». Неотмеченные остаются выданными — висят на инженере до возврата.';

DROP TRIGGER IF EXISTS tasks_install_reserved_parts ON public.tasks;
CREATE TRIGGER tasks_install_reserved_parts
  AFTER UPDATE OF status_code ON public.tasks
  FOR EACH ROW
  WHEN (NEW.status_code = 'closed' AND OLD.status_code IS DISTINCT FROM 'closed')
  EXECUTE FUNCTION public.install_task_parts_on_task_close();

-- История резерва: шаг «установлено» делает инженер, которому запчасть выдали,
-- даже если задачу закрыл координатор. Остальные шаги — как раньше, по входу в CRM.
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
    VALUES (NEW.id, OLD.status, NEW.status,
      CASE WHEN NEW.status = 'installed'
           THEN coalesce(NEW.issued_to, auth.uid(), NEW.requested_by)
           ELSE coalesce(auth.uid(), NEW.issued_to, NEW.requested_by)
      END);
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.record_stock_reservation_transition() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Отмена задачи: освобождаем склад
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.release_task_reservations_on_task_cancel()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Заказанное и собранное снимаем: запчасть снова доступна другим задачам.
  -- Выданное не трогаем — оно физически у инженера, его принимает склад.
  UPDATE public.stock_reservations
     SET status = 'cancelled'
   WHERE task_id = NEW.id AND status IN ('created', 'warehouse_notified');
  RETURN NULL;
END
$$;

REVOKE EXECUTE ON FUNCTION public.release_task_reservations_on_task_cancel() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.release_task_reservations_on_task_cancel() IS
  'Отмена задачи (0028): резервы в статусах «создан» и «собран» снимаются, склад освобождается. Выданное остаётся на инженере до возврата.';

DROP TRIGGER IF EXISTS tasks_release_reservations ON public.tasks;
CREATE TRIGGER tasks_release_reservations
  AFTER UPDATE OF status_code ON public.tasks
  FOR EACH ROW
  WHEN (NEW.status_code = 'cancelled' AND OLD.status_code IS DISTINCT FROM 'cancelled')
  EXECUTE FUNCTION public.release_task_reservations_on_task_cancel();

-- ---------------------------------------------------------------------------
-- 5. Права на RPC: без входа недоступны, вошедшему сотруднику — да.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.create_task_part_reservation(uuid, uuid, public.part_condition, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_task_parts_installed(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_task_part_reservation(uuid, uuid, public.part_condition, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_task_parts_installed(uuid, uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
