-- Остальной склад: псевдонимы артикулов (0047), история движений по позиции (0048),
-- списание и корректировка (0049), приход файлом и остатки по состояниям (0050).
-- Подготовка данных та же, что в role_access.sql. Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/warehouse_rest.sql
-- Всё выполняется в транзакции и откатывается. Ошибка = проверка не прошла.

BEGIN;

-- Служебные функции теста
CREATE FUNCTION pg_temp.act_as(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE FUNCTION pg_temp.as_owner() RETURNS void LANGUAGE plpgsql AS $$
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

-- Ожидаем ошибку прав или проверки данных
CREATE FUNCTION pg_temp.expect_denied(p_sql text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN insufficient_privilege OR check_violation OR raise_exception OR unique_violation
    OR foreign_key_violation OR not_null_violation OR invalid_text_representation THEN
    RAISE NOTICE 'ok: % (запрещено)', p_label;
    RETURN;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — команда прошла, а должна быть запрещена', p_label;
END $$;

CREATE FUNCTION pg_temp.expect_forbidden(p_sql text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'ok: % (нет прав)', p_label;
    RETURN;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — команда прошла, а должна быть запрещена', p_label;
END $$;

-- Ожидаем отказ с конкретным текстом: интерфейс показывает его пользователю дословно
CREATE FUNCTION pg_temp.expect_message(p_sql text, p_message text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE got text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    got := SQLERRM;
    IF got <> p_message THEN
      RAISE EXCEPTION 'ПРОВАЛ: % — сообщение «%», ожидалось «%»', p_label, got, p_message;
    END IF;
    RAISE NOTICE 'ok: % («%»)', p_label, got;
    RETURN;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — команда прошла, а должна быть запрещена', p_label;
END $$;

GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.as_owner(), pg_temp.check(boolean, text),
  pg_temp.expect_denied(text, text), pg_temp.expect_forbidden(text, text),
  pg_temp.expect_message(text, text, text) TO authenticated, anon;

-- Данные (от владельца, RLS не действует)
CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid);
GRANT SELECT, INSERT ON ids TO authenticated;

DO $$
DECLARE
  roles text[] := ARRAY['coordinator', 'engineer', 'warehouse', 'supervisor', 'admin'];
  r text; uid uuid;
  org uuid; site uuid; payer uuid; manuf uuid; model uuid; eq uuid; wt text; t1 uuid;
  part_a uuid; part_b uuid; part_c uuid;
  lot_an uuid; lot_ag uuid; lot_bn uuid;
BEGIN
  FOREACH r IN ARRAY roles LOOP
    uid := gen_random_uuid();
    INSERT INTO auth.users (id, email, aud, role) VALUES (uid, r || '@test.local', 'authenticated', 'authenticated');
    INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
    VALUES (uid, 'Тест ' || r, r::user_role, r || '@test.local', true, r);
    INSERT INTO ids VALUES (r, uid);
  END LOOP;

  INSERT INTO organizations (name) VALUES ('Тестовая больница') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('Тестовая площадка', org) RETURNING id INTO site;
  INSERT INTO payers (name) VALUES ('Тестовый плательщик') RETURNING id INTO payer;
  INSERT INTO manufacturers (name) VALUES ('Тест-Производитель') RETURNING id INTO manuf;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (manuf, 'Модель-1') RETURNING id INTO model;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  VALUES ('SN-TEST-1', manuf, model, site, payer) RETURNING id INTO eq;
  SELECT code INTO wt FROM work_types WHERE is_active ORDER BY code LIMIT 1;

  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by,
    deadline_from, deadline_to, status_code, visit_date, call_reason)
  VALUES ('Ремонт анализатора', wt, eq, site, payer, (SELECT id FROM ids WHERE k = 'engineer'),
    (SELECT id FROM ids WHERE k = 'coordinator'), current_date, current_date + 7, 'in_progress', current_date, 'Не включается')
  RETURNING id INTO t1;

  INSERT INTO parts (article_number, name, minimum_stock) VALUES ('AU-LAMP-12V20W', 'Лампа галогеновая', 4) RETURNING id INTO part_a;
  INSERT INTO parts (article_number, name) VALUES ('XN-FILTER-WB', 'Фильтр цельной крови') RETURNING id INTO part_b;
  INSERT INTO parts (article_number, name, is_active) VALUES ('ART-OFF', 'Снятая с учёта', false) RETURNING id INTO part_c;

  -- Партии и приход: 10 новых и 4 гарантийных лампы, 6 новых фильтров.
  INSERT INTO stock_lots (part_id, part_condition) VALUES (part_a, 'N') RETURNING id INTO lot_an;
  INSERT INTO stock_lots (part_id, part_condition) VALUES (part_a, 'G') RETURNING id INTO lot_ag;
  INSERT INTO stock_lots (part_id, part_condition) VALUES (part_b, 'N') RETURNING id INTO lot_bn;
  INSERT INTO stock_movements (idempotency_key, movement_type, lot_id, part_id, part_condition, quantity, on_hand_delta, performed_by)
  VALUES ('receipt:an', 'receipt', lot_an, part_a, 'N', 10, 10, (SELECT id FROM ids WHERE k = 'warehouse')),
         ('receipt:ag', 'receipt', lot_ag, part_a, 'G', 4, 4, (SELECT id FROM ids WHERE k = 'warehouse')),
         ('receipt:bn', 'receipt', lot_bn, part_b, 'N', 6, 6, (SELECT id FROM ids WHERE k = 'warehouse'));

  INSERT INTO ids VALUES ('t1', t1), ('part_a', part_a), ('part_b', part_b), ('part_off', part_c),
    ('lot_an', lot_an), ('lot_ag', lot_ag), ('lot_bn', lot_bn), ('equipment', eq);
END $$;

-- =========================================================================
-- 0047. Псевдонимы артикулов
-- =========================================================================

SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'warehouse'));
INSERT INTO part_aliases (part_id, alias) VALUES ((SELECT id FROM ids WHERE k = 'part_a'), '12V20W-AU');
INSERT INTO part_aliases (part_id, alias) VALUES ((SELECT id FROM ids WHERE k = 'part_a'), 'LMP 480/680');
SELECT pg_temp.check((SELECT count(*) = 2 FROM part_aliases WHERE part_id = (SELECT id FROM ids WHERE k = 'part_a')),
  'кладовщик заводит псевдонимы артикула');

SELECT pg_temp.expect_message(
  $$INSERT INTO part_aliases (part_id, alias) VALUES ((SELECT id FROM ids WHERE k = 'part_b'), ' 12v20w-au ')$$,
  'Псевдоним «12v20w-au» уже закреплён за запчастью «AU-LAMP-12V20W · Лампа галогеновая»',
  'один псевдоним на две запчасти не заводится');
SELECT pg_temp.expect_message(
  $$INSERT INTO part_aliases (part_id, alias) VALUES ((SELECT id FROM ids WHERE k = 'part_a'), 'au-lamp-12v20w')$$,
  'Это и есть артикул самой запчасти: в псевдонимы пишут артикул поставщика',
  'псевдоним не повторяет артикул своей запчасти');
SELECT pg_temp.expect_message(
  $$INSERT INTO part_aliases (part_id, alias) VALUES ((SELECT id FROM ids WHERE k = 'part_a'), 'XN-FILTER-WB')$$,
  'Артикул «XN-FILTER-WB» занят запчастью «XN-FILTER-WB · Фильтр цельной крови»: псевдоним должен отличаться от артикулов других позиций',
  'псевдоним не занимает артикул другой позиции');
SELECT pg_temp.expect_message(
  $$INSERT INTO parts (article_number, name) VALUES ('12V20W-AU', 'Новая позиция')$$,
  'Артикул «12V20W-AU» уже заведён псевдонимом у запчасти «AU-LAMP-12V20W · Лампа галогеновая»: уберите псевдоним или возьмите другой артикул',
  'артикул новой запчасти не отбирает чужой псевдоним');

-- Поиск склада по псевдониму: как ищет интерфейс (ilike по search_text).
SELECT pg_temp.check((SELECT count(*) = 1 FROM inventory_part_registry
                       WHERE search_text ILIKE '%12v20w-au%' AND id = (SELECT id FROM ids WHERE k = 'part_a')),
  'склад находит запчасть по псевдониму');
SELECT pg_temp.check((SELECT count(*) = 1 FROM inventory_part_registry
                       WHERE search_text ILIKE '%lmp480680%' AND id = (SELECT id FROM ids WHERE k = 'part_a')),
  'псевдоним находится и без пробелов с дефисами');
SELECT pg_temp.check((SELECT aliases = '12V20W-AU, LMP 480/680' FROM inventory_part_registry
                       WHERE id = (SELECT id FROM ids WHERE k = 'part_a')),
  'псевдонимы видны в строке склада в заданном порядке');
SELECT pg_temp.check((SELECT aliases IS NULL FROM inventory_part_registry WHERE id = (SELECT id FROM ids WHERE k = 'part_b')),
  'без псевдонимов колонка пуста, а строка на складе остаётся');

SELECT pg_temp.as_owner();
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer'));
SELECT pg_temp.check((SELECT count(*) = 2 FROM part_aliases WHERE part_id = (SELECT id FROM ids WHERE k = 'part_a')),
  'инженер псевдонимы видит (склад ему открыт на чтение)');
SELECT pg_temp.expect_forbidden(
  $$INSERT INTO part_aliases (part_id, alias) VALUES ((SELECT id FROM ids WHERE k = 'part_b'), 'ENG-1')$$,
  'инженер не заводит псевдонимы');
SELECT pg_temp.as_owner();

SELECT pg_temp.check(NOT has_function_privilege('authenticated', 'public.guard_part_alias()', 'EXECUTE')
                 AND NOT has_function_privilege('anon', 'public.guard_part_alias()', 'EXECUTE'),
  'страж псевдонимов напрямую не вызывается');
SELECT pg_temp.check((SELECT prosecdef FROM pg_proc WHERE proname = 'guard_part_alias'),
  'страж псевдонимов работает от владельца схемы');

ROLLBACK;
