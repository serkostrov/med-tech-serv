-- Проверка прав по ролям (миграция 0009). Запуск на локальной базе с применёнными миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/role_access.sql
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

-- Сколько строк изменила команда
CREATE FUNCTION pg_temp.rows_affected(p_sql text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.check(boolean, text),
  pg_temp.expect_denied(text, text), pg_temp.expect_forbidden(text, text), pg_temp.rows_affected(text) TO authenticated, anon;

-- Данные (от владельца, RLS не действует)
CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid);
GRANT SELECT ON ids TO authenticated;

DO $$
DECLARE
  roles text[] := ARRAY['coordinator', 'engineer', 'engineer2', 'warehouse', 'supervisor', 'admin', 'initiator', 'inactive', 'customer', 'customer2'];
  r text; uid uuid; base text;
  org uuid; site uuid; payer uuid; manuf uuid; model uuid; eq uuid; wt text;
  t1 uuid; t2 uuid; inv uuid; part uuid; ctr uuid;
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

  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by, deadline_from, deadline_to, status_code)
  VALUES ('Задача инженера 1', wt, eq, site, payer, (SELECT id FROM ids WHERE k = 'engineer'), (SELECT id FROM ids WHERE k = 'coordinator'), current_date, current_date + 7, 'assigned')
  RETURNING id INTO t1;
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by, deadline_from, deadline_to, status_code)
  VALUES ('Задача инженера 2', wt, eq, site, payer, (SELECT id FROM ids WHERE k = 'engineer2'), (SELECT id FROM ids WHERE k = 'coordinator'), current_date, current_date + 7, 'assigned')
  RETURNING id INTO t2;
  INSERT INTO ids VALUES ('site', site);
  INSERT INTO customer_organization_access (customer_user_id, organization_id) VALUES ((SELECT id FROM ids WHERE k = 'customer'), org);

  INSERT INTO invoices (payer_id, payer_name) VALUES (payer, 'Тестовый плательщик') RETURNING id INTO inv;
  INSERT INTO price_list (work_type_code, valid_from, amount) VALUES (wt, current_date, 15000);
  INSERT INTO contracts (name, total_amount) VALUES ('Договор тест', 500000) RETURNING id INTO ctr;
  INSERT INTO parts (article_number, name) VALUES ('ART-1', 'Клапан тест') RETURNING id INTO part;

  INSERT INTO ids VALUES ('t1', t1), ('t2', t2), ('invoice', inv), ('part', part), ('equipment', eq), ('contract', ctr), ('payer', payer);
END $$;

-- ---------------------------------------------------------------- Инженер
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer'));
SELECT pg_temp.check((SELECT count(*) FROM tasks) = 1, 'инженер видит только свою задачу');
SELECT pg_temp.check((SELECT count(*) FROM tasks WHERE id = (SELECT id FROM ids WHERE k = 't2')) = 0, 'инженер не видит чужую задачу');
SELECT pg_temp.check((SELECT count(*) FROM invoices) = 0, 'инженер не видит счета');
SELECT pg_temp.check((SELECT count(*) FROM price_list) = 0, 'инженер не видит прайс');
SELECT pg_temp.check((SELECT count(*) FROM contracts) = 0, 'инженер не видит договоры и суммы');
SELECT pg_temp.check((SELECT count(*) FROM equipment) = 1, 'инженер видит приборы');
SELECT pg_temp.check((SELECT count(*) FROM parts) = 1, 'инженер видит склад');
SELECT pg_temp.check(pg_temp.rows_affected(format('UPDATE tasks SET work_description = %L WHERE id = %L', 'Заменён клапан', (SELECT id FROM ids WHERE k = 't1'))) = 1, 'инженер заполняет акт своей задачи');
SELECT pg_temp.check(pg_temp.rows_affected(format('UPDATE tasks SET work_description = %L WHERE id = %L', 'взлом', (SELECT id FROM ids WHERE k = 't2'))) = 0, 'инженер не меняет чужую задачу');
SELECT pg_temp.expect_denied(format('UPDATE tasks SET engineer_id = %L WHERE id = %L', (SELECT id FROM ids WHERE k = 'engineer2'), (SELECT id FROM ids WHERE k = 't1')), 'инженер не переназначает задачу');
SELECT pg_temp.expect_denied(format('UPDATE tasks SET payer_requisites = %L::jsonb WHERE id = %L', '{"inn":"000"}', (SELECT id FROM ids WHERE k = 't1')), 'инженер не меняет реквизиты плательщика');
SELECT pg_temp.expect_denied(format('UPDATE tasks SET deadline_to = deadline_to + 30 WHERE id = %L', (SELECT id FROM ids WHERE k = 't1')), 'инженер не переносит сроки');
SELECT pg_temp.expect_denied('INSERT INTO invoices (payer_id, payer_name) SELECT id, ''x'' FROM payers LIMIT 1', 'инженер не создаёт счёт');
SELECT pg_temp.expect_denied('INSERT INTO parts (article_number, name) VALUES (''X'', ''Y'')', 'инженер не создаёт запчасти');
SELECT pg_temp.check(pg_temp.rows_affected('DELETE FROM tasks') = 0, 'инженер не удаляет задачи');
SELECT pg_temp.check(pg_temp.rows_affected(format('UPDATE users SET access_role_key = %L WHERE id = auth.uid()', 'admin')) = 0, 'инженер не повышает себе роль');
SELECT pg_temp.check((SELECT count(*) FROM audit_log) = 0, 'инженер не читает журнал аудита');
SELECT pg_temp.expect_forbidden(format('UPDATE tasks SET status_code = %L, cancellation_reason = %L WHERE id = %L', 'cancelled', 'сам отменил', (SELECT id FROM ids WHERE k = 't1')), 'инженер не отменяет задачу');
SELECT pg_temp.expect_forbidden(format('UPDATE tasks SET status_code = %L, call_reason = %L WHERE id = %L', 'closed', 'поломка', (SELECT id FROM ids WHERE k = 't1')), 'инженер не закрывает задачу сам');
SELECT pg_temp.check(pg_temp.rows_affected(format('UPDATE tasks SET status_code = %L WHERE id = %L AND status_code = %L', 'in_progress', (SELECT id FROM ids WHERE k = 't1'), 'assigned')) = 1, 'инженер принимает задачу в работу');
RESET ROLE;

-- ---------------------------------------------------------------- Координатор
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'coordinator'));
SELECT pg_temp.check((SELECT count(*) FROM tasks) = 2, 'координатор видит все задачи');
SELECT pg_temp.check((SELECT count(*) FROM invoices) = 1, 'координатор видит счета');
SELECT pg_temp.check((SELECT count(*) FROM price_list) = 1, 'координатор видит прайс');
SELECT pg_temp.check((SELECT count(*) FROM contracts) = 1, 'координатор видит договоры');
SELECT pg_temp.check(pg_temp.rows_affected(format('UPDATE tasks SET engineer_id = %L WHERE id = %L', (SELECT id FROM ids WHERE k = 'engineer'), (SELECT id FROM ids WHERE k = 't2'))) = 1, 'координатор переназначает задачу');
SELECT pg_temp.check(pg_temp.rows_affected(format('INSERT INTO invoices (payer_id, payer_name) VALUES (%L, %L)', (SELECT id FROM ids WHERE k = 'payer'), 'Плательщик')) = 1, 'координатор создаёт счёт');
SELECT pg_temp.check(pg_temp.rows_affected(format(
  'INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, deadline_from, deadline_to) SELECT %L, code, %L, %L, %L, current_date, current_date + 3 FROM work_types WHERE is_active ORDER BY code LIMIT 1',
  'Новая заявка', (SELECT id FROM ids WHERE k = 'equipment'), (SELECT id FROM ids WHERE k = 'site'), (SELECT id FROM ids WHERE k = 'payer'))) = 1, 'координатор создаёт задачу');
SELECT pg_temp.check((SELECT count(*) FROM audit_log) > 0, 'координатор читает журнал, служебные записи пишутся');
SELECT pg_temp.check((SELECT count(*) FROM task_status_history) >= 0, 'история статусов доступна координатору');
RESET ROLE;

-- После переназначения вторая задача стала видна первому инженеру
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer'));
SELECT pg_temp.check((SELECT count(*) FROM tasks) = 2, 'после назначения инженер видит обе свои задачи');
RESET ROLE;

-- ---------------------------------------------------------------- Кладовщик
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'warehouse'));
SELECT pg_temp.check((SELECT count(*) FROM parts) = 1, 'кладовщик видит склад');
SELECT pg_temp.check(pg_temp.rows_affected('INSERT INTO parts (article_number, name) VALUES (''ART-2'', ''Фильтр'')') = 1, 'кладовщик добавляет запчасть');
SELECT pg_temp.check((SELECT count(*) FROM invoices) = 0, 'кладовщик не видит счета');
SELECT pg_temp.check((SELECT count(*) FROM price_list) = 0, 'кладовщик не видит прайс');
SELECT pg_temp.check((SELECT count(*) FROM tasks) = 0, 'кладовщик не видит задачи без резервов');
RESET ROLE;

-- ---------------------------------------------------------------- Администратор
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'admin'));
SELECT pg_temp.check((SELECT count(*) FROM price_list) = 1, 'администратор видит прайс');
SELECT pg_temp.check((SELECT count(*) FROM invoices) = 0, 'администратор не видит деньги задач');
SELECT pg_temp.check(pg_temp.rows_affected(format('UPDATE users SET full_name = %L WHERE id = %L', 'Инженер Переименован', (SELECT id FROM ids WHERE k = 'engineer2'))) = 1, 'администратор меняет сотрудника');
RESET ROLE;

-- ---------------------------------------------------------------- Руководитель
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'supervisor'));
SELECT pg_temp.check((SELECT count(*) FROM tasks) >= 2, 'руководитель видит задачи');
SELECT pg_temp.check((SELECT count(*) FROM invoices) >= 1, 'руководитель видит счета');
RESET ROLE;

-- ---------------------------------------------------------------- Отключённый сотрудник
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'inactive'));
SELECT pg_temp.check((SELECT count(*) FROM tasks) = 0, 'отключённый сотрудник ничего не видит');
SELECT pg_temp.check((SELECT count(*) FROM users) = 0, 'отключённый сотрудник не видит сотрудников');
RESET ROLE;

-- ---------------------------------------------------------------- Инициатор
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'initiator'));
SELECT pg_temp.check(pg_temp.rows_affected(format(
  'INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, deadline_from, deadline_to) SELECT %L, code, %L, %L, %L, current_date, current_date + 3 FROM work_types WHERE is_active ORDER BY code LIMIT 1 RETURNING id',
  'Заявка инициатора', (SELECT id FROM ids WHERE k = 'equipment'), (SELECT id FROM ids WHERE k = 'site'), (SELECT id FROM ids WHERE k = 'payer'))) = 1, 'инициатор создаёт заявку и получает её номер');
SELECT pg_temp.expect_forbidden(format(
  'INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, deadline_from, deadline_to, engineer_id, status_code) SELECT %L, code, %L, %L, %L, current_date, current_date + 3, %L, %L FROM work_types WHERE is_active ORDER BY code LIMIT 1',
  'Сразу в работу', (SELECT id FROM ids WHERE k = 'equipment'), (SELECT id FROM ids WHERE k = 'site'), (SELECT id FROM ids WHERE k = 'payer'), (SELECT id FROM ids WHERE k = 'engineer'), 'in_progress'), 'инициатор не назначает инженера при создании');
SELECT pg_temp.check((SELECT count(*) FROM tasks) = 1, 'инициатор видит только свою заявку');
RESET ROLE;

-- ---------------------------------------------------------------- Подделка приёмки акта
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer'));
SELECT pg_temp.expect_forbidden(format(
  'INSERT INTO task_closures (task_id, submitted_by, submitted_at, verified_by, verified_at) VALUES (%L, auth.uid(), now(), %L, now())',
  (SELECT id FROM ids WHERE k = 't1'), (SELECT id FROM ids WHERE k = 'coordinator')), 'инженер не ставит приёмку акта от имени координатора');
SELECT pg_temp.expect_forbidden('SELECT public.accept_task_closure(id, auth.uid(), ''ok'', now()) FROM tasks LIMIT 1', 'инженер не принимает закрытие');
SELECT pg_temp.check(pg_temp.rows_affected('DELETE FROM task_status_history') = 0, 'инженер не правит историю статусов');
SELECT pg_temp.expect_forbidden('SELECT count(*) FROM public.load_email_event_plan(gen_random_uuid())', 'инженер не вызывает служебные функции очереди');
RESET ROLE;

-- ---------------------------------------------------------------- Клиент
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'customer'));
SELECT pg_temp.check((SELECT count(*) FROM tasks) = 4, 'клиент видит задачи своей организации');
SELECT pg_temp.check((SELECT count(*) FROM invoices) = 0, 'клиент не видит счета');
SELECT pg_temp.check((SELECT count(*) FROM price_list) = 0, 'клиент не видит прайс');
SELECT pg_temp.check(pg_temp.rows_affected(format('UPDATE tasks SET work_description = %L WHERE id = %L', 'клиент', (SELECT id FROM ids WHERE k = 't1'))) = 0, 'клиент не меняет задачи');
SELECT pg_temp.check((SELECT count(*) FROM payers) = 0, 'клиент не видит плательщиков и реквизиты');
SELECT pg_temp.check((SELECT count(*) FROM users WHERE email LIKE 'coordinator%') = 0, 'клиент не видит координаторов и их почту');
SELECT pg_temp.check((SELECT count(*) FROM organizations) = 1, 'клиент видит только свою организацию');
RESET ROLE;
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'customer2'));
SELECT pg_temp.check((SELECT count(*) FROM tasks) = 0, 'клиент без доступа к организации задач не видит');
RESET ROLE;

-- ---------------------------------------------------------------- Без входа
SET LOCAL ROLE anon;
SELECT pg_temp.check((SELECT count(*) FROM tasks) = 0, 'без входа задачи не видны');
SELECT pg_temp.check((SELECT count(*) FROM invoices) = 0, 'без входа счета не видны');
SELECT pg_temp.expect_denied('TRUNCATE task_status_history', 'без входа нельзя очистить таблицу');
SELECT pg_temp.expect_denied('SELECT count(*) FROM task_board_positions', 'без входа порядок карточек на доске не виден');
SELECT pg_temp.expect_forbidden('SELECT count(*) FROM public.claim_business_events(1000, now(), now() + interval ''100 years'')', 'без входа нельзя забрать очередь уведомлений');
SELECT pg_temp.expect_forbidden('SELECT count(*) FROM public.activate_due_maintenance_tasks(''2100-01-01'', now())', 'без входа нельзя запустить задачи ТО');
SELECT pg_temp.expect_forbidden('SELECT setval(''task_number_seq'', 1)', 'без входа нельзя сбить нумерацию задач');
RESET ROLE;

-- ---------------------------------------------------------------- Свой номер Telegram (0021)
-- Своя роль на базе «инженер» с правом назначать: политика UPDATE пускает к своей строке.
-- Проверка идёт до первого вызова set_my_telegram_chat_id в сессии: метки app.own_telegram_chat ещё нет (NULL).
DO $$
DECLARE uid uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.access_roles (key, name, base_role) VALUES ('lead_engineer', 'Старший инженер', 'engineer');
  INSERT INTO public.access_role_permissions (role_key, permission_code)
    SELECT 'lead_engineer', permission_code FROM public.access_role_permissions WHERE role_key = 'engineer'
    UNION SELECT 'lead_engineer', 'tasks.assign';
  INSERT INTO auth.users (id, email, aud, role) VALUES (uid, 'lead@test.local', 'authenticated', 'authenticated');
  INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key) VALUES (uid, 'Тест lead', 'engineer', 'lead@test.local', true, 'lead_engineer');
  INSERT INTO ids VALUES ('lead', uid);
END $$;
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'lead'));
SELECT pg_temp.check(current_setting('app.own_telegram_chat', true) IS NULL, 'метки ещё нет: проверяем свежее соединение');
SELECT pg_temp.expect_denied(format('UPDATE public.users SET telegram_chat_id = %L WHERE id = %L', '-1001234567890', (SELECT id FROM ids WHERE k = 'lead')), 'свой номер напрямую (минуя функцию) не поменять, даже если строка своя доступна на запись');
RESET ROLE;
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer'));
SELECT pg_temp.check((SELECT public.set_my_telegram_chat_id(' 123456789 ')) = '123456789', 'инженер сохраняет свой номер чата через функцию');
SELECT pg_temp.check(pg_temp.rows_affected(format('UPDATE public.users SET telegram_chat_id = %L WHERE id = %L', '555', (SELECT id FROM ids WHERE k = 'engineer'))) = 0, 'свой номер напрямую инженер не меняет');
DO $$ BEGIN
  PERFORM public.set_my_telegram_chat_id('-1001234567890');
  RAISE EXCEPTION 'ПРОВАЛ: номер группы сам себе не вписать — команда прошла';
EXCEPTION WHEN invalid_parameter_value THEN
  RAISE NOTICE 'ok: номер группы сам себе не вписать (запрещено)';
END $$;
RESET ROLE;
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'coordinator'));
SELECT pg_temp.expect_denied(format('UPDATE public.users SET telegram_chat_id = %L WHERE id = %L', '777', (SELECT id FROM ids WHERE k = 'engineer')), 'координатор не меняет номер чата инженера');
SELECT pg_temp.check((SELECT public.set_my_telegram_chat_id('987654321')) = '987654321', 'координатор сохраняет свой номер');
RESET ROLE;
SELECT pg_temp.check((SELECT telegram_chat_id FROM public.users WHERE id = (SELECT id FROM ids WHERE k = 'engineer')) = '123456789', 'номер инженера остался его собственным');

-- ---------------------------------------------------------------- Служебные функции закрыты
SELECT pg_temp.check(NOT EXISTS (
  SELECT 1 FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef AND p.prorettype <> 'trigger'::regtype
     AND has_function_privilege('anon', p.oid, 'EXECUTE')
), 'аноним не вызывает ни одной SECURITY DEFINER функции');
SELECT pg_temp.check(NOT EXISTS (
  SELECT 1 FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef AND p.prorettype <> 'trigger'::regtype
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
     AND p.proname NOT IN ('app_has_permission', 'app_has_any_permission', 'app_can_read_task', 'app_can_write_task',
       'app_can_read_equipment', 'app_can_write_equipment', 'app_storage_object_access', 'app_is_staff',
       'app_current_role_key', 'app_customer_organization_ids', 'app_task_is_open', 'app_is_task_engineer',
       'app_task_accepts_reservations', 'is_app_user', 'create_access_user', 'accept_task_closure',
       'change_equipment_site', 'change_equipment_payer', 'set_my_telegram_chat_id')
), 'сотрудник вызывает только разрешённые SECURITY DEFINER функции');
CREATE FUNCTION public.zz_role_test_probe() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
SELECT pg_temp.check(NOT has_function_privilege('anon', 'public.zz_role_test_probe()', 'EXECUTE'), 'новая функция из будущей миграции закрыта для анонима');

ROLLBACK;
