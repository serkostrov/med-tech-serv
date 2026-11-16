-- Себе вход не отключают, последний администратор остаётся (миграция 0035).
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/no_self_lockout.sql
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

-- Ожидаем отказ, написанный по-русски, и запоминаем его текст в сообщении проверки.
CREATE FUNCTION pg_temp.expect_russian_refusal(p_sql text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  message text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN check_violation OR raise_exception OR insufficient_privilege THEN
    message := SQLERRM;
    IF message !~ '[а-яё]' THEN
      RAISE EXCEPTION 'ПРОВАЛ: % — отказ не по-русски: %', p_label, message;
    END IF;
    RAISE NOTICE 'ok: % (отказ: %)', p_label, message;
    RETURN;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — команда прошла, а должна быть запрещена', p_label;
END $$;

CREATE FUNCTION pg_temp.rows_affected(p_sql text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid);
GRANT SELECT ON ids TO authenticated;
CREATE FUNCTION pg_temp.uid(p_key text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM ids WHERE k = p_key
$$;
GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.act_as_nobody(), pg_temp.check(boolean, text),
  pg_temp.expect_russian_refusal(text, text), pg_temp.rows_affected(text), pg_temp.uid(text) TO authenticated;

-- Два администратора (как в аудите: защита последнего администратора не спасает) и инженер.
DO $$
DECLARE
  admin1 uuid := gen_random_uuid();
  admin2 uuid := gen_random_uuid();
  eng uuid := gen_random_uuid();
BEGIN
  INSERT INTO ids VALUES ('admin1', admin1), ('admin2', admin2), ('eng', eng);
  INSERT INTO auth.users (id, email, aud, role)
  SELECT id, k || '@test.local', 'authenticated', 'authenticated' FROM ids;
  INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key) VALUES
    (admin1, 'Захаров Илья Романович', 'admin', 'admin1@test.local', true, 'admin'),
    (admin2, 'Второй администратор', 'admin', 'admin2@test.local', true, 'admin'),
    (eng, 'Тест инженер', 'engineer', 'eng@test.local', true, 'engineer');
END $$;

-- ---------------------------------------------------------------- Себе вход не отключают
SELECT pg_temp.act_as(pg_temp.uid('admin1'));
SELECT pg_temp.expect_russian_refusal(
  format('UPDATE public.users SET is_active = false WHERE id = %L', (SELECT id FROM ids WHERE k = 'admin1')),
  'администратор не может отключить себя, даже когда есть второй администратор');
SELECT pg_temp.act_as_nobody();
SELECT pg_temp.check((SELECT is_active FROM users WHERE id = pg_temp.uid('admin1')),
  'вход у него остался включённым');

-- Инженеру учётные записи и так закрыты правилами строк: отказ приходит раньше.
SELECT pg_temp.act_as(pg_temp.uid('eng'));
SELECT pg_temp.check(pg_temp.rows_affected(
  format('UPDATE public.users SET is_active = false WHERE id = %L', (SELECT id FROM ids WHERE k = 'eng'))) = 0,
  'инженеру правила строк не дают менять учётные записи, в том числе свою');
SELECT pg_temp.act_as_nobody();

-- Запрет не только про администраторов: своя роль «Кадровик» ведёт сотрудников,
-- и себя её владелец тоже не отключит.
DO $$
DECLARE hr uuid := gen_random_uuid();
BEGIN
  INSERT INTO ids VALUES ('hr', hr);
  INSERT INTO access_roles (key, name, base_role) VALUES ('hr', 'Кадровик', 'coordinator');
  INSERT INTO access_role_permissions (role_key, permission_code) VALUES ('hr', 'users.write'), ('hr', 'users.read');
  INSERT INTO auth.users (id, email, aud, role) VALUES (hr, 'hr@test.local', 'authenticated', 'authenticated');
  INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
  VALUES (hr, 'Тест кадровик', 'coordinator', 'hr@test.local', true, 'hr');
END $$;
SELECT pg_temp.act_as(pg_temp.uid('hr'));
SELECT pg_temp.expect_russian_refusal(
  format('UPDATE public.users SET is_active = false WHERE id = %L', (SELECT id FROM ids WHERE k = 'hr')),
  'кадровик с правом вести сотрудников тоже не отключит себя');
SELECT pg_temp.act_as_nobody();

-- Роль себе тоже не меняют: права считаются по ней, это тот же запертый вход.
SELECT pg_temp.act_as(pg_temp.uid('admin1'));
SELECT pg_temp.expect_russian_refusal(
  format('UPDATE public.users SET access_role_key = ''engineer'' WHERE id = %L', (SELECT id FROM ids WHERE k = 'admin1')),
  'администратор не может назначить себе роль «Инженер»');
SELECT pg_temp.expect_russian_refusal(
  format('UPDATE public.users SET role = ''engineer'' WHERE id = %L', (SELECT id FROM ids WHERE k = 'admin1')),
  'и базовую роль себе не сменить');
SELECT pg_temp.check((SELECT access_role_key FROM users WHERE id = pg_temp.uid('admin1')) = 'admin',
  'роль у него осталась прежней');
SELECT pg_temp.check(pg_temp.rows_affected(
  format('UPDATE public.users SET full_name = ''Захаров Илья Романович'' WHERE id = %L', (SELECT id FROM ids WHERE k = 'admin1'))) = 1,
  'своё ФИО поправить по-прежнему можно');
SELECT pg_temp.check(pg_temp.rows_affected(
  format('UPDATE public.users SET access_role_key = ''sysadmin'' WHERE id = %L', (SELECT id FROM ids WHERE k = 'admin2'))) = 1,
  'чужую роль администратор меняет как раньше');
SELECT pg_temp.check(pg_temp.rows_affected(
  format('UPDATE public.users SET access_role_key = ''admin'' WHERE id = %L', (SELECT id FROM ids WHERE k = 'admin2'))) = 1,
  'и возвращает обратно');

-- Чужой вход администратор отключает как раньше.
SELECT pg_temp.act_as(pg_temp.uid('admin1'));
SELECT pg_temp.check(pg_temp.rows_affected(
  format('UPDATE public.users SET is_active = false WHERE id = %L', (SELECT id FROM ids WHERE k = 'eng'))) = 1,
  'чужой вход администратор отключает как раньше');
SELECT pg_temp.check(pg_temp.rows_affected(
  format('UPDATE public.users SET is_active = true WHERE id = %L', (SELECT id FROM ids WHERE k = 'eng'))) = 1,
  'и включает обратно');

-- ---------------------------------------------------------------- Последний администратор
SELECT pg_temp.check(pg_temp.rows_affected(
  format('UPDATE public.users SET is_active = false WHERE id = %L', (SELECT id FROM ids WHERE k = 'admin2'))) = 1,
  'второго администратора отключили: admin1 остался последним');
SELECT pg_temp.act_as_nobody();
-- Отключение последнего администратора проверяем без входа: иначе сработал бы запрет «себе».
SELECT pg_temp.expect_russian_refusal(
  format('UPDATE public.users SET is_active = false WHERE id = %L', (SELECT id FROM ids WHERE k = 'admin1')),
  'последнего администратора не отключить: отказ называет действие');
SELECT pg_temp.expect_russian_refusal(
  format('UPDATE public.users SET role = ''engineer'' WHERE id = %L', (SELECT id FROM ids WHERE k = 'admin1')),
  'последнему администратору не сменить роль: отказ называет действие');
SELECT pg_temp.expect_russian_refusal(
  format('DELETE FROM public.users WHERE id = %L', (SELECT id FROM ids WHERE k = 'admin1')),
  'последнего администратора не удалить: отказ называет действие');

-- ---------------------------------------------------------------- Своя роль доступа
SELECT pg_temp.act_as(pg_temp.uid('admin1'));
SELECT pg_temp.expect_russian_refusal(
  'UPDATE public.access_roles SET is_active = false WHERE key = ''admin''',
  'свою роль доступа отключить нельзя: без активной роли прав нет вовсе');
SELECT pg_temp.check(pg_temp.rows_affected(
  'UPDATE public.access_roles SET is_active = false WHERE key = ''warehouse''') = 1,
  'чужую роль доступа администратор отключает как раньше');
SELECT pg_temp.act_as_nobody();

-- ---------------------------------------------------------------- Служба и служебные свойства
-- Без входа (импорт, миграции, служба уведомлений) ограничения «себе» не действуют.
UPDATE public.users SET is_active = false WHERE id = pg_temp.uid('eng');
SELECT pg_temp.check(NOT (SELECT is_active FROM users WHERE id = pg_temp.uid('eng')),
  'служба без входа отключает сотрудника как раньше');
SELECT pg_temp.check((SELECT prosecdef FROM pg_proc WHERE proname = 'preserve_last_active_administrator'),
  'защита администратора работает от владельца схемы');
SELECT pg_temp.check((SELECT prosecdef FROM pg_proc WHERE proname = 'preserve_own_access_role'),
  'защита своей роли работает от владельца схемы');
SELECT pg_temp.check(NOT has_function_privilege('authenticated', 'public.preserve_own_access_role()', 'EXECUTE'),
  'защиту своей роли напрямую не вызвать');

ROLLBACK;
