-- Приём ответов клиента в цепочку задачи и очередь ответов координатора.
--
-- Что было не так. Цепочку (0017) база искала только среди входящих писем, а наших
-- ответов в базе не было вовсе. Поэтому ответ клиента на письмо из CRM начинал новую
-- цепочку и ложился в раздел «Письма» как новая заявка: координатор видел «создать
-- задачу» вместо продолжения переписки по уже открытой.
--
-- Что делаем.
--   1. Статус письма «reply»: письмо попало в цепочку уже созданной задачи. Такое письмо
--      не разбирается как заявка, автоответ «заявка принята» по нему не уходит (он уже
--      уходил по первому письму), а в карточке задачи оно видно следующим сообщением.
--   2. ingest_mail_message ищет цепочку и среди наших ответов (mail_replies) и сразу
--      привязывает письмо к задаче цепочки.
--   3. set_mail_attachments переносит вложения такого письма в файлы задачи.
--   4. Очередь ответов для службы: claim_task_mail_replies, mark_task_mail_reply_sent,
--      fail_task_mail_reply. Отметка о попытке ставится до отправки, поэтому один ответ
--      уходит клиенту не больше одного раза.
--
-- Разбор письма нейросетью и настройки ящика здесь не меняются.

ALTER TABLE public.mail_messages
  DROP CONSTRAINT IF EXISTS mail_messages_status_check;
ALTER TABLE public.mail_messages
  ADD CONSTRAINT mail_messages_status_check
  CHECK (status IN ('pending', 'parsed', 'converted', 'ignored', 'failed', 'reply'));

-- ---------------------------------------------------------------------------
-- 1. Письмо в очередь: цепочка, задача, разбор
-- ---------------------------------------------------------------------------

-- Письмо в очередь. Дубль (тот же Message-ID) не создаётся. Ответ в цепочке получает
-- thread_id исходного письма, а если по цепочке уже есть задача — ещё и её номер и
-- статус «reply»: это продолжение переписки, а не новая заявка.
-- needs_parse: письмо новое или прошлый разбор оборвался (сбой базы, остановка службы),
-- его нужно разобрать заново; has_files: файлы письма уже в хранилище;
-- is_reply: письмо легло в цепочку задачи, разбирать его как заявку не нужно.
DROP FUNCTION IF EXISTS public.ingest_mail_message(text, text, text[], text, text, text, timestamptz);
CREATE FUNCTION public.ingest_mail_message(
  p_external_message_id text,
  p_in_reply_to text,
  p_references text[],
  p_sender text,
  p_subject text,
  p_body text,
  p_received_at timestamptz
)
RETURNS TABLE(id uuid, created boolean, thread_id text, needs_parse boolean, has_files boolean, is_reply boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  existing_id uuid;
  existing_pending boolean;
  existing_files boolean;
  existing_reply boolean;
  parent_thread text;
  known_ids text[] := coalesce(p_references, ARRAY[]::text[]) || coalesce(p_in_reply_to, '');
  -- Автоответ «заявка принята» служба отправляет с Message-ID вида
  -- <autoreply-<id письма>@medtechservice> (0017) и в базе его не хранит. Клиенту
  -- в этом письме написано «ответьте на него», поэтому его id разбираем обратно:
  -- иначе ответ клиента начал бы новую заявку.
  known_autoreplies uuid[] := ARRAY(
    SELECT (substring(known_id from '^<autoreply-([0-9a-f-]{36})@medtechservice>$'))::uuid
      FROM unnest(known_ids) AS known_id
     WHERE known_id ~ '^<autoreply-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@medtechservice>$'
  );
  sender_address text := public.app_mail_address(p_sender);
  thread_task uuid;
  new_id uuid;
  new_thread text;
BEGIN
  IF nullif(btrim(coalesce(p_external_message_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'У письма нет Message-ID' USING ERRCODE = '23514';
  END IF;
  SELECT m.id, m.thread_id, (m.status = 'pending' AND m.parsed_at IS NULL),
         m.raw_storage_key IS NOT NULL, m.status = 'reply'
    INTO existing_id, new_thread, existing_pending, existing_files, existing_reply
    FROM public.mail_messages AS m WHERE m.external_message_id = p_external_message_id;
  IF existing_id IS NOT NULL THEN
    RETURN QUERY SELECT existing_id, false, new_thread, existing_pending, existing_files, existing_reply;
    RETURN;
  END IF;
  -- Цепочка: ищем известное письмо, наш ответ или автоответ среди In-Reply-To и References.
  SELECT step.thread INTO parent_thread FROM (
    SELECT coalesce(m.thread_id, m.external_message_id) AS thread, m.received_at AS at
      FROM public.mail_messages AS m
     WHERE m.external_message_id = ANY (known_ids)
        OR m.id = ANY (known_autoreplies)
    UNION ALL
    SELECT r.thread_id, r.created_at
      FROM public.mail_replies AS r
     WHERE r.external_message_id = ANY (known_ids)
  ) AS step
   ORDER BY step.at
   LIMIT 1;
  new_thread := coalesce(parent_thread, p_external_message_id);
  -- Задача цепочки: по ней письмо и попадёт в карточку, а не в заявки. Только если
  -- письмо пришло с того же адреса, что и заявка: Message-ID уходит клиенту в заголовках,
  -- и посторонний, подставив его в In-Reply-To, иначе попал бы в чужую задачу —
  -- получал бы по ней уведомления и забирал себе ответы координатора.
  -- Письмо с другого адреса остаётся обычной новой заявкой, её разбирает координатор.
  IF parent_thread IS NOT NULL AND sender_address IS NOT NULL THEN
    SELECT m.task_id INTO thread_task
      FROM public.mail_messages AS m
     WHERE coalesce(m.thread_id, m.external_message_id) = parent_thread
       AND m.task_id IS NOT NULL
       AND public.app_mail_address(m.sender) = sender_address
     ORDER BY m.received_at
     LIMIT 1;
  END IF;
  INSERT INTO public.mail_messages (
    external_message_id, thread_id, in_reply_to, sender, subject, body, received_at,
    status, task_id, parsed_at, autoreply_sent_at
  )
  VALUES (
    p_external_message_id, new_thread, p_in_reply_to, btrim(p_sender), coalesce(p_subject, ''),
    coalesce(p_body, ''), coalesce(p_received_at, now()),
    CASE WHEN thread_task IS NULL THEN 'pending' ELSE 'reply' END,
    thread_task,
    -- Письмо цепочки не разбирается как заявка: отметка о разборе ставится сразу.
    CASE WHEN thread_task IS NULL THEN NULL ELSE now() END,
    -- Автоответ «заявка принята» по этой цепочке уже уходил: второй раз не нужен.
    CASE WHEN thread_task IS NULL THEN NULL ELSE now() END
  )
  ON CONFLICT (external_message_id) DO NOTHING
  RETURNING mail_messages.id INTO new_id;
  IF new_id IS NULL THEN
    -- Письмо одновременно вставила другая копия службы: она его и разберёт.
    SELECT m.id INTO new_id FROM public.mail_messages AS m WHERE m.external_message_id = p_external_message_id;
    RETURN QUERY SELECT new_id, false, new_thread, false, false, thread_task IS NOT NULL;
    RETURN;
  END IF;
  RETURN QUERY SELECT new_id, true, new_thread, thread_task IS NULL, false, thread_task IS NOT NULL;
END
$$;

-- Файлы письма в хранилище. Если письмо уже относится к задаче (ответ клиента),
-- вложения сразу становятся файлами задачи: координатор и инженер открывают их
-- из карточки, как остальные файлы.
CREATE OR REPLACE FUNCTION public.set_mail_attachments(p_id uuid, p_raw_storage_key text, p_attachments jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  linked_task uuid;
BEGIN
  UPDATE public.mail_messages
     SET raw_storage_key = p_raw_storage_key,
         attachments = coalesce(p_attachments, '[]'::jsonb)
   WHERE id = p_id
  RETURNING task_id INTO linked_task;
  IF linked_task IS NOT NULL THEN
    PERFORM public.attach_mail_files_to_task(p_id, linked_task);
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Очередь ответов координатора для службы
-- ---------------------------------------------------------------------------

-- Ответы, готовые к отправке. Попытка отмечается до отправки (status = 'sending'),
-- поэтому даже при сбое SMTP клиент не получит два одинаковых письма.
-- message_id и заголовки цепочки отдаются готовыми: In-Reply-To — письмо клиента,
-- References — вся переписка по порядку.
-- Служба могла остановиться между взятием ответа и отметкой об отправке: такой
-- ответ навсегда остался бы «отправляется». Через 15 минут помечаем его неудачным
-- тем же кодом, что и прерванную доставку уведомления: повторять нельзя (письмо
-- могло уйти), но координатор видит, что ответ завис, и может написать заново.
CREATE OR REPLACE FUNCTION public.expire_stuck_task_mail_replies()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.mail_replies
     SET status = 'failed', last_error = 'notification_delivery_lease_expired'
   WHERE status = 'sending' AND coalesce(claimed_at, created_at) < now() - interval '15 minutes';
$$;

CREATE OR REPLACE FUNCTION public.claim_task_mail_replies(p_limit integer)
RETURNS TABLE(
  id uuid,
  to_address text,
  subject text,
  body text,
  message_id text,
  in_reply_to text,
  reference_ids text[],
  task_number text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.expire_stuck_task_mail_replies();
  WITH due AS (
    SELECT r.id
      FROM public.mail_replies AS r
     WHERE r.status = 'queued'
     ORDER BY r.created_at
     LIMIT least(greatest(coalesce(p_limit, 1), 1), 100)
     FOR UPDATE OF r SKIP LOCKED
  ), claimed AS (
    UPDATE public.mail_replies AS r
       SET status = 'sending', attempts = r.attempts + 1, claimed_at = now()
      FROM due
     WHERE r.id = due.id
    RETURNING r.id, r.to_address, r.subject, r.body, r.external_message_id, r.in_reply_to,
              r.reference_ids, r.task_id
  )
  SELECT c.id, c.to_address, c.subject, c.body,
         btrim(c.external_message_id, '<>'), c.in_reply_to, c.reference_ids, t.number
    FROM claimed AS c
    LEFT JOIN public.tasks AS t ON t.id = c.task_id;
$$;

CREATE OR REPLACE FUNCTION public.mark_task_mail_reply_sent(p_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.mail_replies
     SET status = 'sent', sent_at = now(), last_error = NULL
   WHERE id = p_id AND status = 'sending';
$$;

-- Неудачная отправка. Временный сбой (почтовый сервер недоступен, 4xx) — p_retry:
-- ответ возвращается в очередь и уходит следующим проходом, но не больше пяти раз.
-- Остальное терминально: текст набрал человек, и писать его заново — его решение,
-- а не молчание службы.
DROP FUNCTION IF EXISTS public.fail_task_mail_reply(uuid, text);
CREATE FUNCTION public.fail_task_mail_reply(p_id uuid, p_error text, p_retry boolean DEFAULT false)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.mail_replies
     SET status = CASE WHEN coalesce(p_retry, false) AND attempts < 5 THEN 'queued' ELSE 'failed' END,
         last_error = left(coalesce(p_error, 'reply_failed'), 200)
   WHERE id = p_id AND status IN ('queued', 'sending');
$$;

DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.ingest_mail_message(text, text, text[], text, text, text, timestamptz)',
    'public.set_mail_attachments(uuid, text, jsonb)',
    'public.claim_task_mail_replies(integer)',
    'public.expire_stuck_task_mail_replies()',
    'public.mark_task_mail_reply_sent(uuid)',
    'public.fail_task_mail_reply(uuid, text, boolean)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO medtech_worker', fn);
  END LOOP;
END
$$;

NOTIFY pgrst, 'reload schema';
