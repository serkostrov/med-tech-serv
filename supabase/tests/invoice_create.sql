-- Проверка создания счёта и замены плательщика (миграции 0010, 0015, 0016). Запуск на локальной базе с миграциями:
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
GRANT SELECT ON v TO authenticated, anon;

DO $$
DECLARE
  coord uuid := gen_random_uuid(); wh uuid := gen_random_uuid(); sup uuid := gen_random_uuid(); t4 uuid;
  org uuid; site uuid; p1 uuid; p2 uuid; m uuid; md uuid; eq1 uuid; eq2 uuid; eq3 uuid; t1 uuid; t2 uuid; t3 uuid; wt text;
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
  INSERT INTO v VALUES ('coord', coord), ('wh', wh), ('sup', sup), ('p1', p1), ('p2', p2), ('eq1', eq1), ('eq2', eq2), ('t1', t1), ('t2', t2), ('t3', t3), ('t4', t4);
END $$;

-- Подготовка: задачи закрываем в обход проверок закрытия (акт и фото здесь не проверяем).
SET session_replication_role = replica;
UPDATE tasks SET status_code = 'closed', engineer_id = (SELECT id FROM v WHERE k = 'coord'),
       call_reason = 'Поломка', work_description = 'Ремонт выполнен'
 WHERE id IN (SELECT id FROM v WHERE k IN ('t1', 't2', 't3'));
SET session_replication_role = origin;

SELECT pg_temp.act_as((SELECT id FROM v WHERE k = 'coord'));

SELECT pg_temp.check((SELECT public.create_invoice((SELECT id FROM v WHERE k = 'p1'), ARRAY[(SELECT id FROM v WHERE k = 't1')], NULL)) IS NOT NULL,
  'координатор создаёт счёт по закрытой задаче');
SELECT pg_temp.check((SELECT count(*) FROM invoices i JOIN invoice_tasks it ON it.invoice_id = i.id WHERE it.task_id = (SELECT id FROM v WHERE k = 't1') AND i.payer_snapshot_source = 'equipment') = 1,
  'счёт привязан к задаче, плательщик из прибора');

SELECT pg_temp.check((SELECT public.create_invoice((SELECT id FROM v WHERE k = 'p1'), ARRAY[(SELECT id FROM v WHERE k = 't1'), (SELECT id FROM v WHERE k = 't2')], NULL)) IS NOT NULL,
  'две задачи на разных приборах с одним плательщиком');

SELECT pg_temp.check((SELECT count(*) FROM invoices) = 2, 'пока два счёта');
SELECT pg_temp.expect_error(format('SELECT public.create_invoice(%L, ARRAY[%L, %L]::uuid[], NULL)',
  (SELECT id FROM v WHERE k = 'p1'), (SELECT id FROM v WHERE k = 't1'), (SELECT id FROM v WHERE k = 't3')),
  'задачи с разными плательщиками отклоняются');
SELECT pg_temp.check((SELECT count(*) FROM invoices) = 2, 'после ошибки пустой черновик не остался');

SELECT pg_temp.expect_error(format('SELECT public.create_invoice(%L, ARRAY[%L]::uuid[], NULL)',
  (SELECT id FROM v WHERE k = 'p2'), (SELECT id FROM v WHERE k = 't1')),
  'другой плательщик без причины отклоняется');

SELECT pg_temp.check((SELECT public.create_invoice((SELECT id FROM v WHERE k = 'p2'), ARRAY[(SELECT id FROM v WHERE k = 't1')], 'Оплачивает головная организация')) IS NOT NULL,
  'другой плательщик с причиной');
SELECT pg_temp.check((SELECT payer_overridden_by FROM invoices WHERE payer_snapshot_source = 'override') = auth.uid(),
  'автор замены — вошедший координатор');

-- Подделка автора замены прямой вставкой: автор всё равно вошедший пользователь.
INSERT INTO invoices (payer_id, status, source_equipment_id, payer_override_reason, payer_overridden_by)
VALUES ((SELECT id FROM v WHERE k = 'p2'), 'draft', (SELECT id FROM v WHERE k = 'eq1'), 'тест', (SELECT id FROM v WHERE k = 'wh'));
SELECT pg_temp.check((SELECT count(*) FROM invoices WHERE payer_overridden_by = (SELECT id FROM v WHERE k = 'wh')) = 0,
  'подставить чужого автора замены нельзя');
RESET ROLE;

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

ROLLBACK;
