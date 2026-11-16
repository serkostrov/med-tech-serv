-- Журналы изменений и входов (миграции 0057, 0058, 0059). Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/audit_journal.sql
-- Всё выполняется в транзакции и откатывается. Ошибка = проверка не прошла.

BEGIN;

-- Вход сотрудника, как его передаёт PostgREST (токен в request.jwt.claims),
-- и адрес обращения, как его передаёт обратный прокси.
CREATE FUNCTION pg_temp.act_as(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE FUNCTION pg_temp.act_as_anon() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  EXECUTE 'SET LOCAL ROLE anon';
END $$;

CREATE FUNCTION pg_temp.act_as_nobody() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
END $$;

CREATE FUNCTION pg_temp.from_ip(p_ip text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.headers', json_build_object('x-forwarded-for', p_ip)::text, true);
END $$;

CREATE FUNCTION pg_temp.check(p_ok boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'ПРОВАЛ: %', p_label;
  END IF;
  RAISE NOTICE 'ok: %', p_label;
END $$;

CREATE FUNCTION pg_temp.expect_denied(p_sql text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  -- Отказ приходит либо по правам и стражам, либо потому, что в такое представление
  -- писать нечем (55000, object_not_in_prerequisite_state): оба исхода — «нельзя».
  EXCEPTION WHEN insufficient_privilege OR check_violation OR raise_exception
    OR feature_not_supported OR object_not_in_prerequisite_state OR invalid_parameter_value THEN
    RAISE NOTICE 'ok: % (запрещено)', p_label;
    RETURN;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — команда прошла, а должна быть запрещена', p_label;
END $$;

CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid);
GRANT SELECT ON ids TO authenticated, anon;
CREATE FUNCTION pg_temp.uid(p_key text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM ids WHERE k = p_key
$$;
GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.act_as_anon(), pg_temp.act_as_nobody(),
  pg_temp.check(boolean, text), pg_temp.expect_denied(text, text), pg_temp.uid(text), pg_temp.from_ip(text)
  TO authenticated, anon;

-- Сотрудники всех ролей, которые спорят за журнал, и немного событий в журнале аудита.
DO $$
DECLARE
  r text;
  uid uuid;
  base text;
  org uuid; site uuid; payer uuid; manuf uuid; model uuid; eq uuid; task uuid; inv uuid; wt text;
BEGIN
  -- Своя роль «Аудитор»: журнал смотреть можно, финансов нет. Именно такая роль, а не
  -- встроенный администратор: у встроенного администратора права на журнал нет вовсе
  -- (0017: «администратор не читает глобальный операционный аудит»), и это проверяется ниже.
  INSERT INTO access_roles (key, name, base_role) VALUES ('auditor', 'Аудитор', 'admin');
  INSERT INTO access_role_permissions (role_key, permission_code) VALUES ('auditor', 'audit.read');

  FOREACH r IN ARRAY ARRAY['coordinator', 'supervisor', 'admin', 'sysadmin', 'auditor', 'engineer', 'warehouse', 'customer'] LOOP
    uid := gen_random_uuid();
    base := CASE r WHEN 'sysadmin' THEN 'admin' WHEN 'auditor' THEN 'admin' ELSE r END;
    INSERT INTO auth.users (id, email, aud, role) VALUES (uid, r || '@journal.test', 'authenticated', 'authenticated');
    INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
    VALUES (uid, 'Журнал ' || r, base::user_role, r || '@journal.test', true, r);
    INSERT INTO ids VALUES (r, uid);
  END LOOP;

  INSERT INTO organizations (name) VALUES ('Журнал: больница') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('Журнал: площадка', org) RETURNING id INTO site;
  INSERT INTO payers (name) VALUES ('Журнал: плательщик') RETURNING id INTO payer;
  INSERT INTO manufacturers (name) VALUES ('Журнал: производитель') RETURNING id INTO manuf;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (manuf, 'Журнал: модель') RETURNING id INTO model;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  VALUES ('JOURNAL-1', manuf, model, site, payer) RETURNING id INTO eq;
  SELECT code INTO wt FROM work_types WHERE is_active ORDER BY code LIMIT 1;
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, created_by, deadline_from, deadline_to)
  VALUES ('Журнал: задача', wt, eq, site, payer, (SELECT id FROM ids WHERE k = 'coordinator'), current_date, current_date + 3)
  RETURNING id INTO task;
  INSERT INTO customer_organization_access (customer_user_id, organization_id)
  VALUES ((SELECT id FROM ids WHERE k = 'customer'), org);
  INSERT INTO ids VALUES ('task', task), ('equipment', eq), ('payer', payer);
END $$;

-- Правки от координатора: именно они и должны быть видны на экране журнала.
SELECT pg_temp.act_as(pg_temp.uid('coordinator'));
UPDATE tasks SET title = 'Журнал: задача (исправлено)' WHERE id = pg_temp.uid('task');
UPDATE equipment SET notes = 'Журнал: прибор проверен' WHERE id = pg_temp.uid('equipment');
INSERT INTO invoices (payer_id, payer_name, total_amount) VALUES (pg_temp.uid('payer'), 'Журнал: плательщик', 125000);
SELECT pg_temp.act_as_nobody();

-- ---------------------------------------------------------------- Экран журнала изменений
SELECT pg_temp.act_as(pg_temp.uid('coordinator'));
SELECT pg_temp.check((SELECT count(*) FROM audit_log_journal WHERE entity_type = 'task' AND entity_id = pg_temp.uid('task')::text) >= 2,
  'в журнале изменений есть события по задаче: создание и правка');
SELECT pg_temp.check((SELECT actor_name FROM audit_log_journal
                       WHERE entity_type = 'task' AND entity_id = pg_temp.uid('task')::text AND action = 'updated'
                       ORDER BY id DESC LIMIT 1) = 'Журнал coordinator',
  'в журнале изменений видно имя автора правки, а не только его идентификатор');
SELECT pg_temp.check((SELECT 'title' = ANY (changed_fields) FROM audit_log_journal
                       WHERE entity_type = 'task' AND entity_id = pg_temp.uid('task')::text AND action = 'updated'
                       ORDER BY id DESC LIMIT 1),
  'в журнале изменений видно, какое поле поменяли');
SELECT pg_temp.check((SELECT table_name FROM audit_log_journal
                       WHERE entity_type = 'task' AND entity_id = pg_temp.uid('task')::text AND action = 'updated'
                       ORDER BY id DESC LIMIT 1) = 'tasks',
  'в журнале изменений видно, в какой таблице была правка');
SELECT pg_temp.check((SELECT before_data ->> 'title' FROM audit_log_journal
                       WHERE entity_type = 'task' AND entity_id = pg_temp.uid('task')::text AND action = 'updated'
                       ORDER BY id DESC LIMIT 1) = 'Журнал: задача',
  'в журнале изменений видно, как было до правки');
-- Отбор и счёт идут в базе: страница журнала не считается в браузере.
SELECT pg_temp.check((SELECT count(*) FROM audit_log_journal WHERE occurred_at >= now() - interval '1 hour') > 0
  AND (SELECT count(*) FROM audit_log_journal WHERE occurred_at < now() - interval '1 hour') = 0,
  'журнал изменений отбирается по дате в базе');
SELECT pg_temp.check((SELECT count(*) FROM audit_log_journal WHERE actor_user_id = pg_temp.uid('coordinator')) >= 3,
  'журнал изменений отбирается по человеку в базе');
SELECT pg_temp.check((SELECT count(*) FROM audit_log_journal WHERE entity_id ILIKE '%' || substring(pg_temp.uid('task')::text, 1, 8) || '%') >= 2,
  'поиск по номеру объекта идёт в базе');
SELECT pg_temp.act_as_nobody();

-- ---------------------------------------------------------------- Денежные поля
-- У координатора есть и просмотр журнала, и финансы: суммы счёта ему видны.
SELECT pg_temp.act_as(pg_temp.uid('coordinator'));
SELECT pg_temp.check((SELECT after_data ? 'total_amount' FROM audit_log_journal
                       WHERE entity_type = 'invoice' AND table_name = 'invoices' ORDER BY id DESC LIMIT 1),
  'координатору суммы счёта в журнале видны: у него есть и просмотр журнала, и финансы');
SELECT pg_temp.check((SELECT NOT money_hidden FROM audit_log_journal WHERE entity_type = 'invoice' AND table_name = 'invoices' ORDER BY id DESC LIMIT 1),
  'координатору журнал не говорит, что что-то скрыто');
SELECT pg_temp.act_as_nobody();
-- У своей роли «Аудитор» журнал есть, а финансов нет: суммы вырезаны, и об этом сказано прямо.
SELECT pg_temp.act_as(pg_temp.uid('auditor'));
SELECT pg_temp.check((SELECT count(*) FROM audit_log_journal WHERE entity_type = 'invoice') >= 1,
  'аудитор видит события по счёту');
SELECT pg_temp.check((SELECT NOT (after_data ? 'total_amount') FROM audit_log_journal
                       WHERE entity_type = 'invoice' AND table_name = 'invoices' ORDER BY id DESC LIMIT 1),
  'без права на финансы суммы счёта в журнале не достаются');
SELECT pg_temp.check((SELECT money_hidden FROM audit_log_journal WHERE entity_type = 'invoice' AND table_name = 'invoices' ORDER BY id DESC LIMIT 1),
  'журнал честно говорит, что по счёту показаны не все поля');
SELECT pg_temp.check((SELECT after_data ->> 'status' FROM audit_log_journal
                       WHERE entity_type = 'invoice' AND table_name = 'invoices' ORDER BY id DESC LIMIT 1) IS NOT NULL,
  'неденежные поля счёта аудитору видны');
-- Список изменённых полей идёт рядом со снимком: названий вырезанных полей в нём быть не должно.
SELECT pg_temp.check(NOT EXISTS (
  SELECT 1 FROM audit_log_journal AS event
   WHERE event.entity_type = 'invoice'
     AND 'total_amount' = ANY (event.changed_fields)),
  'без права на финансы в списке изменённых полей нет даже названий денежных');
SELECT pg_temp.act_as_nobody();
SELECT pg_temp.act_as(pg_temp.uid('coordinator'));
SELECT pg_temp.check(EXISTS (
  SELECT 1 FROM audit_log_journal AS event
   WHERE event.entity_type = 'invoice' AND event.table_name = 'invoices'
     AND 'total_amount' = ANY (event.changed_fields)),
  'с правом на финансы изменённые денежные поля в списке остаются');
SELECT pg_temp.act_as_nobody();
-- В событиях задачи и прибора денег нет с самой записи: вырезает audit_sanitize_jsonb.
SELECT pg_temp.check(NOT EXISTS (
  SELECT 1 FROM audit_log
   WHERE entity_type <> 'invoice'
     AND (after_data ? 'total_amount' OR after_data ? 'payer_requisites' OR before_data ? 'total_amount')),
  'вне счетов денежных полей в журнале нет вовсе');

-- ---------------------------------------------------------------- Кому журналы не положены
-- Инженер, кладовщик и заказчик — по ТЗ. Встроенный администратор здесь же: права на
-- журнал у него нет с 0017 («администратор не читает глобальный операционный аудит»),
-- и экран журналов это правило повторяет, а не обходит.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['engineer', 'warehouse', 'customer', 'admin'] LOOP
    PERFORM pg_temp.act_as((SELECT id FROM ids WHERE k = r));
    PERFORM pg_temp.check(NOT public.app_has_permission('audit.read'), format('у %s нет права на просмотр журнала', r));
    PERFORM pg_temp.check((SELECT count(*) FROM public.audit_log) = 0, format('%s не видит журнал аудита в таблице', r));
    PERFORM pg_temp.check((SELECT count(*) FROM public.audit_log_journal) = 0, format('%s не видит журнал изменений на экране', r));
    PERFORM pg_temp.check((SELECT count(*) FROM public.audit_log_timeline) = 0, format('%s не видит журнал аудита через представление-поток', r));
    PERFORM pg_temp.check((SELECT count(*) FROM public.login_events) = 0, format('%s не видит журнал входов', r));
    PERFORM pg_temp.expect_denied('SELECT public.login_journal()', format('%s не читает журнал входов функцией', r));
    PERFORM pg_temp.act_as_nobody();
  END LOOP;
END $$;

-- Руководитель и системный администратор журнал видят: право у них есть.
SELECT pg_temp.act_as(pg_temp.uid('supervisor'));
SELECT pg_temp.check((SELECT count(*) FROM audit_log_journal) > 0, 'руководитель видит журнал изменений');
SELECT pg_temp.act_as_nobody();
SELECT pg_temp.act_as(pg_temp.uid('sysadmin'));
SELECT pg_temp.check((SELECT count(*) FROM audit_log_journal) > 0, 'системный администратор видит журнал изменений');
SELECT pg_temp.act_as_nobody();

-- Без входа журналы закрыты полностью.
SELECT pg_temp.act_as_anon();
SELECT pg_temp.expect_denied('SELECT count(*) FROM public.audit_log_timeline', 'без входа журнал аудита не читается');
SELECT pg_temp.expect_denied('SELECT count(*) FROM public.audit_log_journal', 'без входа экранный журнал изменений не читается');
SELECT pg_temp.expect_denied('SELECT public.login_journal()', 'без входа журнал входов не читается');
SELECT pg_temp.act_as_nobody();

-- ---------------------------------------------------------------- Журнал не подчищают
SELECT pg_temp.act_as(pg_temp.uid('coordinator'));
SELECT pg_temp.expect_denied('UPDATE public.audit_log SET action = ''ничего не было''', 'событие журнала аудита не поправить');
SELECT pg_temp.expect_denied('DELETE FROM public.audit_log', 'событие журнала аудита не удалить');
SELECT pg_temp.expect_denied('TRUNCATE public.audit_log', 'журнал аудита не очистить');
SELECT pg_temp.expect_denied(
  'INSERT INTO public.audit_log (action, entity_type, entity_id) VALUES (''подделка'', ''task'', ''1'')',
  'событие в журнал аудита не дописать');
SELECT pg_temp.expect_denied(
  'INSERT INTO public.audit_log_timeline (action, entity_type, entity_id) VALUES (''подделка'', ''task'', ''1'')',
  'событие не дописать и через представление-поток');
SELECT pg_temp.expect_denied('UPDATE public.audit_log_timeline SET action = ''ничего не было''', 'через представление-поток событие не поправить');
SELECT pg_temp.expect_denied('DELETE FROM public.audit_log_journal', 'через экранное представление событие не удалить');
SELECT pg_temp.act_as_nobody();

SELECT pg_temp.check(
  (SELECT 'security_invoker=true' = ANY (coalesce(c.reloptions, ARRAY[]::text[]))
     FROM pg_class AS c WHERE c.oid = 'public.audit_log_timeline'::regclass),
  'представление-поток работает правами вызывающего, а не владельца');
SELECT pg_temp.check(
  (SELECT 'security_invoker=true' = ANY (coalesce(c.reloptions, ARRAY[]::text[]))
     FROM pg_class AS c WHERE c.oid = 'public.audit_log_journal'::regclass),
  'экранное представление журнала работает правами вызывающего');
SELECT pg_temp.check(NOT EXISTS (
  SELECT 1 FROM pg_policies AS p
   WHERE p.schemaname = 'public' AND p.tablename IN ('audit_log', 'login_events') AND p.cmd IN ('UPDATE', 'DELETE', 'ALL')),
  'правил изменения и удаления строк у журналов нет');
SELECT pg_temp.check(NOT EXISTS (
  SELECT 1 FROM pg_policies AS p
   WHERE p.schemaname = 'public' AND p.tablename = 'audit_log' AND p.cmd IN ('INSERT', 'ALL')),
  'правила вставки в журнал аудита нет');

-- ---------------------------------------------------------------- Журнал входов: запись
-- Неудачную попытку записывает экран входа, у которого сессии ещё нет.
SELECT pg_temp.act_as_anon();
SELECT pg_temp.from_ip('203.0.113.7');
SELECT public.record_failed_login('Engineer@Journal.Test', 'invalid_credentials');
SELECT public.record_failed_login('нет-такого@journal.test', 'invalid_credentials');
SELECT pg_temp.act_as_nobody();

SELECT pg_temp.check((SELECT count(*) FROM login_events) = 2, 'две неудачные попытки записаны');
SELECT pg_temp.check((SELECT user_id FROM login_events WHERE attempted_login = 'engineer@journal.test') = pg_temp.uid('engineer'),
  'по набранному адресу база сама нашла сотрудника');
SELECT pg_temp.check((SELECT host(ip_address) FROM login_events WHERE attempted_login = 'engineer@journal.test') = '203.0.113.7',
  'адрес обращения записан из заголовков запроса');
SELECT pg_temp.check((SELECT NOT success AND failure_reason = 'invalid_credentials'
                        FROM login_events WHERE attempted_login = 'engineer@journal.test'),
  'исход попытки записан: неудача и причина');
SELECT pg_temp.check((SELECT user_id IS NULL FROM login_events WHERE attempted_login = 'нет-такого@journal.test'),
  'попытка под неизвестным адресом записана без сотрудника');
SELECT pg_temp.check((SELECT count(*) FROM login_events WHERE user_agent IS NOT NULL) = 0,
  'строку браузера журнал не хранит');
SELECT pg_temp.check(NOT EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'login_events'
     AND column_name ~ '(password|secret|token|hash)'),
  'в журнале входов нет ни одного поля под пароль');

-- Подменить автора, исход, время и адрес из запроса нельзя: их ставит база.
SELECT pg_temp.act_as_anon();
SELECT pg_temp.from_ip('203.0.113.9');
INSERT INTO public.login_events (attempted_login, success, failure_reason, user_id, occurred_at, ip_address, user_agent)
VALUES ('подделка@journal.test', true, NULL, pg_temp.uid('coordinator'), timestamptz '2000-01-01', inet '10.0.0.1', 'Подделанный браузер');
SELECT pg_temp.act_as_nobody();
SELECT pg_temp.check((SELECT NOT success AND user_id IS NULL AND user_agent IS NULL
                        AND host(ip_address) = '203.0.113.9' AND occurred_at > now() - interval '1 minute'
                        AND failure_reason = 'unknown'
                        AND attempted_login = 'подделка@journal.test'
                        FROM login_events WHERE ip_address = inet '203.0.113.9'),
  'присланные успех, автор, время, адрес и браузер отброшены, остался только набранный адрес');

-- Завалить журнал потоком попыток не выйдет: сверх предела строки не пишутся,
-- но и затереть журнал потоком тоже нельзя — предел считается по паре
-- «адрес + набранный логин», а обрыв счёта виден отметкой.
SELECT pg_temp.act_as_anon();
SELECT pg_temp.from_ip('198.51.100.4');
DO $$
BEGIN
  FOR i IN 1..25 LOOP
    PERFORM public.record_failed_login('flood@journal.test', 'invalid_credentials');
  END LOOP;
END $$;
-- Настоящая попытка с того же адреса, но под другим адресом входа: поток её не вытеснил.
SELECT public.record_failed_login('coordinator@journal.test', 'invalid_credentials');
SELECT pg_temp.act_as_nobody();
SELECT pg_temp.check((SELECT count(*) FROM login_events
                       WHERE ip_address = inet '198.51.100.4' AND attempted_login = 'flood@journal.test') = 21,
  'сверх 20 попыток в минуту с пары «адрес и логин» пишется одна отметка и всё');
SELECT pg_temp.check((SELECT count(*) FROM login_events
                       WHERE ip_address = inet '198.51.100.4' AND attempted_login = 'flood@journal.test'
                         AND failure_reason = 'too_many_attempts') = 1,
  'обрыв счёта попыток виден в журнале отметкой «слишком много попыток»');
SELECT pg_temp.check((SELECT count(*) FROM login_events
                       WHERE ip_address = inet '198.51.100.4' AND attempted_login = 'coordinator@journal.test') = 1,
  'поток попыток под одним адресом не мешает записать попытку под другим');

-- Поток под разными логинами тоже никого не гасит: настоящая попытка сотрудника
-- записывается и после того, как журнал раздули сотнями чужих пар.
SELECT pg_temp.act_as_anon();
SELECT pg_temp.from_ip('198.51.100.5');
DO $$
BEGIN
  FOR i IN 1..600 LOOP
    PERFORM public.record_failed_login(format('spray%s@journal.test', i), 'invalid_credentials');
  END LOOP;
END $$;
SELECT pg_temp.from_ip('203.0.113.55');
SELECT public.record_failed_login('supervisor@journal.test', 'invalid_credentials');
SELECT pg_temp.act_as_nobody();
SELECT pg_temp.check((SELECT count(*) FROM login_events
                       WHERE ip_address = inet '203.0.113.55' AND attempted_login = 'supervisor@journal.test') = 1,
  'поток чужих попыток не мешает записать настоящую попытку сотрудника');
SELECT pg_temp.check((SELECT count(*) FROM login_events WHERE ip_address = inet '198.51.100.5') = 600,
  'каждая пара потока оставила ровно по строке, а не по два десятка');

-- Адрес с маской сети и без неё — один и тот же адрес, а не две разные пары.
SELECT pg_temp.act_as_anon();
SELECT pg_temp.from_ip('198.51.100.77/24');
SELECT public.record_failed_login('mask@journal.test', 'invalid_credentials');
SELECT pg_temp.from_ip('198.51.100.77');
SELECT public.record_failed_login('mask@journal.test', 'invalid_credentials');
SELECT pg_temp.act_as_nobody();
SELECT pg_temp.check((SELECT count(DISTINCT ip_address) FROM login_events WHERE attempted_login = 'mask@journal.test') = 1,
  'маска сети в заголовке не плодит в журнале разные адреса');

-- Строка журнала входов не меняется и не удаляется.
SELECT pg_temp.act_as(pg_temp.uid('coordinator'));
SELECT pg_temp.expect_denied('UPDATE public.login_events SET success = true', 'запись о входе не поправить');
SELECT pg_temp.expect_denied('DELETE FROM public.login_events', 'запись о входе не удалить');
SELECT pg_temp.expect_denied('TRUNCATE public.login_events', 'журнал входов не очистить');
SELECT pg_temp.act_as_nobody();

-- ---------------------------------------------------------------- Журнал входов: чтение
SELECT pg_temp.act_as(pg_temp.uid('supervisor'));
SELECT pg_temp.check((public.login_journal() -> 'total')::bigint = (SELECT count(*) FROM login_events),
  'в журнале входов все записанные попытки');
SELECT pg_temp.check(jsonb_array_length(public.login_journal(NULL, NULL, NULL, NULL, NULL, 5, 0) -> 'items') = 5,
  'журнал входов отдаётся страницей, а не целиком');
SELECT pg_temp.check((public.login_journal() -> 'successSourceAvailable')::boolean = false,
  'пока журнала входа GoTrue нет, журнал честно говорит, что удачные входы взять негде');
SELECT pg_temp.check((public.login_journal(pg_temp.uid('engineer')) -> 'total')::bigint = 1,
  'журнал входов отбирается по человеку');
SELECT pg_temp.check((public.login_journal(NULL, 'failure') -> 'total')::bigint = (SELECT count(*) FROM login_events)
  AND (public.login_journal(NULL, 'success') -> 'total')::bigint = 0,
  'журнал входов отбирается по исходу');
SELECT pg_temp.check((public.login_journal(NULL, NULL, '203.0.113.7') -> 'total')::bigint = 2,
  'журнал входов ищется по адресу обращения');
SELECT pg_temp.check((public.login_journal(NULL, NULL, 'Журнал engineer') -> 'total')::bigint = 1,
  'журнал входов ищется по имени сотрудника');
SELECT pg_temp.check((public.login_journal(NULL, NULL, NULL, now() + interval '1 hour') -> 'total')::bigint = 0
  AND (public.login_journal(NULL, NULL, NULL, now() - interval '1 hour') -> 'total')::bigint = (SELECT count(*) FROM login_events),
  'журнал входов отбирается по дате');
SELECT pg_temp.check((public.login_journal() -> 'items' -> 0 ->> 'ipAddress') IS NOT NULL
  AND (public.login_journal() -> 'items' -> 0 ->> 'occurredAt') IS NOT NULL
  AND (public.login_journal() -> 'items' -> 0 ->> 'failureReason') IS NOT NULL,
  'в строке журнала входов есть время, адрес и исход');
SELECT pg_temp.expect_denied('SELECT public.login_journal(NULL, ''и так и так'')', 'исход входа принимается только известный');
SELECT pg_temp.act_as_nobody();

-- Удачные входы приходят из журнала самого GoTrue.
CREATE TABLE auth.audit_log_entries (
  instance_id uuid,
  id uuid PRIMARY KEY,
  payload json,
  created_at timestamptz,
  ip_address varchar(64) NOT NULL DEFAULT ''
);
INSERT INTO auth.audit_log_entries (id, payload, created_at, ip_address) VALUES
  (gen_random_uuid(), json_build_object('action', 'login', 'actor_id', (SELECT id FROM ids WHERE k = 'coordinator')::text,
     'actor_username', 'coordinator@journal.test', 'log_type', 'account'), now(), '203.0.113.11'),
  (gen_random_uuid(), json_build_object('action', 'logout', 'actor_id', (SELECT id FROM ids WHERE k = 'coordinator')::text,
     'actor_username', 'coordinator@journal.test', 'log_type', 'account'), now(), '203.0.113.11'),
  (gen_random_uuid(), json_build_object('action', 'login', 'actor_id', (SELECT id FROM ids WHERE k = 'engineer')::text,
     'actor_username', 'engineer@journal.test', 'log_type', 'account'), now(), '203.0.113.12');

SELECT pg_temp.act_as(pg_temp.uid('supervisor'));
SELECT pg_temp.check((public.login_journal() -> 'successSourceAvailable')::boolean = true,
  'журнал входа GoTrue найден: удачные входы есть откуда взять');
SELECT pg_temp.check((public.login_journal(NULL, 'success') -> 'total')::bigint = 2,
  'удачные входы в журнале: ровно входы, выходы не считаются входом');
SELECT pg_temp.check((public.login_journal() -> 'total')::bigint = (SELECT count(*) FROM login_events) + 2,
  'в журнале входов и удачные, и неудачные');
SELECT pg_temp.check((public.login_journal(pg_temp.uid('engineer')) -> 'total')::bigint = 2,
  'по сотруднику видно и его удачный вход, и неудачную попытку');
SELECT pg_temp.check((public.login_journal(NULL, NULL, '203.0.113.11') -> 'items' -> 0 ->> 'userName') = 'Журнал coordinator',
  'у удачного входа видно имя сотрудника');
SELECT pg_temp.check((public.login_journal(NULL, NULL, '203.0.113.11') -> 'items' -> 0 ->> 'source') = 'gotrue',
  'видно, что удачный вход пришёл из журнала службы входа');
SELECT pg_temp.check((public.login_journal(NULL, 'success') -> 'items' -> 0 ->> 'failureReason') IS NULL,
  'у удачного входа причины отказа нет');
SELECT pg_temp.act_as_nobody();

-- Сотруднику без права служебная история GoTrue не достаётся и теперь.
SELECT pg_temp.act_as(pg_temp.uid('engineer'));
SELECT pg_temp.expect_denied('SELECT public.login_journal()', 'инженеру журнал входов закрыт и при живом журнале GoTrue');
SELECT pg_temp.expect_denied('SELECT count(*) FROM auth.audit_log_entries', 'служебный журнал GoTrue инженеру не читается напрямую');
SELECT pg_temp.act_as_nobody();

ROLLBACK;
