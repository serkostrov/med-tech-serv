-- Продолжение в счёт первичной заявки создаёт связанную задачу (миграция 0067).
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/continuation_task.sql
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
  org uuid; site uuid; payer uuid; man uuid; model uuid; eq uuid; task uuid; plain uuid;
BEGIN
  FOREACH r IN ARRAY ARRAY['coordinator', 'engineer'] LOOP
    uid := gen_random_uuid();
    INSERT INTO auth.users (id, email, aud, role) VALUES (uid, 'cont-' || r || '@test.local', 'authenticated', 'authenticated');
    INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
    VALUES (uid, 'Продолжение ' || r, r::user_role, 'cont-' || r || '@test.local', true, r);
    INSERT INTO ids VALUES (r, uid);
  END LOOP;
  INSERT INTO organizations (name) VALUES ('Продолжение: организация') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('Продолжение: площадка', org) RETURNING id INTO site;
  INSERT INTO payers (name) VALUES ('Продолжение: плательщик') RETURNING id INTO payer;
  INSERT INTO manufacturers (name) VALUES ('Продолжение: производитель') RETURNING id INTO man;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (man, 'Продолжение: модель') RETURNING id INTO model;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  VALUES ('CONT-1', man, model, site, payer) RETURNING id INTO eq;
  -- Задачи сразу на проверке: акт, фото и этапы проверяют свои наборы.
  PERFORM set_config('session_replication_role', 'replica', true);
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by,
    deadline_from, deadline_to, status_code, priority, work_modifier, call_reason, work_description,
    recommendations, continued_in_primary)
  VALUES ('Ремонт дозатора', 'repair', eq, site, payer, (SELECT id FROM ids WHERE k = 'engineer'), (SELECT id FROM ids WHERE k = 'coordinator'),
    current_date - 5, current_date - 1, 'under_review', 'urgent', 'G', 'Не дозирует', 'Заменён клапан, нужен второй выезд',
    'Заменить насос после поставки', true)
  RETURNING id INTO task;
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by,
    deadline_from, deadline_to, status_code, call_reason, work_description)
  VALUES ('Диагностика', 'diagnostics', eq, site, payer, (SELECT id FROM ids WHERE k = 'engineer'), (SELECT id FROM ids WHERE k = 'coordinator'),
    current_date - 5, current_date - 1, 'under_review', 'Шумит', 'Проверено')
  RETURNING id INTO plain;
  -- Акт и три фото: без них задачу не закрыть.
  FOREACH uid IN ARRAY ARRAY[task, plain] LOOP
    INSERT INTO files (kind, task_id, storage_key, original_name, content_type, byte_size)
    VALUES ('act', uid, 'test/' || uid || '/act', 'act.jpg', 'image/jpeg', 100),
           ('photo', uid, 'test/' || uid || '/p1', 'p1.jpg', 'image/jpeg', 100),
           ('photo', uid, 'test/' || uid || '/p2', 'p2.jpg', 'image/jpeg', 100),
           ('photo', uid, 'test/' || uid || '/p3', 'p3.jpg', 'image/jpeg', 100);
    INSERT INTO task_closures (task_id, act_file_id, submitted_by)
    SELECT uid, f.id, (SELECT id FROM ids WHERE k = 'engineer') FROM files f WHERE f.task_id = uid AND f.kind = 'act';
  END LOOP;
  PERFORM set_config('session_replication_role', 'origin', true);
  INSERT INTO ids VALUES ('task', task), ('plain', plain);
END $$;

-- Координатор принял акт: задача закрыта.
SELECT pg_temp.act_as(pg_temp.uid('coordinator'));
SELECT public.accept_task_closure(pg_temp.uid('task'), NULL, 'Принято', now());
SELECT public.accept_task_closure(pg_temp.uid('plain'), NULL, 'Принято', now());
SELECT pg_temp.act_as_nobody();
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

SELECT pg_temp.check((SELECT count(*) = 1 FROM tasks WHERE primary_task_id = pg_temp.uid('task')),
  'закрытие с галочкой завело одну задачу-продолжение');
SELECT pg_temp.check((SELECT t.status_code = 'assigned' AND t.engineer_id = pg_temp.uid('engineer')
                        AND t.equipment_id = p.equipment_id AND t.work_type_code = 'repair'
                        AND t.priority::text = 'urgent' AND t.work_modifier::text = 'G'
                        AND t.title LIKE 'Продолжение З-%: Ремонт дозатора'
                        AND t.call_reason LIKE 'Продолжение работ по задаче З-%. Рекомендации из акта: Заменить насос после поставки'
                        AND t.deadline_from = public.company_today() AND t.deadline_to = public.company_today() + 7
                        FROM tasks t JOIN tasks p ON p.id = t.primary_task_id
                       WHERE t.primary_task_id = pg_temp.uid('task')),
  'продолжение — на того же инженера, прибор, вид работ, срочность и гарантию, срок на неделю с сегодня');
SELECT pg_temp.check((SELECT count(*) = 0 FROM tasks WHERE primary_task_id = pg_temp.uid('plain')),
  'без галочки продолжения нет');
SELECT pg_temp.check((SELECT count(*) >= 1 FROM integration_outbox o JOIN tasks t ON t.id = o.aggregate_id
                       WHERE t.primary_task_id = pg_temp.uid('task') AND o.event_type = 'task_engineer_assigned'),
  'инженеру ушло уведомление о назначении');

ROLLBACK;
