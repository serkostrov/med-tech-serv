-- Дубль модели прибора объясняется по-русски (миграция 0039).
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/equipment_model_duplicate.sql
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

-- Отказ должен быть не просто ошибкой, а понятной фразой: ждём в нём слово «Модель».
CREATE FUNCTION pg_temp.expect_refusal_matching(p_sql text, p_pattern text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  message text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN unique_violation OR check_violation OR raise_exception THEN
    message := SQLERRM;
    IF message !~ p_pattern THEN
      RAISE EXCEPTION 'ПРОВАЛ: % — отказ не объясняет причину: %', p_label, message;
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
  pg_temp.expect_refusal_matching(text, text, text), pg_temp.rows_affected(text), pg_temp.uid(text) TO authenticated;

DO $$
DECLARE
  coord uuid := gen_random_uuid();
  bc uuid; sysmex uuid; roche uuid; hidden_model uuid;
BEGIN
  INSERT INTO ids VALUES ('coord', coord);
  INSERT INTO auth.users (id, email, aud, role) VALUES (coord, 'coord@test.local', 'authenticated', 'authenticated');
  INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
  VALUES (coord, 'Тест координатор', 'coordinator', 'coord@test.local', true, 'coordinator');

  INSERT INTO manufacturers (name) VALUES ('Тест Beckman Coulter') RETURNING id INTO bc;
  INSERT INTO manufacturers (name) VALUES ('Тест Sysmex') RETURNING id INTO sysmex;
  INSERT INTO manufacturers (name) VALUES ('Тест Roche') RETURNING id INTO roche;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (bc, 'AU 680');
  INSERT INTO equipment_models (manufacturer_id, name, is_active) VALUES (roche, 'cobas e 411', false)
  RETURNING id INTO hidden_model;
  INSERT INTO ids VALUES ('bc', bc), ('sysmex', sysmex), ('roche', roche), ('hidden', hidden_model);
END $$;

-- ---------------------------------------------------------------- Случай из аудита
SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT pg_temp.expect_refusal_matching(
  format('INSERT INTO public.equipment_models (manufacturer_id, name) VALUES (%L, ''AU 680'')', (SELECT id FROM ids WHERE k = 'bc')),
  'Модель «AU 680» у производителя «Тест Beckman Coulter» уже есть',
  'вторая «AU 680» у того же производителя не заводится, и сказано почему');
SELECT pg_temp.expect_refusal_matching(
  format('INSERT INTO public.equipment_models (manufacturer_id, name) VALUES (%L, ''  au 680 '')', (SELECT id FROM ids WHERE k = 'bc')),
  'Регистр и пробелы при проверке не учитываются',
  'другой регистр и пробелы дублем быть не перестают');
SELECT pg_temp.expect_refusal_matching(
  format('INSERT INTO public.equipment_models (manufacturer_id, name) VALUES (%L, ''cobas e 411'')', (SELECT id FROM ids WHERE k = 'roche')),
  'скрыта: верните её кнопкой «Показать»',
  'скрытая запись тоже ловится, и подсказано, что с ней делать');
SELECT pg_temp.check((SELECT count(*) FROM equipment_models WHERE lower(btrim(name)) = 'au 680') = 1,
  'в справочнике по-прежнему одна «AU 680»');

-- ---------------------------------------------------------------- Что по-прежнему можно
SELECT pg_temp.check(pg_temp.rows_affected(
  format('INSERT INTO public.equipment_models (manufacturer_id, name) VALUES (%L, ''AU 680'')', (SELECT id FROM ids WHERE k = 'sysmex'))) = 1,
  'такое же название у другого производителя заводится');
SELECT pg_temp.check(pg_temp.rows_affected(
  format('UPDATE public.equipment_models SET name = ''AU 680 Plus'' WHERE manufacturer_id = %L AND name = ''AU 680''', (SELECT id FROM ids WHERE k = 'bc'))) = 1,
  'модель переименовывается как раньше');
SELECT pg_temp.check(pg_temp.rows_affected(
  format('UPDATE public.equipment_models SET is_active = true WHERE id = %L', (SELECT id FROM ids WHERE k = 'hidden'))) = 1,
  'скрытую модель можно вернуть: правка самой записи дублем не считается');
SELECT pg_temp.act_as_nobody();

-- Служебное: объяснение работает от владельца схемы, сам индекс на месте.
SELECT pg_temp.check((SELECT prosecdef FROM pg_proc WHERE proname = 'guard_equipment_model_duplicate'),
  'объяснение работает от владельца схемы');
SELECT pg_temp.check(EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'equipment_models_manufacturer_name_ci_uq'),
  'сама гарантия уникальности осталась индексом');

ROLLBACK;
