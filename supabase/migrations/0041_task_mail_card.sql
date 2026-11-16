-- Письмо клиента в карточке задачи: переписка, вложения как файлы задачи и ответ из карточки.
--
-- Что было не так. С 0017 письмо из ящика превращается в задачу, но в самой задаче
-- от письма оставался только перенос вложений: ни текста клиента, ни цепочки, ни способа
-- ответить. Координатор уходил читать письмо в раздел «Письма» (а инженер его вообще не
-- видел), а отвечал из своей почтовой программы — ответ в CRM не попадал.
--
-- Что делаем здесь.
--   1. files.mail_message_id — какому письму принадлежит файл задачи. По нему карточка
--      показывает вложения рядом с письмом, а права остаются правами файлов задачи.
--   2. mail_replies — ответы координатора по задаче. Пишет их только функция
--      send_task_mail_reply, отправляет служба (0042), видит тот, кто видит задачу.
--   3. attach_mail_files_to_task — вложения письма становятся файлами задачи без копии
--      в хранилище: файл остаётся по ключу mail/<письмо>/…, а доступ к нему теперь даёт
--      строка files, то есть право на задачу (и finance.read для финансовых файлов).
--   4. task_mail_thread — вся цепочка для карточки задачи одним запросом.
--
-- Отправка писем, разбор ИИ и настройки почты здесь не меняются.

-- ---------------------------------------------------------------------------
-- 1. Файл задачи знает своё письмо
-- ---------------------------------------------------------------------------

ALTER TABLE public.files
  ADD COLUMN IF NOT EXISTS mail_message_id uuid REFERENCES public.mail_messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS files_mail_message_idx
  ON public.files (mail_message_id)
  WHERE mail_message_id IS NOT NULL;

-- Задачи, созданные из писем до этой миграции: вложения у них уже перенесены,
-- но без связи с письмом. Связываем их с письмом задачи (у задачи оно одно:
-- ответы клиента приходят в ту же цепочку и получают task_id той же задачи).
UPDATE public.files AS f
   SET mail_message_id = first_letter.id
  FROM (
    SELECT DISTINCT ON (m.task_id) m.task_id, m.id
      FROM public.mail_messages AS m
     WHERE m.task_id IS NOT NULL
     ORDER BY m.task_id, m.received_at
  ) AS first_letter
 WHERE f.kind = 'mail_attachment'
   AND f.mail_message_id IS NULL
   AND f.task_id = first_letter.task_id;

-- ---------------------------------------------------------------------------
-- 2. Адрес из заголовка письма
-- ---------------------------------------------------------------------------

-- Отправитель приходит и как «user@example.org», и как «Имя <user@example.org>».
-- Отвечаем только на то, что похоже на адрес; иначе NULL, и ответ не создаётся.
CREATE OR REPLACE FUNCTION public.app_mail_address(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN candidate ~ '^[^[:space:]<>@]+@[^[:space:]<>@]+[.][^[:space:]<>@]+$' THEN candidate
  END
  FROM (
    SELECT btrim(coalesce(substring(coalesce(p_value, '') from '<([^<>]+)>'), p_value, '')) AS candidate
  ) AS extracted
$$;

REVOKE ALL ON FUNCTION public.app_mail_address(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.app_mail_address(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_mail_address(text) TO medtech_api, medtech_worker;

-- ---------------------------------------------------------------------------
-- 3. Ответы координатора по задаче
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.mail_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  -- Письмо, на которое отвечаем: из него берутся адрес, тема и заголовки цепочки.
  mail_message_id uuid NOT NULL REFERENCES public.mail_messages(id) ON DELETE CASCADE,
  thread_id text NOT NULL CHECK (btrim(thread_id) <> ''),
  -- Message-ID нашего ответа, со скобками: по нему ответ клиента попадёт в ту же цепочку.
  external_message_id text NOT NULL UNIQUE CHECK (external_message_id ~ '^<[^<>[:space:]]{1,250}>$'),
  in_reply_to text,
  -- Вся цепочка для заголовка References, по порядку.
  reference_ids text[] NOT NULL DEFAULT '{}'::text[],
  -- Тот же вид адреса, что проверяет app_mail_address: в очередь не попадёт строка,
  -- из которой SMTP не сможет собрать получателя.
  to_address text NOT NULL CHECK (to_address ~ '^[^[:space:]<>@]+@[^[:space:]<>@]+[.][^[:space:]<>@]+$'),
  subject text NOT NULL DEFAULT '',
  body text NOT NULL CHECK (btrim(body) <> '' AND char_length(body) <= 20000),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  author_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Когда служба взяла ответ в работу: по этой отметке видно зависшую отправку.
  claimed_at timestamptz,
  sent_at timestamptz
);

CREATE INDEX IF NOT EXISTS mail_replies_task_idx ON public.mail_replies (task_id, created_at);
CREATE INDEX IF NOT EXISTS mail_replies_queue_idx ON public.mail_replies (status, created_at) WHERE status = 'queued';

ALTER TABLE public.mail_replies ENABLE ROW LEVEL SECURITY;

-- Переписку по задаче видят те, кто её ведёт: координатор и руководитель (почта
-- и так их работа) и инженер этой задачи — ему нужно знать, что пообещали клиенту.
-- Заказчику (своя организация) и кладовщику (пока есть резерв) задача видна, но
-- переписка с клиентом и формулировки координатора — нет.
CREATE OR REPLACE FUNCTION public.app_can_read_task_mail(p_task_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT public.app_can_read_task(p_task_id)
     AND (
       public.app_has_any_permission(ARRAY['tasks.read_all', 'tasks.assign'])
       OR EXISTS (
            SELECT 1 FROM public.tasks AS t
             WHERE t.id = p_task_id AND t.engineer_id = auth.uid() AND auth.uid() IS NOT NULL
          )
     );
$$;

REVOKE ALL ON FUNCTION public.app_can_read_task_mail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.app_can_read_task_mail(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_can_read_task_mail(uuid) TO medtech_api;

-- Писать и удалять ответы через API нельзя: ответ создаёт только send_task_mail_reply,
-- статус меняет только служба.
DROP POLICY IF EXISTS role_read ON public.mail_replies;
CREATE POLICY role_read ON public.mail_replies FOR SELECT TO authenticated
  USING (public.app_can_read_task_mail(task_id));

REVOKE ALL ON TABLE public.mail_replies FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.mail_replies TO authenticated;
GRANT SELECT ON TABLE public.mail_replies TO medtech_api;
GRANT SELECT ON TABLE public.mail_replies TO medtech_backup;

-- Переписка с клиентом — деловая запись: кто и что написал, видно в аудите.
DROP TRIGGER IF EXISTS audit_mail_replies ON public.mail_replies;
CREATE TRIGGER audit_mail_replies
  AFTER INSERT OR UPDATE OR DELETE ON public.mail_replies
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_row();

-- ---------------------------------------------------------------------------
-- 4. Вложения письма — файлы задачи
-- ---------------------------------------------------------------------------

-- Письмо и вложения лежат в хранилище по ключу mail/<письмо>/…; здесь на них
-- появляются строки files с task_id. Копии в папку задачи не делаем: доступ
-- к объекту mail/… даёт та же строка files (см. app_storage_object_access ниже),
-- поэтому вложение открывается и скачивается как обычный файл задачи.
-- Возвращает число файлов письма, связанных с задачей.
CREATE OR REPLACE FUNCTION public.attach_mail_files_to_task(p_mail_id uuid, p_task_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  letter public.mail_messages;
  item jsonb;
  linked integer := 0;
BEGIN
  SELECT * INTO letter FROM public.mail_messages WHERE id = p_mail_id;
  IF letter.id IS NULL THEN
    RAISE EXCEPTION 'Письмо не найдено' USING ERRCODE = '23503';
  END IF;
  -- Только письмо этой задачи: чужое письмо в свою задачу не перетащить, даже
  -- зная его номер. Задачу письму ставит разбор почты (ответ клиента) или
  -- координатор, когда создаёт задачу из письма.
  IF letter.task_id IS DISTINCT FROM p_task_id THEN
    RAISE EXCEPTION 'Письмо относится к другой задаче' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tasks WHERE id = p_task_id) THEN
    RAISE EXCEPTION 'Задача не найдена' USING ERRCODE = '23503';
  END IF;
  -- Служба (своя роль, без входа) переносит вложения ответов клиента сама; всё,
  -- что пришло через API, проходит проверку прав на задачу. Смотрим не только
  -- auth.uid(): токен без sub не должен попадать в ветку службы (внутри функции
  -- с правами владельца current_user — владелец схемы, по нему вызов не отличить).
  IF auth.uid() IS NOT NULL OR nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL THEN
    IF NOT public.app_can_write_task(p_task_id) THEN
      RAISE EXCEPTION 'Недостаточно прав: вложения письма переносит координатор задачи'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  FOR item IN
    SELECT value FROM jsonb_array_elements(
      CASE WHEN letter.raw_storage_key IS NULL THEN '[]'::jsonb
           ELSE jsonb_build_array(jsonb_build_object(
             'storageKey', letter.raw_storage_key,
             'fileName', 'Письмо клиента.eml',
             'contentType', 'message/rfc822',
             'byteSize', 0))
      END || coalesce(letter.attachments, '[]'::jsonb))
  LOOP
    CONTINUE WHEN nullif(btrim(coalesce(item ->> 'storageKey', '')), '') IS NULL;
    BEGIN
      INSERT INTO public.files (
        kind, task_id, mail_message_id, storage_key, original_name, content_type, byte_size,
        uploaded_by, is_financial
      ) VALUES (
        'mail_attachment', p_task_id, p_mail_id, item ->> 'storageKey',
        left(coalesce(nullif(btrim(item ->> 'fileName'), ''), 'вложение'), 200),
        coalesce(nullif(btrim(item ->> 'contentType'), ''), 'application/octet-stream'),
        greatest(1, CASE WHEN item ->> 'byteSize' ~ '^[0-9]+$' THEN (item ->> 'byteSize')::bigint ELSE 1 END),
        auth.uid(), false
      )
      ON CONFLICT (storage_key) DO NOTHING;
    EXCEPTION WHEN insufficient_privilege OR unique_violation THEN
      -- Задача уже закрыта (файлы закрытой задачи не трогают) или файл уже привязан:
      -- остальные вложения всё равно переносим, письмо в карточке от этого не теряется.
      NULL;
    END;
  END LOOP;
  -- Считаем, сколько файлов письма в задаче сейчас, а не сколько добавил этот вызов:
  -- повторный вызов (повтор запроса из браузера) не должен выглядеть как потеря файлов.
  SELECT count(*) INTO linked
    FROM public.files AS f
   WHERE f.mail_message_id = p_mail_id AND f.task_id = p_task_id;
  RETURN linked;
END
$$;

REVOKE ALL ON FUNCTION public.attach_mail_files_to_task(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attach_mail_files_to_task(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attach_mail_files_to_task(uuid, uuid) TO medtech_api, medtech_worker;

-- ---------------------------------------------------------------------------
-- 5. Доступ к объектам письма в хранилище
-- ---------------------------------------------------------------------------

-- Было (0017): папку mail/ читают только те, кто разбирает почту. Теперь вложение,
-- перенесённое в задачу, читает и тот, кому задача доступна: правило то же, что у
-- файлов задачи, включая запрет на финансовые файлы без finance.read.
CREATE OR REPLACE FUNCTION public.app_storage_object_access(p_name text, p_write boolean)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  first_part text := split_part(coalesce(p_name, ''), '/', 1);
  target_id uuid;
BEGIN
  IF first_part = 'mail' THEN
    IF p_write THEN
      RETURN false;
    END IF;
    IF public.app_has_any_permission(ARRAY['tasks.read_all', 'tasks.assign']) THEN
      RETURN true;
    END IF;
    RETURN EXISTS (
      SELECT 1 FROM public.files AS f
       WHERE f.storage_key = p_name
         AND f.task_id IS NOT NULL
         AND public.app_can_read_task(f.task_id)
         AND (NOT f.is_financial OR public.app_has_permission('finance.read'))
    );
  END IF;
  IF NOT p_write
     AND EXISTS (SELECT 1 FROM public.files AS f WHERE f.storage_key = p_name AND f.is_financial)
     AND NOT public.app_has_permission('finance.read') THEN
    RETURN false;
  END IF;
  IF first_part = 'tasks' THEN
    BEGIN
      target_id := split_part(p_name, '/', 2)::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN false;
    END;
    RETURN CASE WHEN p_write THEN public.app_can_write_task(target_id) ELSE public.app_can_read_task(target_id) END;
  END IF;
  BEGIN
    target_id := first_part::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN false;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.equipment WHERE id = target_id) THEN
    RETURN false;
  END IF;
  RETURN CASE WHEN p_write THEN public.app_can_write_equipment() ELSE public.app_can_read_equipment() END;
END
$$;

-- ---------------------------------------------------------------------------
-- 6. Цепочка письма для карточки задачи
-- ---------------------------------------------------------------------------

-- Вложения одного письма: имя, тип, размер, ключ в хранилище и id файла задачи,
-- если вложение уже перенесено. Финансовый файл без finance.read не отдаётся.
CREATE OR REPLACE FUNCTION public.mail_attachment_list(p_mail_id uuid, p_task_id uuid, p_attachments jsonb, p_finance boolean)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH linked AS (
    SELECT f.id, f.original_name AS file_name, f.content_type, f.byte_size, f.storage_key
      FROM public.files AS f
     WHERE f.mail_message_id = p_mail_id
       AND f.task_id = p_task_id
       AND (NOT f.is_financial OR coalesce(p_finance, false))
  ), listed AS (
    SELECT nullif(btrim(coalesce(a.value ->> 'storageKey', '')), '') AS storage_key,
           coalesce(nullif(btrim(a.value ->> 'fileName'), ''), 'вложение') AS file_name,
           coalesce(nullif(btrim(a.value ->> 'contentType'), ''), 'application/octet-stream') AS content_type,
           CASE WHEN a.value ->> 'byteSize' ~ '^[0-9]+$' THEN (a.value ->> 'byteSize')::bigint ELSE 0 END AS byte_size
      FROM jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) AS a
  ), merged AS (
    SELECT linked.id, linked.file_name, linked.content_type, linked.byte_size, linked.storage_key FROM linked
    UNION ALL
    -- Вложение, которое ещё не стало файлом задачи (например, письмо пришло в закрытую
    -- задачу): показываем его имя, а открыть сможет тот, кто разбирает почту.
    -- Если файлы письма в задаче уже есть, список берём только из них: у задач,
    -- созданных до этой миграции, файлы лежат копией в папке задачи, и вложения
    -- письма иначе показались бы дважды, причём вторая плитка не открывалась бы.
    SELECT NULL::uuid, listed.file_name, listed.content_type, listed.byte_size, listed.storage_key
      FROM listed
     WHERE listed.storage_key IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM linked)
       AND NOT EXISTS (SELECT 1 FROM public.files AS f WHERE f.storage_key = listed.storage_key)
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'fileId', merged.id,
           'fileName', merged.file_name,
           'contentType', merged.content_type,
           'byteSize', merged.byte_size,
           'storageKey', merged.storage_key
         ) ORDER BY merged.file_name), '[]'::jsonb)
    FROM merged
$$;

REVOKE ALL ON FUNCTION public.mail_attachment_list(uuid, uuid, jsonb, boolean) FROM PUBLIC, anon, authenticated;
DROP FUNCTION IF EXISTS public.mail_attachment_list(uuid, jsonb, boolean);

-- Вся переписка по задаче по порядку: письма клиента и наши ответы.
-- Кроме писем самой задачи берём письма той же цепочки, по которым задачи ещё нет
-- (клиент дописал до того, как задачу создали) и только от того же отправителя.
-- Письмо, по которому создана другая задача, в чужую карточку не попадает:
-- из одной цепочки координатор мог сделать две задачи, и это разные работы.
CREATE OR REPLACE FUNCTION public.task_mail_thread(p_task_id uuid)
RETURNS TABLE(
  id uuid,
  direction text,
  author text,
  recipient text,
  subject text,
  body text,
  occurred_at timestamptz,
  status text,
  error text,
  attachments jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  finance boolean := public.app_has_permission('finance.read');
BEGIN
  IF NOT public.app_can_read_task(p_task_id) THEN
    RAISE EXCEPTION 'Недостаточно прав: задача недоступна' USING ERRCODE = '42501';
  END IF;
  -- Задача видна, а переписка с клиентом — нет (заказчик, кладовщик): отдаём пусто,
  -- и вкладки с письмом в карточке просто не будет.
  IF NOT public.app_can_read_task_mail(p_task_id) THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH own AS (
    SELECT coalesce(m.thread_id, m.external_message_id) AS thread,
           public.app_mail_address(m.sender) AS address
      FROM public.mail_messages AS m
     WHERE m.task_id = p_task_id
  )
  SELECT letter.id, 'incoming'::text, letter.sender, NULL::text, letter.subject, letter.body,
         letter.received_at, letter.status, NULL::text,
         public.mail_attachment_list(letter.id, p_task_id, letter.attachments, finance)
    FROM public.mail_messages AS letter
   WHERE letter.task_id = p_task_id
      OR (letter.task_id IS NULL
          AND EXISTS (
                SELECT 1 FROM own
                 WHERE own.thread = coalesce(letter.thread_id, letter.external_message_id)
                   AND own.address IS NOT NULL
                   AND own.address = public.app_mail_address(letter.sender)
              ))
  UNION ALL
  SELECT reply.id, 'outgoing'::text, coalesce(author.full_name, 'Сотрудник МедТехСервиса'),
         reply.to_address, reply.subject, reply.body, reply.created_at, reply.status,
         reply.last_error, '[]'::jsonb
    FROM public.mail_replies AS reply
    LEFT JOIN public.users AS author ON author.id = reply.author_id
   WHERE reply.task_id = p_task_id
   ORDER BY 7, 2;
END
$$;

REVOKE ALL ON FUNCTION public.task_mail_thread(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.task_mail_thread(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.task_mail_thread(uuid) TO medtech_api;

-- ---------------------------------------------------------------------------
-- 7. Ответ клиенту из карточки задачи
-- ---------------------------------------------------------------------------

-- Отвечает клиенту тот, кто ведёт задачи и видит почту: координатор и руководитель.
-- Инженер этой задачи переписку читает (app_can_read_task_mail), но сам клиенту не пишет:
-- переписку с заказчиком ведёт координатор. Отвечать есть на что, только если задача
-- пришла из письма.
CREATE OR REPLACE FUNCTION public.app_can_reply_task_mail(p_task_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT public.app_has_permission('tasks.write')
     AND public.app_has_any_permission(ARRAY['tasks.read_all', 'tasks.assign'])
     AND public.app_can_read_task(p_task_id)
     AND EXISTS (
           SELECT 1 FROM public.mail_messages AS m
            WHERE m.task_id = p_task_id
              AND public.app_mail_address(m.sender) IS NOT NULL
         );
$$;

REVOKE ALL ON FUNCTION public.app_can_reply_task_mail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.app_can_reply_task_mail(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_can_reply_task_mail(uuid) TO medtech_api;

-- Ответ ставится в очередь; отправляет его служба (0042) с заголовками цепочки,
-- поэтому у клиента это ответ в том же письме, а не новое.
CREATE OR REPLACE FUNCTION public.send_task_mail_reply(p_task_id uuid, p_body text)
RETURNS TABLE(id uuid, to_address text, subject text, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  text_body text := btrim(coalesce(p_body, ''));
  letter public.mail_messages;
  new_id uuid := gen_random_uuid();
  target text;
  reply_subject text;
  chain text[];
BEGIN
  IF text_body = '' THEN
    RAISE EXCEPTION 'Напишите текст ответа клиенту' USING ERRCODE = '23514';
  END IF;
  IF char_length(text_body) > 20000 THEN
    RAISE EXCEPTION 'Ответ клиенту длиннее 20 000 символов: сократите текст' USING ERRCODE = '23514';
  END IF;
  IF NOT public.app_can_reply_task_mail(p_task_id) THEN
    RAISE EXCEPTION 'Недостаточно прав: отвечать клиенту по задаче может координатор или руководитель'
      USING ERRCODE = '42501';
  END IF;

  -- Отвечаем на последнее письмо этой задачи: если клиент уже дописывал, ответ уйдёт
  -- на него. Берём только письма самой задачи: письмо, подброшенное в цепочку с чужого
  -- адреса, задачу не получает (0042), и ответ на него не уйдёт.
  SELECT m.* INTO letter
    FROM public.mail_messages AS m
   WHERE m.task_id = p_task_id
     AND public.app_mail_address(m.sender) IS NOT NULL
   ORDER BY m.received_at DESC, m.created_at DESC
   LIMIT 1;
  IF letter.id IS NULL THEN
    RAISE EXCEPTION 'По этой задаче нет письма клиента: отвечать не на что' USING ERRCODE = '23503';
  END IF;
  target := public.app_mail_address(letter.sender);
  reply_subject := regexp_replace(coalesce(nullif(btrim(letter.subject), ''), 'Заявка'), '[[:space:]]+', ' ', 'g');
  IF reply_subject !~* '^re:' THEN
    reply_subject := 'Re: ' || reply_subject;
  END IF;

  -- Цепочка для References: Message-ID писем и наших ответов по порядку, последние 20.
  SELECT array_agg(recent.message_id ORDER BY recent.at) INTO chain FROM (
    SELECT thread_step.message_id, thread_step.at FROM (
      SELECT m.external_message_id AS message_id, m.received_at AS at
        FROM public.mail_messages AS m
       WHERE m.task_id = p_task_id
      UNION ALL
      SELECT r.external_message_id, r.created_at
        FROM public.mail_replies AS r
       WHERE r.task_id = p_task_id
    ) AS thread_step
     WHERE thread_step.message_id ~ '^<[^<>[:space:]]{1,250}>$'
     ORDER BY thread_step.at DESC
     LIMIT 20
  ) AS recent;

  INSERT INTO public.mail_replies (
    id, task_id, mail_message_id, thread_id, external_message_id, in_reply_to, reference_ids,
    to_address, subject, body, author_id
  ) VALUES (
    new_id, p_task_id, letter.id, coalesce(letter.thread_id, letter.external_message_id),
    format('<reply-%s@medtechservice>', new_id),
    CASE WHEN letter.external_message_id ~ '^<[^<>[:space:]]{1,250}>$' THEN letter.external_message_id END,
    coalesce(chain, '{}'::text[]), target, left(reply_subject, 250), text_body, auth.uid()
  );

  RETURN QUERY
  SELECT reply.id, reply.to_address, reply.subject, reply.created_at
    FROM public.mail_replies AS reply WHERE reply.id = new_id;
END
$$;

REVOKE ALL ON FUNCTION public.send_task_mail_reply(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_task_mail_reply(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_task_mail_reply(uuid, text) TO medtech_api;

-- PostgREST должен увидеть новую таблицу, поле и функции сразу, без перезапуска.
NOTIFY pgrst, 'reload schema';
