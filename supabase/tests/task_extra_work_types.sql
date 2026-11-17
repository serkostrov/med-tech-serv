-- Несколько видов работ в одной задаче (миграция 0060).
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/task_extra_work_types.sql
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

-- Ожидаем отказ с конкретным текстом: интерфейс показывает его пользователю дословно.
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
  RAISE EXCEPTION 'ПРОВАЛ: % — команда прошла, а должна быть отклонена', p_label;
END $$;

CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON ids TO authenticated;

CREATE FUNCTION pg_temp.uid(p_key text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM ids WHERE k = p_key
$$;

-- Работы в счёте одной строкой: «вид×цена=сумма» через « | », по виду работ.
CREATE FUNCTION pg_temp.works(p_invoice uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(string_agg(format('%s×%s=%s', item.work_type_code, trim_scale(item.unit_price), trim_scale(item.line_total)),
                             ' | ' ORDER BY item.work_type_code), '')
    FROM public.invoice_items AS item
   WHERE item.invoice_id = p_invoice AND item.item_type = 'work'
$$;

GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.act_as_nobody(), pg_temp.check(boolean, text),
  pg_temp.expect_message(text, text, text), pg_temp.uid(text), pg_temp.works(uuid) TO authenticated;

-- ---------------------------------------------------------------- Данные
DO $$
DECLARE
  r text; uid uuid;
  org uuid; site uuid; payer uuid; man uuid; model uuid; eq uuid; task uuid;
BEGIN
  FOREACH r IN ARRAY ARRAY['coordinator', 'engineer'] LOOP
    uid := gen_random_uuid();
    INSERT INTO auth.users (id, email, aud, role) VALUES (uid, 'extra-' || r || '@test.local', 'authenticated', 'authenticated');
    INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
    VALUES (uid, 'Виды работ ' || r, r::user_role, 'extra-' || r || '@test.local', true, r);
    INSERT INTO ids VALUES (r, uid);
  END LOOP;

  INSERT INTO organizations (name) VALUES ('Виды работ: организация') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('Виды работ: площадка', org) RETURNING id INTO site;
  INSERT INTO payers (name, requisites) VALUES ('Виды работ: плательщик', '{"inn": "7701234560", "kpp": "770101001"}'::jsonb)
  RETURNING id INTO payer;
  INSERT INTO manufacturers (name) VALUES ('Виды работ: производитель') RETURNING id INTO man;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (man, 'Виды работ: модель') RETURNING id INTO model;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  VALUES ('EXTRA-1', man, model, site, payer) RETURNING id INTO eq;

  -- Цены на оба вида работ с давних пор: в счёте у каждой строки своя.
  INSERT INTO price_list (work_type_code, guarantee_category_id, valid_from, amount, include_guarantee_work)
  VALUES ('repair', NULL, current_date - 60, 1000, false),
         ('installation', NULL, current_date - 60, 2000, false);

  -- Повторы, пустое значение и основной вид в списке — форма может прислать и так.
  INSERT INTO tasks (title, work_type_code, extra_work_type_codes, equipment_id, site_id, payer_id, created_by,
                     deadline_from, deadline_to, engineer_id)
  VALUES ('Инсталляция и ремонт', 'repair', ARRAY['installation', ' ', 'repair', 'installation'], eq, site, payer,
          (SELECT id FROM ids WHERE k = 'coordinator'), current_date, current_date + 3,
          (SELECT id FROM ids WHERE k = 'engineer'))
  RETURNING id INTO task;

  INSERT INTO ids VALUES ('payer', payer), ('task', task);
END $$;

-- ---------------------------------------------------------------- Список чистится сам
SELECT pg_temp.check((SELECT extra_work_type_codes = ARRAY['installation'] FROM tasks WHERE id = pg_temp.uid('task')),
  'повторы, пустое значение и основной вид из списка убраны');

SELECT pg_temp.expect_message(
  format('UPDATE tasks SET extra_work_type_codes = ARRAY[%L] WHERE id = %L', 'nope', pg_temp.uid('task')),
  'Вида работ «nope» нет в справочнике: выберите из списка',
  'вид работ не из справочника не принимается');

-- Сменили основной вид на тот, что был дополнительным: в списке он не остаётся.
UPDATE tasks SET work_type_code = 'installation', extra_work_type_codes = ARRAY['installation', 'repair']
 WHERE id = pg_temp.uid('task');
SELECT pg_temp.check((SELECT extra_work_type_codes = ARRAY['repair'] FROM tasks WHERE id = pg_temp.uid('task')),
  'основной вид не дублируется в дополнительных');

-- ---------------------------------------------------------------- Кто меняет
SELECT pg_temp.act_as(pg_temp.uid('engineer'));
SELECT pg_temp.expect_message(
  format('UPDATE tasks SET extra_work_type_codes = ARRAY[%L] WHERE id = %L', 'diagnostics', pg_temp.uid('task')),
  'Недостаточно прав: виды работ задачи меняет координатор',
  'инженер дополнительные виды работ не меняет');

SELECT pg_temp.act_as(pg_temp.uid('coordinator'));
UPDATE tasks SET extra_work_type_codes = ARRAY['repair', 'diagnostics'] WHERE id = pg_temp.uid('task');
SELECT pg_temp.check((SELECT extra_work_type_codes = ARRAY['repair', 'diagnostics'] FROM tasks WHERE id = pg_temp.uid('task')),
  'координатор дополнительные виды работ меняет');
UPDATE tasks SET extra_work_type_codes = ARRAY['repair'] WHERE id = pg_temp.uid('task');
SELECT pg_temp.act_as_nobody();

-- ---------------------------------------------------------------- Счёт: строка на каждый вид
-- Задачу закрываем в обход триггеров: акт и фото проверяют свои наборы.
SET session_replication_role = replica;
UPDATE tasks SET status_code = 'closed', call_reason = 'Поломка', work_description = 'Сделано', work_completed = true,
       work_finished_at = now() - interval '1 hour'
 WHERE id = pg_temp.uid('task');
SET session_replication_role = origin;

SELECT pg_temp.act_as(pg_temp.uid('coordinator'));
DO $$
DECLARE inv uuid;
BEGIN
  inv := public.create_invoice(pg_temp.uid('payer'), ARRAY[pg_temp.uid('task')], NULL);
  INSERT INTO ids VALUES ('invoice', inv);
END $$;
SELECT pg_temp.check(pg_temp.works(pg_temp.uid('invoice')) = 'installation×2000=2000 | repair×1000=1000',
  'в счёте строка на каждый вид работ задачи, каждая по своей цене');
SELECT pg_temp.check((SELECT subtotal = 3000 FROM invoices WHERE id = pg_temp.uid('invoice')),
  'сумма счёта — обе работы');

-- ---------------------------------------------------------------- Отчёт: задача в каждом виде
SELECT pg_temp.check((SELECT count(*) = 2 FROM public.report_task_breakdown(current_date - 1, current_date + 1)
   WHERE section = 'work_type' AND item_code IN ('installation', 'repair') AND task_count = 1),
  'в разрезе «Виды работ» задача считается и в инсталляции, и в ремонте');
SELECT pg_temp.act_as_nobody();

ROLLBACK;
