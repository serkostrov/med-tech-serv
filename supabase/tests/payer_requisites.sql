-- ИНН и КПП плательщика проверяются (миграция 0036).
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/payer_requisites.sql
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
  legacy uuid;
BEGIN
  INSERT INTO ids VALUES ('coord', coord);
  INSERT INTO auth.users (id, email, aud, role) VALUES (coord, 'coord@test.local', 'authenticated', 'authenticated');
  INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
  VALUES (coord, 'Тест координатор', 'coordinator', 'coord@test.local', true, 'coordinator');
  -- Старая запись с мусором: такие уже есть на стенде, и миграция их не ломает.
  -- Заводим её с выключенной проверкой — так же, как она попала в базу до миграции.
  ALTER TABLE payers DISABLE TRIGGER payers_validate_requisites;
  INSERT INTO payers (name, requisites) VALUES ('Старый плательщик с мусором', '{"inn":"abc!!","kpp":"12"}'::jsonb)
  RETURNING id INTO legacy;
  ALTER TABLE payers ENABLE TRIGGER payers_validate_requisites;
  INSERT INTO ids VALUES ('legacy', legacy);
END $$;

-- ---------------------------------------------------------------- Сами проверки номеров
SELECT pg_temp.check(public.is_valid_inn('7736012343'), 'ИНН организации из 10 цифр принимается');
SELECT pg_temp.check(public.is_valid_inn('526012874410'), 'ИНН предпринимателя из 12 цифр принимается');
SELECT pg_temp.check(NOT public.is_valid_inn('abc!!'), 'буквы в ИНН не принимаются');
SELECT pg_temp.check(NOT public.is_valid_inn('773601234'), 'девять цифр в ИНН не принимаются');
SELECT pg_temp.check(NOT public.is_valid_inn('7736012340'), 'опечатка в последней цифре ИНН ловится контрольной цифрой');
SELECT pg_temp.check(NOT public.is_valid_inn('526012874411'), 'опечатка в 12-значном ИНН ловится второй контрольной цифрой');
SELECT pg_temp.check(public.is_valid_kpp('773601001'), 'КПП из девяти цифр принимается');
SELECT pg_temp.check(public.is_valid_kpp('7736AB001'), 'КПП иностранной организации с буквами принимается');
SELECT pg_temp.check(NOT public.is_valid_kpp('12'), 'КПП из двух цифр не принимается');
SELECT pg_temp.check(NOT public.is_valid_kpp('7736ab001'), 'строчные буквы в КПП не принимаются');
-- Пробелы из буфера обмена и выгрузки 1С не должны менять вердикт: правило общее с интерфейсом.
SELECT pg_temp.check(public.is_valid_inn(' 7736012343 '), 'обычные пробелы вокруг ИНН не мешают');
SELECT pg_temp.check(public.is_valid_inn(E'7736012343\t'), 'табуляция вокруг ИНН не мешает');
SELECT pg_temp.check(public.is_valid_inn(E'\u00A07736012343'), 'неразрывный пробел вокруг ИНН не мешает');
SELECT pg_temp.check(public.is_valid_kpp(E' 773601001\u00A0'), 'то же правило у КПП');

-- ---------------------------------------------------------------- Случай из аудита
SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT pg_temp.expect_russian_refusal(
  'INSERT INTO public.payers (name, requisites) VALUES (''Тестовый Человек Аудитович'', ''{"inn":"abc!!","kpp":"12"}''::jsonb)',
  'человек с ИНН «abc!!» и КПП «12» не сохраняется');
SELECT pg_temp.expect_russian_refusal(
  'INSERT INTO public.payers (name, requisites) VALUES (''Только КПП'', ''{"kpp":"773601001"}''::jsonb)',
  'КПП без ИНН не сохраняется');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM payers WHERE name = 'Тестовый Человек Аудитович'),
  'мусор в справочник плательщиков не попал');

-- ---------------------------------------------------------------- Что по-прежнему можно
SELECT pg_temp.check(pg_temp.rows_affected(
  'INSERT INTO public.payers (name, requisites) VALUES (''ГБУЗ ГКБ № 1'', ''{"inn":"7736012343","kpp":"773601001"}''::jsonb)') = 1,
  'плательщик с верными реквизитами заводится');
SELECT pg_temp.check(pg_temp.rows_affected(
  'INSERT INTO public.payers (name) VALUES (''Человек с одним телефоном'')') = 1,
  'человек площадки без реквизитов заводится как раньше');
-- Лишние пробелы не просто пропускаются, а убираются: дальше реквизиты уходят в счёт и в акт.
SELECT pg_temp.check(pg_temp.rows_affected(
  'INSERT INTO public.payers (name, requisites) VALUES (''Плательщик с пробелами'', ''{"inn":" 7736012343 ","kpp":"773601001 "}''::jsonb)') = 1,
  'реквизиты с пробелами принимаются');
SELECT pg_temp.check(
  (SELECT requisites ->> 'inn' FROM payers WHERE name = 'Плательщик с пробелами') = '7736012343'
  AND (SELECT requisites ->> 'kpp' FROM payers WHERE name = 'Плательщик с пробелами') = '773601001',
  'и сохраняются уже обрезанными, а не с пробелом внутри');
SELECT pg_temp.check(pg_temp.rows_affected(
  format('UPDATE public.payers SET name = ''Старый плательщик, переименован'' WHERE id = %L', (SELECT id FROM ids WHERE k = 'legacy'))) = 1,
  'старую запись с мусором можно переименовать: проверка идёт только по реквизитам');
SELECT pg_temp.expect_russian_refusal(
  format('UPDATE public.payers SET requisites = ''{"inn":"123"}''::jsonb WHERE id = %L', (SELECT id FROM ids WHERE k = 'legacy')),
  'но исправить реквизиты на другой мусор нельзя');
SELECT pg_temp.check(pg_temp.rows_affected(
  format('UPDATE public.payers SET requisites = ''{"inn":"7736012343"}''::jsonb WHERE id = %L', (SELECT id FROM ids WHERE k = 'legacy'))) = 1,
  'а поправить на верный ИНН можно');
SELECT pg_temp.check(pg_temp.rows_affected(
  format('UPDATE public.payers SET requisites = ''{}''::jsonb WHERE id = %L', (SELECT id FROM ids WHERE k = 'legacy'))) = 1,
  'и убрать реквизиты совсем можно');
SELECT pg_temp.act_as_nobody();

-- Служебное: проверка работает от владельца схемы и напрямую не вызывается.
SELECT pg_temp.check((SELECT prosecdef FROM pg_proc WHERE proname = 'validate_payer_requisites'),
  'проверка реквизитов работает от владельца схемы');
SELECT pg_temp.check(NOT has_function_privilege('authenticated', 'public.validate_payer_requisites()', 'EXECUTE'),
  'проверку реквизитов напрямую не вызвать');
SELECT pg_temp.check(has_function_privilege('authenticated', 'public.is_valid_inn(text)', 'EXECUTE'),
  'сам разбор ИНН доступен вошедшему явно: им пользуются отчёты и импорт');

ROLLBACK;
