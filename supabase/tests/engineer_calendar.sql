-- Календарь загрузки инженеров (миграция 0051).
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/engineer_calendar.sql
-- Всё выполняется в транзакции и откатывается. Ошибка = проверка не прошла.
-- Проверки считают только свои тестовые записи, поэтому другие данные в базе не мешают.

BEGIN;

CREATE FUNCTION pg_temp.act_as(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

-- Та же подготовка, что в invoice_create.sql: закрытие в обход проверок.
SET session_replication_role = replica;
UPDATE tasks SET status_code = 'closed' WHERE title = 'Календарь: закрытая';
SET session_replication_role = DEFAULT;

CREATE FUNCTION pg_temp.check(p_ok boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'ПРОВАЛ: %', p_label;
  END IF;
  RAISE NOTICE 'ok: %', p_label;
END $$;

-- Ожидаем отказ по правам.
CREATE FUNCTION pg_temp.expect_forbidden(p_sql text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'ok: % (нет прав)', p_label;
    RETURN;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — вызов прошёл, а должен быть запрещён', p_label;
END $$;

-- Ожидаем отказ с нужным текстом по-русски.
CREATE FUNCTION pg_temp.expect_message(p_sql text, p_pattern text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  message text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    message := SQLERRM;
    IF message ~ p_pattern THEN
      RAISE NOTICE 'ok: % (отказ: %)', p_label, message;
      RETURN;
    END IF;
    RAISE EXCEPTION 'ПРОВАЛ: % — отказ пришёл, но текст другой: %', p_label, message;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — вызов прошёл, а должен был отказать', p_label;
END $$;

GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.check(boolean, text),
  pg_temp.expect_forbidden(text, text), pg_temp.expect_message(text, text, text) TO authenticated, anon;

CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid);
GRANT SELECT ON ids TO authenticated, anon;

-- Период календаря: понедельник 16.11.2026 — воскресенье 22.11.2026.
-- Даты в тесте фиксированные, чтобы выходные и рабочие дни не зависели от дня прогона.
DO $$
DECLARE
  -- engineer3 и engineer5 неактивны: у первого задача в периоде есть, у второго нет.
  roles text[] := ARRAY['coordinator', 'engineer1', 'engineer2', 'engineer3', 'engineer4', 'engineer5', 'warehouse'];
  r text; uid uuid; base text;
  org uuid; site uuid; payer uuid; manuf uuid; model uuid; eq uuid; wt text;
  coord uuid; e1 uuid; e2 uuid; e3 uuid;
  t_long uuid; t_day1 uuid; t_day2 uuid; t_visit uuid; t_undated uuid; t_cancelled uuid; t_outside uuid; t_closed uuid; t_free uuid;
BEGIN
  FOREACH r IN ARRAY roles LOOP
    uid := gen_random_uuid();
    base := CASE WHEN r LIKE 'engineer%' THEN 'engineer' ELSE r END;
    INSERT INTO auth.users (id, email, aud, role) VALUES (uid, 'cal-' || r || '@test.local', 'authenticated', 'authenticated');
    -- Все заводятся активными: задачу база разрешает назначить только активному инженеру
    -- (триггер tasks_active_engineer_required). Неактивных выключим ниже, после вставки задач.
    INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
    VALUES (uid, 'Календарь ' || r, base::user_role, 'cal-' || r || '@test.local', true, base);
    INSERT INTO ids VALUES (r, uid);
  END LOOP;
  SELECT id INTO coord FROM ids WHERE k = 'coordinator';
  SELECT id INTO e1 FROM ids WHERE k = 'engineer1';
  SELECT id INTO e2 FROM ids WHERE k = 'engineer2';
  SELECT id INTO e3 FROM ids WHERE k = 'engineer3';

  INSERT INTO organizations (name) VALUES ('Календарь: больница') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('Календарь: площадка', org) RETURNING id INTO site;
  INSERT INTO payers (name) VALUES ('Календарь: плательщик') RETURNING id INTO payer;
  INSERT INTO manufacturers (name) VALUES ('Календарь-Производитель') RETURNING id INTO manuf;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (manuf, 'Кал-100') RETURNING id INTO model;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  VALUES ('SN-CAL-1', manuf, model, site, payer) RETURNING id INTO eq;
  SELECT code INTO wt FROM work_types WHERE is_active AND NOT coalesce(requires_hours, false) ORDER BY code LIMIT 1;

  -- Первый инженер: трёхдневная задача 16—18.11 и две однодневные 17.11 (во вторник три задачи).
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by, call_date, deadline_from, deadline_to, status_code)
  VALUES ('Календарь: три дня', wt, eq, site, payer, e1, coord, '2026-11-10', '2026-11-16', '2026-11-18', 'assigned') RETURNING id INTO t_long;
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by, call_date, deadline_from, deadline_to, status_code)
  VALUES ('Календарь: вторник 1', wt, eq, site, payer, e1, coord, '2026-11-10', '2026-11-17', '2026-11-17', 'assigned') RETURNING id INTO t_day1;
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by, call_date, deadline_from, deadline_to, status_code)
  VALUES ('Календарь: вторник 2', wt, eq, site, payer, e1, coord, '2026-11-10', '2026-11-17', '2026-11-17', 'assigned') RETURNING id INTO t_day2;
  -- Отменённая в тот же день не занимает инженера.
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by, call_date, deadline_from, deadline_to, status_code, cancellation_reason)
  VALUES ('Календарь: отменена', wt, eq, site, payer, e1, coord, '2026-11-10', '2026-11-17', '2026-11-17', 'cancelled', 'клиент отказался') RETURNING id INTO t_cancelled;
  -- Вне периода календаря.
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by, call_date, deadline_from, deadline_to, status_code)
  VALUES ('Календарь: декабрь', wt, eq, site, payer, e1, coord, '2026-11-10', '2026-12-01', '2026-12-02', 'assigned') RETURNING id INTO t_outside;

  -- Второй инженер: задача без периода, но с датой выезда 19.11, и задача совсем без срока.
  -- У новых задач период обязателен (ограничение tasks_execution_period_required, 0001),
  -- поэтому такие строки бывают только историческими — из данных до этого ограничения.
  -- Ограничение заведено NOT VALID, то есть старые строки оно пропускает, а новые нет;
  -- чтобы завести такие строки в тесте, снимаем его на время транзакции (ROLLBACK вернёт).
  -- Отложенные триггеры задач должны сработать до ALTER TABLE: иначе Postgres
  -- откажет словами «cannot ALTER TABLE because it has pending trigger events».
  SET CONSTRAINTS ALL IMMEDIATE;
  EXECUTE 'ALTER TABLE public.tasks DROP CONSTRAINT tasks_execution_period_required';
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by, call_date, visit_date, status_code)
  VALUES ('Календарь: только выезд', wt, eq, site, payer, e2, coord, '2026-11-10', '2026-11-19', 'assigned') RETURNING id INTO t_visit;
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by, call_date, status_code)
  VALUES ('Календарь: без срока', wt, eq, site, payer, e2, coord, '2026-11-10', 'assigned') RETURNING id INTO t_undated;
  SET CONSTRAINTS ALL IMMEDIATE;
  EXECUTE 'ALTER TABLE public.tasks ADD CONSTRAINT tasks_execution_period_required CHECK (deadline_from IS NOT NULL AND deadline_to IS NOT NULL) NOT VALID';

  -- Неактивный инженер: закрытая задача в дне периода (день она всё-таки заняла).
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by, call_date, deadline_from, deadline_to, status_code, work_completed, apparatus_approved, customer_has_no_claims, call_reason, work_description)
  -- Закрываем ниже, в обход проверок закрытия: акт и фото здесь не проверяем,
  -- важно только то, что закрытая задача всё равно занимает свой день в календаре.
  VALUES ('Календарь: закрытая', wt, eq, site, payer, e3, coord, '2026-11-10', '2026-11-20', '2026-11-20', 'assigned', true, true, true, 'Не включается', 'Заменён блок питания') RETURNING id INTO t_closed;

  -- Задача периода без инженера: её назначают из календаря.
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, created_by, call_date, deadline_from, deadline_to, status_code)
  VALUES ('Календарь: без инженера', wt, eq, site, payer, coord, '2026-11-10', '2026-11-18', '2026-11-18', 'new') RETURNING id INTO t_free;

  -- Теперь можно выключить: engineer3 остаётся с задачей в периоде, engineer5 — без задач.
  UPDATE public.users SET is_active = false WHERE id IN (e3, (SELECT id FROM ids WHERE k = 'engineer5'));

  INSERT INTO ids VALUES ('t_long', t_long), ('t_day1', t_day1), ('t_day2', t_day2), ('t_visit', t_visit),
    ('t_undated', t_undated), ('t_cancelled', t_cancelled), ('t_outside', t_outside), ('t_closed', t_closed),
    ('t_free', t_free);
END $$;

-- ----------------------------------------------------------------- Координатор
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'coordinator'));

-- Задачи периода: трёхдневная и две однодневные у первого, выезд и «без срока» у второго,
-- закрытая у неактивного. Отменённая и декабрьская не попали.
SELECT pg_temp.check(
  (SELECT count(*) FROM public.engineer_calendar('2026-11-16', '2026-11-22') AS c
    WHERE c.task_id IN (SELECT id FROM ids WHERE k LIKE 't\_%')) = 7,
  'координатор видит задачи периода, кроме отменённой и задач вне периода');

-- Задача без инженера приходит строкой без инженера: из календаря её назначают.
SELECT pg_temp.check(
  (SELECT count(*) = 1 AND bool_and(c.engineer_id IS NULL AND c.engineer_name IS NULL)
     FROM public.engineer_calendar('2026-11-16', '2026-11-22') AS c
    WHERE c.task_id = (SELECT id FROM ids WHERE k = 't_free')),
  'задача без инженера приходит координатору строкой с пустым инженером');

SELECT pg_temp.check(
  (SELECT count(*) FROM public.engineer_calendar('2026-11-16', '2026-11-22') AS c
    WHERE c.task_id = (SELECT id FROM ids WHERE k = 't_cancelled')) = 0,
  'отменённая задача в календарь не попадает');
SELECT pg_temp.check(
  (SELECT count(*) FROM public.engineer_calendar('2026-11-16', '2026-11-22') AS c
    WHERE c.task_id = (SELECT id FROM ids WHERE k = 't_outside')) = 0,
  'задача вне периода в календарь не попадает');
SELECT pg_temp.check(
  (SELECT count(*) FROM public.engineer_calendar('2026-11-16', '2026-11-22') AS c
    WHERE c.task_id = (SELECT id FROM ids WHERE k = 't_closed')) = 1,
  'закрытая задача остаётся в прошедшем дне: день она заняла');

-- Задача без срока приходит с пустыми датами, а не ставится на какой-то день.
SELECT pg_temp.check(
  (SELECT c.period_from IS NULL AND c.period_to IS NULL AND c.visit_date IS NULL
     FROM public.engineer_calendar('2026-11-16', '2026-11-22') AS c
    WHERE c.task_id = (SELECT id FROM ids WHERE k = 't_undated')),
  'открытая задача без срока приходит с пустыми датами');

-- Строка задачи несёт номер, название, площадку и прибор для карточки дня.
SELECT pg_temp.check(
  (SELECT c.task_number <> '' AND c.task_title = 'Календарь: три дня'
        AND c.site_name = 'Календарь: площадка'
        AND c.equipment_label = 'Календарь-Производитель Кал-100 · SN-CAL-1'
     FROM public.engineer_calendar('2026-11-16', '2026-11-22') AS c
    WHERE c.task_id = (SELECT id FROM ids WHERE k = 't_long')),
  'строка календаря несёт номер, название, площадку и прибор');

-- Активный инженер без задач приходит пустой строкой: видно, что у него окно целиком.
SELECT pg_temp.check(
  (SELECT count(*) = 1 AND bool_and(c.task_id IS NULL)
     FROM public.engineer_calendar('2026-11-16', '2026-11-22') AS c
    WHERE c.engineer_id = (SELECT id FROM ids WHERE k = 'engineer4')),
  'активный инженер без задач приходит одной пустой строкой');

-- Неактивный инженер в сетке только с задачами: уволившиеся строк не занимают.
SELECT pg_temp.check(
  (SELECT count(*) FROM public.engineer_calendar('2026-11-16', '2026-11-22') AS c
    WHERE c.engineer_id = (SELECT id FROM ids WHERE k = 'engineer5')) = 0,
  'неактивный инженер без задач в календарь не попадает');
SELECT pg_temp.check(
  (SELECT count(*) = 1 AND bool_and(NOT c.engineer_is_active)
     FROM public.engineer_calendar('2026-11-16', '2026-11-22') AS c
    WHERE c.engineer_id = (SELECT id FROM ids WHERE k = 'engineer3')),
  'неактивный инженер с задачей в периоде приходит с признаком неактивного');

-- В сетке только инженеры: координатора в ней нет.
SELECT pg_temp.check(
  NOT EXISTS (SELECT 1 FROM public.engineer_calendar('2026-11-16', '2026-11-22') AS c
               WHERE c.engineer_id = (SELECT id FROM ids WHERE k = 'coordinator')),
  'в календаре только инженеры: координатора в сетке нет');

-- ----------------------------------------------------------------- Занятость периода
-- Вторник 17.11: у первого инженера три задачи (трёхдневная плюс две однодневные).
SELECT pg_temp.check(
  (SELECT l.busiest_day_count = 3 AND l.busiest_day = '2026-11-17' AND l.task_count = 3
     FROM public.engineer_period_load('2026-11-16', '2026-11-22') AS l
    WHERE l.engineer_id = (SELECT id FROM ids WHERE k = 'engineer1')),
  'самый занятый день первого инженера — вторник с тремя задачами');

-- Пн—Пт пять рабочих дней, занято три (16, 17, 18) — свободных рабочих два.
SELECT pg_temp.check(
  (SELECT l.workday_count = 5 AND l.free_workday_count = 2
     FROM public.engineer_period_load('2026-11-16', '2026-11-22') AS l
    WHERE l.engineer_id = (SELECT id FROM ids WHERE k = 'engineer1')),
  'многодневная задача занимает все свои дни, выходные в свободные рабочие не идут');

-- Второй инженер занят только 19.11 (задача без периода, но с датой выезда).
SELECT pg_temp.check(
  (SELECT l.task_count = 1 AND l.busiest_day = '2026-11-19' AND l.free_workday_count = 4
     FROM public.engineer_period_load('2026-11-16', '2026-11-22') AS l
    WHERE l.engineer_id = (SELECT id FROM ids WHERE k = 'engineer2')),
  'задача без периода занимает день выезда, задача без срока — ни одного дня');

-- Назначаемую задачу в занятость не считаем: иначе инженер «занят» задачей, которую ему же и предлагают.
SELECT pg_temp.check(
  (SELECT l.busiest_day_count = 2
     FROM public.engineer_period_load('2026-11-16', '2026-11-22', (SELECT id FROM ids WHERE k = 't_long')) AS l
    WHERE l.engineer_id = (SELECT id FROM ids WHERE k = 'engineer1')),
  'p_ignore_task_id убирает назначаемую задачу из занятости');

-- Период только из выходных: рабочих дней нет вовсе.
SELECT pg_temp.check(
  (SELECT l.workday_count = 0 AND l.free_workday_count = 0
     FROM public.engineer_period_load('2026-11-21', '2026-11-22') AS l
    WHERE l.engineer_id = (SELECT id FROM ids WHERE k = 'engineer1')),
  'в периоде из субботы и воскресенья рабочих дней нет');

-- ----------------------------------------------------------------- Проверки периода
SELECT pg_temp.expect_message($$SELECT * FROM public.engineer_calendar('2026-11-22', '2026-11-16')$$, 'раньше начала', 'конец периода раньше начала');
SELECT pg_temp.expect_message($$SELECT * FROM public.engineer_calendar(NULL, '2026-11-16')$$, 'начало и конец', 'пустая граница периода');
SELECT pg_temp.expect_message($$SELECT * FROM public.engineer_calendar('2026-01-01', '2026-12-31')$$, '62 дней', 'слишком длинный период');
SELECT pg_temp.expect_message($$SELECT * FROM public.engineer_period_load('2026-01-01', '2026-12-31')$$, '62 дней', 'слишком длинный период занятости');
-- Ровно 62 дня проходят.
SELECT pg_temp.check(
  (SELECT count(*) >= 0 FROM public.engineer_period_load('2026-11-01', '2027-01-01')),
  'период ровно в 62 дня проходит');
RESET ROLE;

-- ----------------------------------------------------------------- Инженер видит только себя
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer1'));
SELECT pg_temp.check(
  (SELECT count(DISTINCT c.engineer_id) FROM public.engineer_calendar('2026-11-16', '2026-11-22') AS c) = 1,
  'инженер видит в календаре только одну строку');
SELECT pg_temp.check(
  (SELECT count(*) FROM public.engineer_calendar('2026-11-16', '2026-11-22') AS c
    WHERE c.engineer_id <> (SELECT id FROM ids WHERE k = 'engineer1')) = 0,
  'инженер не видит в календаре чужих строк');
SELECT pg_temp.check(
  (SELECT count(*) FROM public.engineer_period_load('2026-11-16', '2026-11-22')) = 1,
  'занятость инженер получает только свою');
SELECT pg_temp.check(
  (SELECT count(*) FROM public.engineer_calendar('2026-11-16', '2026-11-22') AS c
    WHERE c.task_id = (SELECT id FROM ids WHERE k = 't_visit')) = 0,
  'инженер не видит задачу коллеги даже в своей строке');
SELECT pg_temp.check(
  (SELECT count(*) FROM public.engineer_calendar('2026-11-16', '2026-11-22') AS c
    WHERE c.task_id = (SELECT id FROM ids WHERE k = 't_free')) = 0,
  'инженер не видит нераспределённых задач');
RESET ROLE;

-- ----------------------------------------------------------------- Кладовщику календарь не положен
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'warehouse'));
SELECT pg_temp.expect_forbidden($$SELECT * FROM public.engineer_calendar('2026-11-16', '2026-11-22')$$, 'кладовщик не открывает календарь загрузки');
SELECT pg_temp.expect_forbidden($$SELECT * FROM public.engineer_period_load('2026-11-16', '2026-11-22')$$, 'кладовщик не читает занятость инженеров');
-- Отказ по правам идёт раньше проверки периода: постороннему не рассказываем даже про её пределы.
SELECT pg_temp.expect_forbidden($$SELECT * FROM public.engineer_calendar('2026-01-01', '2026-12-31')$$, 'кладовщику сначала отказывают в правах, а не в периоде');
RESET ROLE;

-- ----------------------------------------------------------------- Права на сами функции
SELECT pg_temp.check(NOT has_function_privilege('anon', 'public.engineer_calendar(date, date)', 'execute'), 'гость не вызывает календарь');
SELECT pg_temp.check(NOT has_function_privilege('anon', 'public.engineer_period_load(date, date, uuid)', 'execute'), 'гость не вызывает занятость');
SELECT pg_temp.check(has_function_privilege('authenticated', 'public.engineer_calendar(date, date)', 'execute'), 'вошедший пользователь вызывает календарь');
SELECT pg_temp.check(has_function_privilege('authenticated', 'public.engineer_period_load(date, date, uuid)', 'execute'), 'вошедший пользователь вызывает занятость');
-- Индексы выборки на месте: без них на стенде с тысячами задач календарь будет перебирать всё.
SELECT pg_temp.check(EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'tasks_calendar_days_idx'), 'индекс дней задач создан');
-- Индекс из ранней версии миграции не должен оставаться на стенде мёртвым грузом.
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'tasks_calendar_undated_idx'), 'лишний индекс задач без срока убран');

ROLLBACK;
