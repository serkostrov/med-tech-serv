-- Письмо клиента в карточке задачи (миграции 0041–0043): переписка, вложения как файлы
-- задачи, ответ из карточки с заголовками цепочки и уведомления отправителю письма.
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/task_mail.sql
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

-- ---------------------------------------------------------------- Вложения письма — файлы задачи
SELECT pg_temp.act_as(pg_temp.uid('eng'));
SELECT pg_temp.check(NOT public.app_storage_object_access(format('mail/%s/screen.jpg', pg_temp.uid('letter')), false),
  'до переноса вложение письма инженеру недоступно');
SELECT pg_temp.act_as_nobody();

SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT pg_temp.check(public.attach_mail_files_to_task(pg_temp.uid('letter'), pg_temp.uid('task')) = 2,
  'координатор переносит письмо и вложение в файлы задачи');
SELECT pg_temp.check(public.attach_mail_files_to_task(pg_temp.uid('letter'), pg_temp.uid('task')) = 2,
  'повторный перенос дублей не создаёт и показывает те же два файла');
-- Токен без пользователя (sub) не считается службой: перенос всё равно по правам.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    EXECUTE format('SELECT public.attach_mail_files_to_task(%L, %L)',
                   (SELECT id FROM ids WHERE k = 'letter'), (SELECT id FROM ids WHERE k = 'task'));
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'ok: токен без пользователя вложения письма не переносит';
    RETURN;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: токен без пользователя перенёс вложения письма';
END $$;
SELECT pg_temp.act_as(pg_temp.uid('coord'));

-- Чужое письмо в свою задачу не перетащить, даже зная его номер.
SELECT pg_temp.expect_invalid(
  format('SELECT public.attach_mail_files_to_task(%L, %L)', pg_temp.uid('letter'), pg_temp.uid('other_task')),
  'письмо другой задачи к своей не приложить');
SELECT pg_temp.act_as_nobody();

SELECT pg_temp.check(
  (SELECT count(*) FROM public.files WHERE task_id = pg_temp.uid('task') AND mail_message_id = pg_temp.uid('letter')) = 2,
  'файлы задачи помнят, из какого они письма');
SELECT pg_temp.check(
  (SELECT bool_and(storage_key LIKE 'mail/%' AND kind = 'mail_attachment' AND NOT is_financial)
     FROM public.files WHERE mail_message_id = pg_temp.uid('letter')),
  'копии в папку задачи не делается: файл остаётся по ключу письма');

-- Чужой инженер к вложению письма не подходит ни до, ни после переноса.
SELECT pg_temp.act_as(pg_temp.uid('eng2'));
SELECT pg_temp.check(NOT public.app_storage_object_access(format('mail/%s/screen.jpg', pg_temp.uid('letter')), false),
  'инженер чужой задачи вложение письма не открывает');
SELECT pg_temp.act_as_nobody();

SELECT pg_temp.act_as(pg_temp.uid('eng'));
SELECT pg_temp.check(public.app_storage_object_access(format('mail/%s/screen.jpg', pg_temp.uid('letter')), false),
  'инженер задачи открывает вложение письма как файл задачи');
SELECT pg_temp.check(NOT public.app_storage_object_access(format('mail/%s/screen.jpg', pg_temp.uid('letter')), true),
  'писать в папку писем нельзя никому');
SELECT pg_temp.act_as_nobody();

-- Финансовый файл остаётся финансовым: без finance.read его не видно и не скачать.
UPDATE public.files SET is_financial = true
 WHERE mail_message_id = pg_temp.uid('letter') AND original_name = 'экран-ошибки.jpg';
SELECT pg_temp.act_as(pg_temp.uid('eng'));
SELECT pg_temp.check(NOT public.app_has_permission('finance.read'), 'у инженера нет права на финансовые файлы');
SELECT pg_temp.check(NOT public.app_storage_object_access(format('mail/%s/screen.jpg', pg_temp.uid('letter')), false),
  'финансовое вложение письма без finance.read не скачать');
SELECT pg_temp.check(pg_temp.thread_files(pg_temp.uid('task')) = 'Письмо клиента.eml',
  'финансовое вложение в переписке инженеру не показано');
SELECT pg_temp.act_as_nobody();
UPDATE public.files SET is_financial = false WHERE mail_message_id = pg_temp.uid('letter');

-- ---------------------------------------------------------------- Письмо в карточке задачи
SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT pg_temp.check(pg_temp.thread_count(pg_temp.uid('task')) = 1, 'координатор видит письмо в карточке задачи');
SELECT pg_temp.check(
  (SELECT thread.author = 'Воронина С. А. <kdl@client.test>' AND thread.subject = 'Ошибка температуры инкубатора'
            AND thread.body LIKE '%ошибку температуры%' AND thread.direction = 'incoming'
     FROM public.task_mail_thread(pg_temp.uid('task')) AS thread),
  'в карточке видно от кого, когда, тема и текст письма');
SELECT pg_temp.check(pg_temp.thread_files(pg_temp.uid('task')) = 'Письмо клиента.eml, экран-ошибки.jpg',
  'вложения письма перечислены в переписке');
SELECT pg_temp.check(
  (SELECT bool_and((item ->> 'fileId') IS NOT NULL)
     FROM public.task_mail_thread(pg_temp.uid('task')) AS thread,
          jsonb_array_elements(thread.attachments) AS item),
  'у вложения стоит id файла задачи: открывается как обычный файл');
SELECT pg_temp.act_as_nobody();

SELECT pg_temp.act_as(pg_temp.uid('eng'));
SELECT pg_temp.check(pg_temp.thread_count(pg_temp.uid('task')) = 1, 'инженер задачи тоже читает письмо клиента');
SELECT pg_temp.act_as_nobody();

SELECT pg_temp.act_as(pg_temp.uid('eng2'));
SELECT pg_temp.expect_forbidden(format('SELECT * FROM public.task_mail_thread(%L)', pg_temp.uid('task')),
  'инженеру чужой задачи переписка закрыта');
SELECT pg_temp.act_as_nobody();

-- ---------------------------------------------------------------- Ответ из карточки
SELECT pg_temp.act_as(pg_temp.uid('eng'));
SELECT pg_temp.check(NOT public.app_can_reply_task_mail(pg_temp.uid('task')), 'инженеру отвечать клиенту нельзя');
SELECT pg_temp.expect_forbidden(format('SELECT * FROM public.send_task_mail_reply(%L, %L)', pg_temp.uid('task'), 'Выезд в среду'),
  'инженер ответ клиенту не отправит');
SELECT pg_temp.act_as_nobody();

SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT pg_temp.check(public.app_can_reply_task_mail(pg_temp.uid('task')), 'координатор может ответить клиенту');
SELECT pg_temp.expect_invalid(format('SELECT * FROM public.send_task_mail_reply(%L, %L)', pg_temp.uid('task'), '   '),
  'пустой ответ не отправляется');
SELECT pg_temp.check(
  (SELECT reply.to_address = 'kdl@client.test' AND reply.subject = 'Re: Ошибка температуры инкубатора'
     FROM public.send_task_mail_reply(pg_temp.uid('task'), E'Здравствуйте!\nИнженер приедет в среду.') AS reply),
  'ответ уходит на адрес отправителя письма, тема — ответ в той же переписке');
SELECT pg_temp.act_as_nobody();

SELECT pg_temp.check(
  (SELECT count(*) FROM public.mail_replies WHERE task_id = pg_temp.uid('task') AND status = 'queued') = 1,
  'ответ встал в очередь на отправку');
SELECT pg_temp.check(
  (SELECT reply.in_reply_to = '<client-1@mail.test>'
            AND reply.reference_ids = ARRAY['<client-1@mail.test>']
            AND reply.external_message_id ~ '^<reply-[0-9a-f-]+@medtechservice>$'
            AND reply.author_id = pg_temp.uid('coord')
     FROM public.mail_replies AS reply WHERE reply.task_id = pg_temp.uid('task')),
  'у ответа сохранены заголовки цепочки и автор');

-- Переписка в карточке: письмо, затем ответ.
SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT pg_temp.check(pg_temp.thread_text(pg_temp.uid('task')) LIKE 'incoming:%|%outgoing:Здравствуйте!%',
  'в карточке письмо и ответ идут по порядку');
SELECT pg_temp.act_as_nobody();
SELECT pg_temp.act_as(pg_temp.uid('eng'));
SELECT pg_temp.check(pg_temp.thread_count(pg_temp.uid('task')) = 2, 'инженер видит и ответ координатора');
SELECT pg_temp.act_as_nobody();

-- Прямая запись в переписку закрыта: ответ создаёт только функция.
SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT pg_temp.expect_denied(
  format('INSERT INTO public.mail_replies (task_id, mail_message_id, thread_id, external_message_id, to_address, body) VALUES (%L, %L, %L, %L, %L, %L)',
         pg_temp.uid('task'), pg_temp.uid('letter'), '<client-1@mail.test>', '<hand@mail.test>', 'kdl@client.test', 'Руками'),
  'ответ руками в таблицу не вписать');
SELECT pg_temp.expect_denied(format('UPDATE public.mail_replies SET status = %L WHERE task_id = %L', 'sent', pg_temp.uid('task')),
  'статус отправки координатор не подменит');
SELECT pg_temp.act_as_nobody();

-- ---------------------------------------------------------------- Отправка ответа службой
SELECT pg_temp.check(
  (SELECT claimed.message_id ~ '^reply-[0-9a-f-]+@medtechservice$'
            AND claimed.in_reply_to = '<client-1@mail.test>'
            AND claimed.reference_ids = ARRAY['<client-1@mail.test>']
            AND claimed.to_address = 'kdl@client.test'
            AND claimed.task_number LIKE 'З-%'
     FROM public.claim_task_mail_replies(10) AS claimed),
  'служба получает ответ с заголовками цепочки и Message-ID без скобок');
SELECT pg_temp.check(
  (SELECT status = 'sending' AND attempts = 1 FROM public.mail_replies WHERE task_id = pg_temp.uid('task')),
  'взятый ответ отмечен до отправки: второй раз клиенту не уйдёт');
SELECT pg_temp.check((SELECT count(*) FROM public.claim_task_mail_replies(10)) = 0,
  'взятый ответ второй раз не выдаётся');
SELECT public.mark_task_mail_reply_sent((SELECT id FROM public.mail_replies WHERE task_id = pg_temp.uid('task')));
SELECT pg_temp.check(
  (SELECT status = 'sent' AND sent_at IS NOT NULL AND last_error IS NULL
     FROM public.mail_replies WHERE task_id = pg_temp.uid('task')),
  'отправленный ответ отмечен в переписке');

-- Ошибка отправки видна координатору текстом, а не тишиной.
SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT public.send_task_mail_reply(pg_temp.uid('task'), 'Второй ответ клиенту');
SELECT pg_temp.act_as_nobody();
SELECT public.fail_task_mail_reply(
  (SELECT id FROM public.claim_task_mail_replies(10)), 'smtp_connection_failed');
SELECT pg_temp.check(
  (SELECT count(*) FROM public.mail_replies WHERE task_id = pg_temp.uid('task') AND status = 'failed' AND last_error = 'smtp_connection_failed') = 1,
  'неудачная отправка остаётся с ошибкой');
SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT pg_temp.check(
  (SELECT count(*) FROM public.task_mail_thread(pg_temp.uid('task')) AS thread
    WHERE thread.direction = 'outgoing' AND thread.error = 'smtp_connection_failed') = 1,
  'ошибка отправки видна в карточке задачи');
SELECT pg_temp.act_as_nobody();

-- Второй ответ ссылается уже на всю цепочку: письмо клиента и первый наш ответ.
SELECT pg_temp.check(
  (SELECT array_length(reply.reference_ids, 1) = 2 AND reply.reference_ids[1] = '<client-1@mail.test>'
     FROM public.mail_replies AS reply WHERE reply.body = 'Второй ответ клиенту'),
  'References растёт вместе с перепиской');

-- ---------------------------------------------------------------- Ответ клиента попадает в задачу
SELECT pg_temp.check(
  (SELECT ingested.created AND ingested.is_reply AND ingested.thread_id = '<client-1@mail.test>' AND NOT ingested.needs_parse
     FROM public.ingest_mail_message(
       '<client-2@mail.test>',
       (SELECT external_message_id FROM public.mail_replies WHERE body = 'Второй ответ клиенту'),
       ARRAY['<client-1@mail.test>'],
       'kdl@client.test', 'Re: Ошибка температуры инкубатора', 'Спасибо, ждём в среду.',
       now() + interval '5 minutes') AS ingested),
  'ответ клиента на письмо из CRM ложится в цепочку задачи, а не в новые заявки');
SELECT pg_temp.check(
  (SELECT status = 'reply' AND task_id = pg_temp.uid('task')
     FROM public.mail_messages WHERE external_message_id = '<client-2@mail.test>'),
  'письмо цепочки привязано к задаче и не ждёт создания задачи');
SELECT pg_temp.check(
  NOT EXISTS (SELECT 1 FROM public.claim_mail_autoreplies(10) AS due
               WHERE due.external_message_id = '<client-2@mail.test>'),
  'по ответу клиента автоответ «заявка принята» второй раз не уходит');

-- Вложение ответа клиента служба тоже отдаёт задаче.
SELECT public.set_mail_attachments(
  (SELECT id FROM public.mail_messages WHERE external_message_id = '<client-2@mail.test>'),
  format('mail/%s/message.eml', (SELECT id FROM public.mail_messages WHERE external_message_id = '<client-2@mail.test>')),
  jsonb_build_array(jsonb_build_object(
    'storageKey', format('mail/%s/photo.jpg', (SELECT id FROM public.mail_messages WHERE external_message_id = '<client-2@mail.test>')),
    'fileName', 'после-ремонта.jpg', 'contentType', 'image/jpeg', 'byteSize', 120000)));
SELECT pg_temp.check(
  (SELECT count(*) FROM public.files AS f
     JOIN public.mail_messages AS m ON m.id = f.mail_message_id
    WHERE m.external_message_id = '<client-2@mail.test>' AND f.task_id = pg_temp.uid('task')) = 2,
  'вложения ответа клиента стали файлами задачи сами, без координатора');

SELECT pg_temp.act_as(pg_temp.uid('eng'));
SELECT pg_temp.check(pg_temp.thread_count(pg_temp.uid('task')) = 4, 'в карточке вся переписка: два письма и два ответа');
SELECT pg_temp.check(pg_temp.thread_text(pg_temp.uid('task')) LIKE 'incoming:%outgoing:%outgoing:%incoming:Спасибо%',
  'переписка идёт по времени, ответ клиента последним');
SELECT pg_temp.check(pg_temp.thread_files(pg_temp.uid('task')) LIKE '%после-ремонта.jpg%',
  'вложение ответа клиента видно в карточке');
SELECT pg_temp.act_as_nobody();

-- ---------------------------------------------------------------- Уведомления отправителю письма
SELECT pg_temp.check(pg_temp.email_to('task', 'task_engineer_assigned') LIKE '%kdl@client.test%',
  'назначение инженера уходит и отправителю письма');
SELECT pg_temp.check(pg_temp.email_to('task', 'task_engineer_assigned') LIKE '%eng@mail.test%',
  'инженер по-прежнему получает назначение');
SELECT pg_temp.check(
  (SELECT plan.recipient_name
     FROM public.integration_outbox AS event
     JOIN public.load_email_event_plan(event.id) AS plan ON true
    WHERE event.aggregate_id = pg_temp.uid('task') AND event.event_type = 'task_engineer_assigned'
      AND plan.recipient_address = 'kdl@client.test') = 'Воронина Светлана Анатольевна',
  'в письме отправителю стоит его имя из разбора письма');
-- О приёме заявки отправителю отвечает автоответ службы в его же письме (0017),
-- поэтому то же самое из шаблона второй раз не уходит.
SELECT pg_temp.check(pg_temp.email_to('task', 'task_application_accepted') NOT LIKE '%kdl@client.test%',
  'подтверждение приёма отправителю не дублируется: его отправил автоответ');

-- Адрес отправителя берётся из заголовка, мусор отбрасывается.
SELECT pg_temp.check(public.app_mail_address('Воронина С. А. <kdl@client.test>') = 'kdl@client.test',
  'адрес достаётся из «Имя <адрес>»');
SELECT pg_temp.check(public.app_mail_address('kdl@client.test') = 'kdl@client.test', 'простой адрес остаётся как есть');
SELECT pg_temp.check(public.app_mail_address('нет адреса') IS NULL, 'строка без адреса адресом не считается');
SELECT pg_temp.check(public.app_mail_address(NULL) IS NULL, 'пустой отправитель адресом не считается');

-- Тот же адрес у инициатора заявки из справочника «Клиенты»: письмо всё равно одно.
UPDATE public.tasks SET initiator_contact_id = pg_temp.uid('contact') WHERE id = pg_temp.uid('task');
SELECT pg_temp.check(
  (SELECT count(*) FROM public.integration_outbox AS event
     JOIN public.load_email_event_plan(event.id) AS plan ON true
    WHERE event.aggregate_id = pg_temp.uid('task') AND event.event_type = 'task_engineer_assigned'
      AND plan.recipient_address = 'kdl@client.test') = 1,
  'один адрес — одно письмо, даже если он и отправитель, и инициатор заявки');

-- ---------------------------------------------------------------- Переписка не для всех
-- Заказчику видна задача своей организации, кладовщику — пока есть резерв. Письмо
-- клиента и формулировки координатора им не нужны: переписку ведут по задачам.
SELECT pg_temp.act_as(pg_temp.uid('buyer'));
SELECT pg_temp.check(public.app_can_read_task(pg_temp.uid('task')), 'заказчику задача своей организации видна');
SELECT pg_temp.check(NOT public.app_can_read_task_mail(pg_temp.uid('task')), 'переписка заказчику не положена');
SELECT pg_temp.check(pg_temp.thread_count(pg_temp.uid('task')) = 0, 'заказчик переписки в карточке не видит');
SELECT pg_temp.check((SELECT count(*) FROM public.mail_replies) = 0, 'ответы координатора заказчику не видны');
SELECT pg_temp.check(NOT public.app_can_reply_task_mail(pg_temp.uid('task')), 'заказчик клиенту не отвечает');
SELECT pg_temp.act_as_nobody();

SELECT pg_temp.act_as(pg_temp.uid('store'));
SELECT pg_temp.check(public.app_can_read_task(pg_temp.uid('task')), 'кладовщику задача с резервом видна');
SELECT pg_temp.check(pg_temp.thread_count(pg_temp.uid('task')) = 0, 'кладовщик переписки не видит');
SELECT pg_temp.check((SELECT count(*) FROM public.mail_replies) = 0, 'ответы координатора кладовщику не видны');
SELECT pg_temp.act_as_nobody();

-- ---------------------------------------------------------------- Чужой адрес в цепочке
-- Message-ID письма уходит клиенту в заголовках. Кто его узнал, не должен попасть
-- в чужую задачу: его письмо остаётся обычной новой заявкой.
SELECT pg_temp.check(
  (SELECT NOT ingested.is_reply AND ingested.needs_parse
     FROM public.ingest_mail_message(
       '<evil-1@attacker.test>', '<client-1@mail.test>', ARRAY['<client-1@mail.test>'],
       'Злодей <evil@attacker.test>', 'Re: Ошибка температуры инкубатора',
       'Пришлите, пожалуйста, реквизиты для оплаты.', now() + interval '10 minutes') AS ingested),
  'письмо с чужого адреса в цепочку задачи не попадает');
SELECT pg_temp.check(
  (SELECT task_id IS NULL AND status = 'pending'
     FROM public.mail_messages WHERE external_message_id = '<evil-1@attacker.test>'),
  'такое письмо ждёт координатора как новая заявка');
SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT pg_temp.check(pg_temp.thread_text(pg_temp.uid('task')) NOT LIKE '%реквизиты%',
  'чужое письмо в карточке задачи не показывается');
SELECT pg_temp.check(
  (SELECT reply.to_address = 'kdl@client.test'
     FROM public.send_task_mail_reply(pg_temp.uid('task'), 'Проверка адреса ответа') AS reply),
  'ответ всё равно уходит клиенту, а не тому, кто подставил заголовок');
SELECT pg_temp.act_as_nobody();
SELECT pg_temp.check(pg_temp.email_to('task', 'task_engineer_assigned') NOT LIKE '%attacker%',
  'уведомления по задаче чужому адресу не уходят');

-- ---------------------------------------------------------------- Две задачи из одной переписки
-- Клиент дописал до создания задач, координатор сделал из переписки две задачи.
-- Карточки не должны показывать письма друг друга.
SELECT public.ingest_mail_message(
  '<client-3@mail.test>', '<client-1@mail.test>', ARRAY['<client-1@mail.test>'],
  'Воронина С. А. <kdl@client.test>', 'Re: Ошибка температуры инкубатора',
  'И ещё принтер не печатает протоколы.', now() + interval '20 minutes');
UPDATE public.mail_messages SET status = 'converted', task_id = pg_temp.uid('other_task')
 WHERE external_message_id = '<client-3@mail.test>';

SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT pg_temp.check(pg_temp.thread_text(pg_temp.uid('task')) NOT LIKE '%принтер%',
  'письмо второй задачи в карточке первой не показывается');
SELECT pg_temp.check(pg_temp.thread_text(pg_temp.uid('other_task')) LIKE '%принтер%',
  'своё письмо во второй задаче видно');
SELECT pg_temp.check(pg_temp.thread_text(pg_temp.uid('other_task')) NOT LIKE '%ошибку температуры%',
  'письмо первой задачи во вторую не попадает');
SELECT pg_temp.check(
  (SELECT reply.to_address = 'kdl@client.test' AND reply.subject = 'Re: Ошибка температуры инкубатора'
     FROM public.send_task_mail_reply(pg_temp.uid('other_task'), 'По принтеру приедем тем же выездом') AS reply),
  'ответ по второй задаче привязан к её письму');
SELECT pg_temp.act_as_nobody();
SELECT pg_temp.check(
  (SELECT reply.mail_message_id = (SELECT id FROM public.mail_messages WHERE external_message_id = '<client-3@mail.test>')
     FROM public.mail_replies AS reply WHERE reply.body = 'По принтеру приедем тем же выездом'),
  'в ответ подставлено письмо своей задачи');
SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT pg_temp.check(
  (SELECT thread.id = (SELECT id FROM public.mail_messages WHERE external_message_id = '<client-3@mail.test>')
     FROM public.task_mail_thread(pg_temp.uid('other_task')) AS thread WHERE thread.direction = 'incoming'),
  'во второй задаче ровно её письмо');
SELECT pg_temp.act_as_nobody();

-- ---------------------------------------------------------------- Ответ на автоответ
-- Автоответ «заявка принята» уходит с Message-ID <autoreply-<id письма>@medtechservice>
-- и в базе не хранится. Ответ клиента на него всё равно должен попасть в задачу.
SELECT pg_temp.check(
  (SELECT ingested.is_reply
     FROM public.ingest_mail_message(
       '<client-4@mail.test>',
       format('<autoreply-%s@medtechservice>', pg_temp.uid('letter')),
       ARRAY[]::text[], 'kdl@client.test', 'Re: Заявка принята',
       'Спасибо, ждём инженера.', now() + interval '30 minutes') AS ingested),
  'ответ клиента на автоответ попадает в задачу, а не в новые заявки');
SELECT pg_temp.check(
  (SELECT task_id = pg_temp.uid('task') AND status = 'reply'
     FROM public.mail_messages WHERE external_message_id = '<client-4@mail.test>'),
  'такое письмо привязано к задаче автоответа');

-- ---------------------------------------------------------------- Очередь ответов не теряется
-- Временный сбой почты: ответ возвращается в очередь и уйдёт следующим проходом.
SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT public.send_task_mail_reply(pg_temp.uid('task'), 'Ответ с временным сбоем');
SELECT pg_temp.act_as_nobody();
SELECT public.fail_task_mail_reply(
  (SELECT id FROM public.claim_task_mail_replies(10) AS due
    WHERE due.body = 'Ответ с временным сбоем'), 'smtp_connection_failed', true);
SELECT pg_temp.check(
  (SELECT status = 'queued' AND attempts = 1 AND last_error = 'smtp_connection_failed'
     FROM public.mail_replies WHERE body = 'Ответ с временным сбоем'),
  'временный сбой почты возвращает ответ в очередь');
SELECT pg_temp.check(
  (SELECT count(*) FROM public.claim_task_mail_replies(10) AS due WHERE due.body = 'Ответ с временным сбоем') = 1,
  'следующий проход службы берёт его снова');
UPDATE public.mail_replies SET attempts = 5 WHERE body = 'Ответ с временным сбоем';
SELECT public.fail_task_mail_reply(
  (SELECT id FROM public.mail_replies WHERE body = 'Ответ с временным сбоем'), 'smtp_connection_failed', true);
SELECT pg_temp.check(
  (SELECT status = 'failed' FROM public.mail_replies WHERE body = 'Ответ с временным сбоем'),
  'после пяти попыток ответ больше не повторяется, координатор видит отказ');

-- Служба остановилась между взятием ответа и отметкой: ответ не висит «отправляется» вечно.
SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT public.send_task_mail_reply(pg_temp.uid('task'), 'Ответ на зависшей отправке');
SELECT pg_temp.act_as_nobody();
SELECT (SELECT count(*) FROM public.claim_task_mail_replies(10) AS due WHERE due.body = 'Ответ на зависшей отправке');
UPDATE public.mail_replies SET claimed_at = now() - interval '20 minutes' WHERE body = 'Ответ на зависшей отправке';
SELECT public.expire_stuck_task_mail_replies();
SELECT pg_temp.check(
  (SELECT status = 'failed' AND last_error = 'notification_delivery_lease_expired'
     FROM public.mail_replies WHERE body = 'Ответ на зависшей отправке'),
  'зависшая отправка помечается прерванной, повторно письмо не уходит');

-- ---------------------------------------------------------------- Задачи из писем до 0041
-- У них вложения лежат копией в папке задачи: в карточке они не должны двоиться.
INSERT INTO public.files (kind, task_id, mail_message_id, storage_key, original_name, content_type, byte_size, is_financial)
VALUES ('mail_attachment', pg_temp.uid('other_task'),
        (SELECT id FROM public.mail_messages WHERE external_message_id = '<client-3@mail.test>'),
        format('tasks/%s/kopiya.jpg', pg_temp.uid('other_task')), 'скан-принтера.jpg', 'image/jpeg', 1000, false);
UPDATE public.mail_messages
   SET attachments = jsonb_build_array(jsonb_build_object(
         'storageKey', format('mail/%s/kopiya.jpg', id),
         'fileName', 'скан-принтера.jpg', 'contentType', 'image/jpeg', 'byteSize', 1000))
 WHERE external_message_id = '<client-3@mail.test>';
SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT pg_temp.check(pg_temp.thread_files(pg_temp.uid('other_task')) = 'скан-принтера.jpg',
  'у старой задачи вложение письма показано один раз, копией из папки задачи');
SELECT pg_temp.act_as_nobody();

-- ---------------------------------------------------------------- Права на функции
SELECT pg_temp.check(has_function_privilege('authenticated', 'public.task_mail_thread(uuid)', 'execute'),
  'переписку читает вошедший сотрудник (права проверяет сама функция)');
SELECT pg_temp.check(NOT has_function_privilege('anon', 'public.task_mail_thread(uuid)', 'execute'),
  'без входа переписку не прочитать');
SELECT pg_temp.check(NOT has_function_privilege('anon', 'public.send_task_mail_reply(uuid, text)', 'execute'),
  'без входа ответ не отправить');
SELECT pg_temp.check(has_function_privilege('medtech_worker', 'public.claim_task_mail_replies(integer)', 'execute'),
  'очередь ответов забирает служба');
SELECT pg_temp.check(NOT has_function_privilege('authenticated', 'public.claim_task_mail_replies(integer)', 'execute'),
  'очередь ответов сотруднику не доступна');
SELECT pg_temp.check(NOT has_function_privilege('authenticated', 'public.mark_task_mail_reply_sent(uuid)', 'execute'),
  'отметку об отправке ставит только служба');
SELECT pg_temp.check(NOT has_function_privilege('anon', 'public.attach_mail_files_to_task(uuid, uuid)', 'execute'),
  'без входа вложения письма не перенести');
SELECT pg_temp.check(has_function_privilege('authenticated', 'public.app_can_read_task_mail(uuid)', 'execute'),
  'право на переписку сотрудник может спросить у базы');
SELECT pg_temp.check(NOT has_function_privilege('authenticated', 'public.mail_attachment_list(uuid, uuid, jsonb, boolean)', 'execute'),
  'список вложений собирает только база');
SELECT pg_temp.check(NOT has_function_privilege('authenticated', 'public.expire_stuck_task_mail_replies()', 'execute'),
  'зависшие отправки разбирает только служба');

ROLLBACK;
