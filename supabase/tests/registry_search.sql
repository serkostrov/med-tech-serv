-- Проверка миграции 0025: склад (фильтры, сортировка, сводка по всему складу) и поиск
-- приборов по любой сущности, под ролями. Запуск на локальной базе с применёнными миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/registry_search.sql
-- Всё выполняется в транзакции и откатывается. Ошибка = проверка не прошла.
-- Свои строки помечены «R25-» в артикуле и S/N: проверки смотрят только на них,
-- поэтому тест проходит и на базе, где уже есть данные.

BEGIN;

CREATE FUNCTION pg_temp.act_as(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
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

-- Условие поиска, как его строит интерфейс (searchTokens + escapeIlikePattern в m2-api.ts):
-- каждое слово («ё» как «е») должно найтись в search_text; знаки % _ \ экранируются,
-- запятые, точки и скобки остаются как есть.
CREATE FUNCTION pg_temp.search_condition(p_search text) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(format('search_text ILIKE %L',
           '%' || replace(replace(replace(token, '\', '\\'), '%', '\%'), '_', '\_') || '%'), ' AND '), 'true')
    FROM regexp_split_to_table(translate(coalesce(p_search, ''), 'Ёё', 'Ее'), '\s+') AS token
   WHERE token <> ''
$$;

-- Состояние и сортировка склада, как их передаёт inventoryPartPage в PostgREST.
CREATE FUNCTION pg_temp.part_state(p_state text) RETURNS text LANGUAGE sql AS $$
  SELECT CASE p_state
    WHEN 'active' THEN 'is_active = true'
    WHEN 'low' THEN 'is_active = true AND below_minimum = true'
    WHEN 'inactive' THEN 'is_active = false'
    ELSE 'true' END
$$;

CREATE FUNCTION pg_temp.part_order(p_sort text) RETURNS text LANGUAGE sql AS $$
  SELECT CASE p_sort
    WHEN 'article_asc' THEN 'article_number ASC, id ASC'
    WHEN 'article_desc' THEN 'article_number DESC, id DESC'
    WHEN 'available_asc' THEN 'available_quantity ASC, article_number ASC, id ASC'
    WHEN 'available_desc' THEN 'available_quantity DESC, article_number ASC, id ASC'
    ELSE 'name ASC, article_number ASC, id ASC' END
$$;

-- Страница склада: артикулы через запятую в порядке выдачи.
CREATE FUNCTION pg_temp.parts_page(p_search text, p_state text, p_sort text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE result text;
BEGIN
  EXECUTE format(
    'SELECT coalesce(string_agg(article_number, '','' ORDER BY position), '''') FROM ('
      || 'SELECT article_number, row_number() OVER (ORDER BY %3$s) AS position FROM public.inventory_part_registry'
      || ' WHERE article_number LIKE ''R25-%%'' AND (%1$s) AND (%2$s) ORDER BY %3$s LIMIT %4$s OFFSET %5$s) AS page',
    pg_temp.search_condition(p_search), pg_temp.part_state(p_state), pg_temp.part_order(p_sort), p_limit, p_offset)
    INTO result;
  RETURN result;
END $$;

-- Найденные запчасти без учёта порядка (по байтам, чтобы не зависеть от правил сравнения базы).
CREATE FUNCTION pg_temp.parts_set(p_search text, p_state text DEFAULT 'all') RETURNS text LANGUAGE plpgsql AS $$
DECLARE result text;
BEGIN
  EXECUTE format(
    'SELECT coalesce(string_agg(article_number, '','' ORDER BY article_number COLLATE "C"), '''') FROM public.inventory_part_registry'
      || ' WHERE article_number LIKE ''R25-%%'' AND (%s) AND (%s)',
    pg_temp.search_condition(p_search), pg_temp.part_state(p_state))
    INTO result;
  RETURN result;
END $$;

CREATE FUNCTION pg_temp.parts_count(p_search text, p_state text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE result bigint;
BEGIN
  EXECUTE format('SELECT count(*) FROM public.inventory_part_registry WHERE article_number LIKE ''R25-%%'' AND (%s) AND (%s)',
    pg_temp.search_condition(p_search), pg_temp.part_state(p_state)) INTO result;
  RETURN result;
END $$;

-- Найденные приборы: S/N через запятую в порядке реестра (по S/N).
CREATE FUNCTION pg_temp.equipment_found(p_search text, p_filter text DEFAULT 'true') RETURNS text LANGUAGE plpgsql AS $$
DECLARE result text;
BEGIN
  EXECUTE format(
    'SELECT coalesce(string_agg(serial_number, '','' ORDER BY serial_number COLLATE "C"), '''') FROM public.equipment_search'
      || ' WHERE serial_number LIKE ''R25-%%'' AND (%s) AND (%s)',
    pg_temp.search_condition(p_search), p_filter)
    INTO result;
  RETURN result;
END $$;

CREATE FUNCTION pg_temp.summary_text() RETURNS text LANGUAGE sql AS $$
  SELECT format('%s/%s/%s', active, below_minimum, with_engineers) FROM public.inventory_part_summary()
$$;

GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.check(boolean, text), pg_temp.check_eq(text, text, text),
  pg_temp.expect_forbidden(text, text), pg_temp.search_condition(text), pg_temp.part_state(text), pg_temp.part_order(text),
  pg_temp.parts_page(text, text, text, integer, integer), pg_temp.parts_set(text, text), pg_temp.parts_count(text, text),
  pg_temp.equipment_found(text, text), pg_temp.summary_text() TO authenticated, anon;

CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid);
CREATE TEMP TABLE baseline (k text PRIMARY KEY, active bigint, below_minimum bigint, with_engineers bigint);
GRANT SELECT ON ids TO authenticated, anon;
GRANT SELECT, INSERT ON baseline TO authenticated;

-- ------------------------------------------------------------- Сотрудники и роли
DO $$
DECLARE
  r text; uid uuid; base text; access_key text;
BEGIN
  -- Инженер без права на склад и заказчик с правом на приборы (для проверки скрытых связей).
  INSERT INTO public.access_roles (key, name, base_role) VALUES ('r25_engineer_nowh', 'Инженер без склада (тест)', 'engineer');
  INSERT INTO public.access_role_permissions (role_key, permission_code)
    SELECT 'r25_engineer_nowh', permission_code FROM public.access_role_permissions
     WHERE role_key = 'engineer' AND permission_code NOT IN ('warehouse.read', 'warehouse.write', 'tasks.read_all');
  INSERT INTO public.access_roles (key, name, base_role) VALUES ('r25_customer_eq', 'Заказчик с приборами (тест)', 'customer');
  INSERT INTO public.access_role_permissions (role_key, permission_code)
    SELECT 'r25_customer_eq', permission_code FROM public.access_role_permissions WHERE role_key = 'customer'
    UNION SELECT 'r25_customer_eq', 'equipment.read';

  FOREACH r IN ARRAY ARRAY['coordinator', 'engineer', 'warehouse', 'customer', 'engineer_nowh', 'customer_eq'] LOOP
    uid := gen_random_uuid();
    base := CASE r WHEN 'engineer_nowh' THEN 'engineer' WHEN 'customer_eq' THEN 'customer' ELSE r END;
    access_key := CASE r WHEN 'engineer_nowh' THEN 'r25_engineer_nowh' WHEN 'customer_eq' THEN 'r25_customer_eq' ELSE r END;
    INSERT INTO auth.users (id, email, aud, role) VALUES (uid, 'r25-' || r || '@test.local', 'authenticated', 'authenticated');
    INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
    VALUES (uid, 'Тест R25 ' || r, base::user_role, 'r25-' || r || '@test.local', true, access_key);
    INSERT INTO ids VALUES (r, uid);
  END LOOP;
END $$;

-- Сводка склада до тестовых запчастей: дальше проверяем, на сколько она выросла.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'coordinator'));
INSERT INTO baseline SELECT 'coordinator', * FROM public.inventory_part_summary();
RESET ROLE;

-- ------------------------------------------------------------- Приборы и склад
DO $$
DECLARE
  org1 uuid; org2 uuid; site1 uuid; site2 uuid; payer1 uuid; payer2 uuid;
  mindray uuid; beckman uuid; bs620 uuid; dxh uuid; e1 uuid; e2 uuid; e3 uuid; wt text; t1 uuid;
  pa uuid; pb uuid; pc uuid; pd uuid; pe uuid; pz uuid; px uuid;
  la uuid; lbn uuid; lbg uuid; ld uuid; lz uuid;
BEGIN
  INSERT INTO organizations (name) VALUES ('R25 Городская больница') RETURNING id INTO org1;
  INSERT INTO organizations (name) VALUES ('R25 Областная клиника') RETURNING id INTO org2;
  INSERT INTO sites (name, organization_id) VALUES ('Корпус Ёлочка', org1) RETURNING id INTO site1;
  INSERT INTO sites (name, organization_id) VALUES ('Лаборатория', org2) RETURNING id INTO site2;
  INSERT INTO payers (name) VALUES ('R25 ООО Альфа-Плательщик') RETURNING id INTO payer1;
  INSERT INTO payers (name) VALUES ('R25 ИП Бета') RETURNING id INTO payer2;

  SELECT id INTO mindray FROM manufacturers WHERE lower(btrim(name)) = 'mindray';
  IF mindray IS NULL THEN INSERT INTO manufacturers (name) VALUES ('Mindray') RETURNING id INTO mindray; END IF;
  SELECT id INTO beckman FROM manufacturers WHERE lower(btrim(name)) = 'beckman coulter';
  IF beckman IS NULL THEN INSERT INTO manufacturers (name) VALUES ('Beckman Coulter') RETURNING id INTO beckman; END IF;
  SELECT id INTO bs620 FROM equipment_models WHERE manufacturer_id = mindray AND lower(btrim(name)) = 'bs-620';
  IF bs620 IS NULL THEN INSERT INTO equipment_models (manufacturer_id, name) VALUES (mindray, 'BS-620') RETURNING id INTO bs620; END IF;
  SELECT id INTO dxh FROM equipment_models WHERE manufacturer_id = beckman AND lower(btrim(name)) = 'dxh-800';
  IF dxh IS NULL THEN INSERT INTO equipment_models (manufacturer_id, name) VALUES (beckman, 'DxH-800') RETURNING id INTO dxh; END IF;

  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id, status_code)
  VALUES ('R25-TC-7A 001284', mindray, bs620, site1, payer1, 'in_use') RETURNING id INTO e1;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id, status_code, notes)
  VALUES ('R25-BE49081', beckman, dxh, site2, payer2, 'in_repair', 'После ремонта платы') RETURNING id INTO e2;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, status_code)
  VALUES ('R25-SN-3', beckman, dxh, 'in_use') RETURNING id INTO e3;
  INSERT INTO customer_organization_access (customer_user_id, organization_id) VALUES ((SELECT id FROM ids WHERE k = 'customer_eq'), org1);

  SELECT code INTO wt FROM work_types WHERE is_active ORDER BY code LIMIT 1;
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by, deadline_from, deadline_to, status_code)
  VALUES ('R25 задача со складом', wt, e1, site1, payer1, (SELECT id FROM ids WHERE k = 'engineer'), (SELECT id FROM ids WHERE k = 'coordinator'),
          current_date, current_date + 7, 'assigned')
  RETURNING id INTO t1;

  -- Запчасти. Ждём (на складе / резерв / доступно / у инженеров / ниже минимума):
  -- A-100 10/3/7/0/нет; B-200 2/1/1/2/да; C-300 неактивна, партий нет 0/0/0/0/нет;
  -- D-400 неактивна 2/0/2/1/да; E-500 партий нет, минимум 1: 0/0/0/0/да;
  -- Z_900 7/0/7/0/нет; ZX900 партий нет 0/0/0/0/нет.
  INSERT INTO parts (article_number, name, minimum_stock) VALUES ('R25-A-100', 'Альфа клапан', 5) RETURNING id INTO pa;
  INSERT INTO parts (article_number, name, minimum_stock) VALUES ('R25-B-200', 'Бета фильтр', 5) RETURNING id INTO pb;
  INSERT INTO parts (article_number, name, minimum_stock) VALUES ('R25-C-300', 'Шланг для ёмкости', 0) RETURNING id INTO pc;
  INSERT INTO parts (article_number, name, minimum_stock) VALUES ('R25-D-400', 'Дельта датчик', 5) RETURNING id INTO pd;
  INSERT INTO parts (article_number, name, minimum_stock) VALUES ('R25-E-500', 'Эпсилон прокладка', 1) RETURNING id INTO pe;
  INSERT INTO parts (article_number, name, minimum_stock) VALUES ('R25-Z_900', 'Фильтр 50% (тест)', 2) RETURNING id INTO pz;
  INSERT INTO parts (article_number, name, minimum_stock) VALUES ('R25-ZX900', 'Прокладка Икс', 0) RETURNING id INTO px;

  INSERT INTO stock_lots (part_id, part_condition) VALUES (pa, 'N') RETURNING id INTO la;
  INSERT INTO stock_lots (part_id, part_condition) VALUES (pb, 'N') RETURNING id INTO lbn;
  INSERT INTO stock_lots (part_id, part_condition) VALUES (pb, 'G') RETURNING id INTO lbg;
  INSERT INTO stock_lots (part_id, part_condition) VALUES (pd, 'N') RETURNING id INTO ld;
  INSERT INTO stock_lots (part_id, part_condition) VALUES (pz, 'B') RETURNING id INTO lz;
  INSERT INTO stock_movements (idempotency_key, movement_type, lot_id, part_id, part_condition, quantity, on_hand_delta) VALUES
    ('r25:a', 'receipt', la, pa, 'N', 10, 10),
    ('r25:bn', 'receipt', lbn, pb, 'N', 3, 3),
    ('r25:bg', 'receipt', lbg, pb, 'G', 1, 1),
    ('r25:d', 'receipt', ld, pd, 'N', 3, 3),
    ('r25:z', 'receipt', lz, pz, 'B', 7, 7);

  INSERT INTO stock_reservations (part_id, part_condition, quantity, task_id) VALUES (pa, 'N', 3, t1);
  INSERT INTO stock_reservations (part_id, part_condition, quantity, task_id) VALUES (pb, 'G', 1, t1);
  UPDATE stock_reservations SET status = 'warehouse_notified' WHERE part_id = pb AND part_condition = 'G';
  INSERT INTO stock_reservations (part_id, part_condition, quantity, task_id, status) VALUES (pb, 'N', 2, t1, 'created');
  INSERT INTO stock_reservations (part_id, part_condition, quantity, task_id, status) VALUES (pd, 'N', 1, t1, 'created');
  UPDATE stock_reservations SET status = 'warehouse_notified' WHERE (part_id = pb AND part_condition = 'N') OR part_id = pd;

  INSERT INTO ids VALUES ('e1', e1), ('e2', e2), ('e3', e3), ('payer1', payer1), ('payer2', payer2), ('t1', t1),
    ('pa', pa), ('pb', pb), ('pc', pc), ('pd', pd), ('pe', pe), ('pz', pz), ('px', px);
END $$;

-- Выдача инженеру настоящей функцией склада (0022): резерв закрывается, остаток списывается.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'warehouse'));
SELECT public.issue_stock_reservation(r.id)
  FROM public.stock_reservations AS r
 WHERE r.status = 'warehouse_notified' AND r.part_condition = 'N' AND r.part_id IN ((SELECT id FROM ids WHERE k = 'pb'), (SELECT id FROM ids WHERE k = 'pd'));
RESET ROLE;
UPDATE parts SET is_active = false WHERE id IN ((SELECT id FROM ids WHERE k = 'pc'), (SELECT id FROM ids WHERE k = 'pd'));
-- Отложенные проверки склада (остаток, движения к выдаче) прямо сейчас, а не в конце транзакции.
SET CONSTRAINTS ALL IMMEDIATE;

-- ------------------------------------------------------------- Объекты миграции
SELECT pg_temp.check((SELECT coalesce('security_invoker=true' = ANY (reloptions), false) FROM pg_class WHERE oid = 'public.inventory_part_registry'::regclass), 'склад: представление с правами вызывающего');
SELECT pg_temp.check((SELECT coalesce('security_invoker=true' = ANY (reloptions), false) FROM pg_class WHERE oid = 'public.equipment_search'::regclass), 'поиск приборов: представление с правами вызывающего');
SELECT pg_temp.check((SELECT coalesce('security_invoker=true' = ANY (reloptions), false) FROM pg_class WHERE oid = 'public.stock_balances'::regclass), 'остатки stock_balances тоже с правами вызывающего');
SELECT pg_temp.check((SELECT NOT prosecdef AND provolatile = 's' AND proconfig::text LIKE '%search_path=public, pg_temp%' FROM pg_proc WHERE oid = 'public.inventory_part_summary()'::regprocedure), 'сводка: SECURITY INVOKER, STABLE, search_path закреплён');
SELECT pg_temp.check(NOT has_function_privilege('anon', 'public.inventory_part_summary()', 'EXECUTE') AND has_function_privilege('authenticated', 'public.inventory_part_summary()', 'EXECUTE'), 'сводку вызывает только вошедший сотрудник');
SELECT pg_temp.check(NOT has_table_privilege('anon', 'public.inventory_part_registry', 'SELECT') AND NOT has_table_privilege('anon', 'public.equipment_search', 'SELECT'), 'аноним не читает новые представления');
SELECT pg_temp.check(has_table_privilege('authenticated', 'public.inventory_part_registry', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.inventory_part_registry', 'INSERT, UPDATE, DELETE')
  AND has_table_privilege('authenticated', 'public.equipment_search', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.equipment_search', 'INSERT, UPDATE, DELETE'), 'сотруднику только чтение представлений');

-- ------------------------------------------------------------- Склад: координатор
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'coordinator'));
SELECT pg_temp.check_eq((SELECT string_agg(format('%s %s/%s/%s/%s/%s', article_number, on_hand_quantity::float8, reserved_quantity::float8, available_quantity::float8,
    with_engineers_quantity::float8, CASE WHEN below_minimum THEN 'да' ELSE 'нет' END), '; ' ORDER BY article_number COLLATE "C")
  FROM public.inventory_part_registry WHERE article_number LIKE 'R25-%'),
  'R25-A-100 10/3/7/0/нет; R25-B-200 2/1/1/2/да; R25-C-300 0/0/0/0/нет; R25-D-400 2/0/2/1/да; R25-E-500 0/0/0/0/да; R25-ZX900 0/0/0/0/нет; R25-Z_900 7/0/7/0/нет',
  'склад: на складе, резерв, доступно, у инженеров и «ниже минимума» по каждой запчасти');
SELECT pg_temp.check(NOT EXISTS (
  SELECT 1 FROM public.inventory_part_registry AS r
    LEFT JOIN (SELECT part_id, sum(on_hand_quantity) AS on_hand, sum(reserved_quantity) AS reserved, sum(available_quantity) AS available
                 FROM public.stock_balances GROUP BY part_id) AS b ON b.part_id = r.id
   WHERE (r.on_hand_quantity, r.reserved_quantity, r.available_quantity) IS DISTINCT FROM (coalesce(b.on_hand, 0), coalesce(b.reserved, 0), coalesce(b.available, 0))
), 'склад: числа совпадают с суммой stock_balances по состояниям (как в карточке запчасти)');
SELECT pg_temp.check_eq((SELECT format('%s/%s/%s', s.active - b.active, s.below_minimum - b.below_minimum, s.with_engineers - b.with_engineers)
  FROM public.inventory_part_summary() AS s, baseline AS b WHERE b.k = 'coordinator'), '5/2/2',
  'сводка по всему складу: активные, ниже минимума из активных, позиции у инженеров');
SELECT pg_temp.check((SELECT count(*) FROM public.inventory_part_summary()) = 1, 'сводка: одна строка');

SELECT pg_temp.check_eq(pg_temp.parts_set('', 'active'), 'R25-A-100,R25-B-200,R25-E-500,R25-ZX900,R25-Z_900', 'фильтр «Активные»');
SELECT pg_temp.check_eq(pg_temp.parts_set('', 'low'), 'R25-B-200,R25-E-500', 'фильтр «Ниже минимума»: только активные с доступным меньше минимума');
SELECT pg_temp.check_eq(pg_temp.parts_set('', 'inactive'), 'R25-C-300,R25-D-400', 'фильтр «Неактивные»');
SELECT pg_temp.check_eq(pg_temp.parts_set('', 'all'), 'R25-A-100,R25-B-200,R25-C-300,R25-D-400,R25-E-500,R25-ZX900,R25-Z_900', 'фильтр «Все»');
SELECT pg_temp.check((SELECT pg_temp.parts_count('', 'low') = 2 AND pg_temp.parts_count('', 'all') = 7 AND pg_temp.parts_count('фильтр', 'all') = 2), 'общее число по фильтру и поиску');

SELECT pg_temp.check_eq(pg_temp.parts_page('', 'all', 'article_asc', 5), 'R25-A-100,R25-B-200,R25-C-300,R25-D-400,R25-E-500', 'сортировка «Артикул А–Я»');
SELECT pg_temp.check_eq(pg_temp.parts_page('', 'all', 'article_desc', 5, 2), 'R25-E-500,R25-D-400,R25-C-300,R25-B-200,R25-A-100', 'сортировка «Артикул Я–А» со второй страницы');
SELECT pg_temp.check_eq(pg_temp.parts_page('', 'all', 'name_asc'), 'R25-A-100,R25-B-200,R25-D-400,R25-ZX900,R25-Z_900,R25-C-300,R25-E-500', 'сортировка «Наименование»');
SELECT pg_temp.check_eq(pg_temp.parts_page('', 'all', 'available_asc'), 'R25-C-300,R25-E-500,R25-ZX900,R25-B-200,R25-D-400,R25-A-100,R25-Z_900', 'сортировка «Сначала малый остаток», при равенстве по артикулу');
SELECT pg_temp.check_eq(pg_temp.parts_page('', 'all', 'available_desc'), 'R25-A-100,R25-Z_900,R25-D-400,R25-B-200,R25-C-300,R25-E-500,R25-ZX900', 'сортировка «Сначала большой остаток»');
SELECT pg_temp.check_eq(pg_temp.parts_page('', 'all', 'available_asc', 3, 3), 'R25-B-200,R25-D-400,R25-A-100', 'страница 2 по 3 строки при сортировке по остатку');
SELECT pg_temp.check_eq(pg_temp.parts_page('', 'low', 'available_desc'), 'R25-B-200,R25-E-500', 'ниже минимума, сначала большой остаток');

SELECT pg_temp.check_eq(pg_temp.parts_set('клапан'), 'R25-A-100', 'поиск запчасти по наименованию');
SELECT pg_temp.check_eq(pg_temp.parts_set('ФИЛЬТР'), 'R25-B-200,R25-Z_900', 'поиск без учёта регистра');
SELECT pg_temp.check_eq(pg_temp.parts_set('фильтр 50%'), 'R25-Z_900', 'поиск по двум словам, процент как обычный знак');
SELECT pg_temp.check_eq(pg_temp.parts_set('Z_9'), 'R25-Z_900', 'подчёркивание в поиске не подменяет любой знак');
SELECT pg_temp.check_eq(pg_temp.parts_set('(тест)'), 'R25-Z_900', 'скобки в поиске');
SELECT pg_temp.check_eq(pg_temp.parts_set('ёмкости'), 'R25-C-300', 'поиск «ё» как «е»');
SELECT pg_temp.check_eq(pg_temp.parts_set('a100'), 'R25-A-100', 'артикул находится без дефисов');
SELECT pg_temp.check_eq(pg_temp.parts_set('бета 200'), 'R25-B-200', 'слова из артикула и наименования вместе');
SELECT pg_temp.check_eq(pg_temp.parts_set('бета 300'), '', 'все слова должны найтись');
SELECT pg_temp.check_eq(pg_temp.parts_set('фильтр', 'low'), 'R25-B-200', 'поиск вместе с фильтром «Ниже минимума»');
RESET ROLE;

-- ------------------------------------------------------------- Склад: другие роли
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'warehouse'));
SELECT pg_temp.check((SELECT count(*) FROM public.inventory_part_registry WHERE article_number LIKE 'R25-%') = 7, 'кладовщик видит склад');
SELECT pg_temp.check_eq(pg_temp.parts_set('', 'low'), 'R25-B-200,R25-E-500', 'кладовщик: «Ниже минимума»');
RESET ROLE;

SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer'));
SELECT pg_temp.check((SELECT count(*) FROM public.inventory_part_registry WHERE article_number LIKE 'R25-%') = 7, 'инженер с правом на склад видит склад');
RESET ROLE;

SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer_nowh'));
SELECT pg_temp.check((SELECT count(*) FROM public.parts) = 0, 'инженер без права на склад не видит запчастей в таблице');
SELECT pg_temp.check((SELECT count(*) FROM public.inventory_part_registry) = 0, 'инженер без права на склад ничего не получает из представления склада');
SELECT pg_temp.check_eq(pg_temp.summary_text(), '0/0/0', 'инженер без права на склад: сводка пустая');
RESET ROLE;

SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'customer'));
SELECT pg_temp.check((SELECT count(*) FROM public.inventory_part_registry) = 0, 'заказчик не видит склад');
SELECT pg_temp.check_eq(pg_temp.summary_text(), '0/0/0', 'заказчик: сводка пустая');
RESET ROLE;

-- ------------------------------------------------------------- Поиск приборов: координатор
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'coordinator'));
SELECT pg_temp.check_eq(pg_temp.equipment_found(''), 'R25-BE49081,R25-SN-3,R25-TC-7A 001284', 'координатор видит все приборы');
SELECT pg_temp.check_eq(pg_temp.equipment_found('TC-7A 001284'), 'R25-TC-7A 001284', 'поиск по S/N');
SELECT pg_temp.check_eq(pg_temp.equipment_found('tc7a001'), 'R25-TC-7A 001284', 'S/N без пробелов и дефисов');
SELECT pg_temp.check_eq(pg_temp.equipment_found('bs620'), 'R25-TC-7A 001284', 'модель без дефиса');
SELECT pg_temp.check_eq(pg_temp.equipment_found('BS-620'), 'R25-TC-7A 001284', 'поиск по модели');
SELECT pg_temp.check_eq(pg_temp.equipment_found('mindray'), 'R25-TC-7A 001284', 'поиск по производителю без учёта регистра');
SELECT pg_temp.check_eq(pg_temp.equipment_found('ёлочка'), 'R25-TC-7A 001284', 'поиск по площадке, «ё» как «е»');
SELECT pg_temp.check_eq(pg_temp.equipment_found('больница'), 'R25-TC-7A 001284', 'поиск по организации');
SELECT pg_temp.check_eq(pg_temp.equipment_found('альфа-плательщик'), 'R25-TC-7A 001284', 'поиск по плательщику');
SELECT pg_temp.check_eq(pg_temp.equipment_found('платы'), 'R25-BE49081', 'поиск по примечанию, как раньше');
SELECT pg_temp.check_eq(pg_temp.equipment_found('dxh'), 'R25-BE49081,R25-SN-3', 'одна модель у двух приборов');
SELECT pg_temp.check_eq(pg_temp.equipment_found('dxh лаборатория'), 'R25-BE49081', 'слова из модели и площадки вместе');
SELECT pg_temp.check_eq(pg_temp.equipment_found('dxh', 'status_code = ''in_use'''), 'R25-SN-3', 'поиск вместе с фильтром статуса');
SELECT pg_temp.check_eq(pg_temp.equipment_found('beckman', format('current_payer_id = %L', (SELECT id FROM ids WHERE k = 'payer2'))), 'R25-BE49081', 'поиск вместе с фильтром плательщика');
SELECT pg_temp.check_eq(pg_temp.equipment_found('100%'), '', 'процент в поиске не ломает запрос');
SELECT pg_temp.check_eq(pg_temp.equipment_found('нет такого'), '', 'не найдено');
RESET ROLE;

-- ------------------------------------------------------------- Поиск приборов: права
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer'));
SELECT pg_temp.check_eq(pg_temp.equipment_found('beckman'), 'R25-BE49081,R25-SN-3', 'инженер ищет приборы');
RESET ROLE;

SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'warehouse'));
SELECT pg_temp.check((SELECT count(*) FROM public.equipment) = 0, 'кладовщик без права на приборы не видит их в таблице');
SELECT pg_temp.check((SELECT count(*) FROM public.equipment_search) = 0, 'кладовщик без права на приборы ничего не находит');
RESET ROLE;

SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'customer'));
SELECT pg_temp.check((SELECT count(*) FROM public.equipment_search) = 0, 'заказчик без права на приборы ничего не находит');
RESET ROLE;

-- Заказчик с правом на приборы видит приборы (политика приборов от организации не зависит),
-- но плательщики и чужая организация с её площадкой ему закрыты: по ним прибор не находится.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'customer_eq'));
SELECT pg_temp.check_eq(pg_temp.equipment_found(''), 'R25-BE49081,R25-SN-3,R25-TC-7A 001284', 'заказчик с правом на приборы видит приборы');
SELECT pg_temp.check((SELECT count(*) FROM public.payers) = 0, 'заказчику плательщики закрыты');
SELECT pg_temp.check_eq(pg_temp.equipment_found('альфа-плательщик'), '', 'скрытый плательщик не находится через поиск');
SELECT pg_temp.check_eq(pg_temp.equipment_found('областная'), '', 'чужая организация не находится через поиск');
SELECT pg_temp.check_eq(pg_temp.equipment_found('лаборатория'), '', 'площадка чужой организации не находится через поиск');
SELECT pg_temp.check_eq(pg_temp.equipment_found('больница'), 'R25-TC-7A 001284', 'своя организация находится');
SELECT pg_temp.check_eq(pg_temp.equipment_found('BE49081'), 'R25-BE49081', 'видимый прибор находится по S/N');
RESET ROLE;

-- ------------------------------------------------------------- Без входа
SET LOCAL ROLE anon;
SELECT pg_temp.expect_forbidden('SELECT count(*) FROM public.inventory_part_registry', 'без входа склад не виден');
SELECT pg_temp.expect_forbidden('SELECT * FROM public.inventory_part_summary()', 'без входа сводка склада не считается');
SELECT pg_temp.expect_forbidden('SELECT count(*) FROM public.equipment_search', 'без входа приборы не ищутся');
RESET ROLE;

ROLLBACK;
