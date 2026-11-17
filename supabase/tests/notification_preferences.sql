-- Каналы уведомлений по сотруднику (ТЗ, блок 5): notification_preferences из профиля и карточки сотрудника.
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/notification_preferences.sql
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

CREATE FUNCTION pg_temp.event_of(p_key text, p_code text) RETURNS uuid LANGUAGE sql AS $$
  SELECT event.id FROM public.integration_outbox event
   WHERE event.event_type = p_code AND event.aggregate_id = (SELECT id FROM ids WHERE k = p_key)
   ORDER BY event.created_at DESC LIMIT 1
$$;
CREATE FUNCTION pg_temp.email_to(p_key text, p_code text) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(plan.recipient_address, ', ' ORDER BY plan.recipient_address), 'никто')
    FROM public.load_email_event_plan(pg_temp.event_of(p_key, p_code)) plan
$$;
CREATE FUNCTION pg_temp.telegram_to(p_key text, p_code text) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(plan.recipient_address, ', ' ORDER BY plan.recipient_address), 'никто')
    FROM public.load_telegram_event_plan(pg_temp.event_of(p_key, p_code)) plan
$$;

-- ---------------------------------------------------------------- Данные
DO $$
DECLARE
  r text; uid uuid; org uuid; site uuid; payer uuid; man uuid; model uuid; eq uuid; task uuid;
BEGIN
  FOREACH r IN ARRAY ARRAY['coordinator', 'engineer', 'engineer2', 'admin'] LOOP
    uid := gen_random_uuid();
    INSERT INTO auth.users (id, email, aud, role) VALUES (uid, 'np-' || r || '@test.local', 'authenticated', 'authenticated');
    INSERT INTO public.users (id, full_name, role, email, telegram_chat_id, is_active, access_role_key)
    VALUES (uid, 'Каналы ' || r, (CASE WHEN r = 'engineer2' THEN 'engineer' ELSE r END)::user_role, 'np-' || r || '@test.local',
            CASE WHEN r = 'engineer' THEN '7100001' END, true, CASE WHEN r = 'engineer2' THEN 'engineer' ELSE r END);
    INSERT INTO ids VALUES (r, uid);
  END LOOP;
  INSERT INTO organizations (name) VALUES ('Каналы: организация') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('Каналы: площадка', org) RETURNING id INTO site;
  INSERT INTO payers (name) VALUES ('Каналы: плательщик') RETURNING id INTO payer;
  INSERT INTO manufacturers (name) VALUES ('Каналы: производитель') RETURNING id INTO man;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (man, 'Каналы: модель') RETURNING id INTO model;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  VALUES ('NP-1', man, model, site, payer) RETURNING id INTO eq;
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, initiator_id, created_by, call_date, deadline_from, deadline_to, status_code)
  VALUES ('Каналы: ремонт', 'repair', eq, site, payer, (SELECT id FROM ids WHERE k = 'coordinator'), (SELECT id FROM ids WHERE k = 'coordinator'),
          current_date, current_date, current_date + 3, 'new')
  RETURNING id INTO task;
  INSERT INTO ids VALUES ('task', task);
END $$;

-- Сотрудник выключил себе письма «Инженер назначен»: так сохраняет «Мой профиль» (upsert).
SELECT pg_temp.act_as(pg_temp.uid('engineer'));
INSERT INTO public.notification_preferences (user_id, event_code, channel, is_enabled)
VALUES (pg_temp.uid('engineer'), 'task_engineer_assigned', 'email', false)
ON CONFLICT (user_id, event_code, channel) DO UPDATE SET is_enabled = EXCLUDED.is_enabled;
SELECT pg_temp.check((SELECT count(*) = 1 FROM public.notification_preferences WHERE user_id = pg_temp.uid('engineer')),
  'сотрудник сохраняет свои каналы и видит их');
SELECT pg_temp.expect_message(
  format('INSERT INTO public.notification_preferences (user_id, event_code, channel, is_enabled) VALUES (%L, %L, %L, false)',
         pg_temp.uid('engineer2'), 'task_engineer_assigned', 'email'),
  'new row violates row-level security policy for table "notification_preferences"',
  'чужие каналы сотрудник менять не может');
SELECT pg_temp.act_as_nobody();

-- Администратор настраивает каналы другого сотрудника из его карточки.
SELECT pg_temp.act_as(pg_temp.uid('admin'));
INSERT INTO public.notification_preferences (user_id, event_code, channel, is_enabled)
VALUES (pg_temp.uid('engineer2'), 'task_rework_requested', 'telegram', false)
ON CONFLICT (user_id, event_code, channel) DO UPDATE SET is_enabled = EXCLUDED.is_enabled;
SELECT pg_temp.check((SELECT count(*) = 2 FROM public.notification_preferences
                       WHERE user_id IN (pg_temp.uid('engineer'), pg_temp.uid('engineer2'))),
  'администратор меняет и видит каналы сотрудников');
SELECT pg_temp.act_as_nobody();

SELECT pg_temp.act_as(pg_temp.uid('engineer'));
SELECT pg_temp.check((SELECT count(*) = 0 FROM public.notification_preferences WHERE user_id = pg_temp.uid('engineer2')),
  'чужие каналы сотрудник не видит');
SELECT pg_temp.act_as_nobody();

-- Назначили инженера: письмо ему не уходит, в Telegram уходит.
UPDATE public.tasks SET engineer_id = pg_temp.uid('engineer'), status_code = 'assigned' WHERE id = pg_temp.uid('task');
SELECT pg_temp.check(pg_temp.event_of('task', 'task_engineer_assigned') IS NOT NULL, 'назначение поставило событие');
SELECT pg_temp.check(pg_temp.email_to('task', 'task_engineer_assigned') NOT LIKE '%np-engineer@%',
  'выключенный канал: письмо инженеру не уходит');
SELECT pg_temp.check(pg_temp.email_to('task', 'task_engineer_assigned') LIKE '%np-coordinator@%',
  'у инициатора письмо осталось');
SELECT pg_temp.check(pg_temp.telegram_to('task', 'task_engineer_assigned') LIKE '%7100001%',
  'включённый канал: Telegram инженеру уходит');

-- Включил обратно — письмо снова уходит.
SELECT pg_temp.act_as(pg_temp.uid('engineer'));
INSERT INTO public.notification_preferences (user_id, event_code, channel, is_enabled)
VALUES (pg_temp.uid('engineer'), 'task_engineer_assigned', 'email', true)
ON CONFLICT (user_id, event_code, channel) DO UPDATE SET is_enabled = EXCLUDED.is_enabled;
SELECT pg_temp.act_as_nobody();
SELECT pg_temp.check(pg_temp.email_to('task', 'task_engineer_assigned') LIKE '%np-engineer@%',
  'включил обратно: письмо инженеру снова уходит');

ROLLBACK;
