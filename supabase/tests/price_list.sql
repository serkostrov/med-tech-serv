-- Прайс: роли, история цен, страж прямой записи и цена на дату (миграция 0031).
-- Подготовка данных та же, что в role_access.sql. Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/price_list.sql
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

-- Даты теста: всё от сегодняшнего дня по Москве, как считает сама база.
CREATE TEMP TABLE days (k text PRIMARY KEY, d date);
GRANT SELECT ON days TO authenticated;
INSERT INTO days
SELECT shift.k, (now() AT TIME ZONE 'Europe/Moscow')::date + shift.offset_days
  FROM (VALUES ('today', 0), ('p1', -300), ('p2', -100), ('f1', 30), ('f2', 60), ('tomorrow', 1)) AS shift(k, offset_days);

CREATE FUNCTION pg_temp.d(p_key text) RETURNS date LANGUAGE sql STABLE AS $$
  SELECT d FROM days WHERE k = p_key
$$;

CREATE FUNCTION pg_temp.uid(p_key text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM ids WHERE k = p_key
$$;

-- Вся история цен по позиции одной строкой: «начало..конец=цена» через « | ».
CREATE FUNCTION pg_temp.timeline(p_work_type_code text, p_scope text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(string_agg(
           format('%s..%s=%s%s', price_row.valid_from, coalesce(price_row.valid_to::text, '∞'),
                  trim_scale(price_row.amount),
                  CASE WHEN price_row.include_guarantee_work THEN '+г' ELSE '' END),
           ' | ' ORDER BY price_row.valid_from), '')
    FROM public.price_list AS price_row
   WHERE price_row.work_type_code = p_work_type_code
     AND price_row.scope_key = p_scope
$$;

-- Сохранение цены через RPC с запоминанием id строки
CREATE FUNCTION pg_temp.set_price(
  p_key text, p_work_type_code text, p_guarantee_category_id uuid,
  p_amount numeric, p_valid_from date, p_include_guarantee_work boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE new_id uuid;
BEGIN
  SELECT saved.id INTO new_id
    FROM public.set_work_price(p_work_type_code, p_guarantee_category_id, p_amount,
                               p_valid_from, p_include_guarantee_work) AS saved;
  DELETE FROM ids WHERE k = p_key;
  INSERT INTO ids VALUES (p_key, new_id);
  RETURN new_id;
END $$;

GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.act_as_nobody(), pg_temp.check(boolean, text),
  pg_temp.expect_forbidden(text, text), pg_temp.expect_message(text, text, text),
  pg_temp.d(text), pg_temp.uid(text), pg_temp.timeline(text, text),
  pg_temp.set_price(text, text, uuid, numeric, date, boolean) TO authenticated, anon;

-- Данные (от владельца, правила строк не действуют)
DO $$
DECLARE
  roles text[] := ARRAY['coordinator', 'engineer', 'warehouse', 'supervisor', 'admin'];
  r text; uid uuid;
BEGIN
  FOREACH r IN ARRAY roles LOOP
    uid := gen_random_uuid();
    INSERT INTO auth.users (id, email, aud, role) VALUES (uid, r || '@test.local', 'authenticated', 'authenticated');
    INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
    VALUES (uid, 'Тест ' || r, r::user_role, r || '@test.local', true, r);
    INSERT INTO ids VALUES (r, uid);
  END LOOP;

  INSERT INTO ids VALUES ('cat_standard', (SELECT id FROM guarantee_categories WHERE code = 'standard'));
  INSERT INTO ids VALUES ('cat_supplier', (SELECT id FROM guarantee_categories WHERE code = 'supplier_annual'));
END $$;

-- ---------------------------------------------------------------- Права на функции
SELECT pg_temp.check(has_function_privilege('authenticated', 'public.set_work_price(text, uuid, numeric, date, boolean)', 'EXECUTE')
                 AND NOT has_function_privilege('anon', 'public.set_work_price(text, uuid, numeric, date, boolean)', 'EXECUTE'),
  'цену сохраняет только вошедший сотрудник');
SELECT pg_temp.check(has_function_privilege('authenticated', 'public.bulk_update_work_prices(jsonb, date)', 'EXECUTE')
                 AND NOT has_function_privilege('anon', 'public.bulk_update_work_prices(jsonb, date)', 'EXECUTE'),
  'массовое изменение цен доступно только вошедшему сотруднику');
SELECT pg_temp.check(has_function_privilege('authenticated', 'public.delete_future_work_price(uuid)', 'EXECUTE')
                 AND NOT has_function_privilege('anon', 'public.delete_future_work_price(uuid)', 'EXECUTE'),
  'удаление будущей цены доступно только вошедшему сотруднику');
SELECT pg_temp.check(has_function_privilege('authenticated', 'public.work_price_on(text, uuid, date)', 'EXECUTE')
                 AND NOT has_function_privilege('anon', 'public.work_price_on(text, uuid, date)', 'EXECUTE'),
  'цену на дату читает только вошедший сотрудник');
SELECT pg_temp.check(NOT has_function_privilege('authenticated', 'public.guard_price_list_direct_write()', 'EXECUTE')
                 AND NOT has_function_privilege('anon', 'public.guard_price_list_direct_write()', 'EXECUTE'),
  'стража прайса напрямую не вызвать');

SELECT pg_temp.check((SELECT NOT bool_or(prosecdef) FROM pg_proc
                       WHERE proname IN ('set_work_price', 'bulk_update_work_prices',
                                         'delete_future_work_price', 'work_price_on')),
  'все функции прайса работают с правами вызывающего');
SELECT pg_temp.check((SELECT prosecdef FROM pg_proc WHERE proname = 'guard_price_list_direct_write'),
  'страж прайса работает от владельца схемы, как все служебные триггеры');

-- ---------------------------------------------------------------- Права ролей
SELECT pg_temp.act_as(pg_temp.uid('supervisor'));
SELECT pg_temp.check((SELECT public.app_has_permission('price.read') AND public.app_has_permission('price.write')),
  'руководитель получил права на прайс');
SELECT pg_temp.act_as(pg_temp.uid('coordinator'));
SELECT pg_temp.check((SELECT NOT public.app_has_permission('price.write') AND public.app_has_permission('finance.read')),
  'координатор прайс только читает (по finance.read)');
SELECT pg_temp.act_as(pg_temp.uid('engineer'));
SELECT pg_temp.check((SELECT NOT public.app_has_any_permission(ARRAY['price.read', 'price.write', 'finance.read'])),
  'инженеру прайс не положен ни одним правом');
SELECT pg_temp.act_as(pg_temp.uid('warehouse'));
SELECT pg_temp.check((SELECT NOT public.app_has_any_permission(ARRAY['price.read', 'price.write', 'finance.read'])),
  'кладовщику прайс не положен ни одним правом');
SELECT pg_temp.act_as(pg_temp.uid('admin'));
SELECT pg_temp.check((SELECT public.app_has_permission('price.read') AND public.app_has_permission('price.write')),
  'у администратора права на прайс остались прежними');
SELECT pg_temp.act_as_nobody();

-- ---------------------------------------------------------------- История цен
SELECT pg_temp.act_as(pg_temp.uid('supervisor'));
SELECT pg_temp.check(pg_temp.set_price('d_p1', 'diagnostics', NULL, 1000, pg_temp.d('p1')) IS NOT NULL,
  'руководитель заводит первую цену диагностики');
SELECT pg_temp.check(pg_temp.timeline('diagnostics', '*') = format('%s..∞=1000', pg_temp.d('p1')),
  'первая цена действует бессрочно');

SELECT pg_temp.check(pg_temp.set_price('d_p2', 'diagnostics', NULL, 1200, pg_temp.d('p2')) IS NOT NULL,
  'новая цена с более поздней даты');
SELECT pg_temp.check(pg_temp.timeline('diagnostics', '*') = format('%s..%s=1000 | %s..∞=1200', pg_temp.d('p1'), pg_temp.d('p2'), pg_temp.d('p2')),
  'прошлая цена закрыта днём начала новой, история осталась');

-- Исправление цены тем же числом: та же строка, второй период не появляется.
SELECT pg_temp.check(pg_temp.set_price('d_p2_fix', 'diagnostics', NULL, 1300, pg_temp.d('p2'), true) = pg_temp.uid('d_p2'),
  'цена тем же числом исправляется в той же строке');
SELECT pg_temp.check(pg_temp.timeline('diagnostics', '*') = format('%s..%s=1000 | %s..∞=1300+г', pg_temp.d('p1'), pg_temp.d('p2'), pg_temp.d('p2')),
  'после исправления изменились только сумма и пометка про гарантию');

-- Цена вперёд и ещё одна между действующей и будущей.
SELECT pg_temp.check(pg_temp.set_price('d_f2', 'diagnostics', NULL, 2000, pg_temp.d('f2')) IS NOT NULL,
  'цена заводится на будущую дату');
SELECT pg_temp.check(pg_temp.set_price('d_f1', 'diagnostics', NULL, 1800, pg_temp.d('f1')) IS NOT NULL,
  'ещё одна цена между действующей и уже заведённой будущей');
SELECT pg_temp.check(pg_temp.timeline('diagnostics', '*') = format('%s..%s=1000 | %s..%s=1300+г | %s..%s=1800 | %s..∞=2000',
                       pg_temp.d('p1'), pg_temp.d('p2'), pg_temp.d('p2'), pg_temp.d('f1'),
                       pg_temp.d('f1'), pg_temp.d('f2'), pg_temp.d('f2')),
  'периоды не пересеклись: у новой цены сразу выставлен конец по началу будущей');

-- Цена по категории гарантии живёт своей историей, общей не мешает.
SELECT pg_temp.check(pg_temp.set_price('d_cat', 'diagnostics', pg_temp.uid('cat_standard'), 1500, pg_temp.d('p2')) IS NOT NULL,
  'цена по категории гарантии');
SELECT pg_temp.check(pg_temp.timeline('diagnostics', pg_temp.uid('cat_standard')::text) = format('%s..∞=1500', pg_temp.d('p2')),
  'у категории гарантии своя история, общие периоды не тронуты');
SELECT pg_temp.act_as_nobody();

SELECT pg_temp.check((SELECT created_by = pg_temp.uid('supervisor') AND currency = 'RUB'
                      FROM price_list WHERE id = pg_temp.uid('d_p1')),
  'автор цены — вошедший руководитель, валюта рублёвая');

-- ---------------------------------------------------------------- Цена на дату
SELECT pg_temp.act_as(pg_temp.uid('supervisor'));
SELECT pg_temp.check(public.work_price_on('diagnostics', NULL, pg_temp.d('p1') - 1) IS NULL,
  'до первой цены цены нет');
SELECT pg_temp.check(public.work_price_on('diagnostics', NULL, pg_temp.d('p1')) = 1000,
  'в день начала действует уже новая цена');
SELECT pg_temp.check(public.work_price_on('diagnostics', NULL, pg_temp.d('p2') - 1) = 1000,
  'в последний день периода действует прошлая цена');
SELECT pg_temp.check(public.work_price_on('diagnostics', NULL, pg_temp.d('today')) = 1300,
  'сегодня действует текущая цена');
SELECT pg_temp.check(public.work_price_on('diagnostics', NULL, pg_temp.d('f1')) = 1800
                 AND public.work_price_on('diagnostics', NULL, pg_temp.d('f2')) = 2000,
  'на будущие даты действуют заведённые вперёд цены');
SELECT pg_temp.check(public.work_price_on('diagnostics', pg_temp.uid('cat_standard'), pg_temp.d('today')) = 1500,
  'по категории гарантии берётся её собственная цена');
SELECT pg_temp.check(public.work_price_on('diagnostics', pg_temp.uid('cat_supplier'), pg_temp.d('today')) = 1300,
  'по категории без своей цены берётся общая');
SELECT pg_temp.check(public.work_price_on('diagnostics', pg_temp.uid('cat_standard'), pg_temp.d('p1')) = 1000,
  'на дату, когда цены по категории ещё не было, берётся общая');
SELECT pg_temp.check(public.work_price_on('repair', NULL, pg_temp.d('today')) IS NULL,
  'по виду работ без цены возвращается пусто');
SELECT pg_temp.act_as_nobody();

-- ---------------------------------------------------------------- Страж прямой записи
SELECT pg_temp.act_as(pg_temp.uid('supervisor'));
SELECT pg_temp.expect_message(
  format('INSERT INTO public.price_list (work_type_code, valid_from, amount) VALUES (%L, %L, 777)', 'repair', pg_temp.d('today')),
  'Цену заводят только через прайс: добавить строку напрямую нельзя', 'прямой INSERT в прайс запрещён');
SELECT pg_temp.expect_message(
  format('UPDATE public.price_list SET amount = 1 WHERE id = %L', pg_temp.uid('d_p2')),
  'Цену меняют только через прайс: править строку напрямую нельзя', 'прямой UPDATE цены запрещён');
SELECT pg_temp.expect_message(
  format('UPDATE public.price_list SET valid_to = NULL WHERE id = %L', pg_temp.uid('d_p1')),
  'Цену меняют только через прайс: править строку напрямую нельзя', 'период цены напрямую не переписать');
SELECT pg_temp.expect_message(
  format('DELETE FROM public.price_list WHERE id = %L', pg_temp.uid('d_f2')),
  'Цену удаляют только через прайс: удалить строку напрямую нельзя', 'прямой DELETE цены запрещён');
SELECT pg_temp.act_as(pg_temp.uid('admin'));
SELECT pg_temp.expect_message(
  format('DELETE FROM public.price_list WHERE id = %L', pg_temp.uid('d_p1')),
  'Цену удаляют только через прайс: удалить строку напрямую нельзя', 'администратору прямое удаление тоже запрещено');
SELECT pg_temp.act_as_nobody();
SELECT pg_temp.check(pg_temp.timeline('diagnostics', '*') = format('%s..%s=1000 | %s..%s=1300+г | %s..%s=1800 | %s..∞=2000',
                       pg_temp.d('p1'), pg_temp.d('p2'), pg_temp.d('p2'), pg_temp.d('f1'),
                       pg_temp.d('f1'), pg_temp.d('f2'), pg_temp.d('f2')),
  'после попыток прямой записи прайс не изменился');

-- ---------------------------------------------------------------- Удаление только будущей цены
SELECT pg_temp.act_as(pg_temp.uid('supervisor'));
SELECT pg_temp.expect_message(
  format('SELECT public.delete_future_work_price(%L)', pg_temp.uid('d_p1')),
  'Удалить можно только цену, которая ещё не начала действовать: история цен из прайса не удаляется',
  'прошлую цену удалить нельзя');
SELECT pg_temp.expect_message(
  format('SELECT public.delete_future_work_price(%L)', pg_temp.uid('d_p2')),
  'Удалить можно только цену, которая ещё не начала действовать: история цен из прайса не удаляется',
  'действующую цену удалить нельзя');
SELECT pg_temp.expect_message(
  format('SELECT public.delete_future_work_price(%L)', gen_random_uuid()),
  'Цена не найдена', 'несуществующую цену удалить нельзя');

SELECT public.delete_future_work_price(pg_temp.uid('d_f1'));
SELECT pg_temp.check(pg_temp.timeline('diagnostics', '*') = format('%s..%s=1000 | %s..%s=1300+г | %s..∞=2000',
                       pg_temp.d('p1'), pg_temp.d('p2'), pg_temp.d('p2'), pg_temp.d('f2'), pg_temp.d('f2')),
  'отменённая будущая цена убрана, действующая снова работает до следующей');
SELECT public.delete_future_work_price(pg_temp.uid('d_f2'));
SELECT pg_temp.check(pg_temp.timeline('diagnostics', '*') = format('%s..%s=1000 | %s..∞=1300+г', pg_temp.d('p1'), pg_temp.d('p2'), pg_temp.d('p2')),
  'после отмены последней будущей цены действующая снова бессрочная');

-- Цена, начинающаяся сегодня, уже действует: это история, а не план.
SELECT pg_temp.check(pg_temp.set_price('r_today', 'repair', NULL, 500, pg_temp.d('today')) IS NOT NULL,
  'цена ремонта с сегодняшнего дня');
SELECT pg_temp.expect_message(
  format('SELECT public.delete_future_work_price(%L)', pg_temp.uid('r_today')),
  'Удалить можно только цену, которая ещё не начала действовать: история цен из прайса не удаляется',
  'цену, начавшуюся сегодня, удалить нельзя');
SELECT pg_temp.check(pg_temp.set_price('r_tomorrow', 'repair', NULL, 600, pg_temp.d('tomorrow')) IS NOT NULL,
  'цена ремонта с завтрашнего дня');
SELECT public.delete_future_work_price(pg_temp.uid('r_tomorrow'));
SELECT pg_temp.check(pg_temp.timeline('repair', '*') = format('%s..∞=500', pg_temp.d('today')),
  'завтрашняя цена отменена, сегодняшняя снова бессрочная');
SELECT pg_temp.act_as_nobody();

-- ---------------------------------------------------------------- Сутки по Москве
-- Пояс сервера базы выбираем так, чтобы его сегодняшняя дата заведомо не совпала
-- с московской: до 14:00 по Москве это UTC-11, позже — UTC+14. Если бы функция
-- считала «сегодня» по серверу, одна из двух проверок ниже провалилась бы.
DO $$
DECLARE
  tz text := CASE WHEN extract(hour FROM now() AT TIME ZONE 'Europe/Moscow') < 14
                  THEN 'Pacific/Niue' ELSE 'Pacific/Kiritimati' END;
BEGIN
  PERFORM set_config('TimeZone', tz, true);
  PERFORM pg_temp.check(current_date <> (SELECT d FROM days WHERE k = 'today'),
    'пояс сервера базы выбран так, что его дата не совпадает с московской (' || tz || ')');
END $$;

SELECT pg_temp.act_as(pg_temp.uid('supervisor'));
SELECT pg_temp.check(pg_temp.set_price('i_today', 'installation', NULL, 700, pg_temp.d('today')) IS NOT NULL,
  'цена инсталляции с сегодняшнего дня по Москве');
SELECT pg_temp.expect_message(
  format('SELECT public.delete_future_work_price(%L)', pg_temp.uid('i_today')),
  'Удалить можно только цену, которая ещё не начала действовать: история цен из прайса не удаляется',
  'на сервере с другой датой цена с сегодняшнего дня по Москве всё равно не удаляется');
SELECT pg_temp.check(pg_temp.set_price('i_tomorrow', 'installation', NULL, 800, pg_temp.d('tomorrow')) IS NOT NULL,
  'цена инсталляции с завтрашнего дня по Москве');
SELECT public.delete_future_work_price(pg_temp.uid('i_tomorrow'));
SELECT pg_temp.check(pg_temp.timeline('installation', '*') = format('%s..∞=700', pg_temp.d('today')),
  'на сервере с другой датой завтрашняя цена по Москве удаляется');
SELECT pg_temp.act_as_nobody();
SELECT set_config('TimeZone', 'UTC', true);

-- ---------------------------------------------------------------- Массовое изменение
SELECT pg_temp.act_as(pg_temp.uid('supervisor'));
SELECT pg_temp.check(
  public.bulk_update_work_prices(
    jsonb_build_array(
      jsonb_build_object('work_type_code', 'diagnostics', 'guarantee_category_id', NULL, 'amount', 1430, 'include_guarantee_work', true),
      jsonb_build_object('work_type_code', 'repair', 'guarantee_category_id', NULL, 'amount', 550, 'include_guarantee_work', false),
      jsonb_build_object('work_type_code', 'diagnostics', 'guarantee_category_id', pg_temp.uid('cat_standard'), 'amount', 1650)
    ), pg_temp.d('tomorrow')) = 3,
  'массовое изменение применило все три позиции');
SELECT pg_temp.check(pg_temp.timeline('diagnostics', '*') = format('%s..%s=1000 | %s..%s=1300+г | %s..∞=1430+г',
                       pg_temp.d('p1'), pg_temp.d('p2'), pg_temp.d('p2'), pg_temp.d('tomorrow'), pg_temp.d('tomorrow')),
  'массовое изменение закрыло прошлый период так же, как правка по одной цене');
SELECT pg_temp.check(pg_temp.timeline('diagnostics', pg_temp.uid('cat_standard')::text) = format('%s..%s=1500 | %s..∞=1650', pg_temp.d('p2'), pg_temp.d('tomorrow'), pg_temp.d('tomorrow')),
  'в массовом изменении позиция по категории гарантии живёт отдельно от общей');
SELECT pg_temp.check(
  public.bulk_update_work_prices(
    jsonb_build_array(
      jsonb_build_object('work_type_code', 'diagnostics', 'guarantee_category_id', NULL, 'amount', 1430, 'include_guarantee_work', true),
      jsonb_build_object('work_type_code', 'repair', 'guarantee_category_id', NULL, 'amount', 550, 'include_guarantee_work', false)
    ), pg_temp.d('tomorrow')) = 0,
  'повторное применение тех же цен тем же числом не считается изменением');

-- Отказы массового изменения: всё или ничего.
SELECT pg_temp.expect_message(
  format('SELECT public.bulk_update_work_prices(%L, %L)', '[]'::jsonb, pg_temp.d('tomorrow')),
  'Выберите хотя бы одну позицию прайса', 'пустой список позиций не принимается');
SELECT pg_temp.expect_message(
  format('SELECT public.bulk_update_work_prices(%L, %L)', '{"work_type_code": "repair"}'::jsonb, pg_temp.d('tomorrow')),
  'Позиции прайса передаются списком', 'одиночный объект вместо списка не принимается');
SELECT pg_temp.expect_message(
  format('SELECT public.bulk_update_work_prices(%L, %L)', '[{"work_type_code": "repair"}]'::jsonb, pg_temp.d('tomorrow')),
  'В каждой позиции прайса нужен вид работ и цена', 'позиция без цены не принимается');
SELECT pg_temp.expect_message(
  format('SELECT public.bulk_update_work_prices(%L, %L)', '[{"work_type_code": "repair", "amount": "550"}]'::jsonb, pg_temp.d('tomorrow')),
  'В каждой позиции прайса нужен вид работ и цена', 'цена строкой вместо числа не принимается');
SELECT pg_temp.expect_message(
  format('SELECT public.bulk_update_work_prices(%L, %L)', '[{"work_type_code": "repair", "amount": 550, "include_guarantee_work": "да"}]'::jsonb, pg_temp.d('tomorrow')),
  'Пометка про работу по гарантии в позиции прайса должна быть «да» или «нет»', 'пометка про гарантию не строкой');
SELECT pg_temp.expect_message(
  format('SELECT public.bulk_update_work_prices(%L, %L)', '[{"work_type_code": "repair", "amount": 550, "guarantee_category_id": "standard"}]'::jsonb, pg_temp.d('tomorrow')),
  'Категория гарантии в позиции прайса указана неверно', 'категория гарантии не идентификатором');
SELECT pg_temp.expect_message(
  format('SELECT public.bulk_update_work_prices(%L, %L)', '[{"work_type_code": "repair", "amount": 550}, {"work_type_code": "repair", "amount": 560}]'::jsonb, pg_temp.d('tomorrow')),
  'Одна и та же позиция прайса встречается в списке дважды', 'повтор позиции в списке не принимается');
SELECT pg_temp.expect_message(
  format('SELECT public.bulk_update_work_prices(%L, %L)', '[{"work_type_code": "repair", "amount": 999}, {"work_type_code": "ничего-такого", "amount": 100}]'::jsonb, pg_temp.d('f1')),
  'Вид работ не найден в справочнике', 'список с неизвестным видом работ целиком отклонён');
SELECT pg_temp.act_as_nobody();
SELECT pg_temp.check(pg_temp.timeline('repair', '*') = format('%s..%s=500 | %s..∞=550', pg_temp.d('today'), pg_temp.d('tomorrow'), pg_temp.d('tomorrow')),
  'после отклонённого списка цена ремонта осталась от удачного массового изменения');

-- ---------------------------------------------------------------- Проверки одной цены
SELECT pg_temp.act_as(pg_temp.uid('supervisor'));
SELECT pg_temp.expect_message(
  format('SELECT * FROM public.set_work_price(%L, NULL, 100, NULL)', 'repair'),
  'Укажите дату, с которой действует цена', 'цена без даты начала не сохраняется');
SELECT pg_temp.expect_message(
  format('SELECT * FROM public.set_work_price(%L, NULL, NULL, %L)', 'repair', pg_temp.d('f1')),
  'Укажите цену', 'пустая цена не сохраняется');
SELECT pg_temp.expect_message(
  format('SELECT * FROM public.set_work_price(%L, NULL, -1, %L)', 'repair', pg_temp.d('f1')),
  'Цена не может быть отрицательной', 'отрицательная цена не сохраняется');
SELECT pg_temp.expect_message(
  format('SELECT * FROM public.set_work_price(%L, NULL, 1000000000000, %L)', 'repair', pg_temp.d('f1')),
  'Цена слишком большая', 'цена длиннее столбца не сохраняется');
SELECT pg_temp.expect_message(
  format('SELECT * FROM public.set_work_price(%L, NULL, 100, %L)', 'ничего-такого', pg_temp.d('f1')),
  'Вид работ не найден в справочнике', 'цена по неизвестному виду работ не сохраняется');
SELECT pg_temp.expect_message(
  format('SELECT * FROM public.set_work_price(%L, %L, 100, %L)', 'repair', gen_random_uuid(), pg_temp.d('f1')),
  'Категория гарантии не найдена в справочнике', 'цена по неизвестной категории гарантии не сохраняется');
-- Копейки: в прайсе два знака, значение округляется, а не отрезается молча.
SELECT pg_temp.check(pg_temp.set_price('m_kop', 'maintenance', NULL, 1234.567, pg_temp.d('today')) IS NOT NULL,
  'цена с копейками сохраняется');
SELECT pg_temp.check((SELECT saved.amount = 1234.57 FROM public.set_work_price('maintenance', NULL, 1234.567, pg_temp.d('today')) AS saved),
  'цена округлена до копеек');
SELECT pg_temp.act_as_nobody();

-- ---------------------------------------------------------------- Кто что видит и кто что меняет
SELECT pg_temp.act_as(pg_temp.uid('supervisor'));
SELECT pg_temp.check((SELECT count(*) > 0 FROM public.price_list), 'руководитель видит прайс');
SELECT pg_temp.act_as(pg_temp.uid('coordinator'));
SELECT pg_temp.check((SELECT count(*) > 0 FROM public.price_list), 'координатор видит прайс');
SELECT pg_temp.check(public.work_price_on('diagnostics', NULL, pg_temp.d('today')) = 1300,
  'координатор читает цену на дату');
SELECT pg_temp.expect_message(
  format('SELECT * FROM public.set_work_price(%L, NULL, 1, %L)', 'repair', pg_temp.d('f1')),
  'Недостаточно прав: прайс ведёт руководитель', 'координатор цену не меняет');
SELECT pg_temp.expect_forbidden(
  format('SELECT * FROM public.set_work_price(%L, NULL, 1, %L)', 'repair', pg_temp.d('f1')),
  'отказ координатору — именно по правам');
SELECT pg_temp.expect_message(
  format('SELECT public.bulk_update_work_prices(%L, %L)', '[{"work_type_code": "repair", "amount": 1}]'::jsonb, pg_temp.d('f1')),
  'Недостаточно прав: прайс ведёт руководитель', 'координатор цены массово не меняет');
SELECT pg_temp.expect_message(
  format('SELECT public.delete_future_work_price(%L)', pg_temp.uid('d_p2')),
  'Недостаточно прав: прайс ведёт руководитель', 'координатор цены не удаляет');

SELECT pg_temp.act_as(pg_temp.uid('engineer'));
SELECT pg_temp.check((SELECT count(*) = 0 FROM public.price_list), 'инженер не видит ни одной цены');
SELECT pg_temp.check(public.work_price_on('diagnostics', NULL, pg_temp.d('today')) IS NULL,
  'инженеру цена на дату не отдаётся');
SELECT pg_temp.expect_message(
  format('SELECT * FROM public.set_work_price(%L, NULL, 1, %L)', 'repair', pg_temp.d('f1')),
  'Недостаточно прав: прайс ведёт руководитель', 'инженер цену не меняет');

SELECT pg_temp.act_as(pg_temp.uid('warehouse'));
SELECT pg_temp.check((SELECT count(*) = 0 FROM public.price_list), 'кладовщик не видит ни одной цены');
SELECT pg_temp.check(public.work_price_on('diagnostics', NULL, pg_temp.d('today')) IS NULL,
  'кладовщику цена на дату не отдаётся');
SELECT pg_temp.expect_message(
  format('SELECT public.bulk_update_work_prices(%L, %L)', '[{"work_type_code": "repair", "amount": 1}]'::jsonb, pg_temp.d('f1')),
  'Недостаточно прав: прайс ведёт руководитель', 'кладовщик цены массово не меняет');
SELECT pg_temp.act_as_nobody();

-- Изменения прайса попали в журнал аудита: прайс в списке таблиц аудита с 0001.
SELECT pg_temp.check((SELECT count(*) > 0 FROM audit_log
                       WHERE entity_type = 'reference' AND entity_id = pg_temp.uid('d_p2')::text
                         AND actor_user_id = pg_temp.uid('supervisor')),
  'правка цены записана в журнал аудита на руководителя');

ROLLBACK;
