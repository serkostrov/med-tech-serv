-- Перенос данных из 1С: запись приборов и истории, права и повтор без дублей (миграция 0054).
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/import_1c.sql
-- Всё выполняется в транзакции и откатывается. Ошибка = проверка не прошла.
-- Свои строки помечены «IMP54-»: проверки смотрят только на них, поэтому тест
-- проходит и на базе, где уже есть данные.

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

CREATE FUNCTION pg_temp.check_eq(p_actual text, p_expected text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'ПРОВАЛ: % — получили «%», ждали «%»', p_label, p_actual, p_expected;
  END IF;
  RAISE NOTICE 'ok: %', p_label;
END $$;

CREATE FUNCTION pg_temp.expect_refusal_matching(p_sql text, p_pattern text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  message text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN insufficient_privilege OR check_violation OR raise_exception
    OR invalid_parameter_value OR invalid_text_representation THEN
    message := SQLERRM;
    IF message !~ p_pattern THEN
      RAISE EXCEPTION 'ПРОВАЛ: % — отказ не объясняет причину: %', p_label, message;
    END IF;
    RAISE NOTICE 'ok: % (отказ: %)', p_label, message;
    RETURN;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — команда прошла, а должна быть запрещена', p_label;
END $$;

CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid);
CREATE TEMP TABLE payload (k text PRIMARY KEY, value jsonb);
CREATE TEMP TABLE outcome (k text PRIMARY KEY, value jsonb);
GRANT SELECT ON ids TO authenticated;
GRANT SELECT ON payload TO authenticated;
GRANT SELECT, INSERT ON outcome TO authenticated;
CREATE FUNCTION pg_temp.uid(p_key text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM ids WHERE k = p_key
$$;
CREATE FUNCTION pg_temp.data(p_key text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT value FROM payload WHERE k = p_key
$$;
CREATE FUNCTION pg_temp.result(p_key text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT value FROM outcome WHERE k = p_key
$$;
GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.act_as_nobody(), pg_temp.check(boolean, text),
  pg_temp.check_eq(text, text, text), pg_temp.expect_refusal_matching(text, text, text),
  pg_temp.uid(text), pg_temp.data(text), pg_temp.result(text) TO authenticated;

DO $$
DECLARE
  coord uuid := gen_random_uuid();
  engineer uuid := gen_random_uuid();
  keeper uuid := gen_random_uuid();
  maker uuid;
BEGIN
  INSERT INTO ids VALUES ('coord', coord), ('engineer', engineer), ('keeper', keeper);
  INSERT INTO auth.users (id, email, aud, role) VALUES
    (coord, 'imp54-coord@test.local', 'authenticated', 'authenticated'),
    (engineer, 'imp54-engineer@test.local', 'authenticated', 'authenticated'),
    (keeper, 'imp54-keeper@test.local', 'authenticated', 'authenticated');
  INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key) VALUES
    (coord, 'IMP54 координатор', 'coordinator', 'imp54-coord@test.local', true, 'coordinator'),
    (engineer, 'IMP54 инженер', 'engineer', 'imp54-engineer@test.local', true, 'engineer'),
    (keeper, 'IMP54 реестр', 'coordinator', 'imp54-keeper@test.local', true, 'imp54_registry');

  -- Роль ровно с правом заводить приборы, но без права вести справочники.
  INSERT INTO public.access_roles (key, name, base_role) VALUES ('imp54_registry', 'IMP54 только реестр', 'coordinator');
  INSERT INTO public.access_role_permissions (role_key, permission_code)
  VALUES ('imp54_registry', 'equipment.read'), ('imp54_registry', 'equipment.write');

  INSERT INTO public.manufacturers (name) VALUES ('IMP54 Beckman') RETURNING id INTO maker;
  INSERT INTO public.equipment_models (manufacturer_id, name) VALUES (maker, 'IMP54 DxH-800');
  INSERT INTO ids VALUES ('maker', maker);

  INSERT INTO payload VALUES
    ('equipment', jsonb_build_array(jsonb_build_object(
       'serialNumber', 'IMP54-BE49081', 'manufacturer', 'IMP54 Beckman', 'model', 'IMP54 DxH-800'))),
    ('equipment_new_model', jsonb_build_array(jsonb_build_object(
       'serialNumber', 'IMP54-NEW-1', 'manufacturer', 'IMP54 Mindray', 'model', 'IMP54 BS-620'))),
    ('events', jsonb_build_array(
       jsonb_build_object(
         'serialNumber', 'IMP54-BE49081', 'sourceKey', repeat('1', 64),
         'happenedAt', '2024-03-15T00:00:00+03:00', 'summary', 'Инсталляция',
         'client', 'IMP54 клиника', 'description', 'инстал', 'workType', 'Инсталляция'),
       jsonb_build_object(
         'serialNumber', ' imp54-be 49081 ', 'sourceKey', repeat('2', 64),
         'happenedAt', '2024-03-25T00:00:00+03:00', 'summary', 'Ремонт',
         'client', 'IMP54 клиника', 'description', '', 'workType', 'Ремонт'))),
    ('events_orphan', jsonb_build_array(jsonb_build_object(
       'serialNumber', 'IMP54-НЕТ-ТАКОГО', 'sourceKey', repeat('3', 64),
       'happenedAt', '2024-03-15T00:00:00+03:00', 'summary', 'Ремонт',
       'client', '', 'description', '', 'workType', 'Ремонт'))),
    ('events_future', jsonb_build_array(jsonb_build_object(
       'serialNumber', 'IMP54-BE49081', 'sourceKey', repeat('4', 64),
       'happenedAt', '2099-01-01T00:00:00+03:00', 'summary', 'Ремонт',
       'client', '', 'description', '', 'workType', 'Ремонт'))),
    ('events_bad_key', jsonb_build_array(jsonb_build_object(
       'serialNumber', 'IMP54-BE49081', 'sourceKey', 'не-ключ',
       'happenedAt', '2024-03-15T00:00:00+03:00', 'summary', 'Ремонт',
       'client', '', 'description', '', 'workType', 'Ремонт')));
END $$;

-- ---------------------------------------------------------------- Права
SELECT pg_temp.act_as(pg_temp.uid('engineer'));
SELECT pg_temp.expect_refusal_matching(
  'SELECT public.import_equipment_history(''imp54.xlsx'', pg_temp.data(''equipment''), pg_temp.data(''events''))',
  'право заводить приборы',
  'инженер импорт не запускает, и сказано почему');

SELECT pg_temp.act_as(pg_temp.uid('keeper'));
SELECT pg_temp.expect_refusal_matching(
  'SELECT public.import_equipment_history(''imp54.xlsx'', pg_temp.data(''equipment_new_model''), ''[]''::jsonb)',
  'модель, которой нет в справочнике',
  'без права на справочники новую модель импорт не заводит');
SELECT pg_temp.check(
  (public.import_equipment_history('imp54.xlsx', pg_temp.data('equipment'), '[]'::jsonb) ->> 'equipmentCreated') = '1',
  'прибор по известной модели заводится и без права на справочники');

-- ------------------------------------------------- Запись приборов и событий
SELECT pg_temp.act_as(pg_temp.uid('coord'));
INSERT INTO outcome
SELECT 'second', public.import_equipment_history('imp54.xlsx', pg_temp.data('equipment'), pg_temp.data('events'));
SELECT pg_temp.check_eq(pg_temp.result('second') ->> 'equipmentCreated', '0',
  'прибор уже есть: второй раз не создаётся');
SELECT pg_temp.check_eq(pg_temp.result('second') ->> 'eventsCreated', '2',
  'оба события истории записаны');
SELECT pg_temp.check_eq(pg_temp.result('second') ->> 'eventsWithoutEquipment', '0',
  'прибор для событий найден, в том числе по S/N с пробелами и другим регистром');
SELECT pg_temp.check(
  (SELECT count(*) FROM public.equipment_history AS h
     JOIN public.equipment AS e ON e.id = h.equipment_id
    WHERE e.serial_number_normalized = 'IMP54-BE49081') = 2,
  'в истории прибора ровно две записи');
SELECT pg_temp.check(
  (SELECT count(*) FROM public.equipment_history_feed AS feed
     JOIN public.equipment AS e ON e.id = feed.equipment_id
    WHERE e.serial_number_normalized = 'IMP54-BE49081' AND feed.event_type = 'imported') = 2,
  'лента прибора показывает эти записи как «Импорт»');
SELECT pg_temp.check(
  (SELECT h.details ->> 'client'
     FROM public.equipment_history AS h
     JOIN public.equipment AS e ON e.id = h.equipment_id
    WHERE h.source_key = repeat('1', 64) AND e.serial_number_normalized = 'IMP54-BE49081') = 'IMP54 клиника',
  'клиент события сохранён снимком');
SELECT pg_temp.check(
  (SELECT h.created_by
     FROM public.equipment_history AS h
     JOIN public.equipment AS e ON e.id = h.equipment_id
    WHERE h.source_key = repeat('1', 64) AND e.serial_number_normalized = 'IMP54-BE49081')
    = pg_temp.uid('coord'),
  'автор записи — тот, кто запустил импорт');

-- ---------------------------------------------------------------- Повтор без дублей
INSERT INTO outcome
SELECT 'again', public.import_equipment_history('imp54.xlsx', pg_temp.data('equipment'), pg_temp.data('events'));
SELECT pg_temp.check_eq(pg_temp.result('again') ->> 'equipmentCreated', '0', 'повтор не создаёт прибор');
SELECT pg_temp.check_eq(pg_temp.result('again') ->> 'eventsCreated', '0', 'повтор не добавляет событий');
SELECT pg_temp.check_eq(pg_temp.result('again') ->> 'eventsAlready', '2', 'повтор говорит, что события уже были');
SELECT pg_temp.check(
  (SELECT count(*) FROM public.equipment_history AS h
     JOIN public.equipment AS e ON e.id = h.equipment_id
    WHERE e.serial_number_normalized = 'IMP54-BE49081') = 2,
  'после повторной загрузки в истории всё те же две записи');

-- ---------------------------------------------------------------- Новая модель и производитель
INSERT INTO outcome
SELECT 'catalog', public.import_equipment_history('imp54.xlsx', pg_temp.data('equipment_new_model'), '[]'::jsonb);
SELECT pg_temp.check_eq(pg_temp.result('catalog') ->> 'manufacturersCreated', '1', 'новый производитель заведён');
SELECT pg_temp.check_eq(pg_temp.result('catalog') ->> 'modelsCreated', '1', 'новая модель заведена');
SELECT pg_temp.check_eq(pg_temp.result('catalog') ->> 'equipmentCreated', '1', 'прибор по новой модели создан');
SELECT pg_temp.check(
  (SELECT count(*) FROM public.equipment_models AS m
     JOIN public.manufacturers AS k ON k.id = m.manufacturer_id
    WHERE k.name = 'IMP54 Mindray' AND m.name = 'IMP54 BS-620') = 1,
  'в справочнике ровно одна такая модель');

-- ------------------------------------------------- Новый прибор и его история разом
INSERT INTO outcome
SELECT 'together', public.import_equipment_history(
  'imp54-together.xlsx',
  jsonb_build_array(jsonb_build_object(
    'serialNumber', 'IMP54-TOGETHER-1', 'manufacturer', 'IMP54 Beckman', 'model', 'IMP54 DxH-800')),
  jsonb_build_array(jsonb_build_object(
    'serialNumber', 'IMP54-TOGETHER-1', 'sourceKey', repeat('5', 64),
    'happenedAt', '2024-05-05T00:00:00+03:00', 'summary', 'Инсталляция',
    'client', 'IMP54 клиника', 'description', '', 'workType', 'Инсталляция')));
SELECT pg_temp.check_eq(pg_temp.result('together') ->> 'equipmentCreated', '1',
  'прибор создан тем же вызовом');
SELECT pg_temp.check_eq(pg_temp.result('together') ->> 'eventsCreated', '1',
  'событие нашло прибор, созданный в этом же вызове');
SELECT pg_temp.check_eq(pg_temp.result('together') ->> 'eventsWithoutEquipment', '0',
  'потерянных событий нет');
SELECT pg_temp.check_eq(pg_temp.result('together') ->> 'equipmentAlready', '0',
  'повторов в файле не было');

-- Один прибор двумя строками файла: «уже было» не выдумывается из повторов.
INSERT INTO outcome
SELECT 'repeats', public.import_equipment_history(
  'imp54-repeats.xlsx',
  jsonb_build_array(
    jsonb_build_object('serialNumber', 'IMP54-REPEAT-1', 'manufacturer', 'IMP54 Beckman', 'model', 'IMP54 DxH-800'),
    jsonb_build_object('serialNumber', ' imp54-repeat-1 ', 'manufacturer', 'IMP54 Beckman', 'model', 'IMP54 DxH-800')),
  '[]'::jsonb);
SELECT pg_temp.check_eq(pg_temp.result('repeats') ->> 'equipmentCreated', '1', 'прибор создан один раз');
SELECT pg_temp.check_eq(pg_temp.result('repeats') ->> 'equipmentAlready', '0',
  'повтор строки в файле не считается записью, которая уже была');

-- Скрытую модель база на прибор не поставит: отказ говорит, что делать.
SELECT pg_temp.act_as_nobody();
DO $$
DECLARE maker uuid;
BEGIN
  INSERT INTO public.manufacturers (name) VALUES ('IMP54 Hidden') RETURNING id INTO maker;
  INSERT INTO public.equipment_models (manufacturer_id, name, is_active)
  VALUES (maker, 'IMP54 Скрытая', false);
END $$;
SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT pg_temp.expect_refusal_matching(
  'SELECT public.import_equipment_history(''imp54.xlsx'', jsonb_build_array(jsonb_build_object('
  || '''serialNumber'', ''IMP54-HIDDEN-1'', ''manufacturer'', ''IMP54 Hidden'', ''model'', ''IMP54 Скрытая'')), ''[]''::jsonb)',
  'скрыт\(а\) модель',
  'скрытая модель объясняется словами, а не отказом с идентификатором');

-- Прибор уже в реестре, а его модель позже скрыли: повтор файла всё равно проходит.
SELECT pg_temp.act_as_nobody();
UPDATE public.equipment_models AS em
   SET is_active = false
  FROM public.manufacturers AS m
 WHERE m.id = em.manufacturer_id AND m.name = 'IMP54 Beckman' AND em.name = 'IMP54 DxH-800';
SELECT pg_temp.act_as(pg_temp.uid('coord'));
INSERT INTO outcome
SELECT 'after_hide', public.import_equipment_history('imp54.xlsx', pg_temp.data('equipment'), pg_temp.data('events'));
SELECT pg_temp.check_eq(pg_temp.result('after_hide') ->> 'equipmentCreated', '0',
  'скрытая модель не мешает повтору файла: прибор уже в реестре');
SELECT pg_temp.check_eq(pg_temp.result('after_hide') ->> 'eventsCreated', '0',
  'повтор по-прежнему ничего не добавляет');
SELECT pg_temp.act_as_nobody();
UPDATE public.equipment_models AS em
   SET is_active = true
  FROM public.manufacturers AS m
 WHERE m.id = em.manufacturer_id AND m.name = 'IMP54 Beckman' AND em.name = 'IMP54 DxH-800';
SELECT pg_temp.act_as(pg_temp.uid('coord'));

-- ---------------------------------------------------------------- Чего импорт не делает молча
INSERT INTO outcome
SELECT 'orphan', public.import_equipment_history('imp54.xlsx', '[]'::jsonb, pg_temp.data('events_orphan'));
SELECT pg_temp.check_eq(pg_temp.result('orphan') ->> 'eventsWithoutEquipment', '1',
  'событие без прибора не записано, и об этом сказано числом');
SELECT pg_temp.check_eq(pg_temp.result('orphan') ->> 'eventsCreated', '0',
  'в историю ничего не ушло');
SELECT pg_temp.expect_refusal_matching(
  'SELECT public.import_equipment_history(''imp54.xlsx'', ''[]''::jsonb, pg_temp.data(''events_future''))',
  'из будущего',
  'событие будущим числом база не принимает');
SELECT pg_temp.expect_refusal_matching(
  'SELECT public.import_equipment_history(''imp54.xlsx'', ''[]''::jsonb, pg_temp.data(''events_bad_key''))',
  'ключ строки',
  'событие без ключа идемпотентности не записывается');
SELECT pg_temp.expect_refusal_matching(
  'SELECT public.import_equipment_history('''', pg_temp.data(''equipment''), ''[]''::jsonb)',
  'имя файла',
  'импорт без имени файла не запускается');
SELECT pg_temp.expect_refusal_matching(
  'SELECT public.import_equipment_history(''imp54.xlsx'', ''{}''::jsonb, ''[]''::jsonb)',
  'передаются списками',
  'приборы приходят списком, а не объектом');
SELECT pg_temp.expect_refusal_matching(
  'SELECT public.import_equipment_history(''imp54.xlsx'', jsonb_build_array(jsonb_build_object(''serialNumber'', ''IMP54-X'')), ''[]''::jsonb)',
  'серийный номер, производитель и модель',
  'неполная строка прибора не записывается');
SELECT pg_temp.act_as_nobody();

-- ---------------------------------------------------------------- Служебное
SELECT pg_temp.check(
  (SELECT NOT prosecdef FROM pg_proc
    WHERE proname = 'import_equipment_history' AND pronamespace = 'public'::regnamespace),
  'импорт идёт с правами вызывающего: правила строк не обходятся');
SELECT pg_temp.check(
  NOT has_function_privilege('anon', 'public.import_equipment_history(text, jsonb, jsonb)', 'execute'),
  'анонимному доступу импорт не выдан');
SELECT pg_temp.check(
  has_function_privilege('authenticated', 'public.import_equipment_history(text, jsonb, jsonb)', 'execute'),
  'вошедшему сотруднику импорт доступен');
SELECT pg_temp.check(
  EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'equipment_history_import_source_uq'),
  'идемпотентность истории держится уникальным индексом по source_key');

ROLLBACK;
