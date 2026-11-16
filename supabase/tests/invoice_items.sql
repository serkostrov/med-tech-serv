-- Позиции счёта, суммы, жизнь счёта, деньги по прибору и выгрузка для 1С (миграция 0040).
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/invoice_items.sql
-- Всё выполняется в транзакции и откатывается. Ошибка = проверка не прошла.
-- Даты считаются от сегодняшнего дня по Москве, поэтому тест не стареет.

BEGIN;

-- Служебные функции теста
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

-- Ожидаем именно отказ по правам (а не другую проверку данных)
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

-- Ожидаем любой отказ и возвращаем его текст
CREATE FUNCTION pg_temp.expect_error(p_sql text, p_label text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok: % (отказ: %)', p_label, SQLERRM;
    RETURN SQLERRM;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — команда прошла, а должна быть отклонена', p_label;
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

CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON ids TO authenticated;
GRANT SELECT ON ids TO anon;

CREATE TEMP TABLE days (k text PRIMARY KEY, d date);
GRANT SELECT ON days TO authenticated;
INSERT INTO days
SELECT shift.k, (now() AT TIME ZONE 'Europe/Moscow')::date + shift.offset_days
  FROM (VALUES ('today', 0), ('cat_from', -10), ('old', -20), ('common_from', -40),
               ('recent', -5), ('tomorrow', 1), ('after', 2)) AS shift(k, offset_days);

CREATE FUNCTION pg_temp.d(p_key text) RETURNS date LANGUAGE sql STABLE AS $$
  SELECT d FROM days WHERE k = p_key
$$;

CREATE FUNCTION pg_temp.uid(p_key text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM ids WHERE k = p_key
$$;

-- Позиции счёта одной строкой: «количество×цена=сумма[/модификатор][/вне суммы]» через « | ».
CREATE FUNCTION pg_temp.items(p_invoice uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(string_agg(
           format('%s×%s=%s%s%s',
             trim_scale(item.quantity), trim_scale(item.unit_price), trim_scale(item.line_total),
             CASE WHEN item.modifier IS NULL THEN '' ELSE '/' || item.modifier::text END,
             CASE WHEN item.excluded_from_total THEN '/вне суммы' ELSE '' END),
           ' | ' ORDER BY item.item_type, item.description), '')
    FROM public.invoice_items AS item
   WHERE item.invoice_id = p_invoice
$$;

-- Итоги счёта одной строкой: «subtotal+корректировка=total».
CREATE FUNCTION pg_temp.sums(p_invoice uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT format('%s%s=%s', trim_scale(invoice.subtotal),
           CASE WHEN invoice.adjustment_amount >= 0 THEN '+' ELSE '' END || trim_scale(invoice.adjustment_amount),
           trim_scale(invoice.total_amount))
    FROM public.invoices AS invoice
   WHERE invoice.id = p_invoice
$$;

-- Счёт по одной задаче: так короче, и каждая проверка смотрит на свой счёт.
CREATE FUNCTION pg_temp.invoice_for(p_key text, p_task_key text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE new_id uuid;
BEGIN
  new_id := public.create_invoice(pg_temp.uid('payer'), ARRAY[pg_temp.uid(p_task_key)], NULL);
  DELETE FROM ids WHERE k = p_key;
  INSERT INTO ids VALUES (p_key, new_id);
  RETURN new_id;
END $$;

GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.act_as_nobody(), pg_temp.check(boolean, text),
  pg_temp.expect_forbidden(text, text), pg_temp.expect_error(text, text),
  pg_temp.expect_message(text, text, text), pg_temp.d(text), pg_temp.uid(text),
  pg_temp.items(uuid), pg_temp.sums(uuid), pg_temp.invoice_for(text, text) TO authenticated, anon;

-- ---------------------------------------------------------------- Данные
-- Готовит владелец схемы: без вошедшего пользователя правила строк и стражи не мешают.
DO $$
DECLARE
  roles text[] := ARRAY['coordinator', 'engineer', 'warehouse', 'supervisor'];
  r text; uid uuid;
  org uuid; site uuid; payer uuid; man uuid; model uuid;
  cat_std uuid; cat_sup uuid;
  eq1 uuid; eq2 uuid; eq3 uuid;
  part_a uuid; part_b uuid;
  task_key text; task_id uuid;
  res_marked uuid;
BEGIN
  FOREACH r IN ARRAY roles LOOP
    uid := gen_random_uuid();
    INSERT INTO auth.users (id, email, aud, role) VALUES (uid, 'items-' || r || '@test.local', 'authenticated', 'authenticated');
    INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
    VALUES (uid, 'Позиции ' || r, r::user_role, 'items-' || r || '@test.local', true, r);
    INSERT INTO ids VALUES (r, uid);
  END LOOP;

  -- Роль только на просмотр финансов: по контракту finance.read смотрит, finance.write меняет.
  -- Карточка счёта читает таблицы обычным select, поэтому такой роли этого должно хватать.
  INSERT INTO access_roles (key, name, base_role) VALUES ('finance_viewer', 'Наблюдатель финансов', 'supervisor');
  INSERT INTO access_role_permissions (role_key, permission_code) VALUES ('finance_viewer', 'finance.read');
  uid := gen_random_uuid();
  INSERT INTO auth.users (id, email, aud, role) VALUES (uid, 'items-viewer@test.local', 'authenticated', 'authenticated');
  INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
  VALUES (uid, 'Наблюдатель финансов', 'supervisor', 'items-viewer@test.local', true, 'finance_viewer');
  INSERT INTO ids VALUES ('viewer', uid);

  INSERT INTO organizations (name) VALUES ('Позиции: организация') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('Позиции: площадка', org) RETURNING id INTO site;
  -- Реквизиты нужны выгрузке для 1С: ИНН и КПП идут в файл из снимка счёта.
  INSERT INTO payers (name, requisites)
  VALUES ('Позиции: плательщик', '{"inn": "7701234567", "kpp": "770101001"}'::jsonb)
  RETURNING id INTO payer;
  INSERT INTO manufacturers (name) VALUES ('Позиции: производитель') RETURNING id INTO man;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (man, 'Позиции: модель') RETURNING id INTO model;

  SELECT id INTO cat_std FROM guarantee_categories WHERE code = 'standard';
  SELECT id INTO cat_sup FROM guarantee_categories WHERE code = 'supplier_annual';

  -- eq1 — своя цена по категории, eq2 — категория без своей цены (берётся общая).
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id, guarantee_category_id)
  VALUES ('ITEMS-1', man, model, site, payer, cat_std) RETURNING id INTO eq1;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id, guarantee_category_id)
  VALUES ('ITEMS-2', man, model, site, payer, cat_sup) RETURNING id INTO eq2;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id, guarantee_category_id)
  VALUES ('ITEMS-3', man, model, site, payer, cat_std) RETURNING id INTO eq3;

  -- Прайс: общая цена ремонта с давних пор, своя по стандартной категории — позже.
  -- «Прочие работы» считаются по часам, и гарантийная работа по ним оплачивается.
  INSERT INTO price_list (work_type_code, guarantee_category_id, valid_from, amount, include_guarantee_work)
  VALUES ('repair', NULL, (SELECT d FROM days WHERE k = 'common_from'), 1000, false),
         ('repair', cat_std, (SELECT d FROM days WHERE k = 'cat_from'), 1500, false),
         ('other', NULL, (SELECT d FROM days WHERE k = 'common_from'), 500, true);

  INSERT INTO parts (article_number, name) VALUES ('ART-A', 'Клапан') RETURNING id INTO part_a;
  INSERT INTO parts (article_number, name) VALUES ('ART-B', 'Шланг') RETURNING id INTO part_b;
  -- Две партии одной запчасти: в счёт идёт цена последнего прихода (350, не 300).
  INSERT INTO stock_lots (part_id, part_condition, lot_code, receipt_unit_price, created_at)
  VALUES (part_a, 'N', 'L1', 300, now() - interval '10 days'),
         (part_a, 'N', 'L2', 350, now() - interval '1 day'),
         (part_b, 'B', 'L1', NULL, now() - interval '1 day');

  INSERT INTO ids VALUES ('org', org), ('site', site), ('payer', payer),
    ('cat_std', cat_std), ('cat_sup', cat_sup), ('eq1', eq1), ('eq2', eq2), ('eq3', eq3),
    ('part_a', part_a), ('part_b', part_b);

  -- Задачи: ключ, прибор, вид работ, отметка Г/Н, часы, день окончания работ.
  FOR task_key, task_id IN
    SELECT source.k, gen_random_uuid() FROM (VALUES
      ('t_cat'), ('t_old'), ('t_guar'), ('t_guar_paid'), ('t_noprice'),
      ('t_parts'), ('t_common'), ('t_spend'), ('t_cancel')) AS source(k)
  LOOP
    INSERT INTO ids VALUES (task_key, task_id);
  END LOOP;

  INSERT INTO tasks (id, title, work_type_code, equipment_id, site_id, payer_id, created_by,
                     deadline_from, deadline_to, work_modifier, hours, work_finished_at)
  SELECT
    source.id, source.title, source.work_type, source.equipment, site, payer,
    (SELECT id FROM ids WHERE k = 'coordinator'), current_date, current_date + 3,
    source.modifier::work_modifier, source.hours, source.finished
  FROM (VALUES
    ((SELECT id FROM ids WHERE k = 't_cat'), 'Цена по категории', 'repair', eq1, 'N', NULL::numeric,
      (SELECT d FROM days WHERE k = 'recent') + time '10:00' AT TIME ZONE 'Europe/Moscow'),
    ((SELECT id FROM ids WHERE k = 't_old'), 'Цена на старую дату', 'repair', eq1, 'N', NULL::numeric,
      (SELECT d FROM days WHERE k = 'old') + time '10:00' AT TIME ZONE 'Europe/Moscow'),
    ((SELECT id FROM ids WHERE k = 't_guar'), 'Гарантийный ремонт', 'repair', eq1, 'G', NULL::numeric,
      (SELECT d FROM days WHERE k = 'recent') + time '10:00' AT TIME ZONE 'Europe/Moscow'),
    ((SELECT id FROM ids WHERE k = 't_guar_paid'), 'Гарантийные прочие работы', 'other', eq1, 'G', 2.5,
      (SELECT d FROM days WHERE k = 'recent') + time '10:00' AT TIME ZONE 'Europe/Moscow'),
    ((SELECT id FROM ids WHERE k = 't_noprice'), 'ТО без цены в прайсе', 'maintenance', eq1, 'N', NULL::numeric,
      (SELECT d FROM days WHERE k = 'recent') + time '10:00' AT TIME ZONE 'Europe/Moscow'),
    ((SELECT id FROM ids WHERE k = 't_parts'), 'Ремонт с запчастями', 'repair', eq1, 'N', NULL::numeric,
      (SELECT d FROM days WHERE k = 'recent') + time '10:00' AT TIME ZONE 'Europe/Moscow'),
    ((SELECT id FROM ids WHERE k = 't_common'), 'Категория без своей цены', 'repair', eq2, 'N', NULL::numeric,
      (SELECT d FROM days WHERE k = 'recent') + time '10:00' AT TIME ZONE 'Europe/Moscow'),
    ((SELECT id FROM ids WHERE k = 't_spend'), 'Деньги по прибору', 'repair', eq3, 'N', NULL::numeric,
      (SELECT d FROM days WHERE k = 'recent') + time '10:00' AT TIME ZONE 'Europe/Moscow'),
    ((SELECT id FROM ids WHERE k = 't_cancel'), 'Счёт потом отменят', 'repair', eq3, 'N', NULL::numeric,
      (SELECT d FROM days WHERE k = 'recent') + time '10:00' AT TIME ZONE 'Europe/Moscow')
  ) AS source(id, title, work_type, equipment, modifier, hours, finished);

  -- Резервы: два отмеченных установленными (идут в счёт) и один неотмеченный (не идёт).
  INSERT INTO stock_reservations (part_id, part_condition, quantity, task_id, requested_by)
  VALUES (part_a, 'N', 2, (SELECT id FROM ids WHERE k = 't_parts'), (SELECT id FROM ids WHERE k = 'warehouse'))
  RETURNING id INTO res_marked;
  INSERT INTO ids VALUES ('res_marked', res_marked);
  INSERT INTO stock_reservations (part_id, part_condition, quantity, task_id, requested_by)
  VALUES (part_b, 'B', 1, (SELECT id FROM ids WHERE k = 't_parts'), (SELECT id FROM ids WHERE k = 'warehouse')),
         (part_a, 'N', 5, (SELECT id FROM ids WHERE k = 't_parts'), (SELECT id FROM ids WHERE k = 'warehouse')),
         (part_a, 'N', 1, (SELECT id FROM ids WHERE k = 't_spend'), (SELECT id FROM ids WHERE k = 'warehouse'));
END $$;

-- Задачи закрываем и резервы доводим до конца в обход триггеров: акт, фото и складскую
-- цепочку проверяют свои наборы, здесь нужен только результат — закрытая задача
-- с отмеченными установленными запчастями.
SET session_replication_role = replica;
UPDATE tasks SET status_code = 'closed', engineer_id = (SELECT id FROM ids WHERE k = 'engineer'),
       call_reason = 'Поломка', work_description = 'Работы выполнены', work_completed = true
 WHERE id IN (SELECT id FROM ids WHERE k LIKE 't\_%');
UPDATE stock_reservations SET status = 'installed', install_marked = true
 WHERE task_id = (SELECT id FROM ids WHERE k = 't_parts') AND quantity IN (2, 1);
UPDATE stock_reservations SET status = 'issued', install_marked = false
 WHERE task_id = (SELECT id FROM ids WHERE k = 't_parts') AND quantity = 5;
UPDATE stock_reservations SET status = 'installed', install_marked = true
 WHERE task_id = (SELECT id FROM ids WHERE k = 't_spend');
SET session_replication_role = origin;

-- ---------------------------------------------------------------- Позиции собираются сами
SELECT pg_temp.act_as(pg_temp.uid('coordinator'));

-- Правило 1: на каждую задачу счёта строка работы. Цена — из прайса по категории гарантии
-- прибора на дату окончания работ. Без правила счёт остался бы пустым.
SELECT pg_temp.check(pg_temp.invoice_for('inv_cat', 't_cat') IS NOT NULL, 'счёт по закрытой задаче создаётся');
SELECT pg_temp.check(pg_temp.items(pg_temp.uid('inv_cat')) = '1×1500=1500/N',
  'строка работы: количество 1, цена по категории гарантии прибора');
SELECT pg_temp.check(pg_temp.sums(pg_temp.uid('inv_cat')) = '1500+0=1500', 'суммы счёта заполнены сразу при создании');
SELECT pg_temp.check((SELECT count(*) FROM invoice_items
   WHERE invoice_id = pg_temp.uid('inv_cat') AND item_type = 'work'
     AND task_id = pg_temp.uid('t_cat') AND work_type_code = 'repair') = 1,
  'строка работы привязана к задаче и виду работ');

-- Правило 2: цена берётся на дату окончания работ, а не на сегодня. У задачи, законченной
-- до появления цены по категории, цена общая. Без правила счёт пересчитался бы «по-новому».
SELECT pg_temp.check(pg_temp.invoice_for('inv_old', 't_old') IS NOT NULL, 'счёт по старой задаче создаётся');
SELECT pg_temp.check(pg_temp.items(pg_temp.uid('inv_old')) = '1×1000=1000/N',
  'на дату, когда цены по категории ещё не было, берётся общая');
SELECT pg_temp.check(pg_temp.invoice_for('inv_common', 't_common') IS NOT NULL, 'счёт по прибору другой категории создаётся');
SELECT pg_temp.check(pg_temp.items(pg_temp.uid('inv_common')) = '1×1000=1000/N',
  'у категории без своей цены берётся общая цена прайса');

-- Правило 3: гарантийная работа «Г» попадает строкой, но не в сумму, пока в прайсе
-- include_guarantee_work = false. Без правила гарантия выставилась бы заказчику.
SELECT pg_temp.check(pg_temp.invoice_for('inv_guar', 't_guar') IS NOT NULL, 'счёт по гарантийной задаче создаётся');
SELECT pg_temp.check(pg_temp.items(pg_temp.uid('inv_guar')) = '1×1500=0/G/вне суммы',
  'гарантийная работа в счёте строкой, но не в сумме');
SELECT pg_temp.check(pg_temp.sums(pg_temp.uid('inv_guar')) = '0+0=0', 'гарантийная работа не попала в итог счёта');
SELECT pg_temp.check((SELECT excluded_from_total FROM invoice_items WHERE invoice_id = pg_temp.uid('inv_guar')),
  'у гарантийной строки стоит отметка «вне суммы»');
-- Так и задумано: у строки вне суммы line_total равен нулю, а количество и цена остаются
-- настоящими. Справочную сумму такой строки интерфейс считает сам, количеством на цену.
SELECT pg_temp.check((SELECT line_total = 0 AND quantity = 1 AND unit_price = 1500
    FROM invoice_items WHERE invoice_id = pg_temp.uid('inv_guar')),
  'у гарантийной строки сумма нулевая, а количество и цена настоящие');

-- То же правило с другой стороны: прайс разрешает брать деньги за гарантийную работу —
-- строка идёт в сумму. Плюс часы вида работ становятся количеством.
SELECT pg_temp.check(pg_temp.invoice_for('inv_guar_paid', 't_guar_paid') IS NOT NULL, 'счёт по оплачиваемой гарантии создаётся');
SELECT pg_temp.check(pg_temp.items(pg_temp.uid('inv_guar_paid')) = '2.5×500=1250/G',
  'гарантийная работа идёт в сумму, если прайс это разрешает, количество — часы задачи');
SELECT pg_temp.check(public.invoice_work_billable('G', 'repair', pg_temp.uid('cat_std'), pg_temp.d('recent')) = false
  AND public.invoice_work_billable('G', 'other', NULL, pg_temp.d('recent')) = true
  AND public.invoice_work_billable('N', 'repair', pg_temp.uid('cat_std'), pg_temp.d('recent')) = true,
  'правило гарантии живёт в одной функции и смотрит на прайс');

-- Правило 4: цены на дату нет — строка всё равно есть, с нулём и пометкой.
-- Без правила работа молча исчезла бы из счёта.
SELECT pg_temp.check(pg_temp.invoice_for('inv_noprice', 't_noprice') IS NOT NULL, 'счёт по работе без цены создаётся');
SELECT pg_temp.check(pg_temp.items(pg_temp.uid('inv_noprice')) = '1×0=0/N', 'работа без цены в прайсе не теряется');
SELECT pg_temp.check((SELECT description FROM invoice_items WHERE invoice_id = pg_temp.uid('inv_noprice'))
  = 'ТО по сервисной документации (цены в прайсе на ' || to_char(pg_temp.d('recent'), 'DD.MM.YYYY') || ' нет)',
  'в описании строки видно, что цены на дату нет');

-- Правило 5: запчасти берутся из резервов, отмеченных инженером как установленные.
-- Количество — из резерва, состояние Г/Н/Б — в описание, цена — последний приход партии.
SELECT pg_temp.check(pg_temp.invoice_for('inv_parts', 't_parts') IS NOT NULL, 'счёт по задаче с запчастями создаётся');
SELECT pg_temp.check((SELECT count(*) FROM invoice_items WHERE invoice_id = pg_temp.uid('inv_parts') AND item_type = 'part') = 2,
  'в счёт попали только отмеченные установленными запчасти, неотмеченный резерв — нет');
SELECT pg_temp.check((SELECT format('%s×%s', trim_scale(quantity), trim_scale(unit_price))
    FROM invoice_items AS item
    JOIN parts AS part ON part.id = item.part_id
   WHERE item.invoice_id = pg_temp.uid('inv_parts') AND part.article_number = 'ART-A') = '2×350',
  'количество запчасти из резерва, цена — последняя цена прихода партии');
SELECT pg_temp.check((SELECT description FROM invoice_items AS item
    JOIN parts AS part ON part.id = item.part_id
   WHERE item.invoice_id = pg_temp.uid('inv_parts') AND part.article_number = 'ART-A') = 'ART-A — Клапан (Н)',
  'в описании запчасти артикул, название и состояние');
SELECT pg_temp.check((SELECT format('%s|%s', trim_scale(unit_price), description) FROM invoice_items AS item
    JOIN parts AS part ON part.id = item.part_id
   WHERE item.invoice_id = pg_temp.uid('inv_parts') AND part.article_number = 'ART-B')
  = '0|ART-B — Шланг (Б), цены прихода нет',
  'запчасть без цены прихода идёт нулём и с пометкой');
SELECT pg_temp.check((SELECT bool_and(modifier IS NULL AND NOT excluded_from_total) FROM invoice_items
   WHERE invoice_id = pg_temp.uid('inv_parts') AND item_type = 'part'),
  'у строк запчастей нет отметки Г/Н работ и они идут в сумму');
SELECT pg_temp.check(pg_temp.sums(pg_temp.uid('inv_parts')) = '2200+0=2200',
  'итог счёта с запчастями: работа 1500 плюс запчасти 700');

-- Цена прихода партии закрыта от ролей API: её видно только через счёт.
SELECT pg_temp.expect_forbidden('SELECT receipt_unit_price FROM public.stock_lots LIMIT 1',
  'цену прихода партии не прочитать даже координатору');

-- ---------------------------------------------------------------- Пересчёт сумм
-- Правило 6: subtotal — сумма строк, total_amount — subtotal плюс корректировка.
-- Считает база, а не интерфейс: проверяем на правке строк изнутри цепочки.
SELECT pg_temp.act_as_nobody();
SELECT set_config('app.invoice_chain', 'on', true);
UPDATE invoice_items SET quantity = 3 WHERE invoice_id = (SELECT id FROM ids WHERE k = 'inv_parts')
   AND part_id = (SELECT id FROM ids WHERE k = 'part_a');
SELECT set_config('app.invoice_chain', 'off', true);
SELECT pg_temp.act_as(pg_temp.uid('coordinator'));
SELECT pg_temp.check(pg_temp.sums(pg_temp.uid('inv_parts')) = '2550+0=2550',
  'суммы счёта пересчитываются при правке строк, а не руками из интерфейса');

-- Правило 7: корректировка только с причиной, и причина у каждой своя.
SELECT pg_temp.expect_message(format('SELECT public.correct_invoice(%L, -300, %L)', pg_temp.uid('inv_parts'), '   '),
  'Укажите причину корректировки: без неё сумму счёта изменить нельзя', 'корректировка без причины отклоняется');
SELECT pg_temp.check(pg_temp.sums(pg_temp.uid('inv_parts')) = '2550+0=2550', 'после отказа сумма счёта не изменилась');
SELECT public.correct_invoice(pg_temp.uid('inv_parts'), -300, 'Скидка за задержку');
SELECT pg_temp.check(pg_temp.sums(pg_temp.uid('inv_parts')) = '2550-300=2250', 'корректировка с причиной уменьшает итог');
SELECT pg_temp.check((SELECT count(*) FROM invoice_adjustments
   WHERE invoice_id = pg_temp.uid('inv_parts') AND reason = 'Скидка за задержку'
     AND author_id = pg_temp.uid('coordinator')) = 1,
  'корректировка записана в журнал с причиной и автором');
SELECT pg_temp.expect_message(format('SELECT public.correct_invoice(%L, -400, %L)', pg_temp.uid('inv_parts'), 'Скидка за задержку'),
  'У этой корректировки должна быть своя причина: прошлая уже записана тем же текстом',
  'вторая корректировка с прежней причиной отклоняется');
SELECT pg_temp.expect_message(format('SELECT public.correct_invoice(%L, -300, %L)', pg_temp.uid('inv_parts'), 'Та же сумма'),
  'Корректировка уже равна -300 : менять нечего', 'корректировка без изменения суммы отклоняется');

-- Правило 8: пересборка черновика подхватывает новую цену прайса.
SELECT pg_temp.act_as_nobody();
UPDATE price_list SET amount = 1700 WHERE work_type_code = 'repair' AND scope_key <> '*';
SELECT pg_temp.act_as(pg_temp.uid('coordinator'));
SELECT pg_temp.check(public.rebuild_invoice_items(pg_temp.uid('inv_cat')) = 1, 'пересборка возвращает число строк');
SELECT pg_temp.check(pg_temp.items(pg_temp.uid('inv_cat')) = '1×1700=1700/N', 'пересборка берёт новую цену прайса');
SELECT pg_temp.check(pg_temp.sums(pg_temp.uid('inv_cat')) = '1700+0=1700', 'после пересборки итог пересчитан');

-- ---------------------------------------------------------------- Страж прямой записи
-- Правило 9: позиции правит только счёт. Проверки идут после удачных вызовов функций
-- в этой же транзакции: значит, флаг цепочки функции за собой убирают.
SELECT pg_temp.expect_message(format(
  'INSERT INTO invoice_items (invoice_id, item_type, work_type_code, task_id, description, quantity, unit_price) VALUES (%L, %L, %L, %L, %L, 1, 100)',
  pg_temp.uid('inv_cat'), 'work', 'repair', pg_temp.uid('t_cat'), 'Дописано мимо прайса'),
  'Позиции счёта собираются сами: дописать строку напрямую нельзя. Поправьте задачу или прайс и пересоберите черновик.',
  'прямой INSERT в позиции счёта запрещён');
SELECT pg_temp.expect_message(format('UPDATE invoice_items SET unit_price = 1 WHERE invoice_id = %L', pg_temp.uid('inv_cat')),
  'Позиции счёта собираются сами: править строку напрямую нельзя. Поправьте задачу или прайс и пересоберите черновик, а сумму измените корректировкой с причиной.',
  'прямой UPDATE цены в позиции счёта запрещён');
SELECT pg_temp.expect_message(format('DELETE FROM invoice_items WHERE invoice_id = %L', pg_temp.uid('inv_cat')),
  'Позиции счёта собираются сами: удалить строку напрямую нельзя. Уберите задачу из счёта и пересоберите черновик.',
  'прямой DELETE позиции счёта запрещён');
SELECT pg_temp.check(pg_temp.items(pg_temp.uid('inv_cat')) = '1×1700=1700/N', 'после отказов строки счёта на месте');

-- ---------------------------------------------------------------- Жизнь счёта
-- Правило 10: разрешены только переходы черновик → выставлен → передан в 1С и отмена.
SELECT pg_temp.expect_message(format('UPDATE invoices SET status = %L WHERE id = %L', 'transferred_to_1c', pg_temp.uid('inv_cat')),
  'Счёт в состоянии «черновик» нельзя перевести в «передан в 1С». Отсюда возможно только: «выставлен», «отменён».',
  'из черновика сразу в 1С нельзя, отказ по-русски');
SELECT pg_temp.expect_message(format('SELECT public.transfer_invoice_to_1c(%L)', pg_temp.uid('inv_cat')),
  'Передать в 1С можно только выставленный счёт: сейчас он черновик.', 'черновик в 1С не передать');

SELECT public.issue_invoice(pg_temp.uid('inv_cat'));
SELECT pg_temp.check((SELECT status = 'issued' AND issued_at IS NOT NULL AND transferred_at IS NULL
    FROM invoices WHERE id = pg_temp.uid('inv_cat')),
  'счёт выставлен, дата выставления заполнена');
SELECT pg_temp.expect_message(format('SELECT public.issue_invoice(%L)', pg_temp.uid('inv_cat')),
  'Выставить можно только черновик: счёт уже выставлен.', 'выставленный счёт второй раз не выставить');
SELECT pg_temp.expect_message(format('SELECT public.rebuild_invoice_items(%L)', pg_temp.uid('inv_cat')),
  'Пересобрать позиции можно только в черновике: счёт уже выставлен. Исправление — отмена счёта и новый либо корректировка суммы с причиной.',
  'выставленный счёт по прайсу не пересобрать');
SELECT pg_temp.expect_message(format('UPDATE invoices SET status = %L WHERE id = %L', 'draft', pg_temp.uid('inv_cat')),
  'Счёт в состоянии «выставлен» нельзя перевести в «черновик». Отсюда возможно только: «передан в 1С», «отменён».',
  'выставленный счёт не вернуть в черновик');

-- Корректировка выставленного счёта ещё возможна: пока он не ушёл в 1С.
SELECT public.correct_invoice(pg_temp.uid('inv_cat'), -200, 'Согласована скидка');
SELECT pg_temp.check(pg_temp.sums(pg_temp.uid('inv_cat')) = '1700-200=1500', 'выставленный счёт корректируется с причиной');

SELECT public.transfer_invoice_to_1c(pg_temp.uid('inv_cat'));
SELECT pg_temp.check((SELECT status = 'transferred_to_1c' AND transferred_at IS NOT NULL
    FROM invoices WHERE id = pg_temp.uid('inv_cat')),
  'счёт передан в 1С, дата передачи заполнена');
SELECT pg_temp.expect_message(format('SELECT public.correct_invoice(%L, -500, %L)', pg_temp.uid('inv_cat'), 'Поздняя скидка'),
  'Счёт передан в 1С : сумму менять поздно. Договаривайтесь с бухгалтерией и выставляйте новый счёт.',
  'переданный в 1С счёт не корректируется');
-- И то же самое прямым запросом мимо функции: правило держит страж, а не функция.
SELECT pg_temp.expect_message(format('UPDATE invoices SET adjustment_amount = -999, correction_reason = %L WHERE id = %L',
  'мимо функции', pg_temp.uid('inv_cat')),
  'Счёт передан в 1С : сумму менять поздно. Договаривайтесь с бухгалтерией и выставляйте новый счёт.',
  'сумму переданного в 1С счёта не переписать прямым запросом');
SELECT pg_temp.expect_message(format('UPDATE invoices SET correction_reason = %L WHERE id = %L',
  'другая причина', pg_temp.uid('inv_cat')),
  'Счёт передан в 1С : сумму менять поздно. Договаривайтесь с бухгалтерией и выставляйте новый счёт.',
  'причину корректировки у переданного счёта не переписать');
SELECT pg_temp.check(pg_temp.sums(pg_temp.uid('inv_cat')) = '1700-200=1500', 'сумма переданного в 1С счёта осталась прежней');
SELECT pg_temp.expect_message(format('UPDATE invoices SET status = %L WHERE id = %L', 'cancelled', pg_temp.uid('inv_cat')),
  'Счёт в состоянии «передан в 1С» нельзя перевести в «отменён». Отсюда счёт уже не меняется: если нужно исправить, выставьте новый.',
  'переданный в 1С счёт не отменить');

-- История статусов пишется сама и помнит, кто менял.
SELECT pg_temp.check((SELECT string_agg(to_status::text, '>' ORDER BY changed_at, to_status)
    FROM invoice_status_history WHERE invoice_id = pg_temp.uid('inv_cat')) = 'draft>issued>transferred_to_1c',
  'история статусов счёта записана по порядку');
SELECT pg_temp.check((SELECT bool_and(changed_by = pg_temp.uid('coordinator'))
    FROM invoice_status_history WHERE invoice_id = pg_temp.uid('inv_cat')),
  'в истории статусов записан тот, кто менял');

-- ---------------------------------------------------------------- Карточка счёта обычным select
-- Правило 11: карточку интерфейс читает тремя обычными select, без RPC. Значит, права
-- на чтение должны держаться на finance.read, а автор смены статуса — доставаться
-- по ссылке changed_by на сотрудника. Без этого карточка показала бы пустую историю.
SELECT pg_temp.check((SELECT count(*) FROM invoices WHERE id = pg_temp.uid('inv_cat')) = 1,
  'шапка счёта читается обычным select');
SELECT pg_temp.check((SELECT count(*) FROM invoice_items WHERE invoice_id = pg_temp.uid('inv_cat')) = 1,
  'позиции счёта читаются обычным select');
SELECT pg_temp.check((SELECT string_agg(author.full_name, ',' ORDER BY history.changed_at, history.to_status)
    FROM invoice_status_history AS history
    LEFT JOIN users AS author ON author.id = history.changed_by
   WHERE history.invoice_id = pg_temp.uid('inv_cat'))
  = 'Позиции coordinator,Позиции coordinator,Позиции coordinator',
  'в истории статусов виден автор по ссылке на сотрудника');
RESET ROLE;

-- Роль с одним finance.read: смотрит карточку целиком, но ничего не меняет.
SELECT pg_temp.act_as(pg_temp.uid('viewer'));
SELECT pg_temp.check((SELECT count(*) FROM invoices WHERE id = pg_temp.uid('inv_cat')) = 1,
  'право finance.read открывает шапку счёта');
SELECT pg_temp.check((SELECT count(*) FROM invoice_items WHERE invoice_id = pg_temp.uid('inv_cat')) = 1,
  'право finance.read открывает позиции счёта');
SELECT pg_temp.check((SELECT count(*) FROM invoice_status_history WHERE invoice_id = pg_temp.uid('inv_cat')) = 3,
  'право finance.read открывает историю статусов');
SELECT pg_temp.check((SELECT author.full_name FROM invoice_status_history AS history
    JOIN users AS author ON author.id = history.changed_by
   WHERE history.invoice_id = pg_temp.uid('inv_cat') AND history.to_status = 'issued') = 'Позиции coordinator',
  'наблюдателю финансов тоже виден автор смены статуса');
SELECT pg_temp.check((SELECT count(*) FROM public.invoice_export_rows(pg_temp.uid('inv_cat'))) = 1,
  'право finance.read открывает выгрузку счёта');
-- Карточка показывает номер задачи строки: интерфейс берёт его по ссылке task_id.
SELECT pg_temp.check((SELECT task.number FROM invoice_items AS item
    JOIN tasks AS task ON task.id = item.task_id
   WHERE item.invoice_id = pg_temp.uid('inv_cat'))
  = (SELECT number FROM tasks WHERE id = pg_temp.uid('t_cat')),
  'номер задачи строки счёта виден по ссылке на задачу');
SELECT pg_temp.expect_message(format('SELECT public.correct_invoice(%L, -1, %L)', pg_temp.uid('inv_guar'), 'без права'),
  'Корректировать счёт может только тот, кто ведёт счета', 'одного finance.read для корректировки не хватает');
SELECT pg_temp.expect_message(format('SELECT public.issue_invoice(%L)', pg_temp.uid('inv_guar')),
  'Выставить счёт может только тот, кто ведёт счета', 'одного finance.read для выставления не хватает');
RESET ROLE;
SELECT pg_temp.act_as(pg_temp.uid('coordinator'));

-- Отмена черновика (была и раньше) и запрет возврата из отмены.
UPDATE invoices SET status = 'cancelled' WHERE id = pg_temp.uid('inv_noprice');
SELECT pg_temp.check((SELECT status = 'cancelled' FROM invoices WHERE id = pg_temp.uid('inv_noprice')), 'черновик отменяется');
SELECT pg_temp.expect_message(format('SELECT public.issue_invoice(%L)', pg_temp.uid('inv_noprice')),
  'Выставить можно только черновик: счёт уже отменён.', 'отменённый счёт не выставить');
SELECT pg_temp.expect_message(format('SELECT public.rebuild_invoice_items(%L)', pg_temp.uid('inv_noprice')),
  'Пересобрать позиции можно только в черновике: счёт уже отменён. Исправление — отмена счёта и новый либо корректировка суммы с причиной.',
  'отменённый счёт не пересобрать');
SELECT pg_temp.expect_message(format('SELECT public.issue_invoice(%L)', gen_random_uuid()),
  'Счёт не найден', 'несуществующий счёт не выставить');

-- ---------------------------------------------------------------- Деньги по прибору
-- Правило 12: по прибору считаются только неотменённые счета, работы и запчасти отдельно.
SELECT pg_temp.check(pg_temp.invoice_for('inv_spend', 't_spend') IS NOT NULL, 'счёт по прибору для подсчёта денег создаётся');
SELECT public.issue_invoice(pg_temp.uid('inv_spend'));
SELECT pg_temp.check(pg_temp.invoice_for('inv_cancelled', 't_cancel') IS NOT NULL, 'второй счёт по тому же прибору создаётся');
UPDATE invoices SET status = 'cancelled' WHERE id = pg_temp.uid('inv_cancelled');
SELECT pg_temp.check(
  (SELECT format('%s/%s/%s/%s', trim_scale(work_amount), trim_scale(parts_amount), trim_scale(total_amount), invoice_count)
     FROM public.equipment_spend(pg_temp.uid('eq3'), pg_temp.d('today'), pg_temp.d('today'))) = '1700/350/2050/1',
  'деньги по прибору: работы и запчасти отдельно, отменённый счёт не считается');
SELECT pg_temp.check(
  (SELECT format('%s/%s/%s', trim_scale(work_amount), trim_scale(parts_amount), invoice_count)
     FROM public.equipment_spend(pg_temp.uid('eq3'), pg_temp.d('tomorrow'), pg_temp.d('after'))) = '0/0/0',
  'за период без счетов по прибору выходят нули');
SELECT pg_temp.check(
  (SELECT trim_scale(total_amount) FROM public.equipment_spend(pg_temp.uid('eq2'), pg_temp.d('today'), pg_temp.d('today'))) = 1000,
  'по другому прибору считаются только его счета');

-- ---------------------------------------------------------------- Выгрузка для 1С
-- Правило 13: строки счёта отдаются плоско, с плательщиком, ИНН, КПП и отметкой гарантии.
SELECT pg_temp.check((SELECT count(*) FROM public.invoice_export_rows(pg_temp.uid('inv_spend'))) = 2,
  'в выгрузке столько строк, сколько в счёте');
SELECT pg_temp.check((SELECT format('%s/%s/%s/%s', invoice_number, payer_inn, payer_kpp, invoice_date)
    FROM public.invoice_export_rows(pg_temp.uid('inv_spend')) LIMIT 1)
  = (SELECT number FROM invoices WHERE id = pg_temp.uid('inv_spend')) || '/7701234567/770101001/' || pg_temp.d('today')::text,
  'в выгрузке номер счёта, дата и плательщик с ИНН и КПП');
SELECT pg_temp.check((SELECT string_agg(format('%s:%s:%s', item_type, item_code, trim_scale(line_total)), ' | ' ORDER BY item_type)
    FROM public.invoice_export_rows(pg_temp.uid('inv_spend')))
  = 'Запчасть:ART-A:350 | Работа:Ремонт:1700',
  'в выгрузке вид работы или артикул, количество и сумма');
SELECT pg_temp.check((SELECT bool_and(task_number = (SELECT number FROM tasks WHERE id = pg_temp.uid('t_spend')))
    FROM public.invoice_export_rows(pg_temp.uid('inv_spend'))),
  'в каждой строке выгрузки номер задачи');
SELECT pg_temp.check((SELECT guarantee FROM public.invoice_export_rows(pg_temp.uid('inv_guar')))
  = 'Гарантия, в сумму не входит',
  'в выгрузке видно, что гарантийная строка в сумму не входит');

-- ---------------------------------------------------------------- Права ролей
-- Правило 14: инженер и кладовщик не видят ни счетов, ни строк, ни сумм и не ведут счёт.
SELECT pg_temp.act_as(pg_temp.uid('engineer'));
SELECT pg_temp.check((SELECT count(*) FROM invoices) = 0, 'инженер не видит счетов');
SELECT pg_temp.check((SELECT count(*) FROM invoice_items) = 0, 'инженер не видит строк счёта и сумм');
SELECT pg_temp.check((SELECT count(*) FROM invoice_status_history) = 0, 'инженер не видит историю статусов счёта');
SELECT pg_temp.check((SELECT count(*) FROM public.equipment_spend(pg_temp.uid('eq3'), NULL, NULL)
   WHERE total_amount > 0) = 0, 'инженер не узнаёт деньги по прибору');
SELECT pg_temp.check((SELECT count(*) FROM public.invoice_export_rows(pg_temp.uid('inv_spend'))) = 0,
  'инженеру выгрузка счёта не отдаёт строк');
SELECT pg_temp.expect_forbidden('SELECT receipt_unit_price FROM public.stock_lots LIMIT 1',
  'инженер не читает цену прихода запчасти');
SELECT pg_temp.expect_message(format('SELECT public.issue_invoice(%L)', pg_temp.uid('inv_parts')),
  'Выставить счёт может только тот, кто ведёт счета', 'инженер не выставляет счёт');
SELECT pg_temp.expect_message(format('SELECT public.transfer_invoice_to_1c(%L)', pg_temp.uid('inv_parts')),
  'Передать счёт в 1С может только тот, кто ведёт счета', 'инженер не передаёт счёт в 1С');
SELECT pg_temp.expect_message(format('SELECT public.correct_invoice(%L, -1, %L)', pg_temp.uid('inv_parts'), 'взлом'),
  'Корректировать счёт может только тот, кто ведёт счета', 'инженер не корректирует счёт');
SELECT pg_temp.expect_message(format('SELECT public.rebuild_invoice_items(%L)', pg_temp.uid('inv_parts')),
  'Собирать позиции счёта может только тот, кто ведёт счета', 'инженер не пересобирает позиции счёта');
RESET ROLE;

SELECT pg_temp.act_as(pg_temp.uid('warehouse'));
SELECT pg_temp.check((SELECT count(*) FROM invoices) = 0, 'кладовщик не видит счетов');
SELECT pg_temp.check((SELECT count(*) FROM invoice_items) = 0, 'кладовщик не видит строк счёта и сумм');
SELECT pg_temp.expect_message(format('SELECT public.rebuild_invoice_items(%L)', pg_temp.uid('inv_parts')),
  'Собирать позиции счёта может только тот, кто ведёт счета', 'кладовщик не собирает позиции счёта');
RESET ROLE;

-- Руководитель ведёт счета наравне с координатором.
SELECT pg_temp.act_as(pg_temp.uid('supervisor'));
SELECT pg_temp.check((SELECT count(*) FROM invoice_items WHERE invoice_id = pg_temp.uid('inv_parts')) = 3,
  'руководитель видит строки счёта');
SELECT public.issue_invoice(pg_temp.uid('inv_parts'));
SELECT pg_temp.check((SELECT status = 'issued' FROM invoices WHERE id = pg_temp.uid('inv_parts')),
  'руководитель выставляет счёт');
RESET ROLE;

-- Без входа функции счёта недоступны вовсе.
SET LOCAL ROLE anon;
SELECT pg_temp.expect_forbidden(format('SELECT public.issue_invoice(%L)', pg_temp.uid('inv_guar')), 'без входа счёт не выставить');
SELECT pg_temp.expect_forbidden(format('SELECT public.rebuild_invoice_items(%L)', pg_temp.uid('inv_guar')), 'без входа позиции не собрать');
SELECT pg_temp.expect_forbidden(format('SELECT * FROM public.invoice_export_rows(%L)', pg_temp.uid('inv_guar')), 'без входа выгрузки нет');
SELECT pg_temp.expect_forbidden(format('SELECT * FROM public.equipment_spend(%L, NULL, NULL)', pg_temp.uid('eq3')), 'без входа денег по прибору нет');
RESET ROLE;

ROLLBACK;
