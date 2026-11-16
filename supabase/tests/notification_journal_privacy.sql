-- Журнал уведомлений: каждый видит адресованное ему, весь журнал — только журнал и письма (0034).
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/notification_journal_privacy.sql
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

CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid);
GRANT SELECT ON ids TO authenticated;
CREATE FUNCTION pg_temp.uid(p_key text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM ids WHERE k = p_key
$$;
GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.act_as_nobody(), pg_temp.check(boolean, text),
  pg_temp.uid(text) TO authenticated;

-- Четыре уведомления: клиенту, руководителю, инженеру и второму инженеру.
DO $$
DECLARE
  coord uuid := gen_random_uuid();
  sup uuid := gen_random_uuid();
  eng uuid := gen_random_uuid();
  eng2 uuid := gen_random_uuid();
  wh uuid := gen_random_uuid();
  admin_id uuid := gen_random_uuid();
  senior uuid := gen_random_uuid();
BEGIN
  INSERT INTO ids VALUES ('coord', coord), ('sup', sup), ('eng', eng), ('eng2', eng2),
    ('wh', wh), ('admin', admin_id), ('senior', senior);
  INSERT INTO auth.users (id, email, aud, role)
  SELECT id, k || '@test.local', 'authenticated', 'authenticated' FROM ids;

  -- Своя роль «старший инженер»: инженерские права плюс «Все задачи». Ровно тот случай,
  -- из-за которого право на все задачи больше не открывает журнал целиком.
  INSERT INTO access_roles (key, name, base_role) VALUES ('senior_engineer', 'Старший инженер', 'engineer');
  INSERT INTO access_role_permissions (role_key, permission_code)
  SELECT 'senior_engineer', permission_code FROM access_role_permissions WHERE role_key = 'engineer';
  INSERT INTO access_role_permissions (role_key, permission_code) VALUES ('senior_engineer', 'tasks.read_all');

  INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key) VALUES
    (coord, 'Тест координатор', 'coordinator', 'coord@test.local', true, 'coordinator'),
    (sup, 'Тест руководитель', 'supervisor', 'sup@test.local', true, 'supervisor'),
    (eng, 'Тест инженер', 'engineer', 'eng@test.local', true, 'engineer'),
    (eng2, 'Тест инженер второй', 'engineer', 'eng2@test.local', true, 'engineer'),
    (wh, 'Тест кладовщик', 'warehouse', 'wh@test.local', true, 'warehouse'),
    (admin_id, 'Тест администратор', 'admin', 'admin@test.local', true, 'admin'),
    (senior, 'Тест старший инженер', 'engineer', 'senior@test.local', true, 'senior_engineer');

  INSERT INTO notifications (idempotency_key, event_code, recipient_user_id, channel, recipient_address, subject, body) VALUES
    ('t-client', 'task_work_completed', NULL, 'email', 'a.smirnova@gkb1.example', 'Работы завершены', 'Письмо клиенту'),
    ('t-sup', 'task_overdue', sup, 'email', 'sup@test.local', 'Просрочка', 'Письмо руководителю'),
    ('t-eng', 'task_engineer_assigned', eng, 'telegram', '418236501', 'Назначена задача', 'Сообщение инженеру'),
    ('t-eng2', 'task_engineer_assigned', eng2, 'telegram', '529847130', 'Назначена задача', 'Сообщение второму инженеру');
END $$;

-- ---------------------------------------------------------------- Инженер видит только своё
SELECT pg_temp.act_as(pg_temp.uid('eng'));
SELECT pg_temp.check((SELECT count(*) FROM notifications) = 1,
  'инженер видит в журнале одну строку — свою');
SELECT pg_temp.check((SELECT recipient_address FROM notifications) = '418236501',
  'инженеру видно именно его сообщение');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM notifications WHERE recipient_user_id IS NULL),
  'письма клиентам инженеру не видны');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM notifications WHERE recipient_address = '529847130'),
  'чужой телеграм-чат инженеру не виден');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM notifications WHERE recipient_address = 'sup@test.local'),
  'письма руководителю инженеру не видны');
SELECT pg_temp.act_as_nobody();

-- Право «Все задачи» журнал целиком больше не открывает.
SELECT pg_temp.act_as(pg_temp.uid('senior'));
SELECT pg_temp.check(public.app_has_permission('tasks.read_all'),
  'у своей роли «Старший инженер» есть право на все задачи');
SELECT pg_temp.check((SELECT count(*) FROM notifications) = 0,
  'старшему инженеру без своих писем журнал пуст, а не полон чужими');
SELECT pg_temp.act_as_nobody();

-- Кладовщик тоже видит только адресованное ему.
SELECT pg_temp.act_as(pg_temp.uid('wh'));
SELECT pg_temp.check((SELECT count(*) FROM notifications) = 0,
  'кладовщику без своих писем журнал пуст');
SELECT pg_temp.act_as_nobody();

-- ---------------------------------------------------------------- Кому весь журнал положен
SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT pg_temp.check((SELECT count(*) FROM notifications) = 4, 'координатор видит весь журнал');
SELECT pg_temp.act_as_nobody();
SELECT pg_temp.act_as(pg_temp.uid('sup'));
SELECT pg_temp.check((SELECT count(*) FROM notifications) = 4, 'руководитель видит весь журнал');
SELECT pg_temp.act_as_nobody();
SELECT pg_temp.act_as(pg_temp.uid('admin'));
SELECT pg_temp.check((SELECT count(*) FROM notifications) = 4,
  'администратор видит весь журнал: он настраивает письма');
SELECT pg_temp.act_as_nobody();
SELECT pg_temp.act_as(pg_temp.uid('eng2'));
SELECT pg_temp.check((SELECT count(*) FROM notifications) = 1, 'второй инженер видит только своё сообщение');
SELECT pg_temp.act_as_nobody();

-- Журнал никто не правит руками и не удаляет: правило на это не выдано.
SELECT pg_temp.check(
  NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.notifications'::regclass AND polcmd IN ('a', 'd')),
  'вставка и удаление строк журнала через API закрыты');

ROLLBACK;
