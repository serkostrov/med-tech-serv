-- Журнал изменений доступа (миграция 0076): роли и их права пишутся в журнал аудита
-- объектом «user» («Сотрудники и права»), права роли — под ключом роли.
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/audit_access_roles.sql
-- Всё выполняется в транзакции и откатывается. Ошибка = проверка не прошла.

BEGIN;

CREATE FUNCTION pg_temp.act_as(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE FUNCTION pg_temp.act_as_nobody() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
END $$;

CREATE FUNCTION pg_temp.check(p_ok boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'ПРОВАЛ: %', p_label;
  END IF;
  RAISE NOTICE 'ok: %', p_label;
END $$;

-- Ожидаем отказ со словами из p_words: по-русски и про то, что мешает.
CREATE FUNCTION pg_temp.expect_refusal(p_sql text, p_words text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  message text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    message := SQLERRM;
    IF message !~ p_words THEN
      RAISE EXCEPTION 'ПРОВАЛ: % — отказ не тот: %', p_label, message;
    END IF;
    RAISE NOTICE 'ok: % (отказ: %)', p_label, message;
    RETURN;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — команда прошла, а должна быть запрещена', p_label;
END $$;

CREATE TEMP TABLE v (k text PRIMARY KEY, id uuid);
GRANT SELECT ON v TO authenticated;
CREATE FUNCTION pg_temp.uid(p_key text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM v WHERE k = p_key
$$;
GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.act_as_nobody(), pg_temp.check(boolean, text),
  pg_temp.expect_refusal(text, text, text), pg_temp.uid(text) TO authenticated;

-- Данные без входа: администратор (меняет роли) и координатор (журнал ему виден по audit.read).
DO $$
DECLARE
  adm uuid := gen_random_uuid(); coord uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id, email, aud, role) VALUES
    (adm, 'acc-adm@test.local', 'authenticated', 'authenticated'),
    (coord, 'acc-coord@test.local', 'authenticated', 'authenticated');
  INSERT INTO users (id, full_name, role, email, is_active, access_role_key) VALUES
    (adm, 'Администратор Доступа', 'admin', 'acc-adm@test.local', true, 'admin'),
    (coord, 'Координатор Доступа', 'coordinator', 'acc-coord@test.local', true, 'coordinator');
  INSERT INTO v VALUES ('adm', adm), ('coord', coord);
END $$;

-- Администратор заводит роль, даёт ей два права, одно снимает, переименовывает роль.
SELECT pg_temp.act_as(pg_temp.uid('adm'));
INSERT INTO access_roles (key, name, base_role) VALUES ('trial-role', 'Пробная роль', 'coordinator');
INSERT INTO access_role_permissions (role_key, permission_code) VALUES ('trial-role', 'tasks.read'), ('trial-role', 'reports.read');
DELETE FROM access_role_permissions WHERE role_key = 'trial-role' AND permission_code = 'reports.read';
UPDATE access_roles SET name = 'Пробная роль 2' WHERE key = 'trial-role';
SELECT pg_temp.act_as_nobody();

SELECT pg_temp.check(
  (SELECT count(*) FROM audit_log WHERE entity_type = 'user' AND entity_id = 'trial-role') = 5,
  'пять событий по роли: создана, два права выдано, одно снято, переименована');
SELECT pg_temp.check(
  (SELECT count(*) FROM audit_log WHERE entity_id = 'trial-role' AND metadata ->> 'table_name' = 'access_role_permissions') = 3,
  'права роли пишутся под ключом роли, по строке на галочку');
SELECT pg_temp.check(
  (SELECT bool_and(actor_user_id = pg_temp.uid('adm')) FROM audit_log WHERE entity_id = 'trial-role'),
  'автор событий — администратор, который менял роль');
SELECT pg_temp.check(
  EXISTS (SELECT 1 FROM audit_log WHERE entity_id = 'trial-role' AND metadata ->> 'table_name' = 'access_role_permissions'
    AND before_data ->> 'permission_code' = 'reports.read' AND after_data IS NULL),
  'снятое право видно: было «reports.read», стало пусто');
SELECT pg_temp.check(
  EXISTS (SELECT 1 FROM audit_log WHERE entity_id = 'trial-role' AND metadata ->> 'table_name' = 'access_roles'
    AND before_data ->> 'name' = 'Пробная роль' AND after_data ->> 'name' = 'Пробная роль 2'),
  'переименование роли видно: было и стало');

-- Сотрудник с ролью: тоже объект «user», как и раньше.
DO $$
DECLARE
  person uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id, email, aud, role) VALUES (person, 'acc-new@test.local', 'authenticated', 'authenticated');
  INSERT INTO v VALUES ('new', person);
END $$;
SELECT pg_temp.act_as(pg_temp.uid('adm'));
INSERT INTO users (id, full_name, role, email, is_active, access_role_key)
  VALUES (pg_temp.uid('new'), 'Новый Сотрудник', 'coordinator', 'acc-new@test.local', true, 'trial-role');
SELECT pg_temp.act_as_nobody();
SELECT pg_temp.check(
  EXISTS (SELECT 1 FROM audit_log WHERE entity_type = 'user' AND entity_id = pg_temp.uid('new')::text AND after_data ->> 'access_role_key' = 'trial-role'),
  'новый сотрудник с ролью — в том же журнале доступа');

-- Экранный журнал (0057): координатор с audit.read видит события доступа одним отбором.
SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT pg_temp.check(
  (SELECT count(*) FROM audit_log_journal WHERE entity_type = 'user' AND entity_id IN ('trial-role', pg_temp.uid('new')::text)) >= 6,
  'вкладка «Доступ и права»: роль, права и сотрудник видны в экранном журнале');
SELECT pg_temp.act_as_nobody();

ROLLBACK;
