-- Акт во вложении письма «Работы завершены» (миграция 0068).
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/work_completed_act.sql
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
  org uuid; site uuid; payer uuid; man uuid; model uuid; eq uuid; task uuid; open_task uuid;
BEGIN
  FOREACH r IN ARRAY ARRAY['coordinator', 'engineer'] LOOP
    uid := gen_random_uuid();
    INSERT INTO auth.users (id, email, aud, role) VALUES (uid, 'act-' || r || '@test.local', 'authenticated', 'authenticated');
    INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
    VALUES (uid, 'Акт ' || r, r::user_role, 'act-' || r || '@test.local', true, r);
    INSERT INTO ids VALUES (r, uid);
  END LOOP;
  INSERT INTO organizations (name) VALUES ('Акт: организация') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('Акт: площадка', org) RETURNING id INTO site;
  INSERT INTO payers (name) VALUES ('Акт: плательщик') RETURNING id INTO payer;
  INSERT INTO manufacturers (name) VALUES ('Акт: производитель') RETURNING id INTO man;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (man, 'Акт: модель') RETURNING id INTO model;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  VALUES ('ACT-1', man, model, site, payer) RETURNING id INTO eq;
  PERFORM set_config('session_replication_role', 'replica', true);
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by,
    deadline_from, deadline_to, status_code, call_reason, work_description)
  VALUES ('Замена лампы', 'repair', eq, site, payer, (SELECT id FROM ids WHERE k = 'engineer'), (SELECT id FROM ids WHERE k = 'coordinator'),
    current_date - 5, current_date - 1, 'under_review', 'Не горит', 'Лампа заменена')
  RETURNING id INTO task;
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by,
    deadline_from, deadline_to, status_code, call_reason)
  VALUES ('Открытая задача', 'repair', eq, site, payer, (SELECT id FROM ids WHERE k = 'engineer'), (SELECT id FROM ids WHERE k = 'coordinator'),
    current_date - 5, current_date + 1, 'in_progress', 'Шумит')
  RETURNING id INTO open_task;
  -- Два файла «акт»: в письмо идёт тот, что в закрытии задачи, а не последний загруженный.
  INSERT INTO files (kind, task_id, storage_key, original_name, content_type, byte_size)
  VALUES ('act', task, 'tasks/' || task || '/old-act.jpg', 'старый.jpg', 'image/jpeg', 50),
         ('act', task, 'tasks/' || task || '/act.jpg', 'Акт подписанный.JPG', 'image/jpeg', 1234),
         ('photo', task, 'tasks/' || task || '/p1', 'p1.jpg', 'image/jpeg', 100),
         ('photo', task, 'tasks/' || task || '/p2', 'p2.jpg', 'image/jpeg', 100),
         ('photo', task, 'tasks/' || task || '/p3', 'p3.jpg', 'image/jpeg', 100);
  INSERT INTO task_closures (task_id, act_file_id, submitted_by)
  SELECT task, f.id, (SELECT id FROM ids WHERE k = 'engineer') FROM files f WHERE f.task_id = task AND f.original_name = 'Акт подписанный.JPG';
  PERFORM set_config('session_replication_role', 'origin', true);
  INSERT INTO ids VALUES ('task', task), ('open', open_task);
END $$;

-- Координатор принял акт: задача закрыта, ушло событие «Работы завершены».
SELECT pg_temp.act_as(pg_temp.uid('coordinator'));
SELECT public.accept_task_closure(pg_temp.uid('task'), NULL, 'Принято', now());
SELECT pg_temp.act_as_nobody();
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

INSERT INTO ids SELECT 'done_event', o.id FROM integration_outbox o
 WHERE o.aggregate_id = pg_temp.uid('task') AND o.event_type = 'task_work_completed';
INSERT INTO ids SELECT 'other_event', o.id FROM integration_outbox o
 WHERE o.aggregate_id = pg_temp.uid('task') AND o.event_type <> 'task_work_completed' LIMIT 1;
-- Событие чужого вида по той же задаче: акт к нему не отдаётся.
INSERT INTO ids SELECT 'fake_event', gen_random_uuid();
INSERT INTO integration_outbox (id, idempotency_key, aggregate_type, aggregate_id, event_type, payload)
SELECT pg_temp.uid('fake_event'), 'test-act:' || pg_temp.uid('fake_event'), 'task', pg_temp.uid('open'), 'task_work_completed', '{}'::jsonb;

SELECT pg_temp.check(pg_temp.uid('done_event') IS NOT NULL, 'закрытие задачи поставило событие «Работы завершены»');
SELECT pg_temp.check((SELECT count(*) = 1 AND bool_and(a.storage_key LIKE 'tasks/%/act.jpg' AND a.original_name = 'Акт подписанный.JPG'
                        AND a.content_type = 'image/jpeg' AND a.byte_size = 1234 AND a.task_number LIKE 'З-%')
                        FROM public.task_act_for_event(pg_temp.uid('done_event')) AS a),
  'по событию отдаётся акт из закрытия задачи: ключ, имя, тип, размер и номер задачи');
SELECT pg_temp.check((SELECT count(*) = 0 FROM public.task_act_for_event(pg_temp.uid('fake_event'))),
  'у задачи без принятого акта вложения нет');
SELECT pg_temp.check((SELECT count(*) = 0 FROM public.task_act_for_event(gen_random_uuid())),
  'неизвестное событие — пусто');

-- Права: функцию вызывает только служба уведомлений.
SELECT pg_temp.check(has_function_privilege('medtech_worker', 'public.task_act_for_event(uuid)', 'EXECUTE'),
  'служба уведомлений может узнать акт');
SELECT pg_temp.check(NOT has_function_privilege('authenticated', 'public.task_act_for_event(uuid)', 'EXECUTE')
                     AND NOT has_function_privilege('anon', 'public.task_act_for_event(uuid)', 'EXECUTE'),
  'пользователи CRM и аноним вызвать функцию не могут');

ROLLBACK;
