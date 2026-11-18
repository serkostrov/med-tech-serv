-- Встреча 18.11.2026.
--   1. Свой склад инженера: галочка в карточке инженера. Если отмечена, на странице
--      инженера есть вкладка «Склад» — какие запчасти сейчас у него.
--   2. Файлы в ответе клиенту из карточки задачи: координатор прикладывает файлы задачи
--      (фото, акт, документы). Только файлы этой задачи и только видимые ему
--      (финансовые — с finance.read), не больше 10 и 20 МБ на письмо. Служба кладёт
--      их во вложения письма; в переписке ответ показан с этими файлами.
-- Миграция повторяемая: всё через IF NOT EXISTS и CREATE OR REPLACE.

-- ---------------------------------------------------------------------------
-- 1. Свой склад инженера
-- ---------------------------------------------------------------------------

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS has_own_stock boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.users.has_own_stock IS
  'У инженера свой склад: на его странице вкладка «Склад» с выданными ему запчастями';

-- ---------------------------------------------------------------------------
-- 2. Файлы в ответе клиенту
-- ---------------------------------------------------------------------------

ALTER TABLE public.mail_replies
  ADD COLUMN IF NOT EXISTS file_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

-- Ответ с файлами: та же очередь, что у ответа без файлов (0041), плюс проверка файлов.
-- Всё в одной транзакции: служба не возьмёт ответ, пока файлы к нему не записаны.
CREATE OR REPLACE FUNCTION public.send_task_mail_reply(p_task_id uuid, p_body text, p_file_ids uuid[])
RETURNS TABLE(id uuid, to_address text, subject text, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  chosen uuid[] := ARRAY(SELECT DISTINCT f FROM unnest(coalesce(p_file_ids, '{}'::uuid[])) AS f WHERE f IS NOT NULL);
  finance boolean := public.app_has_permission('finance.read');
  total_bytes bigint;
  new_id uuid;
BEGIN
  IF cardinality(chosen) > 10 THEN
    RAISE EXCEPTION 'К ответу можно приложить не больше 10 файлов' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(chosen) AS wanted(file_id)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.files AS f
        WHERE f.id = wanted.file_id
          AND f.task_id = p_task_id
          AND (NOT coalesce(f.is_financial, false) OR finance)
     )
  ) THEN
    RAISE EXCEPTION 'Приложить можно только файлы этой задачи' USING ERRCODE = '23503';
  END IF;
  SELECT coalesce(sum(f.byte_size), 0) INTO total_bytes FROM public.files AS f WHERE f.id = ANY(chosen);
  IF total_bytes > 20 * 1024 * 1024 THEN
    RAISE EXCEPTION 'Файлы больше 20 МБ вместе: почта клиента может не принять такое письмо' USING ERRCODE = '23514';
  END IF;

  -- Права, текст, адрес и цепочку проверяет и записывает прежняя функция.
  SELECT queued.id INTO new_id FROM public.send_task_mail_reply(p_task_id, p_body) AS queued;
  IF cardinality(chosen) > 0 THEN
    UPDATE public.mail_replies AS reply SET file_ids = chosen WHERE reply.id = new_id;
  END IF;

  RETURN QUERY
  SELECT reply.id, reply.to_address, reply.subject, reply.created_at
    FROM public.mail_replies AS reply WHERE reply.id = new_id;
END
$$;

REVOKE ALL ON FUNCTION public.send_task_mail_reply(uuid, text, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_task_mail_reply(uuid, text, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_task_mail_reply(uuid, text, uuid[]) TO medtech_api;

-- Файлы ответа для службы: ключ в хранилище, имя у получателя, тип.
CREATE OR REPLACE FUNCTION public.task_mail_reply_files(p_reply_id uuid)
RETURNS TABLE(storage_key text, file_name text, content_type text, byte_size bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT f.storage_key, f.original_name, f.content_type, f.byte_size
    FROM public.mail_replies AS reply
    JOIN LATERAL unnest(reply.file_ids) WITH ORDINALITY AS chosen(file_id, place) ON true
    JOIN public.files AS f ON f.id = chosen.file_id AND f.task_id = reply.task_id
   WHERE reply.id = p_reply_id
   ORDER BY chosen.place;
$$;

REVOKE ALL ON FUNCTION public.task_mail_reply_files(uuid) FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medtech_worker') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.task_mail_reply_files(uuid) TO medtech_worker';
  END IF;
END
$$;

-- Переписка: наш ответ показывается с приложенными файлами (раньше список был пустым).
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
         reply.last_error,
         coalesce((
           SELECT jsonb_agg(jsonb_build_object(
                    'fileId', f.id,
                    'fileName', f.original_name,
                    'contentType', f.content_type,
                    'byteSize', f.byte_size,
                    'storageKey', f.storage_key
                  ) ORDER BY chosen.place)
             FROM unnest(reply.file_ids) WITH ORDINALITY AS chosen(file_id, place)
             JOIN public.files AS f ON f.id = chosen.file_id AND f.task_id = reply.task_id
            WHERE NOT coalesce(f.is_financial, false) OR finance
         ), '[]'::jsonb)
    FROM public.mail_replies AS reply
    LEFT JOIN public.users AS author ON author.id = reply.author_id
   WHERE reply.task_id = p_task_id
   ORDER BY 7, 2;
END
$$;

REVOKE ALL ON FUNCTION public.task_mail_thread(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.task_mail_thread(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.task_mail_thread(uuid) TO medtech_api;

NOTIFY pgrst, 'reload schema';
