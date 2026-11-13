-- Проверка создания счёта и замены плательщика (миграции 0010, 0015, 0016, 0024). Запуск на локальной базе с миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/invoice_create.sql
-- Всё в транзакции и откатывается. Ошибка = проверка не прошла.

BEGIN;

CREATE FUNCTION pg_temp.act_as(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;
CREATE FUNCTION pg_temp.check(p_ok boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN RAISE EXCEPTION 'ПРОВАЛ: %', p_label; END IF;
  RAISE NOTICE 'ok: %', p_label;
END $$;
-- Вызов в отдельной подтранзакции: ждём ошибку и проверяем, что ничего не осталось.
CREATE FUNCTION pg_temp.expect_error(p_sql text, p_label text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok: % (отказ: %)', p_label, SQLERRM;
    RETURN SQLERRM;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — команда прошла, а должна быть отклонена', p_label;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.check(boolean, text), pg_temp.expect_error(text, text) TO authenticated, anon;

CREATE TEMP TABLE v (k text PRIMARY KEY, id uuid);
GRANT SELECT, INSERT ON v TO authenticated;
GRANT SELECT ON v TO anon;

DO $$
DECLARE
  coord uuid := gen_random_uuid(); wh uuid := gen_random_uuid(); sup uuid := gen_random_uuid(); t4 uuid;
  org uuid; site uuid; p1 uuid; p2 uuid; m uuid; md uuid; eq1 uuid; eq2 uuid; eq3 uuid; t1 uuid; t2 uuid; t3 uuid; t5 uuid; t6 uuid; t7 uuid; wt text;
BEGIN
  INSERT INTO auth.users (id, email, aud, role) VALUES (coord, 'inv-coord@test.local', 'authenticated', 'authenticated'), (wh, 'inv-wh@test.local', 'authenticated', 'authenticated'), (sup, 'inv-sup@test.local', 'authenticated', 'authenticated');
  INSERT INTO users (id, full_name, role, email, is_active, access_role_key) VALUES
    (coord, 'Координатор', 'coordinator', 'inv-coord@test.local', true, 'coordinator'),
    (wh, 'Кладовщик', 'warehouse', 'inv-wh@test.local', true, 'warehouse'),
    (sup, 'Руководитель', 'supervisor', 'inv-sup@test.local', true, 'supervisor');
  INSERT INTO organizations (name) VALUES ('Счета: организация') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('Счета: площадка', org) RETURNING id INTO site;
  INSERT INTO payers (name) VALUES ('Счета: плательщик 1') RETURNING id INTO p1;
  INSERT INTO payers (name) VALUES ('Счета: плательщик 2') RETURNING id INTO p2;
  INSERT INTO manufacturers (name) VALUES ('Счета: производитель') RETURNING id INTO m;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (m, 'Счета: модель') RETURNING id INTO md;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id) VALUES ('INV-1', m, md, site, p1) RETURNING id INTO eq1;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id) VALUES ('INV-2', m, md, site, p1) RETURNING id INTO eq2;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id) VALUES ('INV-3', m, md, site, p2) RETURNING id INTO eq3;
  SELECT code INTO wt FROM work_types WHERE is_active AND NOT coalesce(requires_hours, false) ORDER BY code LIMIT 1;
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, created_by, deadline_from, deadline_to) VALUES ('Счета 1', wt, eq1, site, p1, coord, current_date, current_date + 3) RETURNING id INTO t1;
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, created_by, deadline_from, deadline_to) VALUES ('Счета 2', wt, eq2, site, p1, coord, current_date, current_date + 3) RETURNING id INTO t2;
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, created_by, deadline_from, deadline_to) VALUES ('Счета 3', wt, eq3, site, p2, coord, current_date, current_date + 3) RETURNING id INTO t3;
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, created_by, deadline_from, deadline_to) VALUES ('Открытая', wt, eq1, site, p1, coord, current_date, current_date + 3) RETURNING id INTO t4;
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, created_by, deadline_from, deadline_to) VALUES ('Счета 5', wt, eq1, site, p1, coord, current_date, current_date + 3) RETURNING id INTO t5;
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, created_by, deadline_from, deadline_to) VALUES ('Счета 6', wt, eq2, site, p1, coord, current_date, current_date + 3) RETURNING id INTO t6;
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, created_by, deadline_from, deadline_to) VALUES ('Счета 7', wt, eq1, site, p1, coord, current_date, current_date + 3) RETURNING id INTO t7;
  INSERT INTO v VALUES ('coord', coord), ('wh', wh), ('sup', sup), ('p1', p1), ('p2', p2), ('eq1', eq1), ('eq2', eq2),
    ('t1', t1), ('t2', t2), ('t3', t3), ('t4', t4), ('t5', t5), ('t6', t6), ('t7', t7);
END $$;

-- Подготовка: задачи закрываем в обход проверок закрытия (акт и фото здесь не проверяем).
SET session_replication_role = replica;
UPDATE tasks SET status_code = 'closed', engineer_id = (SELECT id FROM v WHERE k = 'coord'),
       call_reason = 'Поломка', work_description = 'Ремонт выполнен'
 WHERE id IN (SELECT id FROM v WHERE k IN ('t1', 't2', 't3', 't5', 't6', 't7'));
SET session_replication_role = origin;

SELECT pg_temp.act_as((SELECT id FROM v WHERE k = 'coord'));

SELECT pg_temp.check((SELECT public.create_invoice((SELECT id FROM v WHERE k = 'p1'), ARRAY[(SELECT id FROM v WHERE k = 't1')], NULL)) IS NOT NULL,
  'координатор создаёт счёт по закрытой задаче');
SELECT pg_temp.check((SELECT count(*) FROM invoices i JOIN invoice_tasks it ON it.invoice_id = i.id WHERE it.task_id = (SELECT id FROM v WHERE k = 't1') AND i.payer_snapshot_source = 'equipment') = 1,
  'счёт привязан к задаче, плательщик из прибора');
INSERT INTO v SELECT 'inv1', invoice_id FROM invoice_tasks WHERE task_id = (SELECT id FROM v WHERE k = 't1');

SELECT pg_temp.check((SELECT public.create_invoice((SELECT id FROM v WHERE k = 'p1'), ARRAY[(SELECT id FROM v WHERE k = 't5'), (SELECT id FROM v WHERE k = 't2')], NULL)) IS NOT NULL,
  'две задачи на разных приборах с одним плательщиком');

SELECT pg_temp.check((SELECT count(*) FROM invoices) = 2, 'пока два счёта');
SELECT pg_temp.expect_error(format('SELECT public.create_invoice(%L, ARRAY[%L, %L]::uuid[], NULL)',
  (SELECT id FROM v WHERE k = 'p1'), (SELECT id FROM v WHERE k = 't6'), (SELECT id FROM v WHERE k = 't3')),
  'задачи с разными плательщиками отклоняются');
SELECT pg_temp.check((SELECT count(*) FROM invoices) = 2, 'после ошибки пустой черновик не остался');

SELECT pg_temp.expect_error(format('SELECT public.create_invoice(%L, ARRAY[%L]::uuid[], NULL)',
  (SELECT id FROM v WHERE k = 'p2'), (SELECT id FROM v WHERE k = 't6')),
  'другой плательщик без причины отклоняется');

SELECT pg_temp.check((SELECT public.create_invoice((SELECT id FROM v WHERE k = 'p2'), ARRAY[(SELECT id FROM v WHERE k = 't6')], 'Оплачивает головная организация')) IS NOT NULL,
  'другой плательщик с причиной');
SELECT pg_temp.check((SELECT payer_overridden_by FROM invoices WHERE payer_snapshot_source = 'override') = auth.uid(),
  'автор замены — вошедший координатор');

-- Одна задача — один действующий счёт (0024).
SELECT pg_temp.check(position(
    (SELECT number FROM tasks WHERE id = (SELECT id FROM v WHERE k = 't1')) || ' (счёт ' || (SELECT number FROM invoices WHERE id = (SELECT id FROM v WHERE k = 'inv1')) || ')'
    IN pg_temp.expect_error(format('SELECT public.create_invoice(%L, ARRAY[%L]::uuid[], NULL)', (SELECT id FROM v WHERE k = 'p1'), (SELECT id FROM v WHERE k = 't1')),
      'задача уже в счёте: второй счёт с ней не создаётся')) > 0,
  'в ошибке номер задачи и номер счёта, где она уже есть');
SELECT pg_temp.check(pg_temp.expect_error(format('SELECT public.create_invoice(%L, ARRAY[%L, %L]::uuid[], NULL)',
    (SELECT id FROM v WHERE k = 'p1'), (SELECT id FROM v WHERE k = 't1'), (SELECT id FROM v WHERE k = 't2')),
    'две занятые задачи: счёт не создаётся')
  LIKE '%' || (SELECT number FROM tasks WHERE id = (SELECT id FROM v WHERE k = 't1')) || '%'
       || (SELECT number FROM tasks WHERE id = (SELECT id FROM v WHERE k = 't2')) || '%',
  'в ошибке названы все занятые задачи');
SELECT pg_temp.check((SELECT count(*) FROM invoices) = 3, 'после отказа лишний счёт не создан');

-- Подделка автора замены прямой вставкой: автор всё равно вошедший пользователь.
INSERT INTO invoices (payer_id, status, source_equipment_id, payer_override_reason, payer_overridden_by)
VALUES ((SELECT id FROM v WHERE k = 'p2'), 'draft', (SELECT id FROM v WHERE k = 'eq1'), 'тест', (SELECT id FROM v WHERE k = 'wh'));
SELECT pg_temp.check((SELECT count(*) FROM invoices WHERE payer_overridden_by = (SELECT id FROM v WHERE k = 'wh')) = 0,
  'подставить чужого автора замены нельзя');
INSERT INTO v SELECT 'inv_direct', id FROM invoices WHERE payer_override_reason = 'тест';

SELECT pg_temp.expect_error(format('INSERT INTO invoice_tasks (invoice_id, task_id) VALUES (%L, %L)',
  (SELECT id FROM v WHERE k = 'inv_direct'), (SELECT id FROM v WHERE k = 't1')), 'занятую задачу не привязать к другому счёту и прямым запросом');
UPDATE invoice_tasks SET invoice_active = false WHERE task_id = (SELECT id FROM v WHERE k = 't1');
SELECT pg_temp.check((SELECT bool_and(invoice_active) FROM invoice_tasks WHERE task_id = (SELECT id FROM v WHERE k = 't1')),
  'отметку «задача занята» запросом не снять');

-- Отмена счёта освобождает его задачи.
UPDATE invoices SET status = 'cancelled' WHERE id = (SELECT id FROM v WHERE k = 'inv1');
SELECT pg_temp.check((SELECT NOT invoice_active FROM invoice_tasks WHERE invoice_id = (SELECT id FROM v WHERE k = 'inv1')),
  'после отмены счёта его задача свободна');
SELECT pg_temp.check((SELECT public.create_invoice((SELECT id FROM v WHERE k = 'p1'), ARRAY[(SELECT id FROM v WHERE k = 't1')], NULL)) IS NOT NULL,
  'задачу из отменённого счёта выставляют заново');
SELECT pg_temp.check((SELECT count(*) FROM invoice_tasks WHERE task_id = (SELECT id FROM v WHERE k = 't1')) = 2
  AND (SELECT count(*) FROM invoice_tasks WHERE task_id = (SELECT id FROM v WHERE k = 't1') AND invoice_active) = 1,
  'отменённый счёт хранит задачу для истории, действующий — один');
SELECT pg_temp.expect_error(format('UPDATE invoices SET status = %L WHERE id = %L', 'draft', (SELECT id FROM v WHERE k = 'inv1')),
  'отменённый счёт не вернуть в работу');
INSERT INTO v SELECT 'inv_t1', invoice_id FROM invoice_tasks WHERE task_id = (SELECT id FROM v WHERE k = 't1') AND invoice_active;

-- Строка счёта по задаче — только по задаче этого счёта: второй раз задачу строкой не выставить.
SELECT pg_temp.expect_error(format('INSERT INTO invoice_items (invoice_id, item_type, work_type_code, task_id, description, quantity, unit_price) SELECT %L, %L, code, %L, %L, 1, 100 FROM work_types WHERE is_active ORDER BY code LIMIT 1',
  (SELECT id FROM v WHERE k = 'inv_direct'), 'work', (SELECT id FROM v WHERE k = 't1'), 'Работа по задаче из другого счёта'),
  'строку по задаче из другого счёта не добавить');
INSERT INTO invoice_items (invoice_id, item_type, work_type_code, task_id, description, quantity, unit_price)
SELECT (SELECT id FROM v WHERE k = 'inv_t1'), 'work', code, (SELECT id FROM v WHERE k = 't1'), 'Работа по задаче', 1, 100
  FROM work_types WHERE is_active ORDER BY code LIMIT 1;
SELECT pg_temp.check((SELECT count(*) FROM invoice_items WHERE invoice_id = (SELECT id FROM v WHERE k = 'inv_t1')) = 1, 'строка по задаче своего счёта добавляется');
SELECT pg_temp.expect_error(format('DELETE FROM invoice_tasks WHERE invoice_id = %L AND task_id = %L', (SELECT id FROM v WHERE k = 'inv_t1'), (SELECT id FROM v WHERE k = 't1')),
  'задачу со строками счёта из него не убрать');
DELETE FROM invoice_items WHERE invoice_id = (SELECT id FROM v WHERE k = 'inv_t1');
-- Перенос задачи между черновиками: прежняя версия строки не считается вторым счётом.
UPDATE invoice_tasks SET invoice_id = (SELECT id FROM v WHERE k = 'inv_direct')
 WHERE invoice_id = (SELECT id FROM v WHERE k = 'inv_t1') AND task_id = (SELECT id FROM v WHERE k = 't1');
SELECT pg_temp.check((SELECT invoice_active FROM invoice_tasks WHERE invoice_id = (SELECT id FROM v WHERE k = 'inv_direct') AND task_id = (SELECT id FROM v WHERE k = 't1')),
  'задачу переносят из черновика в черновик');
UPDATE invoice_tasks SET invoice_id = (SELECT id FROM v WHERE k = 'inv_t1')
 WHERE invoice_id = (SELECT id FROM v WHERE k = 'inv_direct') AND task_id = (SELECT id FROM v WHERE k = 't1');
-- Одним запросом меняют и счёт, и задачу связи: занятость второй задачи в исходном счёте видна.
-- (После первого create_invoice проверка снимка плательщика срабатывает сразу, поэтому задача
-- с тем же плательщиком прибора, что у счёта.)
INSERT INTO invoice_tasks (invoice_id, task_id) VALUES ((SELECT id FROM v WHERE k = 'inv_t1'), (SELECT id FROM v WHERE k = 't7'));
SELECT pg_temp.check(position((SELECT number FROM invoices WHERE id = (SELECT id FROM v WHERE k = 'inv_t1')) IN pg_temp.expect_error(format(
  'UPDATE invoice_tasks SET invoice_id = %L, task_id = %L WHERE invoice_id = %L AND task_id = %L',
  (SELECT id FROM v WHERE k = 'inv_direct'), (SELECT id FROM v WHERE k = 't7'), (SELECT id FROM v WHERE k = 'inv_t1'), (SELECT id FROM v WHERE k = 't1')),
  'связь не переписать на задачу, которая уже в исходном счёте')) > 0, 'в ошибке номер счёта, где задача уже есть');
DELETE FROM invoice_tasks WHERE invoice_id = (SELECT id FROM v WHERE k = 'inv_t1') AND task_id = (SELECT id FROM v WHERE k = 't7');
RESET ROLE;

-- Гарантия самой базы: без триггеров (как при одновременных запросах) вторую действующую связь не записать.
SET session_replication_role = replica;
SELECT pg_temp.check(position('invoice_tasks_one_active_invoice_uq' IN pg_temp.expect_error(format('INSERT INTO invoice_tasks (invoice_id, task_id, invoice_active) VALUES (%L, %L, true)',
  (SELECT id FROM v WHERE k = 'inv_direct'), (SELECT id FROM v WHERE k = 't1')), 'без триггеров вторая действующая связь не записывается')) > 0,
  'уникальный индекс не пускает задачу во второй действующий счёт');
SET session_replication_role = origin;

-- Владелец схемы удаляет счёт целиком (вручную, не через API): строки и связи уходят вместе с ним.
INSERT INTO invoice_items (invoice_id, item_type, work_type_code, task_id, description, quantity, unit_price)
SELECT (SELECT id FROM v WHERE k = 'inv_t1'), 'work', code, (SELECT id FROM v WHERE k = 't1'), 'Работа по задаче', 1, 100
  FROM work_types WHERE is_active ORDER BY code LIMIT 1;
DELETE FROM invoices WHERE id = (SELECT id FROM v WHERE k = 'inv_t1');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM invoice_tasks WHERE invoice_id = (SELECT id FROM v WHERE k = 'inv_t1'))
  AND NOT EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = (SELECT id FROM v WHERE k = 'inv_t1')),
  'владелец схемы удаляет счёт со строками и задачами одной командой');

-- Замена плательщика задачи координатором, потом руководитель меняет прибор.
SELECT pg_temp.act_as((SELECT id FROM v WHERE k = 'coord'));
UPDATE tasks SET payer_id = (SELECT id FROM v WHERE k = 'p2'), payer_override_reason = 'Платит головная', payer_overridden_by = auth.uid()
 WHERE id = (SELECT id FROM v WHERE k = 't4');
SELECT pg_temp.check((SELECT payer_snapshot_source FROM tasks WHERE id = (SELECT id FROM v WHERE k = 't4')) = 'override', 'координатор заменил плательщика задачи');
RESET ROLE;
SELECT pg_temp.act_as((SELECT id FROM v WHERE k = 'sup'));
UPDATE tasks SET equipment_id = (SELECT id FROM v WHERE k = 'eq2') WHERE id = (SELECT id FROM v WHERE k = 't4');
SELECT pg_temp.check((SELECT payer_overridden_by FROM tasks WHERE id = (SELECT id FROM v WHERE k = 't4')) = auth.uid(),
  'руководитель меняет прибор такой задачи, автором замены становится он');
SELECT pg_temp.check((SELECT payer_overridden_at FROM tasks WHERE id = (SELECT id FROM v WHERE k = 't4')) IS NOT NULL,
  'время замены заполнено заново');
RESET ROLE;

-- Кладовщик счёт не создаёт.
SELECT pg_temp.act_as((SELECT id FROM v WHERE k = 'wh'));
SELECT pg_temp.expect_error(format('SELECT public.create_invoice(%L, ARRAY[%L]::uuid[], NULL)',
  (SELECT id FROM v WHERE k = 'p1'), (SELECT id FROM v WHERE k = 't2')), 'кладовщик не создаёт счёт');
RESET ROLE;

-- Без входа функция недоступна.
SET LOCAL ROLE anon;
SELECT pg_temp.expect_error(format('SELECT public.create_invoice(%L, ARRAY[%L]::uuid[], NULL)',
  (SELECT id FROM v WHERE k = 'p1'), (SELECT id FROM v WHERE k = 't2')), 'без входа счёт не создаётся');
RESET ROLE;

-- Старый счёт отменяется и после смены плательщика прибора: проверка снимка нужна при
-- привязке задачи, а не при отметке об отмене. Отложенную проверку запускаем сразу.
UPDATE equipment SET current_payer_id = (SELECT id FROM v WHERE k = 'p2') WHERE id = (SELECT id FROM v WHERE k = 'eq2');
SELECT pg_temp.act_as((SELECT id FROM v WHERE k = 'coord'));
SET CONSTRAINTS invoice_tasks_payer_snapshot_valid IMMEDIATE;
UPDATE invoices SET status = 'cancelled'
 WHERE id = (SELECT invoice_id FROM invoice_tasks WHERE task_id = (SELECT id FROM v WHERE k = 't2') AND invoice_active);
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM invoice_tasks WHERE task_id IN (SELECT id FROM v WHERE k IN ('t2', 't5')) AND invoice_active),
  'счёт отменён после смены плательщика прибора, его задачи свободны');
RESET ROLE;

ROLLBACK;
