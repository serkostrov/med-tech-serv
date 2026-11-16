-- Показание счётчика только растёт (миграция 0038).
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/meter_reading_only_grows.sql
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

-- Прибор AU 480 с последним показанием 152 300 (как в аудите) и задача инженера в работе.
DO $$
DECLARE
  coord uuid := gen_random_uuid();
  eng uuid := gen_random_uuid();
  org uuid; site uuid; payer uuid; manuf uuid; model uuid; eq uuid; eq_fresh uuid; wt text; task uuid; task2 uuid;
BEGIN
  INSERT INTO ids VALUES ('coord', coord), ('eng', eng);
  INSERT INTO auth.users (id, email, aud, role) VALUES
    (coord, 'coord@test.local', 'authenticated', 'authenticated'),
    (eng, 'eng@test.local', 'authenticated', 'authenticated');
  INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key) VALUES
    (coord, 'Тест координатор', 'coordinator', 'coord@test.local', true, 'coordinator'),
    (eng, 'Тест инженер', 'engineer', 'eng@test.local', true, 'engineer');

  INSERT INTO organizations (name) VALUES ('Тестовая больница') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('Тестовая площадка', org) RETURNING id INTO site;
  INSERT INTO payers (name) VALUES ('Тестовый плательщик') RETURNING id INTO payer;
  INSERT INTO manufacturers (name) VALUES ('Тест Beckman Coulter') RETURNING id INTO manuf;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (manuf, 'AU 480') RETURNING id INTO model;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id, last_meter_reading)
  VALUES ('2018061207', manuf, model, site, payer, 152300) RETURNING id INTO eq;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  VALUES ('NEW-NO-METER', manuf, model, site, payer) RETURNING id INTO eq_fresh;
  SELECT code INTO wt FROM work_types WHERE is_active ORDER BY code LIMIT 1;

  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by,
                     call_date, deadline_from, deadline_to, status_code, call_reason, work_description)
  VALUES ('Посторонний шум в узле перемешивания', wt, eq, site, payer, eng, coord,
          current_date, current_date, current_date + 7, 'in_progress', 'Шум', 'Заменён узел')
  RETURNING id INTO task;
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by,
                     call_date, deadline_from, deadline_to, status_code)
  VALUES ('Задача по новому прибору', wt, eq_fresh, site, payer, eng, coord,
          current_date, current_date, current_date + 7, 'in_progress')
  RETURNING id INTO task2;
  INSERT INTO ids VALUES ('equipment', eq), ('fresh', eq_fresh), ('task', task), ('task_fresh', task2);
END $$;

-- Второй открытый наряд по тому же прибору: ремонт и ТО идут одновременно — обычное дело.
DO $$
DECLARE
  second uuid; act_a uuid; act_b uuid; wt text;
BEGIN
  SELECT code INTO wt FROM work_types WHERE is_active ORDER BY code LIMIT 1;
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by,
                     call_date, deadline_from, deadline_to, status_code, call_reason, work_description, visit_date)
  SELECT 'ТО по тому же прибору', wt, task.equipment_id, task.site_id, task.payer_id, task.engineer_id, task.created_by,
         current_date, current_date, current_date + 7, 'in_progress', 'ТО', 'Плановое ТО', current_date
    FROM tasks AS task WHERE task.id = (SELECT id FROM ids WHERE k = 'task_fresh')
  RETURNING id INTO second;
  INSERT INTO ids VALUES ('task_second', second);

  INSERT INTO files (task_id, kind, original_name, content_type, byte_size, storage_key, uploaded_by)
  SELECT t.id, 'photo', 'photo' || g || '.jpg', 'image/jpeg', 10, 'k/' || t.id || '/' || g,
         (SELECT id FROM ids WHERE k = 'coord')
    FROM (VALUES ((SELECT id FROM ids WHERE k = 'task_fresh')), (second)) AS t(id), generate_series(1, 3) AS g;
  INSERT INTO files (task_id, kind, original_name, content_type, byte_size, storage_key, uploaded_by)
  VALUES ((SELECT id FROM ids WHERE k = 'task_fresh'), 'act', 'act1.jpg', 'image/jpeg', 10, 'k/act1', (SELECT id FROM ids WHERE k = 'coord'))
  RETURNING id INTO act_a;
  INSERT INTO files (task_id, kind, original_name, content_type, byte_size, storage_key, uploaded_by)
  VALUES (second, 'act', 'act2.jpg', 'image/jpeg', 10, 'k/act2', (SELECT id FROM ids WHERE k = 'coord'))
  RETURNING id INTO act_b;
  -- Моменты сдачи разные: в жизни наряды сдают не в одну микросекунду, а паспорт прибора
  -- берёт показание последней сдачи. Одинаковое время сделало бы проверку случайной.
  INSERT INTO task_closures (task_id, act_file_id, submitted_by, submitted_at) VALUES
    ((SELECT id FROM ids WHERE k = 'task_fresh'), act_a, (SELECT id FROM ids WHERE k = 'eng'), now() - interval '2 hours'),
    (second, act_b, (SELECT id FROM ids WHERE k = 'eng'), now() - interval '1 hour');
END $$;

-- ---------------------------------------------------------------- Случай из аудита
SELECT pg_temp.act_as(pg_temp.uid('eng'));
SELECT pg_temp.expect_russian_refusal(
  format('UPDATE public.tasks SET meter_reading = 1 WHERE id = %L', (SELECT id FROM ids WHERE k = 'task')),
  'показание 1 при последнем 152 300 не сохраняется');
SELECT pg_temp.expect_russian_refusal(
  format('UPDATE public.tasks SET meter_reading = 152299 WHERE id = %L', (SELECT id FROM ids WHERE k = 'task')),
  'даже на единицу меньше предыдущего не сохраняется');
SELECT pg_temp.check((SELECT meter_reading IS NULL FROM tasks WHERE id = pg_temp.uid('task')),
  'в задаче показания так и нет');

-- ---------------------------------------------------------------- Что по-прежнему можно
SELECT pg_temp.check(pg_temp.rows_affected(
  format('UPDATE public.tasks SET meter_reading = 152300 WHERE id = %L', (SELECT id FROM ids WHERE k = 'task'))) = 1,
  'равное предыдущему принимается: прибор мог стоять');
SELECT pg_temp.check(pg_temp.rows_affected(
  format('UPDATE public.tasks SET meter_reading = 153010 WHERE id = %L', (SELECT id FROM ids WHERE k = 'task'))) = 1,
  'выросшее показание принимается');
SELECT pg_temp.check(pg_temp.rows_affected(
  format('UPDATE public.tasks SET meter_reading = NULL WHERE id = %L', (SELECT id FROM ids WHERE k = 'task'))) = 1,
  'показание можно не указывать: поле необязательное');
SELECT pg_temp.check(pg_temp.rows_affected(
  format('UPDATE public.tasks SET meter_reading = 1 WHERE id = %L', (SELECT id FROM ids WHERE k = 'task_fresh'))) = 1,
  'у прибора без показаний принимается любое: первое показание сравнивать не с чем');
SELECT pg_temp.act_as_nobody();

-- ---------------------------------------------------------------- Журнал показаний тоже учитывается
-- Показание прошлой задачи выше, чем производное значение в паспорте: сравниваем с большим.
UPDATE equipment SET last_meter_reading = 100 WHERE id = pg_temp.uid('equipment');
INSERT INTO equipment_meter_readings (equipment_id, reading, measured_at, source, created_by)
VALUES (pg_temp.uid('equipment'), 200000, now(), 'manual', pg_temp.uid('eng'));
SELECT pg_temp.act_as(pg_temp.uid('eng'));
SELECT pg_temp.expect_russian_refusal(
  format('UPDATE public.tasks SET meter_reading = 150000 WHERE id = %L', (SELECT id FROM ids WHERE k = 'task')),
  'сравнение идёт и с журналом показаний, а не только с паспортом');
SELECT pg_temp.check(pg_temp.rows_affected(
  format('UPDATE public.tasks SET meter_reading = 200001 WHERE id = %L', (SELECT id FROM ids WHERE k = 'task'))) = 1,
  'выше самого большого известного показания принимается');
SELECT pg_temp.act_as_nobody();

-- ---------------------------------------------------------------- Два открытых наряда по прибору
-- Главная дыра первой редакции: при вводе второго показания первое ещё нигде не записано,
-- обе проверки на вводе проходят, а в журнал ложится убывающий ряд.
-- Берём прибор без показаний: в журнале показаний ничего не стираем, он неизменяем.
UPDATE tasks SET call_reason = 'Шум', work_description = 'Заменён узел', visit_date = current_date
 WHERE id IN (pg_temp.uid('task_fresh'), pg_temp.uid('task_second'));
SELECT pg_temp.act_as(pg_temp.uid('eng'));
SELECT pg_temp.check(pg_temp.rows_affected(
  format('UPDATE public.tasks SET meter_reading = 1000 WHERE id = %L', (SELECT id FROM ids WHERE k = 'task_fresh'))) = 1,
  'в первый наряд вписали 1000: прибор был без показаний');
SELECT pg_temp.check(pg_temp.rows_affected(
  format('UPDATE public.tasks SET meter_reading = 500 WHERE id = %L', (SELECT id FROM ids WHERE k = 'task_second'))) = 1,
  'во второй наряд вписали 500: на этот момент сравнивать ещё не с чем');
SELECT pg_temp.act_as_nobody();

UPDATE tasks SET status_code = 'under_review' WHERE id = pg_temp.uid('task_fresh');
UPDATE tasks SET status_code = 'under_review' WHERE id = pg_temp.uid('task_second');
UPDATE tasks SET status_code = 'closed' WHERE id = pg_temp.uid('task_fresh');
SELECT pg_temp.check((SELECT last_meter_reading FROM equipment WHERE id = pg_temp.uid('fresh')) = 1000,
  'первый наряд приняли: в паспорте 1000');
SELECT pg_temp.expect_russian_refusal(
  format('UPDATE public.tasks SET status_code = ''closed'' WHERE id = %L', (SELECT id FROM ids WHERE k = 'task_second')),
  'второй наряд с показанием 500 не принять: в журнал убывающий ряд не попадёт');
SELECT pg_temp.check(
  NOT EXISTS (SELECT 1 FROM equipment_meter_readings WHERE equipment_id = pg_temp.uid('fresh') AND reading = 500),
  'в истории счётчика нет упавшего показания');
SELECT pg_temp.check((SELECT last_meter_reading FROM equipment WHERE id = pg_temp.uid('fresh')) = 1000,
  'и в паспорте по-прежнему 1000');

-- Поправили показание в задаче — и она принимается. На проверке это делает координатор:
-- инженеру сданная задача уже не принадлежит.
SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT pg_temp.check(pg_temp.rows_affected(
  format('UPDATE public.tasks SET meter_reading = 1200 WHERE id = %L', (SELECT id FROM ids WHERE k = 'task_second'))) = 1,
  'координатор поправил показание на 1200');
SELECT pg_temp.act_as_nobody();
UPDATE tasks SET status_code = 'closed' WHERE id = pg_temp.uid('task_second');
SELECT pg_temp.check((SELECT last_meter_reading FROM equipment WHERE id = pg_temp.uid('fresh')) = 1200,
  'после правки наряд принят, в паспорте 1200');

-- Служебное: запрет работает от владельца схемы и напрямую не вызывается.
SELECT pg_temp.check((SELECT prosecdef FROM pg_proc WHERE proname = 'guard_task_meter_reading_growth'),
  'запрет работает от владельца схемы');
SELECT pg_temp.check(NOT has_function_privilege('authenticated', 'public.guard_task_meter_reading_growth()', 'EXECUTE'),
  'запрет напрямую не вызвать');
SELECT pg_temp.check((SELECT prosecdef FROM pg_proc WHERE proname = 'guard_meter_reading_history_growth'),
  'проверка журнала показаний работает от владельца схемы');
SELECT pg_temp.check(NOT has_function_privilege('authenticated', 'public.guard_meter_reading_history_growth()', 'EXECUTE'),
  'проверку журнала показаний напрямую не вызвать');

ROLLBACK;
