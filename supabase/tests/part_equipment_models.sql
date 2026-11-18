-- Запчасть подходит к модели прибора (миграция 0073).
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/part_equipment_models.sql
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

-- Ожидаем отказ по правам именно по-русски: сообщение видит координатор.
CREATE FUNCTION pg_temp.expect_forbidden(p_sql text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE message text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN insufficient_privilege THEN
    message := nullif(btrim(SQLERRM), '');
    IF message IS NULL OR message !~ '[А-Яа-яЁё]' THEN
      RAISE EXCEPTION 'ПРОВАЛ: % — отказ не по-русски: %', p_label, message;
    END IF;
    RAISE NOTICE 'ok: % (нет прав: %)', p_label, message;
    RETURN;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — команда прошла, а должна быть запрещена', p_label;
END $$;

-- Отказ правил строк и грантов: сообщение даёт сама база, поэтому язык не проверяем.
CREATE FUNCTION pg_temp.expect_denied(p_sql text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'ok: % (закрыто правилами базы)', p_label;
    RETURN;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — команда прошла, а должна быть запрещена', p_label;
END $$;

CREATE FUNCTION pg_temp.expect_invalid(p_sql text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE message text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    message := nullif(btrim(SQLERRM), '');
    IF message IS NULL OR message !~ '[А-Яа-яЁё]' THEN
      RAISE EXCEPTION 'ПРОВАЛ: % — отказ не по-русски: %', p_label, message;
    END IF;
    RAISE NOTICE 'ok: % (не принято: %)', p_label, message;
    RETURN;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — команда прошла, а должна быть запрещена', p_label;
END $$;

CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid);
GRANT SELECT ON ids TO authenticated;
CREATE FUNCTION pg_temp.uid(p_key text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM ids WHERE k = p_key
$$;
GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.act_as_nobody(), pg_temp.check(boolean, text),
  pg_temp.expect_forbidden(text, text), pg_temp.expect_invalid(text, text),
  pg_temp.expect_denied(text, text), pg_temp.uid(text) TO authenticated;

-- Сколько писем и ответов видно в карточке задачи.
CREATE FUNCTION pg_temp.thread_count(p_task uuid) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer FROM public.task_mail_thread(p_task)
$$;

-- Переписка одной строкой, по порядку: так видно и порядок, и кто писал.
CREATE FUNCTION pg_temp.thread_text(p_task uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT string_agg(thread.direction || ':' || left(thread.body, 20), ' | ' ORDER BY thread.occurred_at, thread.direction)
    FROM public.task_mail_thread(p_task) AS thread
$$;

CREATE FUNCTION pg_temp.thread_files(p_task uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(string_agg(item ->> 'fileName', ', ' ORDER BY item ->> 'fileName'), 'нет')
    FROM public.task_mail_thread(p_task) AS thread,
         jsonb_array_elements(thread.attachments) AS item
$$;

GRANT EXECUTE ON FUNCTION pg_temp.thread_count(uuid), pg_temp.thread_text(uuid), pg_temp.thread_files(uuid) TO authenticated;

-- Адресаты плана писем одной строкой по алфавиту.
CREATE FUNCTION pg_temp.email_to(p_task text, p_code text) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(plan.recipient_address, ', ' ORDER BY plan.recipient_address), 'никто')
    FROM public.integration_outbox AS event
    JOIN public.load_email_event_plan(event.id) AS plan ON true
   WHERE event.event_type = p_code
     AND event.aggregate_id = (SELECT id FROM ids WHERE k = p_task)
$$;

DO $$
DECLARE
  coord uuid := gen_random_uuid();
  eng uuid := gen_random_uuid();
  eng2 uuid := gen_random_uuid();
  buyer uuid := gen_random_uuid();
  store uuid := gen_random_uuid();
  org uuid; site uuid; payer uuid; manuf uuid; model uuid; eq uuid; wt text;
  contact uuid; task uuid; letter uuid; other_task uuid; part uuid;
BEGIN
  INSERT INTO auth.users (id, email, aud, role) VALUES
    (coord, 'coord@mail.test', 'authenticated', 'authenticated'),
    (eng, 'eng@mail.test', 'authenticated', 'authenticated'),
    (eng2, 'eng2@mail.test', 'authenticated', 'authenticated'),
    (buyer, 'buyer@mail.test', 'authenticated', 'authenticated'),
    (store, 'store@mail.test', 'authenticated', 'authenticated');
  INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key) VALUES
    (coord, 'Тест координатор', 'coordinator', 'coord@mail.test', true, 'coordinator'),
    (eng, 'Тест инженер', 'engineer', 'eng@mail.test', true, 'engineer'),
    (eng2, 'Чужой инженер', 'engineer', 'eng2@mail.test', true, 'engineer'),
    (buyer, 'Тест заказчик', 'customer', 'buyer@mail.test', true, 'customer'),
    (store, 'Тест кладовщик', 'warehouse', 'store@mail.test', true, 'warehouse');

  INSERT INTO organizations (name) VALUES ('Тестовая больница писем') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('КДЛ письма', org) RETURNING id INTO site;
  INSERT INTO site_contacts (site_id, full_name, email, phone)
  VALUES (site, 'Воронина Светлана Анатольевна', 'kdl@client.test', '+7 (831) 438-92-10')
  RETURNING id INTO contact;
  INSERT INTO payers (name) VALUES ('Плательщик писем') RETURNING id INTO payer;
  INSERT INTO manufacturers (name) VALUES ('Письмо-Производитель') RETURNING id INTO manuf;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (manuf, 'cobas e 411') RETURNING id INTO model;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  VALUES ('SN-MAIL-1', manuf, model, site, payer) RETURNING id INTO eq;
  SELECT code INTO wt FROM work_types WHERE is_active ORDER BY code LIMIT 1;

  -- Задача из письма: назначена инженеру, в очереди сразу два события (0001).
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id,
                     created_by, call_date, deadline_from, deadline_to, status_code)
  VALUES ('Ошибка температуры инкубатора', wt, eq, site, payer, eng, coord,
          '2026-11-10', '2026-11-11', '2026-11-14', 'assigned')
  RETURNING id INTO task;

  -- Письмо клиента, из которого создана задача. Отправитель написан с именем:
  -- адрес из него достаёт app_mail_address.
  INSERT INTO public.mail_messages (
    external_message_id, thread_id, sender, subject, body, received_at, status, task_id,
    parsed_payload, ai_confidence, parsed_at, autoreply_sent_at
  ) VALUES (
    '<client-1@mail.test>', '<client-1@mail.test>', 'Воронина С. А. <kdl@client.test>',
    'Ошибка температуры инкубатора', E'Добрый день!\nАнализатор выдаёт ошибку температуры.',
    '2026-11-10 09:12+03', 'converted', task,
    jsonb_build_object('contactName', 'Воронина Светлана Анатольевна', 'summary', 'Ошибка температуры'),
    0.93, now(), now()
  ) RETURNING id INTO letter;
  -- Вложения письма лежат в хранилище по ключу mail/<письмо>/…
  UPDATE public.mail_messages
     SET raw_storage_key = format('mail/%s/message.eml', letter),
         attachments = jsonb_build_array(jsonb_build_object(
           'storageKey', format('mail/%s/screen.jpg', letter),
           'fileName', 'экран-ошибки.jpg',
           'contentType', 'image/jpeg',
           'byteSize', 284311))
   WHERE id = letter;

  -- Заказчику видна задача своей организации, кладовщику — пока по ней есть резерв.
  INSERT INTO customer_organization_access (customer_user_id, organization_id) VALUES (buyer, org);
  INSERT INTO parts (article_number, name) VALUES ('MAIL-1', 'Клапан письма') RETURNING id INTO part;
  INSERT INTO stock_reservations (part_id, part_condition, quantity, task_id, requested_by)
  VALUES (part, 'N', 1, task, coord);

  -- Вторая задача из той же переписки: клиент дописал до того, как задачи создали.
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id,
                     created_by, call_date, deadline_from, deadline_to, status_code)
  VALUES ('Заодно посмотреть принтер', wt, eq, site, payer, eng2, coord,
          '2026-11-10', '2026-11-11', '2026-11-14', 'assigned')
  RETURNING id INTO other_task;

  INSERT INTO ids VALUES ('coord', coord), ('eng', eng), ('eng2', eng2), ('buyer', buyer),
    ('store', store), ('task', task), ('letter', letter), ('site', site), ('contact', contact),
    ('other_task', other_task);
END $$;

CREATE FUNCTION pg_temp.part_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT id FROM public.parts WHERE article_number = 'MAIL-1' $$;
CREATE FUNCTION pg_temp.model_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT id FROM public.equipment_models WHERE name = 'cobas e 411' ORDER BY id LIMIT 1 $$;
GRANT EXECUTE ON FUNCTION pg_temp.part_id(), pg_temp.model_id() TO authenticated;

-- Кладовщик отмечает, инженер видит, но не меняет.
SELECT pg_temp.act_as(pg_temp.uid('store'));
INSERT INTO public.part_equipment_models (part_id, model_id) VALUES (pg_temp.part_id(), pg_temp.model_id());
SELECT pg_temp.check((SELECT count(*) = 1 FROM public.part_equipment_models WHERE part_id = pg_temp.part_id()), 'кладовщик отмечает модель');
SELECT pg_temp.check((SELECT created_by = pg_temp.uid('store') FROM public.part_equipment_models WHERE part_id = pg_temp.part_id()), 'кто отметил, записывается сам');
SELECT pg_temp.act_as(pg_temp.uid('eng'));
SELECT pg_temp.check((SELECT count(*) = 1 FROM public.part_equipment_models WHERE model_id = pg_temp.model_id()), 'инженер видит, какие запчасти подходят к модели');
SELECT pg_temp.expect_denied(format('INSERT INTO public.part_equipment_models (part_id, model_id) SELECT id, %L FROM public.parts WHERE article_number = %L', pg_temp.model_id(), 'MAIL-1'), 'инженер модель не отмечает');
DELETE FROM public.part_equipment_models WHERE part_id = pg_temp.part_id();
SELECT pg_temp.act_as_nobody();
SELECT pg_temp.check((SELECT count(*) = 1 FROM public.part_equipment_models WHERE part_id = pg_temp.part_id()), 'инженер связь не удаляет');
SELECT pg_temp.check(NOT has_table_privilege('anon', 'public.part_equipment_models', 'select'), 'без входа связь не видна');
SELECT pg_temp.act_as(pg_temp.uid('store'));
DELETE FROM public.part_equipment_models WHERE part_id = pg_temp.part_id();
SELECT pg_temp.act_as_nobody();
SELECT pg_temp.check((SELECT count(*) = 0 FROM public.part_equipment_models WHERE part_id = pg_temp.part_id()), 'кладовщик снимает отметку');

ROLLBACK;
