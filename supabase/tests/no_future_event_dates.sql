-- Дата вызова и даты событий прибора не из будущего (миграция 0037).
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/no_future_event_dates.sql
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

DO $$
DECLARE
  coord uuid := gen_random_uuid();
  org uuid; site uuid; site2 uuid; payer uuid; payer2 uuid; manuf uuid; model uuid; eq uuid; wt text;
BEGIN
  INSERT INTO ids VALUES ('coord', coord);
  INSERT INTO auth.users (id, email, aud, role) VALUES (coord, 'coord@test.local', 'authenticated', 'authenticated');
  INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
  VALUES (coord, 'Тест координатор', 'coordinator', 'coord@test.local', true, 'coordinator');

  INSERT INTO organizations (name) VALUES ('Тестовая больница') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('Площадка 1', org) RETURNING id INTO site;
  INSERT INTO sites (name, organization_id) VALUES ('Площадка 2', org) RETURNING id INTO site2;
  INSERT INTO payers (name) VALUES ('Плательщик 1') RETURNING id INTO payer;
  INSERT INTO payers (name) VALUES ('Плательщик 2') RETURNING id INTO payer2;
  INSERT INTO manufacturers (name) VALUES ('Тест-Производитель') RETURNING id INTO manuf;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (manuf, 'Модель-1') RETURNING id INTO model;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  VALUES ('SN-DATES-1', manuf, model, site, payer) RETURNING id INTO eq;
  SELECT code INTO wt FROM work_types WHERE is_active ORDER BY code LIMIT 1;
  INSERT INTO ids VALUES ('site2', site2), ('payer2', payer2), ('equipment', eq), ('site', site), ('payer', payer);
  INSERT INTO ids VALUES ('work_type', NULL);
  UPDATE ids SET id = NULL WHERE k = 'work_type';
  CREATE TEMP TABLE work_type_code AS SELECT wt AS code;
  GRANT SELECT ON work_type_code TO authenticated;
END $$;

-- ---------------------------------------------------------------- Дата вызова (находка 34)
SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT pg_temp.expect_russian_refusal(format($sql$
  INSERT INTO public.tasks (title, work_type_code, equipment_id, site_id, payer_id, created_by,
                            call_date, deadline_from, deadline_to, status_code)
  VALUES ('Задача из будущего', %L, %L, %L, %L, %L, DATE '2035-01-01', current_date, current_date + 7, 'new')
$sql$, (SELECT code FROM work_type_code), (SELECT id FROM ids WHERE k = 'equipment'),
   (SELECT id FROM ids WHERE k = 'site'), (SELECT id FROM ids WHERE k = 'payer'), (SELECT id FROM ids WHERE k = 'coord')),
  'дата вызова 01.01.2035 не принимается');

SELECT pg_temp.check(pg_temp.rows_affected(format($sql$
  INSERT INTO public.tasks (title, work_type_code, equipment_id, site_id, payer_id, created_by,
                            call_date, deadline_from, deadline_to, status_code)
  VALUES ('Обычная задача', %L, %L, %L, %L, %L, public.company_today(), current_date, current_date + 7, 'new')
$sql$, (SELECT code FROM work_type_code), (SELECT id FROM ids WHERE k = 'equipment'),
   (SELECT id FROM ids WHERE k = 'site'), (SELECT id FROM ids WHERE k = 'payer'), (SELECT id FROM ids WHERE k = 'coord'))) = 1,
  'задача с сегодняшней датой вызова и сроком на будущее заводится как раньше');
SELECT pg_temp.act_as_nobody();
INSERT INTO ids SELECT 'task', id FROM tasks WHERE title = 'Обычная задача';

SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT pg_temp.expect_russian_refusal(
  format('UPDATE public.tasks SET call_date = DATE ''2035-01-01'' WHERE id = %L', (SELECT id FROM ids WHERE k = 'task')),
  'дату вызова нельзя перенести в будущее и правкой задачи');
SELECT pg_temp.check(pg_temp.rows_affected(
  format('UPDATE public.tasks SET call_date = public.company_today() - 3 WHERE id = %L', (SELECT id FROM ids WHERE k = 'task'))) = 1,
  'дату вызова в прошлом поставить можно: заявку могли занести задним числом');
SELECT pg_temp.check(pg_temp.rows_affected(
  format('UPDATE public.tasks SET deadline_to = public.company_today() + 365 WHERE id = %L', (SELECT id FROM ids WHERE k = 'task'))) = 1,
  'срок работ в будущем не трогаем: это план, а не событие');

-- ---------------------------------------------------------------- Событие прибора (находка 2)
SELECT pg_temp.expect_russian_refusal(format($sql$
  INSERT INTO public.equipment_history (equipment_id, event_type, happened_at, summary, details, created_by)
  VALUES (%L, 'manual', TIMESTAMPTZ '2030-01-01 10:00+03', 'Диагностика', '{}'::jsonb, %L)
$sql$, (SELECT id FROM ids WHERE k = 'equipment'), (SELECT id FROM ids WHERE k = 'coord')),
  'прошлое событие прибора из 2030 года не принимается');

SELECT pg_temp.check(pg_temp.rows_affected(format($sql$
  INSERT INTO public.equipment_history (equipment_id, event_type, happened_at, summary, details, created_by)
  VALUES (%L, 'manual', now(), 'Диагностика сегодня', '{}'::jsonb, %L)
$sql$, (SELECT id FROM ids WHERE k = 'equipment'), (SELECT id FROM ids WHERE k = 'coord'))) = 1,
  'сегодняшнее событие прибора записывается как раньше');

-- Смена места установки и плательщика: дату берёт функция, запрет ловит её так же.
SELECT pg_temp.expect_russian_refusal(format($sql$
  SELECT public.change_equipment_site(%L, %L, TIMESTAMPTZ '2030-01-01 10:00+03', 'Переезд в будущее', %L)
$sql$, (SELECT id FROM ids WHERE k = 'equipment'), (SELECT id FROM ids WHERE k = 'site2'), (SELECT id FROM ids WHERE k = 'coord')),
  'смена места установки будущей датой не проходит');
SELECT pg_temp.expect_russian_refusal(format($sql$
  SELECT public.change_equipment_payer(%L, %L, TIMESTAMPTZ '2030-01-01 10:00+03', 'Смена в будущем', %L)
$sql$, (SELECT id FROM ids WHERE k = 'equipment'), (SELECT id FROM ids WHERE k = 'payer2'), (SELECT id FROM ids WHERE k = 'coord')),
  'смена плательщика будущей датой не проходит');

-- Секунда вперёд от начала транзакции: тот же день, и позже записи, открытой при заведении прибора.
SELECT pg_temp.check(public.change_equipment_site(
  pg_temp.uid('equipment'), pg_temp.uid('site2'), now() + interval '1 second', 'Переезд в другой корпус', pg_temp.uid('coord')) IS NOT NULL,
  'смена места установки сегодняшней датой работает как раньше');
SELECT pg_temp.act_as_nobody();

-- Прибор переехал: история не содержит записей из будущего.
SELECT pg_temp.check(
  NOT EXISTS (SELECT 1 FROM equipment_site_history
               WHERE equipment_id = pg_temp.uid('equipment')
                 AND (valid_from AT TIME ZONE 'Europe/Moscow')::date > public.company_today()),
  'в истории места установки нет записей из будущего');
SELECT pg_temp.check((SELECT public.company_today()) = (now() AT TIME ZONE 'Europe/Moscow')::date,
  'сегодня считается по часам компании');

ROLLBACK;
