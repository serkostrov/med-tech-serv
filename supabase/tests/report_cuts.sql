-- Разрезы отчётов и затраты за период (миграции 0044 и 0045).
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/report_cuts.sql
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

CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid);
GRANT SELECT, INSERT ON ids TO authenticated;
GRANT SELECT ON ids TO anon;

CREATE TEMP TABLE days (k text PRIMARY KEY, d date);
GRANT SELECT ON days TO authenticated;
INSERT INTO days
SELECT shift.k, (now() AT TIME ZONE 'Europe/Moscow')::date + shift.offset_days
  FROM (VALUES ('today', 0), ('from', -10), ('mid', -5), ('before', -11), ('long_ago', -40)) AS shift(k, offset_days);

CREATE FUNCTION pg_temp.d(p_key text) RETURNS date LANGUAGE sql STABLE AS $$
  SELECT d FROM days WHERE k = p_key
$$;

CREATE FUNCTION pg_temp.uid(p_key text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM ids WHERE k = p_key
$$;

-- Разрез одной строкой: «код=задач/закрыто/просрочено» через « | », по коду значения.
-- Порядок самой функции (сверху частые) проверяется отдельно: иначе строка теста
-- зависела бы от сортировки русских названий в базе стенда.
CREATE FUNCTION pg_temp.cut(p_section text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(string_agg(
           format('%s=%s/%s/%s', row.item_code, row.task_count, row.closed_count, row.overdue_count),
           ' | ' ORDER BY row.item_code), '')
    FROM public.report_task_breakdown(pg_temp.d('from'), pg_temp.d('today')) AS row
   WHERE row.section = p_section
$$;

-- Одна строка разреза: «задач/закрыто/просрочено». Для разрезов, где код — это id.
CREATE FUNCTION pg_temp.cut_row(p_section text, p_code text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT format('%s/%s/%s', row.task_count, row.closed_count, row.overdue_count)
    FROM public.report_task_breakdown(pg_temp.d('from'), pg_temp.d('today')) AS row
   WHERE row.section = p_section AND row.item_code = p_code
$$;

-- Имя значения разреза: интерфейс показывает его как есть, поэтому проверяем дословно.
CREATE FUNCTION pg_temp.cut_name(p_section text, p_code text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT row.item_name
    FROM public.report_task_breakdown(pg_temp.d('from'), pg_temp.d('today')) AS row
   WHERE row.section = p_section AND row.item_code = p_code
$$;

-- Первая строка разреза в порядке функции: сверху должно идти самое частое значение.
CREATE FUNCTION pg_temp.cut_first(p_section text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT row.item_code
    FROM public.report_task_breakdown(pg_temp.d('from'), pg_temp.d('today')) AS row
   WHERE row.section = p_section
   LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.act_as_nobody(), pg_temp.check(boolean, text),
  pg_temp.expect_forbidden(text, text), pg_temp.d(text), pg_temp.uid(text),
  pg_temp.cut(text), pg_temp.cut_row(text, text), pg_temp.cut_name(text, text),
  pg_temp.cut_first(text) TO authenticated, anon;

-- ---------------------------------------------------------------- Данные
DO $$
DECLARE
  roles text[] := ARRAY['coordinator', 'engineer', 'warehouse', 'supervisor'];
  r text; uid uuid;
  org uuid; site1 uuid; site2 uuid; payer1 uuid; payer2 uuid; man uuid; model uuid;
  eq1 uuid; eq2 uuid; part_a uuid; part_b uuid; e2 uuid;
  task_key text; task_id uuid;
BEGIN
  FOREACH r IN ARRAY roles LOOP
    uid := gen_random_uuid();
    INSERT INTO auth.users (id, email, aud, role) VALUES (uid, 'cuts-' || r || '@test.local', 'authenticated', 'authenticated');
    INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
    VALUES (uid, 'Разрезы ' || r, r::user_role, 'cuts-' || r || '@test.local', true, r);
    INSERT INTO ids VALUES (r, uid);
  END LOOP;

  -- Второй инженер: загрузка считается по каждому отдельно.
  e2 := gen_random_uuid();
  INSERT INTO auth.users (id, email, aud, role) VALUES (e2, 'cuts-engineer2@test.local', 'authenticated', 'authenticated');
  INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
  VALUES (e2, 'Разрезы инженер два', 'engineer', 'cuts-engineer2@test.local', true, 'engineer');
  INSERT INTO ids VALUES ('engineer2', e2);

  -- Роль «смотрит отчёты, но не деньги»: ровно та, из-за которой нужна проверка
  -- finance.read внутри функций затрат.
  INSERT INTO access_roles (key, name, base_role) VALUES ('report_viewer', 'Наблюдатель отчётов', 'supervisor');
  INSERT INTO access_role_permissions (role_key, permission_code)
  VALUES ('report_viewer', 'reports.read'), ('report_viewer', 'tasks.read'), ('report_viewer', 'tasks.read_all');
  uid := gen_random_uuid();
  INSERT INTO auth.users (id, email, aud, role) VALUES (uid, 'cuts-viewer@test.local', 'authenticated', 'authenticated');
  INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
  VALUES (uid, 'Наблюдатель отчётов', 'supervisor', 'cuts-viewer@test.local', true, 'report_viewer');
  INSERT INTO ids VALUES ('viewer', uid);

  -- Роль «деньги вижу, приборы нет»: в app_can_read_equipment права finance.read нет,
  -- и обычное соединение с приборами выкинуло бы из затрат все строки.
  INSERT INTO access_roles (key, name, base_role) VALUES ('money_only', 'Только деньги', 'supervisor');
  INSERT INTO access_role_permissions (role_key, permission_code)
  VALUES ('money_only', 'finance.read'), ('money_only', 'reports.read'), ('money_only', 'tasks.read');
  uid := gen_random_uuid();
  INSERT INTO auth.users (id, email, aud, role) VALUES (uid, 'cuts-money@test.local', 'authenticated', 'authenticated');
  INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
  VALUES (uid, 'Только деньги', 'supervisor', 'cuts-money@test.local', true, 'money_only');
  INSERT INTO ids VALUES ('money', uid);

  INSERT INTO organizations (name) VALUES ('Разрезы: организация') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('Разрезы: первая площадка', org) RETURNING id INTO site1;
  INSERT INTO sites (name, organization_id) VALUES ('Разрезы: вторая площадка', org) RETURNING id INTO site2;
  INSERT INTO payers (name, requisites)
  VALUES ('Разрезы: плательщик один', '{"inn": "7701234560", "kpp": "770101001"}'::jsonb) RETURNING id INTO payer1;
  INSERT INTO payers (name, requisites)
  VALUES ('Разрезы: плательщик два', '{"inn": "7701234578", "kpp": "770101001"}'::jsonb) RETURNING id INTO payer2;
  INSERT INTO manufacturers (name) VALUES ('Разрезы: производитель') RETURNING id INTO man;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (man, 'Разрезы: модель') RETURNING id INTO model;

  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  VALUES ('CUTS-1', man, model, site1, payer1) RETURNING id INTO eq1;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  VALUES ('CUTS-2', man, model, site2, payer2) RETURNING id INTO eq2;

  INSERT INTO parts (article_number, name) VALUES ('CUTS-ART-A', 'Клапан') RETURNING id INTO part_a;
  INSERT INTO parts (article_number, name) VALUES ('CUTS-ART-B', 'Шланг') RETURNING id INTO part_b;

  -- Прайс нужен затратам: без цены счёт соберётся нулями и проверять будет нечего.
  INSERT INTO price_list (work_type_code, guarantee_category_id, valid_from, amount, include_guarantee_work)
  VALUES ('repair', NULL, (SELECT d FROM days WHERE k = 'long_ago'), 1000, false);

  INSERT INTO ids VALUES ('org', org), ('site1', site1), ('site2', site2),
    ('payer1', payer1), ('payer2', payer2), ('eq1', eq1), ('eq2', eq2),
    ('part_a', part_a), ('part_b', part_b);

  FOR task_key, task_id IN
    SELECT source.k, gen_random_uuid() FROM (VALUES
      ('t_ontime'), ('t_late'), ('t_overdue'), ('t_hours'), ('t_cancelled'),
      ('t_edge_in'), ('t_edge_out'), ('t_eq2_paid'), ('t_old')) AS source(k)
  LOOP
    INSERT INTO ids VALUES (task_key, task_id);
  END LOOP;
END $$;

-- Задачи заводим в обход триггеров: акт, фото и переходы этапов проверяют свои наборы,
-- здесь нужен только результат — задачи периода в разных состояниях.
SET session_replication_role = replica;

INSERT INTO tasks (id, title, work_type_code, status_code, priority, equipment_id, site_id, payer_id,
                   engineer_id, reason_code, work_modifier, hours, deadline_from, deadline_to,
                   call_date, completed_at, work_finished_at, created_at, created_by)
SELECT
  source.id, source.title, source.work_type, source.status, source.priority::task_priority,
  source.equipment, source.site, source.payer, source.engineer, source.reason,
  source.modifier::work_modifier, source.hours, source.deadline_from, source.deadline_to,
  source.call_day, source.completed, source.completed, source.created,
  pg_temp.uid('coordinator')
FROM (VALUES
  -- Закрыта вовремя: окончание не позже конца срока.
  (pg_temp.uid('t_ontime'), 'Закрыта вовремя', 'repair', 'closed', 'planned', pg_temp.uid('eq1'),
    pg_temp.uid('site1'), pg_temp.uid('payer1'), pg_temp.uid('engineer'), 'wear', 'N', NULL::numeric,
    pg_temp.d('from') + 1, pg_temp.d('from') + 3, pg_temp.d('from'),
    public.company_day_start(pg_temp.d('from') + 2) + interval '10 hours',
    public.company_day_start(pg_temp.d('from')) + interval '9 hours'),
  -- Закрыта с опозданием: окончание позже конца срока.
  (pg_temp.uid('t_late'), 'Закрыта с опозданием', 'repair', 'closed', 'urgent', pg_temp.uid('eq1'),
    pg_temp.uid('site1'), pg_temp.uid('payer1'), pg_temp.uid('engineer'), 'user_fault', 'N', NULL::numeric,
    pg_temp.d('from') + 1, pg_temp.d('from') + 2, pg_temp.d('from'),
    public.company_day_start(pg_temp.d('mid')) + interval '10 hours',
    public.company_day_start(pg_temp.d('from')) + interval '9 hours'),
  -- Открыта, срок вышел: просрочена.
  (pg_temp.uid('t_overdue'), 'Срок вышел', 'maintenance', 'in_progress', 'planned', pg_temp.uid('eq2'),
    pg_temp.uid('site2'), pg_temp.uid('payer2'), pg_temp.uid('engineer2'), 'warranty', 'G', NULL::numeric,
    pg_temp.d('from') + 1, pg_temp.d('from') + 2, pg_temp.d('from'), NULL::timestamptz,
    public.company_day_start(pg_temp.d('from')) + interval '9 hours'),
  -- Прочие работы с часами, без причины и без отметки гарантийности. Срок ещё не вышел.
  (pg_temp.uid('t_hours'), 'Прочие работы', 'other', 'new', 'planned', pg_temp.uid('eq2'),
    pg_temp.uid('site2'), pg_temp.uid('payer2'), pg_temp.uid('engineer2'), NULL::text, NULL, 4.5,
    pg_temp.d('today'), pg_temp.d('today') + 2, pg_temp.d('mid'), NULL::timestamptz,
    public.company_day_start(pg_temp.d('mid')) + interval '9 hours'),
  -- Отменённая: в разрезе этапов есть, в открытых и просроченных нет, инженера не занимает.
  (pg_temp.uid('t_cancelled'), 'Отменена', 'repair', 'cancelled', 'planned', pg_temp.uid('eq1'),
    pg_temp.uid('site1'), pg_temp.uid('payer1'), pg_temp.uid('engineer'), 'wear', 'N', NULL::numeric,
    pg_temp.d('from') + 1, pg_temp.d('from') + 2, pg_temp.d('mid'), NULL::timestamptz,
    public.company_day_start(pg_temp.d('mid')) + interval '9 hours'),
  -- Край периода: 00:30 по Москве первого дня — внутри. Инженера нет.
  (pg_temp.uid('t_edge_in'), 'Полночь первого дня', 'repair', 'new', 'planned', pg_temp.uid('eq1'),
    pg_temp.uid('site1'), pg_temp.uid('payer1'), NULL::uuid, 'wear', 'N', NULL::numeric,
    pg_temp.d('today'), pg_temp.d('today') + 1, pg_temp.d('from'), NULL::timestamptz,
    public.company_day_start(pg_temp.d('from')) + interval '30 minutes'),
  -- Край периода: 23:30 по Москве дня перед периодом — снаружи.
  (pg_temp.uid('t_edge_out'), 'Вечер накануне', 'repair', 'new', 'planned', pg_temp.uid('eq1'),
    pg_temp.uid('site1'), pg_temp.uid('payer1'), NULL::uuid, 'wear', 'N', NULL::numeric,
    pg_temp.d('today'), pg_temp.d('today') + 1, pg_temp.d('before'), NULL::timestamptz,
    public.company_day_start(pg_temp.d('from')) - interval '30 minutes'),
  -- Закрытая задача второго прибора: по ней счёт второму плательщику.
  (pg_temp.uid('t_eq2_paid'), 'Ремонт второго прибора', 'repair', 'closed', 'planned', pg_temp.uid('eq2'),
    pg_temp.uid('site2'), pg_temp.uid('payer2'), pg_temp.uid('engineer2'), 'wear', 'N', NULL::numeric,
    pg_temp.d('from') + 1, pg_temp.d('from') + 2, pg_temp.d('from'),
    public.company_day_start(pg_temp.d('from') + 2) + interval '10 hours',
    public.company_day_start(pg_temp.d('from')) + interval '9 hours'),
  -- Давняя задача: в период не попадает ни при каком пересчёте.
  (pg_temp.uid('t_old'), 'Давняя задача', 'repair', 'closed', 'planned', pg_temp.uid('eq1'),
    pg_temp.uid('site1'), pg_temp.uid('payer1'), pg_temp.uid('engineer'), 'wear', 'N', NULL::numeric,
    pg_temp.d('long_ago'), pg_temp.d('long_ago') + 2, pg_temp.d('long_ago'),
    public.company_day_start(pg_temp.d('long_ago') + 1) + interval '10 hours',
    public.company_day_start(pg_temp.d('long_ago')) + interval '9 hours')
) AS source(id, title, work_type, status, priority, equipment, site, payer, engineer, reason,
            modifier, hours, deadline_from, deadline_to, call_day, completed, created);

-- Запчасти задач: по состояниям Г, Н и Б.
INSERT INTO task_parts (task_id, part_id, part_condition, article_number_snapshot, name_snapshot, quantity, installed, position)
VALUES
  (pg_temp.uid('t_ontime'), pg_temp.uid('part_a'), 'N', 'CUTS-ART-A', 'Клапан', 2, true, 0),
  (pg_temp.uid('t_ontime'), pg_temp.uid('part_b'), 'G', 'CUTS-ART-B', 'Шланг', 1, true, 1),
  (pg_temp.uid('t_late'), pg_temp.uid('part_a'), 'G', 'CUTS-ART-A', 'Клапан', 3, true, 0),
  (pg_temp.uid('t_overdue'), pg_temp.uid('part_b'), 'B', 'CUTS-ART-B', 'Шланг', 1, false, 0),
  -- Запчасть давней задачи в период не попадает.
  (pg_temp.uid('t_old'), pg_temp.uid('part_a'), 'B', 'CUTS-ART-A', 'Клапан', 7, true, 0);

SET session_replication_role = origin;

-- ---------------------------------------------------------------- Цифры шапки
SELECT pg_temp.act_as(pg_temp.uid('supervisor'));

SELECT pg_temp.check(
  (SELECT task_count FROM public.report_task_summary(pg_temp.d('from'), pg_temp.d('today'))) = 7,
  'в период попали семь задач: вечер накануне и давняя задача остались снаружи');
SELECT pg_temp.check(
  (SELECT closed_count FROM public.report_task_summary(pg_temp.d('from'), pg_temp.d('today'))) = 3,
  'закрытых за период три');
SELECT pg_temp.check(
  (SELECT cancelled_count FROM public.report_task_summary(pg_temp.d('from'), pg_temp.d('today'))) = 1,
  'отменённая одна');
SELECT pg_temp.check(
  (SELECT open_count FROM public.report_task_summary(pg_temp.d('from'), pg_temp.d('today'))) = 3,
  'открытых три: закрытые и отменённые не в счёт');
SELECT pg_temp.check(
  (SELECT overdue_count FROM public.report_task_summary(pg_temp.d('from'), pg_temp.d('today'))) = 1,
  'просрочена одна: закрытые и отменённую не считаем, задачи с будущим сроком тоже');
SELECT pg_temp.check(
  (SELECT closed_dated_count FROM public.report_task_summary(pg_temp.d('from'), pg_temp.d('today'))) = 3
  AND (SELECT closed_on_time_count FROM public.report_task_summary(pg_temp.d('from'), pg_temp.d('today'))) = 2
  AND (SELECT closed_on_time_percent FROM public.report_task_summary(pg_temp.d('from'), pg_temp.d('today'))) = 67,
  'вовремя закрыты две закрытые из трёх: 67 процентов');
SELECT pg_temp.check(
  (SELECT engineer_count FROM public.report_task_summary(pg_temp.d('from'), pg_temp.d('today'))) = 2,
  'инженеров в периоде двое: задача без инженера счёт не увеличивает');
SELECT pg_temp.check(
  (SELECT task_count FROM public.report_task_summary(pg_temp.d('today'), pg_temp.d('from'))) = 0,
  'перевёрнутый период пуст, а не считается наоборот');

-- ---------------------------------------------------------------- Разбивки
SELECT pg_temp.check(pg_temp.cut('status') = 'cancelled=1/0/0 | closed=3/3/0 | in_progress=1/0/1 | new=2/0/0',
  'этапы: по строке на этап, с закрытыми и просроченными');
SELECT pg_temp.check(pg_temp.cut('work_type') = 'maintenance=1/0/1 | other=1/0/0 | repair=5/3/0',
  'виды работ');
SELECT pg_temp.check(pg_temp.cut('reason') = 'unset=1/0/0 | user_fault=1/1/0 | warranty=1/0/1 | wear=4/2/0',
  'причины обращений: задача без причины отдельной строкой unset');
SELECT pg_temp.check(pg_temp.cut_name('reason', 'warranty') = 'Гарантийный случай',
  'причина названа как в справочнике');
SELECT pg_temp.check(pg_temp.cut_name('reason', 'unset') = 'Причина не указана',
  'задача без причины подписана по-русски');
SELECT pg_temp.check(pg_temp.cut('modifier') = 'G=1/0/1 | N=5/3/0 | unset=1/0/0',
  'гарантийность работ: Г, Н и не отмечено');
SELECT pg_temp.check(pg_temp.cut_name('modifier', 'G') = 'Г · гарантийные работы'
  AND pg_temp.cut_name('modifier', 'N') = 'Н · вина пользователя'
  AND pg_temp.cut_name('modifier', 'unset') = 'Не отмечено',
  'отметки гарантийности подписаны');
SELECT pg_temp.check(pg_temp.cut_row('equipment', pg_temp.uid('eq1')::text) = '4/2/0'
  AND pg_temp.cut_row('equipment', pg_temp.uid('eq2')::text) = '3/1/1',
  'приборы: выезды, закрытые и просроченные по каждому');
SELECT pg_temp.check(pg_temp.cut_name('equipment', pg_temp.uid('eq1')::text) = 'Разрезы: производитель Разрезы: модель · CUTS-1',
  'прибор подписан производителем, моделью и заводским номером');
SELECT pg_temp.check(pg_temp.cut_first('equipment') = pg_temp.uid('eq1')::text,
  'сверху разреза самое частое значение: интерфейс рисует полосы в этом порядке');
SELECT pg_temp.check(pg_temp.cut_row('site', pg_temp.uid('site1')::text) = '4/2/0'
  AND pg_temp.cut_row('site', pg_temp.uid('site2')::text) = '3/1/1',
  'площадки');
SELECT pg_temp.check(pg_temp.cut_row('engineer', pg_temp.uid('engineer')::text) = '3/2/0'
  AND pg_temp.cut_row('engineer', pg_temp.uid('engineer2')::text) = '3/1/1'
  AND pg_temp.cut_row('engineer', 'unset') = '1/0/0',
  'инженеры: без инженера отдельной строкой');
SELECT pg_temp.check(pg_temp.cut_name('engineer', 'unset') = 'Инженер не назначен',
  'строка без инженера подписана по-русски');
SELECT pg_temp.check(
  (SELECT sum(task_count) FROM public.report_task_breakdown(pg_temp.d('from'), pg_temp.d('today'))
    WHERE section = 'month') = 7
  AND (SELECT count(*) FROM public.report_task_breakdown(pg_temp.d('from'), pg_temp.d('today'))
        WHERE section = 'month' AND item_code !~ '^\d{4}-\d{2}$') = 0,
  'месяцы: все задачи периода разложены по месяцам создания, код месяца — ГГГГ-ММ');
SELECT pg_temp.check(
  (SELECT count(*) FROM public.report_task_breakdown(pg_temp.d('from'), pg_temp.d('today'))
    WHERE section NOT IN ('status', 'work_type', 'month', 'reason', 'modifier', 'equipment', 'site', 'engineer')) = 0,
  'других разрезов функция не придумывает');

-- ---------------------------------------------------------------- Гарантийность замен
SELECT pg_temp.check(
  (SELECT string_agg(format('%s=%s/%s/%s', condition_code, task_count, position_count, trim_scale(quantity)), ' | ')
     FROM public.report_part_warranty(pg_temp.d('from'), pg_temp.d('today'))) = 'G=2/2/4 | N=1/1/2 | B=1/1/1',
  'запчасти по состояниям Г, Н и Б: задач, позиций и количество');
SELECT pg_temp.check(
  (SELECT condition_name FROM public.report_part_warranty(pg_temp.d('from'), pg_temp.d('today'))
    WHERE condition_code = 'B') = 'Б · бывшая в употреблении',
  'состояния запчастей подписаны');

-- ---------------------------------------------------------------- Загрузка инженеров
-- У первого инженера в периоде три задачи, но отменённая не занимает: остаются две
-- со сроками в три дня (один день общий). У второго — три задачи и три занятых дня.
SELECT pg_temp.check(
  (SELECT task_count FROM public.report_engineer_load(pg_temp.d('from'), pg_temp.d('today'))
    WHERE engineer_id = pg_temp.uid('engineer')) = 2,
  'загрузка первого инженера: отменённая задача не занимает');
SELECT pg_temp.check(
  (SELECT busy_days FROM public.report_engineer_load(pg_temp.d('from'), pg_temp.d('today'))
    WHERE engineer_id = pg_temp.uid('engineer')) = 3,
  'занятые дни считаются один раз: у двух задач дни пересекаются');
SELECT pg_temp.check(
  (SELECT period_days FROM public.report_engineer_load(pg_temp.d('from'), pg_temp.d('today'))
    WHERE engineer_id = pg_temp.uid('engineer')) = 11,
  'длина периода отдаётся рядом: доля загрузки считается без второго запроса');
SELECT pg_temp.check(
  (SELECT format('%s/%s/%s/%s', task_count, closed_count, overdue_count, trim_scale(work_hours))
     FROM public.report_engineer_load(pg_temp.d('from'), pg_temp.d('today'))
    WHERE engineer_id = pg_temp.uid('engineer2')) = '3/1/1/4.5',
  'по второму инженеру: задачи, закрытые, просрочка и часы прочих работ');
SELECT pg_temp.check(
  (SELECT count(*) FROM public.report_engineer_load(pg_temp.d('from'), pg_temp.d('today'))) = 2,
  'в загрузке только инженеры с задачами периода');
SELECT pg_temp.check(
  (SELECT busy_days FROM public.report_engineer_load(pg_temp.d('long_ago'), pg_temp.d('long_ago') + 1)
    WHERE engineer_id = pg_temp.uid('engineer')) = 2,
  'задача, кончающаяся после периода, занимает только дни внутри периода');

-- ---------------------------------------------------------------- Инженер видит только своё
SELECT pg_temp.act_as(pg_temp.uid('engineer'));
SELECT pg_temp.check(
  (SELECT task_count FROM public.report_task_summary(pg_temp.d('from'), pg_temp.d('today'))) = 3,
  'инженер в отчёте видит только свои задачи: правила строк считают за него');

-- ---------------------------------------------------------------- Деньги: только finance.read
SELECT pg_temp.act_as(pg_temp.uid('coordinator'));
DO $$
DECLARE inv_paid uuid; inv_other uuid; inv_eq2 uuid; inv_cancelled uuid;
BEGIN
  inv_paid := public.create_invoice(pg_temp.uid('payer1'), ARRAY[pg_temp.uid('t_ontime')], NULL);
  inv_other := public.create_invoice(pg_temp.uid('payer1'), ARRAY[pg_temp.uid('t_late')], NULL);
  inv_eq2 := public.create_invoice(pg_temp.uid('payer2'), ARRAY[pg_temp.uid('t_eq2_paid')], NULL);
  inv_cancelled := public.create_invoice(pg_temp.uid('payer1'), ARRAY[pg_temp.uid('t_old')], NULL);
  -- Отменённый счёт не платят: в затраты он не идёт.
  UPDATE public.invoices SET status = 'cancelled' WHERE id = inv_cancelled;
  -- Ручная корректировка — тоже деньги плательщика, и в его разрезе она видна.
  PERFORM public.correct_invoice(inv_other, -100, 'Скидка по договорённости');
  INSERT INTO ids VALUES ('inv_paid', inv_paid), ('inv_other', inv_other),
    ('inv_eq2', inv_eq2), ('inv_cancelled', inv_cancelled);
END $$;

SELECT pg_temp.act_as(pg_temp.uid('supervisor'));
SELECT pg_temp.check(
  (SELECT format('%s/%s/%s/%s', task_count, invoice_count, trim_scale(work_amount), trim_scale(total_amount))
     FROM public.report_equipment_spend(pg_temp.d('from'), pg_temp.d('today'))
    WHERE equipment_id = pg_temp.uid('eq1')) = '2/2/2000/2000',
  'затраты по прибору: оба счёта по его задачам, отменённый не считается');
SELECT pg_temp.check(
  (SELECT count(*) FROM public.report_equipment_spend(pg_temp.d('from'), pg_temp.d('today'))) = 2,
  'в затратах по приборам только приборы со счетами за период');
SELECT pg_temp.check(
  (SELECT serial_number || ' / ' || equipment_name || ' / ' || site_name || ' / ' || payer_name
     FROM public.report_equipment_spend(pg_temp.d('from'), pg_temp.d('today'))
    WHERE equipment_id = pg_temp.uid('eq1'))
  = 'CUTS-1 / Разрезы: производитель Разрезы: модель / Разрезы: первая площадка / Разрезы: плательщик один',
  'прибор в затратах подписан номером, моделью, площадкой и плательщиком');
SELECT pg_temp.check(
  (SELECT equipment_id FROM public.report_equipment_spend(pg_temp.d('from'), pg_temp.d('today')) LIMIT 1)
    = pg_temp.uid('eq1'),
  'сверху затрат самый дорогой прибор');
SELECT pg_temp.check(
  (SELECT format('%s/%s/%s/%s/%s', invoice_count, task_count, trim_scale(work_amount),
                 trim_scale(adjustment_amount), trim_scale(total_amount))
     FROM public.report_payer_spend(pg_temp.d('from'), pg_temp.d('today'))
    WHERE payer_id = pg_temp.uid('payer1')) = '2/2/2000/-100/1900',
  'затраты по плательщику: итог с корректировкой, работы без неё, отменённый счёт не в счёт');
SELECT pg_temp.check(
  (SELECT format('%s/%s/%s', invoice_count, trim_scale(adjustment_amount), trim_scale(total_amount))
     FROM public.report_payer_spend(pg_temp.d('from'), pg_temp.d('today'))
    WHERE payer_id = pg_temp.uid('payer2')) = '1/0/1000',
  'второй плательщик со своим счётом');
SELECT pg_temp.check(
  (SELECT count(*) FROM public.report_payer_spend(pg_temp.d('long_ago'), pg_temp.d('long_ago') + 1)) = 0,
  'в периоде без счетов затраты пусты');

-- Инженер и кладовщик затрат не видят. Ни строки, ни нулей, из которых видно,
-- по каким приборам счета вообще есть.
SELECT pg_temp.act_as(pg_temp.uid('engineer'));
SELECT pg_temp.check(
  (SELECT count(*) FROM public.report_equipment_spend(pg_temp.d('from'), pg_temp.d('today'))) = 0
  AND (SELECT count(*) FROM public.report_payer_spend(pg_temp.d('from'), pg_temp.d('today'))) = 0,
  'инженер затрат не видит');
SELECT pg_temp.act_as(pg_temp.uid('warehouse'));
SELECT pg_temp.check(
  (SELECT count(*) FROM public.report_equipment_spend(pg_temp.d('from'), pg_temp.d('today'))) = 0
  AND (SELECT count(*) FROM public.report_payer_spend(pg_temp.d('from'), pg_temp.d('today'))) = 0,
  'кладовщик затрат не видит');

-- Итог руководителя запоминаем, чтобы сверить с ним роль без прав на приборы:
-- литерал в проверке пропустил бы регресс, сдвинувший обе цифры разом. Запоминаем
-- под руководителем: выше уже побывали инженер с кладовщиком, которым затрат не видно.
CREATE TEMP TABLE sums (k text PRIMARY KEY, v numeric);
GRANT SELECT, INSERT ON sums TO authenticated;
SELECT pg_temp.act_as(pg_temp.uid('supervisor'));
INSERT INTO sums
SELECT 'supervisor_eq1', total_amount
  FROM public.report_equipment_spend(pg_temp.d('from'), pg_temp.d('today'))
 WHERE equipment_id = pg_temp.uid('eq1');

-- Роль «деньги без приборов»: затраты по приборам считаются, просто без названия
-- прибора. Молча терять деньги из-за прав на справочник нельзя.
SELECT pg_temp.act_as(pg_temp.uid('money'));
SELECT pg_temp.check(
  (SELECT count(*) FROM public.report_equipment_spend(pg_temp.d('from'), pg_temp.d('today'))) = 2,
  'затраты по приборам считаются и без права на приборы');
SELECT pg_temp.check(
  (SELECT total_amount FROM public.report_equipment_spend(pg_temp.d('from'), pg_temp.d('today'))
    WHERE equipment_id = pg_temp.uid('eq1'))
  = (SELECT v FROM sums WHERE k = 'supervisor_eq1'),
  'итог по прибору тот же, что у руководителя');
SELECT pg_temp.check(
  (SELECT serial_number FROM public.report_equipment_spend(pg_temp.d('from'), pg_temp.d('today'))
    WHERE equipment_id = pg_temp.uid('eq1')) = '',
  'название прибора пустое, а не выдуманное');

-- Роль «отчёты без денег»: разрезы по задачам отдаются, затраты — нет.
SELECT pg_temp.act_as(pg_temp.uid('viewer'));
SELECT pg_temp.check(
  (SELECT task_count FROM public.report_task_summary(pg_temp.d('from'), pg_temp.d('today'))) = 7,
  'наблюдатель отчётов видит разрезы по задачам');
SELECT pg_temp.check(
  (SELECT count(*) FROM public.report_equipment_spend(pg_temp.d('from'), pg_temp.d('today'))) = 0
  AND (SELECT count(*) FROM public.report_payer_spend(pg_temp.d('from'), pg_temp.d('today'))) = 0,
  'наблюдателю отчётов без finance.read затраты не отдаются');

-- ---------------------------------------------------------------- Задача без срока
-- Перенесённые из 1С задачи могут быть без периода выполнения: ограничение на сроки
-- заведено как NOT VALID и старые строки не проверяет. Для загрузки инженеров у такой
-- задачи занятым считается день создания. Проверяем, что условия по самим столбцам,
-- добавленные ради индекса, эту ветку не отрезали.
SELECT pg_temp.act_as_nobody();
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_execution_period_required;
SET session_replication_role = replica;
INSERT INTO tasks (id, title, work_type_code, status_code, priority, equipment_id, site_id, payer_id,
                   engineer_id, call_date, created_at, created_by)
VALUES (gen_random_uuid(), 'Без срока, перенесена из 1С', 'repair', 'assigned', 'planned',
        pg_temp.uid('eq1'), pg_temp.uid('site1'), pg_temp.uid('payer1'), pg_temp.uid('engineer'),
        pg_temp.d('mid'), public.company_day_start(pg_temp.d('mid')) + interval '9 hours',
        pg_temp.uid('coordinator'));
SET session_replication_role = origin;

SELECT pg_temp.act_as(pg_temp.uid('supervisor'));
SELECT pg_temp.check(
  (SELECT task_count FROM public.report_engineer_load(pg_temp.d('from'), pg_temp.d('today'))
    WHERE engineer_id = pg_temp.uid('engineer')) = 3,
  'задача без срока попадает в загрузку инженера');
SELECT pg_temp.check(
  (SELECT busy_days FROM public.report_engineer_load(pg_temp.d('from'), pg_temp.d('today'))
    WHERE engineer_id = pg_temp.uid('engineer')) = 4,
  'у задачи без срока занят день создания, и это ещё один день к трём прежним');
SELECT pg_temp.check(
  (SELECT busy_days FROM public.report_engineer_load(pg_temp.d('today'), pg_temp.d('today'))
    WHERE engineer_id = pg_temp.uid('engineer')) IS NULL,
  'в период без её дня создания задача без срока не попадает');

-- ---------------------------------------------------------------- Аноним
SELECT pg_temp.act_as_nobody();
SET LOCAL ROLE anon;
SELECT pg_temp.expect_forbidden(
  'SELECT * FROM public.report_task_summary(current_date - 10, current_date)',
  'аноним не строит отчёт');
SELECT pg_temp.expect_forbidden(
  'SELECT * FROM public.report_task_breakdown(current_date - 10, current_date)',
  'аноним не получает разбивки');
SELECT pg_temp.expect_forbidden(
  'SELECT * FROM public.report_period_tasks(current_date - 10, current_date)',
  'аноним не получает задачи периода');
SELECT pg_temp.expect_forbidden(
  'SELECT * FROM public.report_part_warranty(current_date - 10, current_date)',
  'аноним не получает гарантийность замен');
SELECT pg_temp.expect_forbidden(
  'SELECT * FROM public.report_engineer_load(current_date - 10, current_date)',
  'аноним не получает загрузку инженеров');
SELECT pg_temp.expect_forbidden(
  'SELECT * FROM public.report_equipment_spend(current_date - 10, current_date)',
  'аноним не получает затраты по приборам');
SELECT pg_temp.expect_forbidden(
  'SELECT * FROM public.report_payer_spend(current_date - 10, current_date)',
  'аноним не получает затраты по плательщикам');
RESET ROLE;

ROLLBACK;
