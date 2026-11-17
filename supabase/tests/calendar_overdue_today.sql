-- Календарь инженеров: незакрытая просрочка занимает инженера и сегодня (миграция 0064).
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/calendar_overdue_today.sql
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
  org uuid; site uuid; payer uuid; man uuid; model uuid; eq uuid; t uuid;
  today date := public.company_today();
BEGIN
  FOREACH r IN ARRAY ARRAY['coordinator', 'engineer'] LOOP
    uid := gen_random_uuid();
    INSERT INTO auth.users (id, email, aud, role) VALUES (uid, 'cal-' || r || '@test.local', 'authenticated', 'authenticated');
    INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
    VALUES (uid, 'Календарь ' || r, r::user_role, 'cal-' || r || '@test.local', true, r);
    INSERT INTO ids VALUES (r, uid);
  END LOOP;
  INSERT INTO organizations (name) VALUES ('Календарь: организация') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('Календарь: площадка', org) RETURNING id INTO site;
  INSERT INTO payers (name) VALUES ('Календарь: плательщик') RETURNING id INTO payer;
  INSERT INTO manufacturers (name) VALUES ('Календарь: производитель') RETURNING id INTO man;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (man, 'Календарь: модель') RETURNING id INTO model;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  VALUES ('CAL-1', man, model, site, payer) RETURNING id INTO eq;

  -- Этапы и акт проверяют свои наборы: здесь задачи заводим сразу на нужном этапе.
  PERFORM set_config('session_replication_role', 'replica', true);
  -- Срок давно прошёл, задача в работе: инженер всё ещё занят.
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, created_by, engineer_id, deadline_from, deadline_to, status_code)
  VALUES ('Хвост в работе', 'repair', eq, site, payer, (SELECT id FROM ids WHERE k = 'coordinator'),
          (SELECT id FROM ids WHERE k = 'engineer'), today - 10, today - 5, 'in_progress') RETURNING id INTO t;
  INSERT INTO ids VALUES ('t_late', t);
  -- Срок прошёл, но работа сдана на проверку: инженера больше не занимает.
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, created_by, engineer_id, deadline_from, deadline_to, status_code)
  VALUES ('Сдана на проверку', 'repair', eq, site, payer, (SELECT id FROM ids WHERE k = 'coordinator'),
          (SELECT id FROM ids WHERE k = 'engineer'), today - 10, today - 5, 'under_review') RETURNING id INTO t;
  INSERT INTO ids VALUES ('t_review', t);
  -- Срочная, никому не назначена, срок прошёл: её надо раздать первой.
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, created_by, deadline_from, deadline_to, status_code, priority)
  VALUES ('Срочная без инженера', 'repair', eq, site, payer, (SELECT id FROM ids WHERE k = 'coordinator'),
          today - 4, today - 3, 'new', 'urgent') RETURNING id INTO t;
  INSERT INTO ids VALUES ('t_unassigned', t);
  PERFORM set_config('session_replication_role', 'origin', true);
END $$;

-- Задачи заведены в обход проверок этапов: здесь нужен только их срок и этап.
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

SELECT pg_temp.check(public.task_calendar_day_to(public.company_today() - 5, public.company_today() - 10, NULL, 'in_progress') = public.company_today(),
  'незакрытая просрочка тянется до сегодня');
SELECT pg_temp.check(public.task_calendar_day_to(public.company_today() - 5, public.company_today() - 10, NULL, 'under_review') = public.company_today() - 5,
  'сданная на проверку — по своему сроку');
SELECT pg_temp.check(public.task_calendar_day_to(public.company_today() + 3, public.company_today(), NULL, 'in_progress') = public.company_today() + 3,
  'задача в сроке — по своему сроку');

SELECT pg_temp.act_as(pg_temp.uid('coordinator'));
SELECT pg_temp.check((SELECT count(*) = 1 FROM public.engineer_calendar(public.company_today(), public.company_today() + 6)
                       WHERE task_id = pg_temp.uid('t_late') AND engineer_id = pg_temp.uid('engineer')),
  'в календаре этой недели просроченная работа у инженера есть');
SELECT pg_temp.check((SELECT count(*) = 0 FROM public.engineer_calendar(public.company_today(), public.company_today() + 6)
                       WHERE task_id = pg_temp.uid('t_review')),
  'сданной на проверку в календаре недели нет');
SELECT pg_temp.check((SELECT count(*) = 1 FROM public.engineer_calendar(public.company_today(), public.company_today() + 6)
                       WHERE task_id = pg_temp.uid('t_unassigned') AND engineer_id IS NULL),
  'срочная неназначенная просрочка видна среди нераспределённых');
SELECT pg_temp.check((SELECT task_count = 1 AND overdue_task_count = 1
                        FROM public.engineer_period_load(public.company_today(), public.company_today() + 6)
                       WHERE engineer_id = pg_temp.uid('engineer')),
  'подсказка при назначении считает инженера занятым');
SELECT pg_temp.act_as_nobody();

ROLLBACK;
