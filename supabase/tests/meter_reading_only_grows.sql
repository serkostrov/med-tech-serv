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

-- Служебное: запрет работает от владельца схемы и напрямую не вызывается.
SELECT pg_temp.check((SELECT prosecdef FROM pg_proc WHERE proname = 'guard_task_meter_reading_growth'),
  'запрет работает от владельца схемы');
SELECT pg_temp.check(NOT has_function_privilege('authenticated', 'public.guard_task_meter_reading_growth()', 'EXECUTE'),
  'запрет напрямую не вызвать');

ROLLBACK;
