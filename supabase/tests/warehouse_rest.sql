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

-- Сколько строк изменила команда: правку и удаление движений политики не запрещают
-- ошибкой, а просто не дают ни одной строки — проверяем именно это.
CREATE FUNCTION pg_temp.rows_affected(p_sql text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.as_owner(), pg_temp.check(boolean, text),
  pg_temp.expect_denied(text, text), pg_temp.expect_forbidden(text, text),
  pg_temp.expect_message(text, text, text), pg_temp.rows_affected(text) TO authenticated, anon;

-- Данные (от владельца, RLS не действует)
CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid);
GRANT SELECT, INSERT ON ids TO authenticated;

DO $$
DECLARE
  roles text[] := ARRAY['coordinator', 'engineer', 'warehouse', 'supervisor', 'admin', 'customer'];
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
  -- Приход тремя днями раньше: в тесте всё остальное происходит «сейчас», и порядок
  -- истории (сначала свежее) проверяется по-настоящему.
  INSERT INTO stock_movements (idempotency_key, movement_type, lot_id, part_id, part_condition, quantity, on_hand_delta, performed_by, occurred_at, comment)
  VALUES ('receipt:an', 'receipt', lot_an, part_a, 'N', 10, 10, (SELECT id FROM ids WHERE k = 'warehouse'), now() - interval '3 days', 'Накладная 77 от поставщика'),
         ('receipt:ag', 'receipt', lot_ag, part_a, 'G', 4, 4, (SELECT id FROM ids WHERE k = 'warehouse'), now() - interval '3 days', NULL),
         ('receipt:bn', 'receipt', lot_bn, part_b, 'N', 6, 6, (SELECT id FROM ids WHERE k = 'warehouse'), now() - interval '3 days', NULL);

  INSERT INTO ids VALUES ('t1', t1), ('part_a', part_a), ('part_b', part_b), ('part_off', part_c),
    ('lot_an', lot_an), ('lot_ag', lot_ag), ('lot_bn', lot_bn), ('equipment', eq);
END $$;

-- Создание резерва через RPC с запоминанием id (как в warehouse_chain.sql)
CREATE FUNCTION pg_temp.make_reservation(p_key text, p_task uuid, p_part uuid, p_condition part_condition, p_quantity numeric)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE new_id uuid;
BEGIN
  SELECT created.id INTO new_id FROM public.create_task_part_reservation(p_task, p_part, p_condition, p_quantity) AS created;
  INSERT INTO ids VALUES (p_key, new_id);
  RETURN new_id;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.make_reservation(text, uuid, uuid, part_condition, numeric) TO authenticated;

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

-- =========================================================================
-- 0049. Списание и корректировка остатка
-- =========================================================================

SELECT pg_temp.check(has_function_privilege('authenticated', 'public.write_off_stock(uuid, public.part_condition, numeric, text)', 'EXECUTE')
                 AND NOT has_function_privilege('anon', 'public.write_off_stock(uuid, public.part_condition, numeric, text)', 'EXECUTE'),
  'списание доступно вошедшему сотруднику и закрыто без входа');
SELECT pg_temp.check(NOT (SELECT prosecdef FROM pg_proc WHERE proname = 'write_off_stock')
                 AND NOT (SELECT prosecdef FROM pg_proc WHERE proname = 'adjust_stock'),
  'списание и корректировка работают с правами вызывающего');

SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer'));
SELECT pg_temp.expect_message(
  $$SELECT public.write_off_stock((SELECT id FROM ids WHERE k = 'part_a'), 'N', 1, 'Разбил')$$,
  'Списывать запчасти со склада может только склад', 'инженер не списывает запчасти');
SELECT pg_temp.expect_message(
  $$SELECT public.adjust_stock((SELECT id FROM ids WHERE k = 'part_a'), 'N', 9, 'Пересчёт')$$,
  'Править остаток на складе может только склад', 'инженер не правит остаток');
SELECT pg_temp.as_owner();

SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'warehouse'));
SELECT pg_temp.expect_message(
  $$SELECT public.write_off_stock((SELECT id FROM ids WHERE k = 'part_a'), 'N', 1, '   ')$$,
  'Укажите причину списания: брак, утеря, бой — она останется в истории позиции',
  'списание без причины не проводится');
SELECT pg_temp.expect_message(
  $$SELECT public.write_off_stock((SELECT id FROM ids WHERE k = 'part_a'), 'N', 0, 'Брак')$$,
  'Количество для списания должно быть больше нуля', 'нулевое списание не проводится');
SELECT pg_temp.expect_message(
  $$SELECT public.write_off_stock((SELECT id FROM ids WHERE k = 'part_a'), 'B', 1, 'Брак')$$,
  'На складе нет этой запчасти в состоянии «б/у»: списывать нечего',
  'списание из пустого состояния отказывается с названием состояния');
SELECT pg_temp.expect_message(
  $$SELECT public.write_off_stock((SELECT id FROM ids WHERE k = 'part_a'), 'N', 11, 'Брак')$$,
  'На складе 10 шт. в состоянии «новая»: списать можно не больше 10',
  'больше, чем на складе, не списать');

-- Под задачу зарезервировано 3 новых лампы: списать можно только остальные 7.
SELECT pg_temp.check(pg_temp.make_reservation('res_a', (SELECT id FROM ids WHERE k = 't1'),
    (SELECT id FROM ids WHERE k = 'part_a'), 'N', 3) IS NOT NULL,
  'кладовщик заказал 3 шт. под задачу');
SELECT pg_temp.expect_message(
  $$SELECT public.write_off_stock((SELECT id FROM ids WHERE k = 'part_a'), 'N', 8, 'Бой при перевозке')$$,
  'На складе 10 шт. в состоянии «новая», из них 3 под задачи в резерве: списать можно не больше 7',
  'зарезервированное под задачи не списывается');

SELECT pg_temp.check(public.write_off_stock((SELECT id FROM ids WHERE k = 'part_a'), 'N', 2, 'Бой при перевозке') = 8,
  'кладовщик списал 2 шт. и получил новый остаток');
SELECT pg_temp.check((SELECT on_hand_quantity = 8 AND reserved_quantity = 3 AND available_quantity = 5
                        FROM stock_balances WHERE part_id = (SELECT id FROM ids WHERE k = 'part_a') AND part_condition = 'N'),
  'остаток, резерв и доступное сошлись после списания');
SELECT pg_temp.check((SELECT count(*) = 1 FROM stock_movements
                       WHERE part_id = (SELECT id FROM ids WHERE k = 'part_a') AND movement_type = 'writeoff'
                         AND quantity = 2 AND on_hand_delta = -2 AND comment = 'Бой при перевозке'
                         AND performed_by = (SELECT id FROM ids WHERE k = 'warehouse')),
  'списание записано движением с причиной и автором');

-- Корректировка: фактически на полке 6 новых ламп вместо восьми учётных.
SELECT pg_temp.expect_message(
  $$SELECT public.adjust_stock((SELECT id FROM ids WHERE k = 'part_a'), 'N', 6, '')$$,
  'Укажите причину корректировки: номер инвентаризации или что именно разошлось',
  'корректировка без причины не проводится');
SELECT pg_temp.expect_message(
  $$SELECT public.adjust_stock((SELECT id FROM ids WHERE k = 'part_a'), 'N', 8, 'Инвентаризация 11/2026')$$,
  'В состоянии «новая» на складе уже 8 шт.: корректировать нечего',
  'корректировка без разницы не проводится');
SELECT pg_temp.expect_message(
  $$SELECT public.adjust_stock((SELECT id FROM ids WHERE k = 'part_a'), 'N', 2, 'Инвентаризация 11/2026')$$,
  'Под задачи зарезервировано 3 шт. в состоянии «новая», а по факту насчитали 2: снимите лишние резервы или проверьте пересчёт',
  'корректировка ниже резерва не проводится');
SELECT pg_temp.expect_message(
  $$SELECT public.adjust_stock((SELECT id FROM ids WHERE k = 'part_a'), 'N', -1, 'Инвентаризация 11/2026')$$,
  'Фактический остаток не может быть отрицательным', 'отрицательный факт не принимается');

SELECT pg_temp.check(public.adjust_stock((SELECT id FROM ids WHERE k = 'part_a'), 'N', 6, 'Инвентаризация 11/2026') = 6,
  'кладовщик выставил фактический остаток 6 шт.');
SELECT pg_temp.check((SELECT count(*) = 1 FROM stock_movements
                       WHERE part_id = (SELECT id FROM ids WHERE k = 'part_a') AND movement_type = 'adjustment'
                         AND quantity = 2 AND on_hand_delta = -2
                         AND comment = 'Инвентаризация: было 8, стало 6. Инвентаризация 11/2026'),
  'корректировка проведена встречным движением с разницей в причине');
-- Корректировка в плюс по состоянию, которого на складе ещё не было: партия заводится сама.
SELECT pg_temp.check(public.adjust_stock((SELECT id FROM ids WHERE k = 'part_a'), 'B', 3, 'Нашли на полке') = 3,
  'корректировка в плюс по пустому состоянию заводит партию');
SELECT pg_temp.check((SELECT on_hand_quantity = 3 FROM stock_balances
                       WHERE part_id = (SELECT id FROM ids WHERE k = 'part_a') AND part_condition = 'B'),
  'найденные б/у встали в остаток');
-- Снятая с учёта позиция: брак в ней тоже находят, инвентаризация считает всё.
SELECT pg_temp.check(public.adjust_stock((SELECT id FROM ids WHERE k = 'part_off'), 'N', 1, 'Нашли при инвентаризации') = 1,
  'снятая с учёта позиция корректируется');

-- Движения только добавляются: правка и удаление закрыты (0014), причина обязательна.
SELECT pg_temp.check(pg_temp.rows_affected($$UPDATE stock_movements SET quantity = 1 WHERE movement_type = 'writeoff'$$) = 0,
  'движение склада не исправить');
SELECT pg_temp.check(pg_temp.rows_affected($$DELETE FROM stock_movements WHERE movement_type = 'writeoff'$$) = 0,
  'движение склада не удалить');
SELECT pg_temp.check((SELECT count(*) = 1 FROM stock_movements WHERE movement_type = 'writeoff' AND quantity = 2),
  'списание осталось в истории как было');
SELECT pg_temp.expect_message(
  $$INSERT INTO stock_movements (idempotency_key, movement_type, lot_id, part_id, part_condition, quantity, on_hand_delta)
    VALUES ('direct:writeoff', 'writeoff', (SELECT id FROM ids WHERE k = 'lot_an'),
            (SELECT id FROM ids WHERE k = 'part_a'), 'N', 1, -1)$$,
  'У списания и корректировки причина обязательна: без неё движение по складу не проводится',
  'прямое списание без причины не проводится');
SELECT pg_temp.as_owner();

-- =========================================================================
-- 0048. История движений по позиции
-- =========================================================================

SELECT pg_temp.check(has_function_privilege('authenticated', 'public.inventory_part_movements(uuid, integer, integer)', 'EXECUTE')
                 AND NOT has_function_privilege('anon', 'public.inventory_part_movements(uuid, integer, integer)', 'EXECUTE'),
  'история движений доступна вошедшему сотруднику и закрыта без входа');

SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'warehouse'));
SELECT pg_temp.check((SELECT count(*) = 5 FROM public.inventory_part_movements((SELECT id FROM ids WHERE k = 'part_a'))),
  'история показывает все движения позиции по всем состояниям');
SELECT pg_temp.check((SELECT movement_type <> 'receipt' FROM public.inventory_part_movements((SELECT id FROM ids WHERE k = 'part_a')) LIMIT 1)
                 AND (SELECT movement_type = 'receipt' FROM public.inventory_part_movements((SELECT id FROM ids WHERE k = 'part_a'), 1, 4)),
  'история идёт от свежего к старому: приход трёхдневной давности в конце');
SELECT pg_temp.check((SELECT performed_by_name = 'Тест warehouse' AND comment LIKE 'Инвентаризация: было 8, стало 6.%'
                        FROM public.inventory_part_movements((SELECT id FROM ids WHERE k = 'part_a'))
                       WHERE movement_type = 'adjustment' AND part_condition = 'N'),
  'у корректировки видны автор и причина');
SELECT pg_temp.check((SELECT comment = 'Накладная 77 от поставщика' AND task_number IS NULL AND reservation_number IS NULL
                        FROM public.inventory_part_movements((SELECT id FROM ids WHERE k = 'part_a'))
                       WHERE movement_type = 'receipt' AND part_condition = 'N'),
  'у прихода видно, по какой накладной он пришёл');
-- Остаток после движения считается по своему состоянию, а не по всей позиции: у последнего
-- движения в состоянии он совпадает с остатком склада (10 − 2 − 2 = 6 новых, 4 гарантийных,
-- 3 найденных б/у). Списание и корректировка в тесте идут одной транзакцией, то есть в одну
-- и ту же секунду: что из них считать первым, порядок не определяет, поэтому проверяем итог.
SELECT pg_temp.check((SELECT on_hand_after = 6 FROM public.inventory_part_movements((SELECT id FROM ids WHERE k = 'part_a'))
                       WHERE part_condition = 'N' LIMIT 1)
                 AND (SELECT on_hand_after = 10 FROM public.inventory_part_movements((SELECT id FROM ids WHERE k = 'part_a'))
                       WHERE movement_type = 'receipt' AND part_condition = 'N')
                 AND (SELECT on_hand_after = 4 FROM public.inventory_part_movements((SELECT id FROM ids WHERE k = 'part_a'))
                       WHERE part_condition = 'G' LIMIT 1)
                 AND (SELECT on_hand_after = 3 FROM public.inventory_part_movements((SELECT id FROM ids WHERE k = 'part_a'))
                       WHERE part_condition = 'B' LIMIT 1),
  'остаток после движения посчитан по состоянию, а не по всей позиции');
SELECT pg_temp.check((SELECT total_count = 5 FROM public.inventory_part_movements((SELECT id FROM ids WHERE k = 'part_a'), 2, 0) LIMIT 1)
                 AND (SELECT count(*) = 2 FROM public.inventory_part_movements((SELECT id FROM ids WHERE k = 'part_a'), 2, 0)),
  'история листается страницами, общее число рядом со строкой');
SELECT pg_temp.expect_message(
  $$SELECT * FROM public.inventory_part_movements('00000000-0000-4000-8000-000000000000')$$,
  'Запчасть не найдена в справочнике', 'история несуществующей позиции отказывается понятно');
SELECT pg_temp.as_owner();

-- Инженеру склад открыт на чтение: историю он видит, цены прихода в ней нет ни у кого.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer'));
SELECT pg_temp.check((SELECT count(*) = 5 FROM public.inventory_part_movements((SELECT id FROM ids WHERE k = 'part_a'))),
  'инженер видит историю движений');
SELECT pg_temp.as_owner();
SELECT pg_temp.check(NOT EXISTS (
  SELECT 1 FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'inventory_part_movements'
     AND pg_get_function_result(p.oid) ILIKE '%price%'
), 'история движений не отдаёт цену прихода');

-- Выдача и возврат в истории: номер задачи остаётся виден и после того, как задача
-- перестала быть доступна кладовщику (ради этого 0048 и работает от владельца схемы).
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'warehouse'));
UPDATE stock_reservations SET status = 'warehouse_notified' WHERE id = (SELECT id FROM ids WHERE k = 'res_a');
SELECT public.issue_stock_reservation((SELECT id FROM ids WHERE k = 'res_a'));
SELECT pg_temp.check((SELECT task_number LIKE 'З-%' AND reservation_number LIKE 'Р-%'
                        AND equipment_serial_number = 'SN-TEST-1' AND quantity = 3
                        FROM public.inventory_part_movements((SELECT id FROM ids WHERE k = 'part_a'))
                       WHERE movement_type = 'issue'),
  'у выдачи в истории видны задача, резерв и прибор');
SELECT public.return_stock_reservation((SELECT id FROM ids WHERE k = 'res_a'));
SELECT pg_temp.check(NOT public.app_can_read_task((SELECT id FROM ids WHERE k = 't1')),
  'после возврата задача кладовщику уже не видна');
SELECT pg_temp.check((SELECT task_number LIKE 'З-%' FROM public.inventory_part_movements((SELECT id FROM ids WHERE k = 'part_a'))
                       WHERE movement_type = 'issue'),
  'номер задачи в истории виден и после того, как задача закрылась для склада');
SELECT pg_temp.check((SELECT count(*) = 7 FROM public.inventory_part_movements((SELECT id FROM ids WHERE k = 'part_a'))),
  'выдача и возврат встали в историю позиции');
SELECT pg_temp.as_owner();

-- Заказчику склад закрыт целиком: ни остатков, ни истории движений по позиции.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'customer'));
SELECT pg_temp.check((SELECT count(*) = 0 FROM inventory_part_registry), 'заказчик не видит склада');
SELECT pg_temp.expect_message(
  $$SELECT * FROM public.inventory_part_movements((SELECT id FROM ids WHERE k = 'part_a'))$$,
  'История движений по запчасти доступна только складу', 'заказчик не читает историю движений');
SELECT pg_temp.expect_message(
  $$SELECT * FROM public.preview_stock_receipt('[{"article": "AU-LAMP-12V20W", "quantity": 1}]'::jsonb)$$,
  'Загружать приход накладной может только склад', 'заказчик не разбирает накладные');
SELECT pg_temp.as_owner();

-- =========================================================================
-- 0050. Приход накладной файлом и остаток по состояниям
-- =========================================================================

SELECT pg_temp.check(has_function_privilege('authenticated', 'public.preview_stock_receipt(jsonb)', 'EXECUTE')
                 AND has_function_privilege('authenticated', 'public.receive_stock_batch(jsonb)', 'EXECUTE')
                 AND NOT has_function_privilege('anon', 'public.preview_stock_receipt(jsonb)', 'EXECUTE')
                 AND NOT has_function_privilege('anon', 'public.receive_stock_batch(jsonb)', 'EXECUTE'),
  'разбор и приход накладной доступны вошедшему сотруднику и закрыты без входа');
SELECT pg_temp.check(NOT (SELECT prosecdef FROM pg_proc WHERE proname = 'preview_stock_receipt')
                 AND NOT (SELECT prosecdef FROM pg_proc WHERE proname = 'receive_stock_batch'),
  'разбор и приход накладной работают с правами вызывающего');

SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer'));
SELECT pg_temp.expect_message(
  $$SELECT * FROM public.preview_stock_receipt('[{"article": "AU-LAMP-12V20W", "quantity": 1}]'::jsonb)$$,
  'Загружать приход накладной может только склад', 'инженер накладную не разбирает');
SELECT pg_temp.expect_message(
  $$SELECT * FROM public.receive_stock_batch('[{"article": "AU-LAMP-12V20W", "quantity": 1}]'::jsonb)$$,
  'Оприходовать накладную может только склад', 'инженер накладную не приходует');
SELECT pg_temp.as_owner();

SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'warehouse'));
SELECT pg_temp.expect_message($$SELECT * FROM public.preview_stock_receipt('[]'::jsonb)$$,
  'В файле нет ни одной строки с приходом', 'пустой файл отказывается понятно');

-- Что система распознала: артикул, псевдоним поставщика, состояние словом и число строкой.
CREATE TEMP TABLE preview AS SELECT * FROM public.preview_stock_receipt($$[
  {"row": 2, "article": "au-lamp-12v20w", "quantity": 5, "condition": "Н", "unit_price": 1500.50, "comment": "Накладная 108"},
  {"row": 3, "article": " 12V20W-AU ", "quantity": "2,5", "condition": "гарантийная", "comment": "Накладная 108"},
  {"row": 4, "article": "XN-FILTER-WB", "quantity": 10, "condition": ""},
  {"row": 5, "article": "НЕТ-ТАКОГО", "quantity": 1, "condition": "Н"},
  {"row": 6, "article": "ART-OFF", "quantity": 1, "condition": "Н"},
  {"row": 7, "article": "XN-FILTER-WB", "quantity": 1, "condition": "ерунда"},
  {"row": 8, "article": "AU-LAMP-12V20W", "quantity": "много", "condition": "Б"},
  {"row": 9, "article": "", "quantity": 1, "condition": "Н"},
  {"row": 10, "article": "XN-FILTER-WB", "quantity": 4, "condition": "Б", "unit_price": "дорого"}
]$$::jsonb);

SELECT pg_temp.check((SELECT part_id = (SELECT id FROM ids WHERE k = 'part_a') AND matched_by = 'article'
                        AND part_condition = 'N' AND quantity = 5 AND unit_price = 1500.50 AND error IS NULL
                        FROM preview WHERE row_no = 2),
  'строка по артикулу распознана с ценой и состоянием «Н»');
SELECT pg_temp.check((SELECT part_id = (SELECT id FROM ids WHERE k = 'part_a') AND matched_by = 'alias'
                        AND part_condition = 'G' AND quantity = 2.5 AND error IS NULL
                        FROM preview WHERE row_no = 3),
  'строка по псевдониму поставщика распознана, количество «2,5» прочитано');
SELECT pg_temp.check((SELECT part_condition = 'N' AND error IS NULL FROM preview WHERE row_no = 4),
  'пустое состояние считается новой запчастью');
SELECT pg_temp.check((SELECT error = 'Артикул «НЕТ-ТАКОГО» на складе не найден: добавьте запчасть или заведите ей псевдоним'
                        FROM preview WHERE row_no = 5),
  'неизвестный артикул назван в ошибке своей строки');
SELECT pg_temp.check((SELECT error = 'Запчасть «ART-OFF · Снятая с учёта» снята с учёта: приходовать её нельзя'
                        FROM preview WHERE row_no = 6),
  'снятая с учёта позиция не приходуется');
SELECT pg_temp.check((SELECT error = 'Состояние «ерунда» непонятно: напишите Г, Н или Б' FROM preview WHERE row_no = 7),
  'непонятное состояние не угадывается');
SELECT pg_temp.check((SELECT error = 'Количество должно быть числом, например 5 или 2,5' FROM preview WHERE row_no = 8),
  'нечисловое количество названо ошибкой строки');
SELECT pg_temp.check((SELECT error = 'Не указан артикул' FROM preview WHERE row_no = 9),
  'строка без артикула названа ошибкой');
SELECT pg_temp.check((SELECT error = 'Цену укажите числом, например 1500,50 — или оставьте клетку пустой'
                        FROM preview WHERE row_no = 10),
  'нечисловая цена не теряется молча');
SELECT pg_temp.check((SELECT count(*) = 6 FROM preview WHERE error IS NOT NULL),
  'ошибки приходят списком по строкам, а не одной фразой');
SELECT pg_temp.check((SELECT count(*) = 0 FROM stock_movements
                       WHERE part_id = (SELECT id FROM ids WHERE k = 'part_b') AND movement_type = 'receipt'
                         AND comment = 'Накладная 108'),
  'разбор ничего не оприходовал: склад не тронут');

-- Одна запчасть в одном состоянии двумя строками: цена прихода у партии одна, и какую
-- из двух взял бы счёт, по файлу не понять — просим объединить, назвав обе строки.
SELECT pg_temp.check((SELECT count(*) = 2 FROM public.preview_stock_receipt($$[
    {"row": 2, "article": "AU-LAMP-12V20W", "quantity": 1, "condition": "Н"},
    {"row": 5, "article": "au-lamp-12v20w", "quantity": 2, "condition": "новая"}
  ]$$::jsonb) AS twice
   WHERE twice.error = 'Этот артикул в том же состоянии есть в файле ещё раз (строки 2, 5): объедините их в одну'),
  'две строки на одну запчасть в одном состоянии названы обе');

-- Приход с ошибкой: не проводится ни одна строка.
SELECT pg_temp.expect_message(
  $$SELECT * FROM public.receive_stock_batch($x$[
    {"row": 2, "article": "AU-LAMP-12V20W", "quantity": 5, "condition": "Н"},
    {"row": 3, "article": "НЕТ-ТАКОГО", "quantity": 1, "condition": "Н"}
  ]$x$::jsonb)$$,
  'В файле 1 ошибка: на склад не попала ни одна строка. Строка 3: Артикул «НЕТ-ТАКОГО» на складе не найден: добавьте запчасть или заведите ей псевдоним',
  'ошибка в одной строке не пускает на склад весь файл');
SELECT pg_temp.check((SELECT on_hand_quantity = 6 FROM stock_balances
                       WHERE part_id = (SELECT id FROM ids WHERE k = 'part_a') AND part_condition = 'N'),
  'после отказа остаток не изменился');

-- Приход без ошибок: все строки одной транзакцией.
CREATE TEMP TABLE applied AS SELECT * FROM public.receive_stock_batch($$[
  {"row": 2, "article": "au-lamp-12v20w", "quantity": 5, "condition": "Н", "unit_price": 1500.50, "comment": "Накладная 108 от 14.11.2026"},
  {"row": 3, "article": "12V20W-AU", "quantity": 2, "condition": "Г", "comment": "Накладная 108 от 14.11.2026"},
  {"row": 4, "article": "XN-FILTER-WB", "quantity": 10, "comment": "Накладная 108 от 14.11.2026"}
]$$::jsonb);
SELECT pg_temp.check((SELECT count(*) = 3 FROM applied), 'оприходованы все три строки накладной');
-- Состояние, которого у позиции ещё не было: партия заводится приходом сама.
SELECT pg_temp.check((SELECT on_hand_after = 2 FROM public.receive_stock_batch($$[
    {"row": 2, "article": "XN-FILTER-WB", "quantity": 2, "condition": "Б", "comment": "Б/у из обмена"}
  ]$$::jsonb)),
  'приход в новое состояние заводит партию сам');
SELECT pg_temp.check((SELECT on_hand_after = 11 FROM applied WHERE part_condition = 'N' AND part_article = 'AU-LAMP-12V20W'),
  'в ответе видно, сколько стало на складе');
SELECT pg_temp.check((SELECT on_hand_quantity = 11 FROM stock_balances
                       WHERE part_id = (SELECT id FROM ids WHERE k = 'part_a') AND part_condition = 'N')
                 AND (SELECT on_hand_quantity = 6 FROM stock_balances
                       WHERE part_id = (SELECT id FROM ids WHERE k = 'part_a') AND part_condition = 'G')
                 AND (SELECT on_hand_quantity = 16 FROM stock_balances
                       WHERE part_id = (SELECT id FROM ids WHERE k = 'part_b') AND part_condition = 'N'),
  'остатки по состояниям сошлись после прихода файлом');
SELECT pg_temp.check((SELECT count(*) = 3 FROM stock_movements
                       WHERE movement_type = 'receipt' AND comment = 'Накладная 108 от 14.11.2026'
                         AND performed_by = (SELECT id FROM ids WHERE k = 'warehouse')),
  'приход файлом записан движениями с накладной в комментарии и автором');
SELECT pg_temp.check((SELECT count(*) = 2 FROM public.inventory_part_movements((SELECT id FROM ids WHERE k = 'part_a'))
                       WHERE comment = 'Накладная 108 от 14.11.2026'),
  'приход файлом виден в истории позиции');
SELECT pg_temp.as_owner();

-- Цена прихода: склад её записал, но прочитать не может ни из партии, ни из истории.
SELECT pg_temp.check((SELECT receipt_unit_price = 1500.50 FROM stock_lots WHERE id = (SELECT id FROM ids WHERE k = 'lot_an')),
  'цена прихода из файла легла в партию');
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'warehouse'));
SELECT pg_temp.expect_forbidden($$SELECT receipt_unit_price FROM stock_lots$$,
  'кладовщик цену прихода не читает');
SELECT pg_temp.as_owner();
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer'));
SELECT pg_temp.expect_forbidden($$SELECT receipt_unit_price FROM stock_lots$$,
  'инженер цену прихода не читает');
SELECT pg_temp.as_owner();

-- Остаток по состояниям в списке склада.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'warehouse'));
SELECT pg_temp.check((SELECT on_hand_new = 11 AND on_hand_guarantee = 6 AND on_hand_used = 3
                        AND on_hand_quantity = 20
                        FROM inventory_part_registry WHERE id = (SELECT id FROM ids WHERE k = 'part_a')),
  'в списке склада остаток разложен по Г, Н и Б и сходится с общим');
SELECT pg_temp.check((SELECT available_new = 11 AND available_guarantee = 6 AND available_used = 3
                        FROM inventory_part_registry WHERE id = (SELECT id FROM ids WHERE k = 'part_a')),
  'доступное тоже по состояниям');
-- У снятой с учёта позиции после корректировки лежит одна новая: остальные состояния нули,
-- а не пусто — иначе в списке вместо «0» был бы прочерк.
SELECT pg_temp.check((SELECT on_hand_quantity = 1 AND on_hand_new = 1 AND on_hand_guarantee = 0 AND on_hand_used = 0
                        FROM inventory_part_registry WHERE id = (SELECT id FROM ids WHERE k = 'part_off')),
  'у позиции с остатком в одном состоянии остальные нули');
-- Сравниваем значения, а не «не ложь»: иначе проверка прошла бы и на пустом ответе.
SELECT pg_temp.check((SELECT on_hand_quantity = 18 AND on_hand_new = 16 AND available_new = 16
                        AND on_hand_guarantee = 0 AND on_hand_used = 2
                        FROM inventory_part_registry WHERE article_number = 'XN-FILTER-WB'),
  'позиция с остатком не считается пустой');
SELECT pg_temp.as_owner();

ROLLBACK;
