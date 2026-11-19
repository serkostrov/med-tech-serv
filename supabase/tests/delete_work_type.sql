-- Удаление вида работ (миграция 0075): только неиспользованный, не встроенный,
-- руководителем или администратором; цены уходят вместе с ним.
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/delete_work_type.sql
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

-- Ожидаем отказ со словами из p_words: по-русски и про то, что мешает.
CREATE FUNCTION pg_temp.expect_refusal(p_sql text, p_words text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  message text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    message := SQLERRM;
    IF message !~ p_words THEN
      RAISE EXCEPTION 'ПРОВАЛ: % — отказ не тот: %', p_label, message;
    END IF;
    RAISE NOTICE 'ok: % (отказ: %)', p_label, message;
    RETURN;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — команда прошла, а должна быть запрещена', p_label;
END $$;

CREATE TEMP TABLE v (k text PRIMARY KEY, id uuid);
GRANT SELECT ON v TO authenticated;
CREATE FUNCTION pg_temp.uid(p_key text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM v WHERE k = p_key
$$;
GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.act_as_nobody(), pg_temp.check(boolean, text),
  pg_temp.expect_refusal(text, text, text), pg_temp.uid(text) TO authenticated;

-- Данные без входа: сотрудники трёх ролей, неиспользованный вид работ с ценой и вид работ в задаче.
DO $$
DECLARE
  coord uuid := gen_random_uuid(); sup uuid := gen_random_uuid(); adm uuid := gen_random_uuid();
  org uuid; site uuid; payer uuid; manuf uuid; model uuid; eq uuid;
BEGIN
  INSERT INTO auth.users (id, email, aud, role) VALUES
    (coord, 'wt-coord@test.local', 'authenticated', 'authenticated'),
    (sup, 'wt-sup@test.local', 'authenticated', 'authenticated'),
    (adm, 'wt-adm@test.local', 'authenticated', 'authenticated');
  INSERT INTO users (id, full_name, role, email, is_active, access_role_key) VALUES
    (coord, 'Координатор Справочников', 'coordinator', 'wt-coord@test.local', true, 'coordinator'),
    (sup, 'Руководитель Справочников', 'supervisor', 'wt-sup@test.local', true, 'supervisor'),
    (adm, 'Администратор Справочников', 'admin', 'wt-adm@test.local', true, 'admin');
  INSERT INTO v VALUES ('coord', coord), ('sup', sup), ('adm', adm);

  INSERT INTO work_types (code, name, sort_order) VALUES
    ('trial_unused', 'Пробный вид работ', 900),
    ('trial_used', 'Вид работ в задаче', 901),
    ('trial_extra', 'Дополнительный вид работ', 902);
  -- Цена неиспользованного вида: без входа страж прайса (0031) запись пропускает.
  INSERT INTO price_list (work_type_code, amount, valid_from) VALUES ('trial_unused', 1500, current_date);

  INSERT INTO organizations (name) VALUES ('Виды работ: организация') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('Виды работ: площадка', org) RETURNING id INTO site;
  INSERT INTO payers (name) VALUES ('Виды работ: плательщик') RETURNING id INTO payer;
  INSERT INTO manufacturers (name) VALUES ('Виды работ: производитель') RETURNING id INTO manuf;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (manuf, 'Виды работ: модель') RETURNING id INTO model;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  VALUES ('WT-1', manuf, model, site, payer) RETURNING id INTO eq;
  INSERT INTO tasks (title, work_type_code, extra_work_type_codes, equipment_id, site_id, payer_id, created_by, deadline_from, deadline_to)
  VALUES ('Виды работ: задача', 'trial_used', ARRAY['trial_extra'], eq, site, payer, sup, current_date, current_date + 3);
END $$;

-- -------------------------------------------------------------- Кому нельзя
SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT pg_temp.expect_refusal('SELECT public.delete_work_type(''trial_unused'')', 'руководитель и администратор',
  'координатор вид работ не удаляет, хотя справочники ведёт');
SELECT pg_temp.check((SELECT count(*) FROM work_types WHERE code = 'trial_unused') = 1,
  'после отказа координатору вид работ на месте');
-- В обход функции строку не удалить никому.
DELETE FROM public.work_types WHERE code = 'trial_unused';
SELECT pg_temp.act_as(pg_temp.uid('sup'));
DELETE FROM public.work_types WHERE code = 'trial_unused';
SELECT pg_temp.check((SELECT count(*) FROM work_types WHERE code = 'trial_unused') = 1,
  'прямой DELETE не удаляет вид работ ни координатору, ни руководителю');

-- -------------------------------------------------------------- Что нельзя удалить
SELECT pg_temp.expect_refusal('SELECT public.delete_work_type(''trial_used'')', 'в задачах: 1.*только скрыть',
  'вид работ из задачи не удаляется, отказ говорит, где он и что делать');
SELECT pg_temp.expect_refusal('SELECT public.delete_work_type(''trial_extra'')', 'в задачах: 1',
  'дополнительный вид работ задачи тоже держит удаление');
SELECT pg_temp.expect_refusal('SELECT public.delete_work_type(''maintenance'')', 'встроен',
  'встроенный вид работ не удаляется');
SELECT pg_temp.expect_refusal('SELECT public.delete_work_type(''no_such_code'')', 'не найден',
  'несуществующий вид работ — понятный отказ');

-- -------------------------------------------------------------- Что можно
SELECT public.delete_work_type('trial_unused');
SELECT pg_temp.check((SELECT count(*) FROM work_types WHERE code = 'trial_unused') = 0,
  'руководитель удалил неиспользованный вид работ');
SELECT pg_temp.act_as_nobody();
SELECT pg_temp.check((SELECT count(*) FROM price_list WHERE work_type_code = 'trial_unused') = 0,
  'цены удалённого вида работ ушли вместе с ним');
SELECT pg_temp.check(coalesce(current_setting('app.price_chain', true), 'off') <> 'on',
  'флаг записи в прайс после удаления снят');

INSERT INTO work_types (code, name, sort_order) VALUES ('trial_admin', 'Пробный вид администратора', 903);
SELECT pg_temp.act_as(pg_temp.uid('adm'));
SELECT public.delete_work_type('trial_admin');
SELECT pg_temp.check((SELECT count(*) FROM work_types WHERE code = 'trial_admin') = 0,
  'администратор тоже удаляет неиспользованный вид работ');
SELECT pg_temp.check(public.app_can_delete_work_types(), 'администратору удаление доступно');
SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT pg_temp.check(NOT public.app_can_delete_work_types(), 'координатору удаление недоступно');
SELECT pg_temp.act_as_nobody();

ROLLBACK;
