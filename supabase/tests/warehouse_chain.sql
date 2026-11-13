-- Цепочка резерва склада: заказ запчасти, выдача, отметка установки, закрытие
-- задачи и отмена задачи (миграция 0028). Подготовка данных та же, что в
-- role_access.sql. Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/warehouse_chain.sql
-- Всё выполняется в транзакции и откатывается. Ошибка = проверка не прошла.


BEGIN;

-- Служебные функции теста
CREATE FUNCTION pg_temp.act_as(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE FUNCTION pg_temp.check(p_ok boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'ПРОВАЛ: %', p_label;
  END IF;
  RAISE NOTICE 'ok: %', p_label;
END $$;

-- Ожидаем ошибку прав при выполнении команды
CREATE FUNCTION pg_temp.expect_denied(p_sql text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN insufficient_privilege OR check_violation OR raise_exception THEN
    RAISE NOTICE 'ok: % (запрещено)', p_label;
    RETURN;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — команда прошла, а должна быть запрещена', p_label;
END $$;

-- Ожидаем именно отказ по правам (а не другую проверку данных)
CREATE FUNCTION pg_temp.expect_forbidden(p_sql text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'ok: % (нет прав)', p_label;
    RETURN;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — команда прошла, а должна быть запрещена', p_label;
END $$;

-- Ожидаем отказ с конкретным текстом: интерфейс показывает его пользователю дословно
CREATE FUNCTION pg_temp.expect_message(p_sql text, p_message text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE got text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    got := SQLERRM;
    IF got <> p_message THEN
      RAISE EXCEPTION 'ПРОВАЛ: % — сообщение «%», ожидалось «%»', p_label, got, p_message;
    END IF;
    RAISE NOTICE 'ok: % («%»)', p_label, got;
    RETURN;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — команда прошла, а должна быть запрещена', p_label;
END $$;

-- Сколько строк изменила команда
CREATE FUNCTION pg_temp.rows_affected(p_sql text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.check(boolean, text),
  pg_temp.expect_denied(text, text), pg_temp.expect_forbidden(text, text),
  pg_temp.expect_message(text, text, text), pg_temp.rows_affected(text) TO authenticated, anon;

-- Данные (от владельца, RLS не действует)
CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid);
GRANT SELECT, INSERT ON ids TO authenticated;

-- В тесте нужна задача без прибора. Новую такую не создать, но исторические строки
-- есть — ограничение tasks_core_relations_required потому и NOT VALID (0001).
-- Снимаем его на время подготовки данных и сразу возвращаем как было.
ALTER TABLE tasks DROP CONSTRAINT tasks_core_relations_required;

DO $$
DECLARE
  roles text[] := ARRAY['coordinator', 'engineer', 'engineer2', 'warehouse', 'supervisor', 'admin', 'initiator', 'inactive', 'customer', 'customer2'];
  r text; uid uuid; base text;
  org uuid; site uuid; payer uuid; manuf uuid; model uuid; eq uuid; wt text;
  t1 uuid; t2 uuid; t3 uuid; t4 uuid;
  part_a uuid; part_b uuid; part_c uuid; part_d uuid; part_off uuid;
  lot_a uuid; lot_b uuid; lot_c uuid; lot_d uuid;
BEGIN
  FOREACH r IN ARRAY roles LOOP
    uid := gen_random_uuid();
    base := CASE r WHEN 'engineer2' THEN 'engineer' WHEN 'inactive' THEN 'coordinator' WHEN 'customer2' THEN 'customer' ELSE r END;
    INSERT INTO auth.users (id, email, aud, role) VALUES (uid, r || '@test.local', 'authenticated', 'authenticated');
    INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
    VALUES (uid, 'Тест ' || r, base::user_role, r || '@test.local', r <> 'inactive', base);
    INSERT INTO ids VALUES (r, uid);
  END LOOP;

  INSERT INTO organizations (name) VALUES ('Тестовая больница') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('Тестовая площадка', org) RETURNING id INTO site;
  INSERT INTO payers (name) VALUES ('Тестовый плательщик') RETURNING id INTO payer;
  INSERT INTO manufacturers (name) VALUES ('Тест-Производитель') RETURNING id INTO manuf;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (manuf, 'Модель-1') RETURNING id INTO model;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  VALUES ('SN-TEST-1', manuf, model, site, payer) RETURNING id INTO eq;
  SELECT code INTO wt FROM work_types WHERE is_active ORDER BY code LIMIT 1;

  -- Задача инженера с прибором: по ней идёт вся цепочка.
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by,
    deadline_from, deadline_to, status_code, visit_date, call_reason, work_description, work_finished_at)
  VALUES ('Ремонт дозатора', wt, eq, site, payer, (SELECT id FROM ids WHERE k = 'engineer'), (SELECT id FROM ids WHERE k = 'coordinator'),
    current_date, current_date + 7, 'in_progress', current_date, 'Не включается', 'Заменён клапан', '2026-11-13 12:30:00+03')
  RETURNING id INTO t1;
  -- Задача другого инженера.
  -- Задача другого инженера: по ней проверяем время установки без времени окончания работ.
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by,
    deadline_from, deadline_to, status_code, visit_date, call_reason, work_description)
  VALUES ('Задача другого инженера', wt, eq, site, payer, (SELECT id FROM ids WHERE k = 'engineer2'), (SELECT id FROM ids WHERE k = 'coordinator'),
    current_date, current_date + 7, 'in_progress', current_date, 'Шумит', 'Заменён датчик')
  RETURNING id INTO t2;
  -- Историческая задача без прибора.
  INSERT INTO tasks (title, work_type_code, site_id, payer_id, engineer_id, created_by,
    deadline_from, deadline_to, status_code)
  VALUES ('Задача без прибора', wt, site, payer, (SELECT id FROM ids WHERE k = 'engineer'), (SELECT id FROM ids WHERE k = 'coordinator'),
    current_date, current_date + 7, 'in_progress')
  RETURNING id INTO t3;
  -- Задача, которую отменят.
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by,
    deadline_from, deadline_to, status_code)
  VALUES ('Задача под отмену', wt, eq, site, payer, (SELECT id FROM ids WHERE k = 'engineer'), (SELECT id FROM ids WHERE k = 'coordinator'),
    current_date, current_date + 7, 'in_progress')
  RETURNING id INTO t4;
  INSERT INTO parts (article_number, name) VALUES ('ART-A', 'Клапан тест') RETURNING id INTO part_a;
  INSERT INTO parts (article_number, name) VALUES ('ART-B', 'Датчик тест') RETURNING id INTO part_b;
  INSERT INTO parts (article_number, name) VALUES ('ART-C', 'Шприц тест') RETURNING id INTO part_c;
  INSERT INTO parts (article_number, name) VALUES ('ART-D', 'Фильтр тест') RETURNING id INTO part_d;
  INSERT INTO parts (article_number, name, is_active) VALUES ('ART-OFF', 'Снятая с учёта', false) RETURNING id INTO part_off;

  INSERT INTO stock_lots (part_id, part_condition) VALUES (part_a, 'N') RETURNING id INTO lot_a;
  INSERT INTO stock_lots (part_id, part_condition) VALUES (part_b, 'N') RETURNING id INTO lot_b;
  INSERT INTO stock_lots (part_id, part_condition) VALUES (part_c, 'N') RETURNING id INTO lot_c;
  INSERT INTO stock_lots (part_id, part_condition) VALUES (part_d, 'N') RETURNING id INTO lot_d;
  INSERT INTO stock_movements (idempotency_key, movement_type, lot_id, part_id, part_condition, quantity, on_hand_delta)
  VALUES ('receipt:a', 'receipt', lot_a, part_a, 'N', 10, 10),
         ('receipt:b', 'receipt', lot_b, part_b, 'N', 10, 10),
         ('receipt:c', 'receipt', lot_c, part_c, 'N', 1, 1),
         ('receipt:d', 'receipt', lot_d, part_d, 'N', 10, 10);

  INSERT INTO ids VALUES ('t1', t1), ('t2', t2), ('t3', t3), ('t4', t4),
    ('part_a', part_a), ('part_b', part_b), ('part_c', part_c), ('part_d', part_d), ('part_off', part_off),
    ('equipment', eq), ('site', site), ('payer', payer);
END $$;

-- Отложенные события подготовки проведены — возвращаем ограничение как в 0001.
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
ALTER TABLE tasks ADD CONSTRAINT tasks_core_relations_required CHECK (
  equipment_id IS NOT NULL AND site_id IS NOT NULL AND payer_id IS NOT NULL
) NOT VALID;

-- Создание резерва через RPC с запоминанием id
CREATE FUNCTION pg_temp.make_reservation(p_key text, p_task uuid, p_part uuid, p_condition part_condition, p_quantity numeric)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE new_id uuid;
BEGIN
  SELECT created.id INTO new_id FROM public.create_task_part_reservation(p_task, p_part, p_condition, p_quantity) AS created;
  INSERT INTO ids VALUES (p_key, new_id);
  RETURN new_id;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.make_reservation(text, uuid, uuid, part_condition, numeric) TO authenticated;

-- ---------------------------------------------------------------- Права на RPC
SELECT pg_temp.check(has_function_privilege('authenticated', 'public.create_task_part_reservation(uuid, uuid, public.part_condition, numeric)', 'EXECUTE'),
  'заказ запчасти доступен вошедшему сотруднику');
SELECT pg_temp.check(NOT has_function_privilege('anon', 'public.create_task_part_reservation(uuid, uuid, public.part_condition, numeric)', 'EXECUTE'),
  'без входа заказ запчасти не вызвать');
SELECT pg_temp.check(has_function_privilege('authenticated', 'public.set_task_parts_installed(uuid, uuid[])', 'EXECUTE'),
  'отметка установки доступна вошедшему сотруднику');
SELECT pg_temp.check(NOT has_function_privilege('anon', 'public.set_task_parts_installed(uuid, uuid[])', 'EXECUTE'),
  'без входа отметку установки не вызвать');
SELECT pg_temp.check(NOT has_function_privilege('authenticated', 'public.install_task_parts_on_task_close()', 'EXECUTE'),
  'проведение установки напрямую не вызвать');
SELECT pg_temp.check(NOT has_function_privilege('authenticated', 'public.release_task_reservations_on_task_finish()', 'EXECUTE'),
  'снятие резервов при закрытии и отмене напрямую не вызвать');
SELECT pg_temp.check((SELECT prosecdef FROM pg_proc WHERE proname = 'install_task_parts_on_task_close'),
  'проведение установки работает от владельца схемы');
SELECT pg_temp.check((SELECT prosecdef FROM pg_proc WHERE proname = 'release_task_reservations_on_task_finish'),
  'снятие резервов при закрытии и отмене работает от владельца схемы');
SELECT pg_temp.check(NOT (SELECT prosecdef FROM pg_proc WHERE proname = 'create_task_part_reservation'),
  'заказ запчасти работает с правами вызывающего');
SELECT pg_temp.check((SELECT prosecdef FROM pg_proc WHERE proname = 'set_task_parts_installed'),
  'отметка установки работает от владельца схемы: в резервы инженеру писать нельзя');
SELECT pg_temp.check(NOT has_function_privilege('anon', 'public.release_task_reservations_on_task_finish()', 'EXECUTE')
                 AND NOT has_function_privilege('anon', 'public.install_task_parts_on_task_close()', 'EXECUTE'),
  'без входа триггерные функции цепочки недоступны');

-- ---------------------------------------------------------------- Заказ запчасти
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'coordinator'));
SELECT pg_temp.check(pg_temp.make_reservation('res_a', (SELECT id FROM ids WHERE k = 't1'), (SELECT id FROM ids WHERE k = 'part_a'), 'N', 2) IS NOT NULL,
  'координатор заказывает запчасть под задачу в работе');
SELECT pg_temp.check(pg_temp.make_reservation('res_b', (SELECT id FROM ids WHERE k = 't1'), (SELECT id FROM ids WHERE k = 'part_b'), 'N', 1) IS NOT NULL,
  'вторая запчасть под ту же задачу');
-- Второй резерв той же запчасти в том же состоянии: нормальный случай (два одинаковых
-- предохранителя), строка позиции в карточке на них будет одна.
SELECT pg_temp.check(pg_temp.make_reservation('res_a2', (SELECT id FROM ids WHERE k = 't1'), (SELECT id FROM ids WHERE k = 'part_a'), 'N', 3) IS NOT NULL,
  'второй резерв той же запчасти в том же состоянии под ту же задачу');
SELECT pg_temp.check(pg_temp.make_reservation('res_d', (SELECT id FROM ids WHERE k = 't1'), (SELECT id FROM ids WHERE k = 'part_d'), 'N', 1) IS NOT NULL,
  'запчасть, по которой в карточке уже есть ручная позиция «для продажи»');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);

SELECT pg_temp.check((SELECT r.status = 'created' AND r.quantity = 2 AND r.part_condition = 'N'
                        AND r.task_id = (SELECT id FROM ids WHERE k = 't1')
                        AND r.requested_by = (SELECT id FROM ids WHERE k = 'coordinator')
                        AND r.number LIKE 'Р-%'
                      FROM stock_reservations r WHERE r.id = (SELECT id FROM ids WHERE k = 'res_a')),
  'резерв создан на задачу, количество и заказчик записаны, номер выдан');
SELECT pg_temp.check((SELECT count(*) = 1 FROM stock_reservation_history h
                       WHERE h.reservation_id = (SELECT id FROM ids WHERE k = 'res_a')
                         AND h.from_status IS NULL AND h.to_status = 'created'
                         AND h.changed_by = (SELECT id FROM ids WHERE k = 'coordinator')),
  'в истории резерва автор первого шага — координатор');
SELECT pg_temp.check((SELECT count(*) = 1 FROM integration_outbox o
                       WHERE o.aggregate_type = 'stock_reservation'
                         AND o.aggregate_id = (SELECT id FROM ids WHERE k = 'res_a')
                         AND o.event_type = 'stock_reservation_created'),
  'событие «резерв создан» поставлено в очередь уведомлений');
SELECT pg_temp.check((SELECT b.available_quantity = 5 AND b.reserved_quantity = 5 AND b.on_hand_quantity = 10
                      FROM stock_balances b
                     WHERE b.part_id = (SELECT id FROM ids WHERE k = 'part_a') AND b.part_condition = 'N'),
  'доступный остаток уменьшился на количество обоих резервов');

-- Инженеру заказывать запчасти нельзя.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer'));
SELECT pg_temp.expect_message(
  format('SELECT * FROM public.create_task_part_reservation(%L, %L, %L, 1)', (SELECT id FROM ids WHERE k = 't1'), (SELECT id FROM ids WHERE k = 'part_a'), 'N'),
  'Заказать запчасть со склада может только склад или координатор', 'инженер не заказывает запчасть');
SELECT pg_temp.expect_forbidden(
  format('SELECT * FROM public.create_task_part_reservation(%L, %L, %L, 1)', (SELECT id FROM ids WHERE k = 't1'), (SELECT id FROM ids WHERE k = 'part_a'), 'N'),
  'отказ инженеру — именно по правам');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);

-- Отказы заказа: нет остатка, не та задача, количество, запчасть.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'warehouse'));
SELECT pg_temp.expect_message(
  format('SELECT * FROM public.create_task_part_reservation(%L, %L, %L, 2)', (SELECT id FROM ids WHERE k = 't1'), (SELECT id FROM ids WHERE k = 'part_c'), 'N'),
  'На складе доступно 1 шт. этой запчасти в состоянии Н, а нужно 2', 'на складе не хватает запчасти');
SELECT pg_temp.expect_message(
  format('SELECT * FROM public.create_task_part_reservation(%L, %L, %L, 1)', gen_random_uuid(), (SELECT id FROM ids WHERE k = 'part_a'), 'N'),
  'Резерв можно создать только для задачи, которая ещё в работе', 'под несуществующую задачу резерв не создать');
SELECT pg_temp.expect_message(
  format('SELECT * FROM public.create_task_part_reservation(%L, %L, %L, 0)', (SELECT id FROM ids WHERE k = 't1'), (SELECT id FROM ids WHERE k = 'part_a'), 'N'),
  'Количество в резерве должно быть больше нуля', 'нулевое количество не принимается');
SELECT pg_temp.expect_message(
  format('SELECT * FROM public.create_task_part_reservation(%L, %L, %L, 1)', (SELECT id FROM ids WHERE k = 't1'), gen_random_uuid(), 'N'),
  'Запчасть не найдена в справочнике', 'несуществующая запчасть не принимается');
SELECT pg_temp.expect_message(
  format('SELECT * FROM public.create_task_part_reservation(%L, %L, %L, 1)', (SELECT id FROM ids WHERE k = 't1'), (SELECT id FROM ids WHERE k = 'part_off'), 'N'),
  'Запчасть снята с учёта: резерв по ней создать нельзя', 'снятая с учёта запчасть не резервируется');
-- Запчасть, которую отметить установкой нельзя: резерв есть, но он не выдан.
SELECT pg_temp.check(pg_temp.make_reservation('res_waiting', (SELECT id FROM ids WHERE k = 't1'), (SELECT id FROM ids WHERE k = 'part_c'), 'N', 1) IS NOT NULL,
  'кладовщик заказывает запчасть под ту же задачу');

-- ---------------------------------------------------------------- Выдача инженеру (0022)
SELECT pg_temp.check(pg_temp.rows_affected(format('UPDATE public.stock_reservations SET status = %L WHERE id IN (%L, %L, %L, %L)',
  'warehouse_notified', (SELECT id FROM ids WHERE k = 'res_a'), (SELECT id FROM ids WHERE k = 'res_b'),
  (SELECT id FROM ids WHERE k = 'res_a2'), (SELECT id FROM ids WHERE k = 'res_d'))) = 4,
  'кладовщик отмечает, что запчасти собраны');
SELECT public.issue_stock_reservation((SELECT id FROM ids WHERE k = 'res_a'));
SELECT public.issue_stock_reservation((SELECT id FROM ids WHERE k = 'res_b'));
SELECT public.issue_stock_reservation((SELECT id FROM ids WHERE k = 'res_a2'));
SELECT public.issue_stock_reservation((SELECT id FROM ids WHERE k = 'res_d'));
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
SELECT pg_temp.check((SELECT r.status = 'issued' AND r.issued_to = (SELECT id FROM ids WHERE k = 'engineer')
                      FROM stock_reservations r WHERE r.id = (SELECT id FROM ids WHERE k = 'res_a')),
  'выдача 0022 работает: резерв выдан инженеру задачи');
SELECT pg_temp.check((SELECT count(*) = 1 FROM stock_movements m
                       WHERE m.reservation_id = (SELECT id FROM ids WHERE k = 'res_a') AND m.movement_type = 'issue' AND m.on_hand_delta = -2),
  'выдача списала запчасть со склада');

-- Координатор вписал в карточку ручную позицию «для продажи» по той же запчасти.
INSERT INTO task_parts (task_id, part_id, part_condition, article_number_snapshot, name_snapshot, quantity, for_sale, position)
VALUES ((SELECT id FROM ids WHERE k = 't1'), (SELECT id FROM ids WHERE k = 'part_d'), 'N',
  'ART-D', 'Фильтр тест (продажа)', 1, true,
  (SELECT coalesce(max(position) + 1, 0) FROM task_parts WHERE task_id = (SELECT id FROM ids WHERE k = 't1')));

-- ---------------------------------------------------------------- Отметка установки
-- Чужой инженер отметить не может.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer2'));
SELECT pg_temp.expect_message(
  format('SELECT public.set_task_parts_installed(%L, ARRAY[%L]::uuid[])', (SELECT id FROM ids WHERE k = 't1'), (SELECT id FROM ids WHERE k = 'res_a')),
  'Отметить установку может инженер задачи или координатор', 'чужой инженер установку не отмечает');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);

SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer'));
-- Невыданный резерв и резерв чужой задачи отметить нельзя.
SELECT pg_temp.expect_message(
  format('SELECT public.set_task_parts_installed(%L, ARRAY[%L]::uuid[])', (SELECT id FROM ids WHERE k = 't1'), (SELECT id FROM ids WHERE k = 'res_waiting')),
  'Запчасть не выдана инженеру по этой задаче: отметить установку нельзя', 'невыданную запчасть установленной не отметить');
SELECT pg_temp.expect_message(
  format('SELECT public.set_task_parts_installed(%L, ARRAY[%L]::uuid[])', (SELECT id FROM ids WHERE k = 't1'), gen_random_uuid()),
  'Запчасть не выдана инженеру по этой задаче: отметить установку нельзя', 'чужой резерв в отметке не принимается');
-- Без прибора отмечать нечего.
SELECT pg_temp.expect_message(
  format('SELECT public.set_task_parts_installed(%L, ARRAY[]::uuid[])', (SELECT id FROM ids WHERE k = 't3')),
  'Чтобы отметить установку, у задачи должен быть прибор', 'без прибора установку не отметить');

-- Инженер отмечает первую запчасть, вторую оставляет у себя.
SELECT public.set_task_parts_installed((SELECT id FROM ids WHERE k = 't1'), ARRAY[(SELECT id FROM ids WHERE k = 'res_a')]::uuid[]);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
SELECT pg_temp.check((SELECT tp.installed AND tp.quantity = 2 AND tp.part_condition = 'N'
                        AND tp.article_number_snapshot = 'ART-A' AND tp.name_snapshot = 'Клапан тест'
                      FROM task_parts tp WHERE tp.reservation_id = (SELECT id FROM ids WHERE k = 'res_a')),
  'позиция задачи создана по резерву: количество, состояние и снимки из справочника');
SELECT pg_temp.check((SELECT count(*) = 0 FROM task_parts tp WHERE tp.reservation_id = (SELECT id FROM ids WHERE k = 'res_b')),
  'неотмеченная выданная запчасть позиции не создаёт');

-- Снятие отметки оставляет строку и связь с резервом.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer'));
SELECT public.set_task_parts_installed((SELECT id FROM ids WHERE k = 't1'), ARRAY[]::uuid[]);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
SELECT pg_temp.check((SELECT NOT tp.installed FROM task_parts tp WHERE tp.reservation_id = (SELECT id FROM ids WHERE k = 'res_a')),
  'снятая отметка: установки нет, строка и связь с резервом остались');

-- Отметили снова: вторая строка не заводится.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer'));
SELECT public.set_task_parts_installed((SELECT id FROM ids WHERE k = 't1'), ARRAY[(SELECT id FROM ids WHERE k = 'res_a')]::uuid[]);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
SELECT pg_temp.check((SELECT count(*) = 1 FROM task_parts tp
                       WHERE tp.task_id = (SELECT id FROM ids WHERE k = 't1')
                         AND tp.part_id = (SELECT id FROM ids WHERE k = 'part_a')),
  'повторная отметка обновляет ту же строку позиции');
SELECT pg_temp.check((SELECT tp.installed FROM task_parts tp WHERE tp.reservation_id = (SELECT id FROM ids WHERE k = 'res_a')),
  'повторная отметка снова ставит «установлено»');

-- Пустое значение в списке — ошибка, а не молча пропущенный элемент.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer'));
SELECT pg_temp.expect_message(
  format('SELECT public.set_task_parts_installed(%L, ARRAY[%L, NULL]::uuid[])', (SELECT id FROM ids WHERE k = 't1'), (SELECT id FROM ids WHERE k = 'res_a')),
  'В списке установленных запчастей попалось пустое значение', 'пустое значение в списке установленного не принимается');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
SELECT pg_temp.check((SELECT r.install_marked FROM stock_reservations r WHERE r.id = (SELECT id FROM ids WHERE k = 'res_a')),
  'отказ из-за пустого значения ничего не изменил');

-- Отметку ставит только RPC: прямой запрос к резерву отбивается.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'warehouse'));
SELECT pg_temp.expect_message(
  format('UPDATE public.stock_reservations SET install_marked = true WHERE id = %L', (SELECT id FROM ids WHERE k = 'res_b')),
  'Отметку об установке ставит инженер в задаче, а не склад', 'склад не ставит отметку установки напрямую');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'coordinator'));
SELECT pg_temp.expect_message(
  format('UPDATE public.stock_reservations SET install_marked = true WHERE id = %L', (SELECT id FROM ids WHERE k = 'res_b')),
  'Отметку об установке ставит инженер в задаче, а не склад', 'координатор тоже не ставит отметку напрямую');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
SELECT pg_temp.check((SELECT NOT r.install_marked FROM stock_reservations r WHERE r.id = (SELECT id FROM ids WHERE k = 'res_b')),
  'после отказов отметка на резерве так и не появилась');

-- Отмеченную запчасть вернули на склад: строка карточки не должна остаться с прежним
-- количеством. Два резерва одной запчасти, возвращаем сначала один, потом второй.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'warehouse'));
SELECT pg_temp.check(pg_temp.make_reservation('res_b2', (SELECT id FROM ids WHERE k = 't1'), (SELECT id FROM ids WHERE k = 'part_b'), 'N', 1) IS NOT NULL,
  'второй резерв той же запчасти, что уже выдана инженеру');
SELECT pg_temp.check(pg_temp.make_reservation('res_b3', (SELECT id FROM ids WHERE k = 't1'), (SELECT id FROM ids WHERE k = 'part_b'), 'N', 2) IS NOT NULL,
  'третий резерв той же запчасти');
SELECT pg_temp.check(pg_temp.make_reservation('res_b4', (SELECT id FROM ids WHERE k = 't1'), (SELECT id FROM ids WHERE k = 'part_b'), 'N', 1) IS NOT NULL,
  'четвёртый резерв той же запчасти: его вернут уже после сдачи задачи');
UPDATE public.stock_reservations SET status = 'warehouse_notified'
 WHERE id IN ((SELECT id FROM ids WHERE k = 'res_b2'), (SELECT id FROM ids WHERE k = 'res_b3'), (SELECT id FROM ids WHERE k = 'res_b4'));
SELECT public.issue_stock_reservation((SELECT id FROM ids WHERE k = 'res_b2'));
SELECT public.issue_stock_reservation((SELECT id FROM ids WHERE k = 'res_b3'));
SELECT public.issue_stock_reservation((SELECT id FROM ids WHERE k = 'res_b4'));
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer'));
SELECT public.set_task_parts_installed((SELECT id FROM ids WHERE k = 't1'),
  ARRAY[(SELECT id FROM ids WHERE k = 'res_a'), (SELECT id FROM ids WHERE k = 'res_b2'),
        (SELECT id FROM ids WHERE k = 'res_b3'), (SELECT id FROM ids WHERE k = 'res_b4')]::uuid[]);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
SELECT pg_temp.check((SELECT tp.installed AND tp.quantity = 4 FROM task_parts tp
                       WHERE tp.task_id = (SELECT id FROM ids WHERE k = 't1') AND tp.part_id = (SELECT id FROM ids WHERE k = 'part_b')),
  'отмечены все три резерва одной запчасти: в карточке 4 шт.');

-- Прав на позиции задачи у кладовщика нет: строку пересобирает сама цепочка.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'warehouse'));
SELECT pg_temp.check(NOT public.app_can_write_task((SELECT id FROM ids WHERE k = 't1')),
  'кладовщик позиции задачи менять не вправе');
SELECT public.return_stock_reservation((SELECT id FROM ids WHERE k = 'res_b2'));
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.check((SELECT r.status = 'returned' AND NOT r.install_marked
                      FROM stock_reservations r WHERE r.id = (SELECT id FROM ids WHERE k = 'res_b2')),
  'возврат снял отметку об установке с возвращённого резерва');
SELECT pg_temp.check((SELECT tp.installed AND tp.quantity = 3
                        AND tp.reservation_id IN ((SELECT id FROM ids WHERE k = 'res_b3'), (SELECT id FROM ids WHERE k = 'res_b4'))
                      FROM task_parts tp
                     WHERE tp.task_id = (SELECT id FROM ids WHERE k = 't1') AND tp.part_id = (SELECT id FROM ids WHERE k = 'part_b')),
  'строка карточки пересобрана по оставшимся отмеченным резервам: 3 шт.');

SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'warehouse'));
SELECT public.return_stock_reservation((SELECT id FROM ids WHERE k = 'res_b3'));
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.check((SELECT tp.quantity = 1 AND tp.reservation_id = (SELECT id FROM ids WHERE k = 'res_b4')
                      FROM task_parts tp
                     WHERE tp.task_id = (SELECT id FROM ids WHERE k = 't1') AND tp.part_id = (SELECT id FROM ids WHERE k = 'part_b')),
  'после второго возврата в карточке остался только последний отмеченный резерв: 1 шт.');
SELECT pg_temp.check((SELECT r.status = 'issued' AND NOT r.install_marked
                      FROM stock_reservations r WHERE r.id = (SELECT id FROM ids WHERE k = 'res_b')),
  'неотмеченный выданный резерв той же запчасти возвратами не задет');

-- Снять выданный резерв нельзя: отмеченную запчасть только возвращают на склад.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'warehouse'));
SELECT pg_temp.expect_message(
  format('UPDATE public.stock_reservations SET status = %L WHERE id = %L', 'cancelled', (SELECT id FROM ids WHERE k = 'res_a')),
  'Недопустимый переход резерва: issued -> cancelled', 'отмеченную выданную запчасть не снять, её возвращают');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
SELECT pg_temp.check((SELECT r.install_marked AND r.status = 'issued' FROM stock_reservations r WHERE r.id = (SELECT id FROM ids WHERE k = 'res_a')),
  'после отказа отметка и статус резерва на месте');

-- Отмечаем оба резерва одной запчасти и запчасть с ручной позицией «для продажи».
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer'));
SELECT public.set_task_parts_installed((SELECT id FROM ids WHERE k = 't1'),
  ARRAY[(SELECT id FROM ids WHERE k = 'res_a'), (SELECT id FROM ids WHERE k = 'res_a2'),
        (SELECT id FROM ids WHERE k = 'res_b4'), (SELECT id FROM ids WHERE k = 'res_d')]::uuid[]);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
SELECT pg_temp.check((SELECT count(*) = 4 FROM stock_reservations r
                       WHERE r.task_id = (SELECT id FROM ids WHERE k = 't1')
                         AND r.status = 'issued' AND r.install_marked),
  'отметка стоит на каждом резерве отдельно');
SELECT pg_temp.check((SELECT tp.installed AND tp.quantity = 5
                        AND tp.reservation_id IN ((SELECT id FROM ids WHERE k = 'res_a'), (SELECT id FROM ids WHERE k = 'res_a2'))
                      FROM task_parts tp
                     WHERE tp.task_id = (SELECT id FROM ids WHERE k = 't1')
                       AND tp.part_id = (SELECT id FROM ids WHERE k = 'part_a') AND tp.part_condition = 'N'),
  'в карточке одна строка на оба резерва, количество просуммировано');
SELECT pg_temp.check((SELECT count(*) = 1 FROM task_parts tp
                       WHERE tp.task_id = (SELECT id FROM ids WHERE k = 't1')
                         AND tp.part_id = (SELECT id FROM ids WHERE k = 'part_a')),
  'вторая строка по той же запчасти не заводится');
SELECT pg_temp.check((SELECT tp.for_sale AND NOT tp.installed AND tp.quantity = 1
                        AND tp.name_snapshot = 'Фильтр тест (продажа)' AND tp.reservation_id IS NULL
                      FROM task_parts tp
                     WHERE tp.task_id = (SELECT id FROM ids WHERE k = 't1')
                       AND tp.part_id = (SELECT id FROM ids WHERE k = 'part_d')),
  'ручная позиция «для продажи» не тронута: ни количество, ни наименование, ни связь');
SELECT pg_temp.check((SELECT r.install_marked FROM stock_reservations r WHERE r.id = (SELECT id FROM ids WHERE k = 'res_d')),
  'отметка резерва при этом сохранилась: по складу установка пройдёт');
SELECT pg_temp.check((SELECT tp.quantity = 1 AND tp.installed FROM task_parts tp
                       WHERE tp.task_id = (SELECT id FROM ids WHERE k = 't1')
                         AND tp.part_id = (SELECT id FROM ids WHERE k = 'part_b')),
  'строка по возвращавшейся запчасти пересчитана заново и новой отметке не помешала');

-- ---------------------------------------------------------------- Закрытие задачи
-- Акт и три фото: без них задачу не сдать и не закрыть (0023, 0014).
CREATE FUNCTION pg_temp.add_file(p_task uuid, p_kind text, p_n int) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE fid uuid;
BEGIN
  INSERT INTO files (kind, task_id, storage_key, original_name, content_type, byte_size)
  VALUES (p_kind::file_kind, p_task, 'test/' || p_task || '/' || p_kind || '-' || p_n, p_kind || p_n || '.jpg', 'image/jpeg', 100)
  RETURNING id INTO fid;
  RETURN fid;
END $$;

SELECT pg_temp.add_file((SELECT id FROM ids WHERE k = 't1'), 'act', 1);
INSERT INTO task_closures (task_id, act_file_id, submitted_by)
  SELECT (SELECT id FROM ids WHERE k = 't1'), f.id, (SELECT id FROM ids WHERE k = 'engineer')
    FROM files f WHERE f.task_id = (SELECT id FROM ids WHERE k = 't1') AND f.kind = 'act';
SELECT pg_temp.add_file((SELECT id FROM ids WHERE k = 't1'), 'photo', 1);
SELECT pg_temp.add_file((SELECT id FROM ids WHERE k = 't1'), 'photo', 2);
SELECT pg_temp.add_file((SELECT id FROM ids WHERE k = 't1'), 'photo', 3);

SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer'));
SELECT pg_temp.check(pg_temp.rows_affected(format('UPDATE public.tasks SET status_code = %L WHERE id = %L', 'under_review', (SELECT id FROM ids WHERE k = 't1'))) = 1,
  'инженер сдаёт задачу на проверку');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);

-- Тот самый случай из отчёта: отметил, сдал задачу, а запчасть вернули на склад.
-- Отметки уже заморожены, поправить строку вручную нечем — чинит сама цепочка.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'warehouse'));
SELECT public.return_stock_reservation((SELECT id FROM ids WHERE k = 'res_b4'));
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.check((SELECT NOT r.install_marked FROM stock_reservations r WHERE r.id = (SELECT id FROM ids WHERE k = 'res_b4')),
  'возврат по сданной задаче снял отметку');
SELECT pg_temp.check((SELECT count(*) = 0 FROM task_parts tp
                       WHERE tp.task_id = (SELECT id FROM ids WHERE k = 't1') AND tp.part_id = (SELECT id FROM ids WHERE k = 'part_b')),
  'вернули всё отмеченное по сданной задаче — строка из карточки убрана, зависшего количества нет');

-- Сданную задачу инженер уже не правит: отметки установки заморожены.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer'));
SELECT pg_temp.expect_message(
  format('SELECT public.set_task_parts_installed(%L, ARRAY[]::uuid[])', (SELECT id FROM ids WHERE k = 't1')),
  'Задача сдана, закрыта или отменена: отметки об установке больше не меняются', 'после сдачи на проверку отметки не меняются');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);

SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'coordinator'));
SELECT public.accept_task_closure((SELECT id FROM ids WHERE k = 't1'), NULL, 'Принято', now());
SELECT pg_temp.check((SELECT t.status_code = 'closed' FROM public.tasks t WHERE t.id = (SELECT id FROM ids WHERE k = 't1')),
  'координатор принимает акт и закрывает задачу');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
-- Отложенные проверки склада (0001, 0022) должны пройти прямо здесь, а не при COMMIT.
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

SELECT pg_temp.check((SELECT r.status = 'installed' FROM stock_reservations r WHERE r.id = (SELECT id FROM ids WHERE k = 'res_a')),
  'при закрытии задачи отмеченный резерв стал «установлено»');
SELECT pg_temp.check((SELECT m.movement_type = 'install' AND m.on_hand_delta = 0 AND m.quantity = 2
                        AND m.equipment_id = (SELECT id FROM ids WHERE k = 'equipment')
                        AND m.task_id = (SELECT id FROM ids WHERE k = 't1')
                        AND m.performed_by = (SELECT id FROM ids WHERE k = 'engineer')
                        AND m.occurred_at = '2026-11-13 12:30:00+03'::timestamptz
                      FROM stock_movements m WHERE m.idempotency_key = 'install:' || (SELECT id FROM ids WHERE k = 'res_a')),
  'движение «установка» записано на прибор задачи, автор — инженер, время окончания работ');
SELECT pg_temp.check((SELECT h.changed_by = (SELECT id FROM ids WHERE k = 'engineer')
                      FROM stock_reservation_history h
                     WHERE h.reservation_id = (SELECT id FROM ids WHERE k = 'res_a') AND h.to_status = 'installed'),
  'в истории резерва автор установки — инженер, которому выдали запчасть');
SELECT pg_temp.check((SELECT f.event_type = 'part_replacement' AND f.summary = 'ART-A · Клапан тест'
                        AND f.created_by = (SELECT id FROM ids WHERE k = 'engineer')
                      FROM equipment_history_feed f
                     WHERE f.equipment_id = (SELECT id FROM ids WHERE k = 'equipment')
                       AND f.stock_movement_id = (SELECT m.id FROM stock_movements m
                                                   WHERE m.idempotency_key = 'install:' || (SELECT id FROM ids WHERE k = 'res_a'))),
  'в истории прибора появилась замена запчасти');
SELECT pg_temp.check((SELECT r.status = 'issued' FROM stock_reservations r WHERE r.id = (SELECT id FROM ids WHERE k = 'res_b')),
  'неотмеченная выданная запчасть осталась «выдана» — висит на инженере');
SELECT pg_temp.check((SELECT count(*) = 0 FROM stock_movements m
                       WHERE m.reservation_id = (SELECT id FROM ids WHERE k = 'res_b') AND m.movement_type = 'install'),
  'по неотмеченной запчасти установка не проводилась');

-- Два резерва одной запчасти: два движения и два «установлено», строка в карточке одна.
SELECT pg_temp.check((SELECT count(*) = 2 FROM stock_reservations r
                       WHERE r.id IN ((SELECT id FROM ids WHERE k = 'res_a'), (SELECT id FROM ids WHERE k = 'res_a2'))
                         AND r.status = 'installed'),
  'оба резерва одной запчасти стали «установлено»');
SELECT pg_temp.check((SELECT count(*) = 2 FROM stock_movements m
                       WHERE m.movement_type = 'install'
                         AND m.reservation_id IN ((SELECT id FROM ids WHERE k = 'res_a'), (SELECT id FROM ids WHERE k = 'res_a2'))),
  'по каждому резерву своё движение «установка»');
SELECT pg_temp.check((SELECT sum(m.quantity) = 5 FROM stock_movements m
                       WHERE m.movement_type = 'install'
                         AND m.reservation_id IN ((SELECT id FROM ids WHERE k = 'res_a'), (SELECT id FROM ids WHERE k = 'res_a2'))),
  'в прибор проведено всё выданное количество, а не только одна строка карточки');
SELECT pg_temp.check((SELECT count(*) = 2 FROM equipment_history_feed f
                       WHERE f.equipment_id = (SELECT id FROM ids WHERE k = 'equipment')
                         AND f.event_type = 'part_replacement' AND f.summary = 'ART-A · Клапан тест'),
  'в истории прибора обе замены этой запчасти');
-- Партия движения «установка» — та же, из которой выдали.
SELECT pg_temp.check((SELECT install.lot_id = issue.lot_id
                      FROM stock_movements install
                      JOIN stock_movements issue
                        ON issue.reservation_id = install.reservation_id AND issue.movement_type = 'issue'
                     WHERE install.idempotency_key = 'install:' || (SELECT id FROM ids WHERE k = 'res_a')),
  'установка проведена по той же партии, из которой выдали');
-- Ручная позиция «для продажи» осталась нетронутой, а по складу установка прошла.
SELECT pg_temp.check((SELECT r.status = 'installed' FROM stock_reservations r WHERE r.id = (SELECT id FROM ids WHERE k = 'res_d')),
  'резерв с ручной позицией «для продажи» тоже установлен');
SELECT pg_temp.check((SELECT tp.for_sale AND NOT tp.installed AND tp.quantity = 1 AND tp.reservation_id IS NULL
                      FROM task_parts tp
                     WHERE tp.task_id = (SELECT id FROM ids WHERE k = 't1')
                       AND tp.part_id = (SELECT id FROM ids WHERE k = 'part_d')),
  'после закрытия ручная позиция «для продажи» всё ещё не тронута');

-- Закрытие освобождает заказанное и собранное: иначе оно вечно висит в «доступно».
SELECT pg_temp.check((SELECT r.status = 'cancelled' FROM stock_reservations r WHERE r.id = (SELECT id FROM ids WHERE k = 'res_waiting')),
  'закрытие задачи снимает незаказанный резерв');
SELECT pg_temp.check((SELECT b.available_quantity = 1 FROM stock_balances b
                       WHERE b.part_id = (SELECT id FROM ids WHERE k = 'part_c') AND b.part_condition = 'N'),
  'снятый при закрытии резерв вернулся в доступный остаток');

-- Закрытую задачу не правит и координатор: установка уже проведена по складу.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'coordinator'));
SELECT pg_temp.expect_message(
  format('SELECT public.set_task_parts_installed(%L, ARRAY[%L]::uuid[])', (SELECT id FROM ids WHERE k = 't1'), (SELECT id FROM ids WHERE k = 'res_b')),
  'Задача сдана, закрыта или отменена: отметки об установке больше не меняются', 'координатор не меняет отметки у закрытой задачи');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);

-- Под закрытую задачу новый резерв не создать.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'warehouse'));
SELECT pg_temp.expect_message(
  format('SELECT * FROM public.create_task_part_reservation(%L, %L, %L, 1)', (SELECT id FROM ids WHERE k = 't1'), (SELECT id FROM ids WHERE k = 'part_a'), 'N'),
  'Резерв можно создать только для задачи, которая ещё в работе', 'под закрытую задачу резерв не создать');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------- Возврат на склад (0022)
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'warehouse'));
SELECT public.return_stock_reservation((SELECT id FROM ids WHERE k = 'res_b'));
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.check((SELECT r.status = 'returned' FROM stock_reservations r WHERE r.id = (SELECT id FROM ids WHERE k = 'res_b')),
  'возврат 0022 работает: запчасть принята обратно на склад');
SELECT pg_temp.check((SELECT b.on_hand_quantity = 10 FROM stock_balances b
                       WHERE b.part_id = (SELECT id FROM ids WHERE k = 'part_b') AND b.part_condition = 'N'),
  'после возврата остаток запчасти восстановлен');

-- ---------------------------------------------------------------- Установка без времени окончания работ
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'warehouse'));
SELECT pg_temp.check(pg_temp.make_reservation('res_t2', (SELECT id FROM ids WHERE k = 't2'), (SELECT id FROM ids WHERE k = 'part_b'), 'N', 1) IS NOT NULL,
  'заказ запчасти под задачу второго инженера');
UPDATE public.stock_reservations SET status = 'warehouse_notified' WHERE id = (SELECT id FROM ids WHERE k = 'res_t2');
SELECT public.issue_stock_reservation((SELECT id FROM ids WHERE k = 'res_t2'));
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer2'));
SELECT public.set_task_parts_installed((SELECT id FROM ids WHERE k = 't2'), ARRAY[(SELECT id FROM ids WHERE k = 'res_t2')]::uuid[]);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
SELECT pg_temp.add_file((SELECT id FROM ids WHERE k = 't2'), 'act', 1);
INSERT INTO task_closures (task_id, act_file_id, submitted_by)
  SELECT (SELECT id FROM ids WHERE k = 't2'), f.id, (SELECT id FROM ids WHERE k = 'engineer2')
    FROM files f WHERE f.task_id = (SELECT id FROM ids WHERE k = 't2') AND f.kind = 'act';
SELECT pg_temp.add_file((SELECT id FROM ids WHERE k = 't2'), 'photo', 1);
SELECT pg_temp.add_file((SELECT id FROM ids WHERE k = 't2'), 'photo', 2);
SELECT pg_temp.add_file((SELECT id FROM ids WHERE k = 't2'), 'photo', 3);
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer2'));
UPDATE public.tasks SET status_code = 'under_review' WHERE id = (SELECT id FROM ids WHERE k = 't2');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'coordinator'));
SELECT public.accept_task_closure((SELECT id FROM ids WHERE k = 't2'), NULL, 'Принято', now());
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.check((SELECT t.work_finished_at IS NULL FROM tasks t WHERE t.id = (SELECT id FROM ids WHERE k = 't2')),
  'у задачи второго инженера времени окончания работ нет');
SELECT pg_temp.check((SELECT m.occurred_at = now() AND m.performed_by = (SELECT id FROM ids WHERE k = 'engineer2')
                      FROM stock_movements m WHERE m.idempotency_key = 'install:' || (SELECT id FROM ids WHERE k = 'res_t2')),
  'без времени окончания работ установка проведена моментом закрытия');

-- ---------------------------------------------------------------- Отмена задачи освобождает склад
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'warehouse'));
SELECT pg_temp.check(pg_temp.make_reservation('res_new', (SELECT id FROM ids WHERE k = 't4'), (SELECT id FROM ids WHERE k = 'part_a'), 'N', 1) IS NOT NULL,
  'заказ под задачу, которую потом отменят');
SELECT pg_temp.check(pg_temp.make_reservation('res_ready', (SELECT id FROM ids WHERE k = 't4'), (SELECT id FROM ids WHERE k = 'part_b'), 'N', 1) IS NOT NULL,
  'второй заказ под ту же задачу');
SELECT pg_temp.check(pg_temp.make_reservation('res_given', (SELECT id FROM ids WHERE k = 't4'), (SELECT id FROM ids WHERE k = 'part_b'), 'N', 1) IS NOT NULL,
  'третий заказ под ту же задачу');
SELECT pg_temp.check(pg_temp.rows_affected(format('UPDATE public.stock_reservations SET status = %L WHERE id IN (%L, %L)',
  'warehouse_notified', (SELECT id FROM ids WHERE k = 'res_ready'), (SELECT id FROM ids WHERE k = 'res_given'))) = 2,
  'две запчасти собраны кладовщиком');
SELECT public.issue_stock_reservation((SELECT id FROM ids WHERE k = 'res_given'));
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);

SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'coordinator'));
SELECT pg_temp.check(pg_temp.rows_affected(format('UPDATE public.tasks SET status_code = %L, cancellation_reason = %L WHERE id = %L',
  'cancelled', 'Дубль заявки', (SELECT id FROM ids WHERE k = 't4'))) = 1, 'координатор отменяет задачу');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.check((SELECT r.status = 'cancelled' FROM stock_reservations r WHERE r.id = (SELECT id FROM ids WHERE k = 'res_new')),
  'отмена задачи снимает заказанную запчасть');
SELECT pg_temp.check((SELECT r.status = 'cancelled' FROM stock_reservations r WHERE r.id = (SELECT id FROM ids WHERE k = 'res_ready')),
  'отмена задачи снимает собранную запчасть');
SELECT pg_temp.check((SELECT r.status = 'issued' FROM stock_reservations r WHERE r.id = (SELECT id FROM ids WHERE k = 'res_given')),
  'выданная запчасть при отмене задачи остаётся на инженере');
SELECT pg_temp.check((SELECT b.available_quantity = 5 AND b.reserved_quantity = 0 FROM stock_balances b
                       WHERE b.part_id = (SELECT id FROM ids WHERE k = 'part_a') AND b.part_condition = 'N'),
  'снятые резервы вернули количество в доступный остаток');

ROLLBACK;
