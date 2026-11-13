-- Событие «Задача просрочена» по дню компании (миграция 0027).
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/overdue_events.sql
-- Всё выполняется в транзакции и откатывается. Ошибка = проверка не прошла.
-- Проверки считают события только своих тестовых задач, поэтому другие данные в базе не мешают.


BEGIN;

CREATE FUNCTION pg_temp.check(p_ok boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'ПРОВАЛ: %', p_label;
  END IF;
  RAISE NOTICE 'ok: %', p_label;
END $$;

CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid);

-- Сколько событий о просрочке у тестовой задачи.
CREATE FUNCTION pg_temp.overdue_events(p_key text) RETURNS integer LANGUAGE sql AS $$
  SELECT count(*)::integer FROM public.integration_outbox
   WHERE event_type = 'task_overdue' AND aggregate_id = (SELECT id FROM ids WHERE k = p_key)
$$;

DO $$
DECLARE
  uid uuid := gen_random_uuid();
  eng uuid := gen_random_uuid();
  org uuid; site uuid; payer uuid; manuf uuid; model uuid; eq uuid; wt text; t1 uuid; t2 uuid;
BEGIN
  INSERT INTO auth.users (id, email, aud, role) VALUES (uid, 'coord@test.local', 'authenticated', 'authenticated'), (eng, 'eng@test.local', 'authenticated', 'authenticated');
  INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key) VALUES
    (uid, 'Тест координатор', 'coordinator', 'coord@test.local', true, 'coordinator'),
    (eng, 'Тест инженер', 'engineer', 'eng@test.local', true, 'engineer');
  INSERT INTO organizations (name) VALUES ('Тестовая больница') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('Тестовая площадка', org) RETURNING id INTO site;
  INSERT INTO payers (name) VALUES ('Тестовый плательщик') RETURNING id INTO payer;
  INSERT INTO manufacturers (name) VALUES ('Тест-Производитель') RETURNING id INTO manuf;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (manuf, 'Модель-1') RETURNING id INTO model;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  VALUES ('SN-OVERDUE-1', manuf, model, site, payer) RETURNING id INTO eq;
  SELECT code INTO wt FROM work_types WHERE is_active ORDER BY code LIMIT 1;
  -- Срок по 12.11 у открытой задачи и у отменённой (отменённая не просрочена).
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by, call_date, deadline_from, deadline_to, status_code)
  VALUES ('Открытая со сроком 12.11', wt, eq, site, payer, eng, uid, '2026-11-01', '2026-11-05', '2026-11-12', 'assigned') RETURNING id INTO t1;
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by, call_date, deadline_from, deadline_to, status_code, cancellation_reason)
  VALUES ('Отменённая со сроком 12.11', wt, eq, site, payer, eng, uid, '2026-11-01', '2026-11-05', '2026-11-12', 'cancelled', 'Клиент отказался') RETURNING id INTO t2;
  INSERT INTO ids VALUES ('t1', t1), ('t2', t2);
END $$;

-- Сервер базы в UTC, как на стенде.
SET LOCAL TIME ZONE 'UTC';

-- 23:30 по Москве 12.11 (20:30 UTC): срок «по 12.11» ещё не вышел.
SELECT public.enqueue_overdue_task_events('2026-11-12T20:30:00Z');
SELECT pg_temp.check(pg_temp.overdue_events('t1') = 0, '23:30 по Москве в день срока задача ещё не просрочена');

-- 00:30 по Москве 13.11 (21:30 UTC, по UTC ещё 12.11): задача уже просрочена.
SELECT public.enqueue_overdue_task_events('2026-11-12T21:30:00Z');
SELECT pg_temp.check(pg_temp.overdue_events('t1') = 1, '00:30 по Москве на следующий день событие о просрочке есть, хотя по UTC ещё день срока');
SELECT pg_temp.check(pg_temp.overdue_events('t2') = 0, 'у отменённой задачи события нет');

-- Повторный запуск не создаёт второго события по тому же сроку.
SELECT public.enqueue_overdue_task_events('2026-11-13T06:00:00Z');
SELECT pg_temp.check(pg_temp.overdue_events('t1') = 1, 'повторный запуск не дублирует событие');

-- Пояс сервера восточнее Москвы: раньше событие приходило до конца дня срока по Москве.
SET LOCAL TIME ZONE 'Asia/Novosibirsk';
UPDATE tasks SET deadline_to = '2026-11-20' WHERE id = (SELECT id FROM ids WHERE k = 't1');
SELECT public.enqueue_overdue_task_events('2026-11-20T20:30:00Z');
SELECT pg_temp.check(pg_temp.overdue_events('t1') = 1, 'сервер восточнее Москвы: 23:30 по Москве в день срока нового события нет');
SELECT public.enqueue_overdue_task_events('2026-11-20T21:01:00Z');
SELECT pg_temp.check(pg_temp.overdue_events('t1') = 2, 'сервер восточнее Москвы: 00:01 по Москве событие есть');

-- Пояс сервера западнее Москвы: та же граница.
SET LOCAL TIME ZONE 'America/Los_Angeles';
UPDATE tasks SET deadline_to = '2026-11-25' WHERE id = (SELECT id FROM ids WHERE k = 't1');
SELECT public.enqueue_overdue_task_events('2026-11-25T20:59:00Z');
SELECT pg_temp.check(pg_temp.overdue_events('t1') = 2, 'сервер западнее Москвы: 23:59 по Москве в день срока нового события нет');
SELECT public.enqueue_overdue_task_events('2026-11-25T21:01:00Z');
SELECT pg_temp.check(pg_temp.overdue_events('t1') = 3, 'сервер западнее Москвы: 00:01 по Москве событие есть');

-- Вызвать функцию может только служба.
SELECT pg_temp.check(NOT has_function_privilege('anon', 'public.enqueue_overdue_task_events(timestamptz)', 'execute'), 'гость не вызывает функцию');
SELECT pg_temp.check(NOT has_function_privilege('authenticated', 'public.enqueue_overdue_task_events(timestamptz)', 'execute'), 'вошедший пользователь не вызывает функцию');
SELECT pg_temp.check(NOT has_function_privilege('medtech_api', 'public.enqueue_overdue_task_events(timestamptz)', 'execute'), 'роль API не вызывает функцию');
SELECT pg_temp.check(NOT has_function_privilege('medtech_backup', 'public.enqueue_overdue_task_events(timestamptz)', 'execute'), 'роль резервного копирования не вызывает функцию');
SELECT pg_temp.check(has_function_privilege('medtech_worker', 'public.enqueue_overdue_task_events(timestamptz)', 'execute'), 'служба вызывает функцию');

ROLLBACK;
