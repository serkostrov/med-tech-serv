-- Компетенции инженера, сохранение плана ТО и задачи из плана (миграция 0026).
-- Запуск на локальной базе с применёнными миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/competencies_maintenance_plan.sql
-- Всё выполняется в транзакции и откатывается. Ошибка = проверка не прошла.

BEGIN;

CREATE FUNCTION pg_temp.act_as(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;
CREATE FUNCTION pg_temp.check(p_ok boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN RAISE EXCEPTION 'ПРОВАЛ: %', p_label; END IF;
  RAISE NOTICE 'ok: %', p_label;
END $$;
-- Ждём ошибку с этим текстом. Команда идёт в подтранзакции, как запрос API: при ошибке не остаётся ничего.
CREATE FUNCTION pg_temp.expect_error(p_sql text, p_fragment text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF position(p_fragment IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'ПРОВАЛ: % — другая ошибка: %', p_label, SQLERRM;
    END IF;
    RAISE NOTICE 'ok: % (отказ: %)', p_label, SQLERRM;
    RETURN;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — команда прошла, а должна быть отклонена', p_label;
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
GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.check(boolean, text), pg_temp.expect_error(text, text, text),
  pg_temp.expect_forbidden(text, text) TO authenticated, anon, medtech_worker;

CREATE TEMP TABLE v (k text PRIMARY KEY, id uuid);
GRANT SELECT ON v TO authenticated, anon, medtech_worker;

DO $$
DECLARE
  r text; uid uuid; base text;
  org uuid; site uuid; payer uuid; m1 uuid; m2 uuid; md uuid; eq uuid;
BEGIN
  FOREACH r IN ARRAY ARRAY['coordinator', 'engineer', 'engineer_off', 'warehouse', 'initiator'] LOOP
    uid := gen_random_uuid();
    base := CASE r WHEN 'engineer_off' THEN 'engineer' ELSE r END;
    INSERT INTO auth.users (id, email, aud, role) VALUES (uid, r || '@plan.test.local', 'authenticated', 'authenticated');
    INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
    VALUES (uid, 'План ' || r, base::user_role, r || '@plan.test.local', true, base);
    INSERT INTO v VALUES (r, uid);
  END LOOP;
  INSERT INTO organizations (name) VALUES ('План: больница') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('План: площадка', org) RETURNING id INTO site;
  INSERT INTO payers (name) VALUES ('План: плательщик') RETURNING id INTO payer;
  INSERT INTO manufacturers (name) VALUES ('План: Mindray') RETURNING id INTO m1;
  INSERT INTO manufacturers (name) VALUES ('План: Beckman') RETURNING id INTO m2;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (m1, 'BC-6800') RETURNING id INTO md;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  VALUES ('PLAN-1', m1, md, site, payer) RETURNING id INTO eq;
  INSERT INTO v VALUES ('m1', m1), ('m2', m2), ('eq', eq), ('site', site), ('payer', payer);
END $$;

-- Вызов функции компетенций одной строкой: инженер и список.
CREATE FUNCTION pg_temp.competencies_sql(p_engineer text, p_items text) RETURNS text LANGUAGE sql AS $$
  SELECT format('SELECT public.replace_engineer_competencies(%L, %L::jsonb)', (SELECT id FROM v WHERE k = p_engineer),
    replace(replace(p_items, 'M1', (SELECT id FROM v WHERE k = 'm1')::text), 'M2', (SELECT id FROM v WHERE k = 'm2')::text));
$$;
CREATE FUNCTION pg_temp.lines(p_engineer text) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(model_line, ',' ORDER BY model_line), '')
    FROM public.engineer_competencies WHERE engineer_id = (SELECT id FROM v WHERE k = p_engineer);
$$;
GRANT EXECUTE ON FUNCTION pg_temp.competencies_sql(text, text), pg_temp.lines(text) TO authenticated, anon;

-- ---------------------------------------------------------------- Компетенции
SELECT pg_temp.check((SELECT NOT prosecdef FROM pg_proc WHERE proname = 'replace_engineer_competencies'), 'функция компетенций работает с правами вызывающего');
SELECT pg_temp.check((SELECT NOT prosecdef FROM pg_proc WHERE proname = 'replace_maintenance_plan'), 'функция плана ТО работает с правами вызывающего');

SELECT pg_temp.act_as((SELECT id FROM v WHERE k = 'coordinator'));
DO $$ BEGIN EXECUTE pg_temp.competencies_sql('engineer', '[{"manufacturerId":"M1","modelLine":" BC-6800 "},{"manufacturerId":"M2","modelLine":"AU"}]'); END $$;
SELECT pg_temp.check(pg_temp.lines('engineer') = 'AU,BC-6800', 'координатор сохраняет набор компетенций, линейка без пробелов по краям');
RESET ROLE;
INSERT INTO v SELECT 'kept', id FROM public.engineer_competencies WHERE model_line = 'BC-6800';
SELECT pg_temp.act_as((SELECT id FROM v WHERE k = 'coordinator'));
DO $$ BEGIN EXECUTE pg_temp.competencies_sql('engineer', '[{"manufacturerId":"M1","modelLine":"BC-6800"},{"manufacturerId":"M2","modelLine":"AU 480"},{"manufacturerId":"M2","modelLine":"au 480"}]'); END $$;
SELECT pg_temp.check(pg_temp.lines('engineer') = 'AU 480,BC-6800', 'набор заменён: убранная удалена, новая добавлена, повтор записан один раз');
SELECT pg_temp.check(EXISTS (SELECT 1 FROM public.engineer_competencies WHERE id = (SELECT id FROM v WHERE k = 'kept')), 'оставшаяся компетенция не пересоздаётся');
DO $$ BEGIN EXECUTE pg_temp.competencies_sql('engineer', '[{"manufacturerId":"M1","modelLine":"bc-6800"},{"manufacturerId":"M2","modelLine":"AU 480"}]'); END $$;
SELECT pg_temp.check(pg_temp.lines('engineer') = 'AU 480,bc-6800', 'смена регистра линейки сохраняется');
SELECT pg_temp.expect_error(pg_temp.competencies_sql('engineer', '[{"manufacturerId":"M1","modelLine":"XN"},{"manufacturerId":"M2","modelLine":"  "}]'),
  'производитель из справочника и линейка', 'компетенция без линейки отклоняется');
SELECT pg_temp.expect_error(format('SELECT public.replace_engineer_competencies(%L, %L::jsonb)', (SELECT id FROM v WHERE k = 'engineer'),
  json_build_array(json_build_object('manufacturerId', gen_random_uuid(), 'modelLine', 'XN'))::text),
  'Производитель не найден', 'неизвестный производитель отклоняется');
SELECT pg_temp.check(pg_temp.lines('engineer') = 'AU 480,bc-6800', 'после отказа набор прежний');
SELECT pg_temp.expect_error(pg_temp.competencies_sql('coordinator', '[{"manufacturerId":"M1","modelLine":"XN"}]'),
  'Инженер не найден', 'компетенции только у инженера');
SELECT pg_temp.expect_error(pg_temp.competencies_sql('engineer', '{"manufacturerId":"M1","modelLine":"XN"}'),
  'списком', 'не список отклоняется понятным сообщением');
SELECT pg_temp.expect_error(pg_temp.competencies_sql('engineer', '[{"manufacturerId":"M1","modelLine":"' || repeat('X', 101) || '"}]'),
  'длиннее 100', 'слишком длинная линейка отклоняется');
DO $$ BEGIN EXECUTE pg_temp.competencies_sql('engineer', '[]'); END $$;
SELECT pg_temp.check(pg_temp.lines('engineer') = '', 'пустой список убирает все компетенции');
DO $$ BEGIN EXECUTE pg_temp.competencies_sql('engineer_off', '[{"manufacturerId":"M1","modelLine":"BC"},{"manufacturerId":"M2","modelLine":"AU"}]'); END $$;
RESET ROLE;

-- Старая запись с двойным пробелом (до 0026 могли внести в базу напрямую).
INSERT INTO public.engineer_competencies (engineer_id, manufacturer_id, model_line)
VALUES ((SELECT id FROM v WHERE k = 'engineer_off'), (SELECT id FROM v WHERE k = 'm2'), 'AU  480');
-- Отключённому инженеру новую компетенцию не добавить; при отказе не теряется и та, что убиралась.
UPDATE public.users SET is_active = false WHERE id = (SELECT id FROM v WHERE k = 'engineer_off');
SELECT pg_temp.act_as((SELECT id FROM v WHERE k = 'coordinator'));
SELECT pg_temp.expect_error(pg_temp.competencies_sql('engineer_off', '[{"manufacturerId":"M1","modelLine":"BC"},{"manufacturerId":"M1","modelLine":"XN"}]'),
  'активному инженеру', 'отключённому инженеру новую компетенцию не добавить');
SELECT pg_temp.check(pg_temp.lines('engineer_off') = 'AU,AU  480,BC', 'отказ откатывает всё: убранная компетенция на месте');
DO $$ BEGIN EXECUTE pg_temp.competencies_sql('engineer_off', '[{"manufacturerId":"M1","modelLine":"BC"},{"manufacturerId":"M2","modelLine":"AU 480"}]'); END $$;
SELECT pg_temp.check(pg_temp.lines('engineer_off') = 'AU  480,BC', 'у отключённого инженера компетенцию можно убрать, лишние пробелы старой записи не мешают');
DO $$ BEGIN EXECUTE pg_temp.competencies_sql('engineer_off', '[{"manufacturerId":"M1","modelLine":"BC"}]'); END $$;
SELECT pg_temp.check(pg_temp.lines('engineer_off') = 'BC', 'и старую запись можно убрать');
RESET ROLE;

SELECT pg_temp.act_as((SELECT id FROM v WHERE k = 'engineer'));
SELECT pg_temp.expect_forbidden(pg_temp.competencies_sql('engineer', '[{"manufacturerId":"M1","modelLine":"BC"}]'), 'инженер не меняет компетенции');
RESET ROLE;
SELECT pg_temp.act_as((SELECT id FROM v WHERE k = 'warehouse'));
SELECT pg_temp.expect_forbidden(pg_temp.competencies_sql('engineer', '[{"manufacturerId":"M1","modelLine":"BC"}]'), 'кладовщик не меняет компетенции');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT pg_temp.expect_forbidden(pg_temp.competencies_sql('engineer', '[]'), 'без входа функция компетенций закрыта');
RESET ROLE;
SELECT pg_temp.check(pg_temp.lines('engineer') = '', 'чужие попытки ничего не изменили');

-- ---------------------------------------------------------------- План ТО одной транзакцией
CREATE FUNCTION pg_temp.plan_sql(p_periods text) RETURNS text LANGUAGE sql AS $$
  SELECT format('SELECT public.replace_maintenance_plan(%L, 2027, %L::jsonb)', (SELECT id FROM v WHERE k = 'eq'),
    replace(p_periods, 'ENG', (SELECT id FROM v WHERE k = 'engineer')::text));
$$;
CREATE FUNCTION pg_temp.plan_text() RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(period_no || ':' || to_char(period_from, 'MM-DD') || coalesce('/' || comment, ''), ',' ORDER BY period_no), '')
    FROM public.maintenance_plans WHERE equipment_id = (SELECT id FROM v WHERE k = 'eq') AND plan_year = 2027;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.plan_sql(text), pg_temp.plan_text() TO authenticated, anon;

SELECT pg_temp.act_as((SELECT id FROM v WHERE k = 'coordinator'));
DO $$ BEGIN EXECUTE pg_temp.plan_sql('[{"periodFrom":"2027-09-01","periodTo":"2027-09-15","assignedEngineerId":"ENG","comment":" осень "},{"periodFrom":"2027-03-01","periodTo":"2027-03-10","assignedEngineerId":null}]'); END $$;
SELECT pg_temp.check(pg_temp.plan_text() = '1:03-01,2:09-01/осень', 'координатор сохраняет план, номера ТО по датам');
SELECT pg_temp.check((SELECT bool_and(created_by = auth.uid() AND work_type_code = 'maintenance' AND status = 'planned') FROM public.maintenance_plans WHERE equipment_id = (SELECT id FROM v WHERE k = 'eq')),
  'автор периода — тот, кто сохранил, вид работ ТО');
SELECT pg_temp.check((SELECT assigned_engineer_id FROM public.maintenance_plans WHERE equipment_id = (SELECT id FROM v WHERE k = 'eq') AND period_no = 2) = (SELECT id FROM v WHERE k = 'engineer'),
  'инженер периода сохраняется');
DO $$ BEGIN EXECUTE pg_temp.plan_sql('[{"periodFrom":"2027-02-01","periodTo":"2027-02-10"},{"periodFrom":"2027-06-01","periodTo":"2027-06-10"},{"periodFrom":"2027-10-01","periodTo":"2027-10-10"}]'); END $$;
SELECT pg_temp.check(pg_temp.plan_text() = '1:02-01,2:06-01,3:10-01', 'новый план заменяет старый целиком');
SELECT pg_temp.expect_error(pg_temp.plan_sql('[{"periodFrom":"2027-04-01","periodTo":"2027-04-20"},{"periodFrom":"2027-04-10","periodTo":"2027-04-30"}]'),
  'не должны пересекаться', 'пересекающиеся периоды отклоняются');
SELECT pg_temp.expect_error(pg_temp.plan_sql('[{"periodFrom":"2028-01-10","periodTo":"2028-01-20"}]'),
  'maintenance_plans', 'период вне года отклоняется');
SELECT pg_temp.check(pg_temp.plan_text() = '1:02-01,2:06-01,3:10-01', 'после отказа старый план на месте, а не удалён');
SELECT pg_temp.expect_error(pg_temp.plan_sql('[]'), 'от 1 до 5', 'пустой план отклоняется');
SELECT pg_temp.expect_error(pg_temp.plan_sql('[{"periodFrom":"1.02.2027","periodTo":"2027-02-10"}]'), 'даты начала и окончания', 'дата не в формате ГГГГ-ММ-ДД отклоняется');
SELECT pg_temp.expect_error(pg_temp.plan_sql('[{"periodFrom":"2027-02-30","periodTo":"2027-03-10"}]'), 'несуществующий день', 'несуществующий день отклоняется по-русски');
RESET ROLE;

SELECT pg_temp.act_as((SELECT id FROM v WHERE k = 'engineer'));
SELECT pg_temp.expect_forbidden(pg_temp.plan_sql('[{"periodFrom":"2027-02-01","periodTo":"2027-02-10"}]'), 'инженер не меняет план ТО');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT pg_temp.expect_forbidden(pg_temp.plan_sql('[{"periodFrom":"2027-02-01","periodTo":"2027-02-10"}]'), 'без входа функция плана закрыта');
RESET ROLE;
SELECT pg_temp.check(pg_temp.plan_text() = '1:02-01,2:06-01,3:10-01', 'чужие попытки план не изменили');

-- ---------------------------------------------------------------- Задачи из плана «Запланировано»
UPDATE public.maintenance_plans SET assigned_engineer_id = (SELECT id FROM v WHERE k = 'engineer')
 WHERE equipment_id = (SELECT id FROM v WHERE k = 'eq') AND period_no = 1;
CREATE TEMP TABLE periods (k text PRIMARY KEY, id uuid, period_from date, period_to date);
GRANT SELECT ON periods TO authenticated, anon;
INSERT INTO periods SELECT 'p' || period_no, id, period_from, period_to FROM public.maintenance_plans
 WHERE equipment_id = (SELECT id FROM v WHERE k = 'eq') AND plan_year = 2027;
INSERT INTO v SELECT k, id FROM periods;

-- Как generateMaintenanceTasks: статус planned, прибор и сроки из периода, инженер из плана, если он есть.
CREATE FUNCTION pg_temp.planned_task_sql(p_period text, p_engineer text) RETURNS text LANGUAGE sql AS $$
  SELECT format(
    'INSERT INTO public.tasks (title, work_type_code, status_code, is_maintenance_plan, maintenance_plan_id, equipment_id, site_id, payer_id, engineer_id, deadline_from, deadline_to, created_by)'
    || ' VALUES (%L, ''maintenance'', ''planned'', true, %L, %L, %L, %L, %L, %L, %L, auth.uid())',
    'ТО 2027', p.id, (SELECT id FROM v WHERE k = 'eq'), (SELECT id FROM v WHERE k = 'site'), (SELECT id FROM v WHERE k = 'payer'),
    (SELECT id FROM v WHERE k = p_engineer), p.period_from, p.period_to)
    FROM periods AS p WHERE p.k = p_period;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.planned_task_sql(text, text) TO authenticated, anon;

SELECT pg_temp.act_as((SELECT id FROM v WHERE k = 'coordinator'));
DO $$ BEGIN EXECUTE pg_temp.planned_task_sql('p1', 'engineer'); END $$;
DO $$ BEGIN EXECUTE pg_temp.planned_task_sql('p2', 'nobody'); END $$;
SELECT pg_temp.check((SELECT count(*) FROM public.tasks WHERE status_code = 'planned' AND maintenance_plan_id IN (SELECT id FROM v WHERE k IN ('p1', 'p2'))) = 2,
  'координатор создаёт задачи плана «Запланировано» с инженером и без');
SELECT pg_temp.check((SELECT engineer_id FROM public.tasks WHERE maintenance_plan_id = (SELECT id FROM v WHERE k = 'p1')) = (SELECT id FROM v WHERE k = 'engineer'),
  'инженер из плана остаётся в запланированной задаче');
SELECT pg_temp.expect_error(format(
  'INSERT INTO public.tasks (title, work_type_code, status_code, equipment_id, site_id, payer_id, deadline_from, deadline_to) VALUES (%L, ''maintenance'', ''planned'', %L, %L, %L, current_date, current_date + 3)',
  'Без плана', (SELECT id FROM v WHERE k = 'eq'), (SELECT id FROM v WHERE k = 'site'), (SELECT id FROM v WHERE k = 'payer')),
  'task_planned_status_valid', '«Запланировано» только у задачи из плана');
SELECT pg_temp.expect_error(pg_temp.planned_task_sql('p1', 'nobody'), 'tasks_maintenance_plan_once_uq', 'вторая задача на тот же период не создаётся');
SELECT pg_temp.expect_error(pg_temp.plan_sql('[{"periodFrom":"2027-02-01","periodTo":"2027-02-10"}]'),
  'уже создана задача', 'период с задачей план не удаляет, сообщение понятное');
SELECT pg_temp.check(pg_temp.plan_text() = '1:02-01,2:06-01,3:10-01', 'план с задачами остался целым');
RESET ROLE;
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM public.integration_outbox WHERE aggregate_id IN (SELECT id FROM public.tasks WHERE maintenance_plan_id IS NOT NULL)),
  'запланированная задача уведомлений не шлёт');

SELECT pg_temp.act_as((SELECT id FROM v WHERE k = 'initiator'));
SELECT pg_temp.expect_forbidden(pg_temp.planned_task_sql('p3', 'nobody'), 'инициатор задачу плана не создаёт');
RESET ROLE;

-- План с задачами: периоды с задачей остаются, остальные меняются, можно добавить новый.
SELECT pg_temp.act_as((SELECT id FROM v WHERE k = 'coordinator'));
DO $$ BEGIN EXECUTE pg_temp.plan_sql('[{"periodFrom":"2027-02-01","periodTo":"2027-02-10"},{"periodFrom":"2027-06-01","periodTo":"2027-06-10"},{"periodFrom":"2027-11-01","periodTo":"2027-11-10","comment":"перенесён"},{"periodFrom":"2027-12-01","periodTo":"2027-12-10"}]'); END $$;
SELECT pg_temp.check(pg_temp.plan_text() = '1:02-01,2:06-01,3:11-01/перенесён,4:12-01', 'к плану с задачами добавлен период, свободный перенесён, номера свободные');
SELECT pg_temp.check((SELECT count(*) FROM public.maintenance_plans WHERE id IN (SELECT id FROM v WHERE k IN ('p1', 'p2'))) = 2,
  'периоды с задачами остались теми же строками');
SELECT pg_temp.check((SELECT count(*) FROM public.tasks WHERE maintenance_plan_id IN (SELECT id FROM v WHERE k IN ('p1', 'p2'))) = 2,
  'задачи по-прежнему ссылаются на свои периоды');
SELECT pg_temp.expect_error(pg_temp.plan_sql('[{"periodFrom":"2027-02-02","periodTo":"2027-02-10"},{"periodFrom":"2027-06-01","periodTo":"2027-06-10"}]'),
  'уже создана задача', 'даты периода с задачей не меняются');
SELECT pg_temp.expect_error(pg_temp.plan_sql('[{"periodFrom":"2027-02-01","periodTo":"2027-02-10"},{"periodFrom":"2027-02-01","periodTo":"2027-02-10"},{"periodFrom":"2027-06-01","periodTo":"2027-06-10"}]'),
  'не должны повторяться', 'повтор периода с задачей не теряется молча');
SELECT pg_temp.expect_error(pg_temp.plan_sql('[{"periodFrom":"2027-02-01","periodTo":"2027-02-10"},{"periodFrom":"2027-06-01","periodTo":"2027-06-10"},{"periodFrom":"2027-05-25","periodTo":"2027-06-05"}]'),
  'не должны пересекаться', 'новый период не пересекает период с задачей');
SELECT pg_temp.check(pg_temp.plan_text() = '1:02-01,2:06-01,3:11-01/перенесён,4:12-01', 'после отказов план с задачами прежний');
RESET ROLE;
INSERT INTO v SELECT 'p_nov', id FROM public.maintenance_plans
 WHERE equipment_id = (SELECT id FROM v WHERE k = 'eq') AND plan_year = 2027 AND period_from = '2027-11-01';
SELECT pg_temp.act_as((SELECT id FROM v WHERE k = 'coordinator'));
DO $$ BEGIN EXECUTE pg_temp.plan_sql('[{"periodFrom":"2027-02-01","periodTo":"2027-02-10"},{"periodFrom":"2027-06-01","periodTo":"2027-06-10"},{"periodFrom":"2027-11-01","periodTo":"2027-11-10","assignedEngineerId":"ENG","comment":"обновлён"},{"periodFrom":"2027-12-01","periodTo":"2027-12-10"}]'); END $$;
SELECT pg_temp.check((SELECT comment = 'обновлён' AND assigned_engineer_id = (SELECT id FROM v WHERE k = 'engineer') FROM public.maintenance_plans WHERE id = (SELECT id FROM v WHERE k = 'p_nov')),
  'свободный период с теми же датами меняется на месте: та же строка, новый инженер и комментарий');
RESET ROLE;

-- Своя роль «Планировщик»: назначает (tasks.assign), видит приборы, но не задачи.
DO $$
DECLARE uid uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.access_roles (key, name, base_role, is_builtin) VALUES ('plan_test_planner', 'Планировщик', 'coordinator', false);
  INSERT INTO public.access_role_permissions (role_key, permission_code) VALUES ('plan_test_planner', 'tasks.assign'), ('plan_test_planner', 'equipment.read');
  INSERT INTO auth.users (id, email, aud, role) VALUES (uid, 'planner@plan.test.local', 'authenticated', 'authenticated');
  INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key) VALUES (uid, 'План планировщик', 'coordinator', 'planner@plan.test.local', true, 'plan_test_planner');
  INSERT INTO v VALUES ('planner', uid);
  -- Задача по декабрьскому периоду, отметка периода не записалась (он всё ещё «Запланировано»).
  INSERT INTO public.tasks (title, work_type_code, status_code, is_maintenance_plan, maintenance_plan_id, equipment_id, site_id, payer_id, deadline_from, deadline_to)
  SELECT 'ТО 2027', 'maintenance', 'planned', true, p.id, p.equipment_id, (SELECT id FROM v WHERE k = 'site'), (SELECT id FROM v WHERE k = 'payer'), p.period_from, p.period_to
    FROM public.maintenance_plans p WHERE p.equipment_id = (SELECT id FROM v WHERE k = 'eq') AND p.plan_year = 2027 AND p.period_from = '2027-12-01';
END $$;
SELECT pg_temp.act_as((SELECT id FROM v WHERE k = 'planner'));
SELECT pg_temp.check((SELECT count(*) FROM public.tasks) = 0, 'планировщик задач не видит');
DO $$ BEGIN EXECUTE pg_temp.plan_sql('[{"periodFrom":"2027-02-01","periodTo":"2027-02-10"},{"periodFrom":"2027-06-01","periodTo":"2027-06-10"},{"periodFrom":"2027-11-01","periodTo":"2027-11-10","assignedEngineerId":"ENG","comment":"обновлён"},{"periodFrom":"2027-12-01","periodTo":"2027-12-10"},{"periodFrom":"2027-09-01","periodTo":"2027-09-10"}]'); END $$;
SELECT pg_temp.check(pg_temp.plan_text() = '1:02-01,2:06-01,3:11-01/обновлён,4:12-01,5:09-01',
  'планировщик добавляет период, хотя задачи по другим периодам ему не видны');
SELECT pg_temp.expect_error(pg_temp.plan_sql('[{"periodFrom":"2027-02-01","periodTo":"2027-02-10"},{"periodFrom":"2027-06-01","periodTo":"2027-06-10"},{"periodFrom":"2027-11-01","periodTo":"2027-11-10"},{"periodFrom":"2027-09-01","periodTo":"2027-09-10"}]'),
  'уже созданы задачи из плана', 'период с невидимой задачей не удалить, сообщение понятное');
RESET ROLE;

-- Отменённый период без задачи: не удаляется, причина — статус, а не задача.
UPDATE public.maintenance_plans SET status = 'cancelled'
 WHERE equipment_id = (SELECT id FROM v WHERE k = 'eq') AND plan_year = 2027 AND period_from = '2027-09-01';
SELECT pg_temp.act_as((SELECT id FROM v WHERE k = 'coordinator'));
SELECT pg_temp.expect_error(pg_temp.plan_sql('[{"periodFrom":"2027-02-01","periodTo":"2027-02-10"},{"periodFrom":"2027-06-01","periodTo":"2027-06-10"},{"periodFrom":"2027-11-01","periodTo":"2027-11-10"},{"periodFrom":"2027-12-01","periodTo":"2027-12-10"}]'),
  'закрыт (отменено)', 'закрытый период без задачи не удаляется, причина названа верно');
SELECT pg_temp.check(pg_temp.plan_text() = '1:02-01,2:06-01,3:11-01/обновлён,4:12-01,5:09-01', 'после отказа план прежний');
RESET ROLE;

-- ---------------------------------------------------------------- Запуск по расписанию: «Запланировано» -> «Новая»
CREATE TEMP TABLE activated (task_id uuid);
GRANT INSERT, SELECT ON activated TO medtech_worker;
-- Служба ходит в базу напрямую, без входа сотрудника: auth.uid() пустой.
SELECT set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true);
SET LOCAL ROLE medtech_worker;
INSERT INTO activated SELECT task_id FROM public.activate_due_maintenance_tasks('2027-02-01', now());
RESET ROLE;
SELECT pg_temp.check(EXISTS (SELECT 1 FROM activated a JOIN public.tasks t ON t.id = a.task_id WHERE t.maintenance_plan_id = (SELECT id FROM v WHERE k = 'p1'))
  AND NOT EXISTS (SELECT 1 FROM activated a JOIN public.tasks t ON t.id = a.task_id WHERE t.maintenance_plan_id = (SELECT id FROM v WHERE k = 'p2')),
  'запуск по расписанию берёт только задачу, чей период начался');
SELECT pg_temp.check((SELECT status_code = 'new' AND engineer_id = (SELECT id FROM v WHERE k = 'engineer')
  FROM public.tasks WHERE maintenance_plan_id = (SELECT id FROM v WHERE k = 'p1')), 'задача стала «Новой», инженер из плана на месте');
SELECT pg_temp.check((SELECT status_code FROM public.tasks WHERE maintenance_plan_id = (SELECT id FROM v WHERE k = 'p2')) = 'planned', 'задача следующего периода ждёт своего срока');
SELECT pg_temp.check(EXISTS (SELECT 1 FROM public.task_status_history h JOIN public.tasks t ON t.id = h.task_id
  WHERE t.maintenance_plan_id = (SELECT id FROM v WHERE k = 'p1') AND h.from_status = 'planned' AND h.to_status = 'new'), 'в истории переход «Запланировано» -> «Новая»');
SELECT pg_temp.check(EXISTS (SELECT 1 FROM public.integration_outbox o JOIN public.tasks t ON t.id = o.aggregate_id
  WHERE t.maintenance_plan_id = (SELECT id FROM v WHERE k = 'p1') AND o.event_type = 'task_application_accepted'), 'при запуске ставится событие «Заявка принята»');

SELECT pg_temp.act_as((SELECT id FROM v WHERE k = 'coordinator'));
SELECT pg_temp.check((SELECT count(*) FROM (SELECT 1 FROM public.tasks WHERE maintenance_plan_id = (SELECT id FROM v WHERE k = 'p1')) AS seen) = 1, 'координатор видит запущенную задачу');
DO $$ BEGIN
  UPDATE public.tasks SET status_code = 'assigned' WHERE maintenance_plan_id = (SELECT id FROM v WHERE k = 'p1');
END $$;
RESET ROLE;
SELECT pg_temp.check((SELECT status_code = 'assigned' AND engineer_id = (SELECT id FROM v WHERE k = 'engineer')
  FROM public.tasks WHERE maintenance_plan_id = (SELECT id FROM v WHERE k = 'p1')), 'координатор подтверждает назначение инженера из плана');
SELECT pg_temp.check(EXISTS (SELECT 1 FROM public.integration_outbox o JOIN public.tasks t ON t.id = o.aggregate_id
  WHERE t.maintenance_plan_id = (SELECT id FROM v WHERE k = 'p1') AND o.event_type = 'task_engineer_assigned'), 'инженер получает уведомление о назначении');

ROLLBACK;
