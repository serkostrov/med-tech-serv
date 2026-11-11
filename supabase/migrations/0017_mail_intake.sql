-- Приём заявок из почты (Блок 4 ТЗ).
-- Служба (роль medtech_worker) забирает письма из ящика по IMAP, кладёт исходное
-- письмо и вложения в хранилище (mail/<id>/...), разбирает письмо по форме
-- заявки и ищет прибор по заводскому номеру. Координатор проверяет черновик во
-- вкладке «Письма» и создаёт задачу; письмо и вложения прикрепляются к задаче,
-- отправителю уходит автоответ «заявка принята».

ALTER TABLE public.mail_messages
  ADD COLUMN IF NOT EXISTS in_reply_to text,
  ADD COLUMN IF NOT EXISTS raw_storage_key text,
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS parsed_at timestamptz,
  ADD COLUMN IF NOT EXISTS autoreply_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS autoreply_error text;

-- Задачи из писем, созданные до появления автоответа, не должны получить его задним числом.
UPDATE public.mail_messages
   SET autoreply_sent_at = now()
 WHERE status = 'converted' AND autoreply_sent_at IS NULL;

-- Письмо в очередь. Дубль (тот же Message-ID) не создаётся. Ответ в цепочке
-- получает thread_id исходного письма. needs_parse: письмо новое или прошлый
-- разбор оборвался (сбой базы, остановка службы), его нужно разобрать заново;
-- has_files: файлы письма уже в хранилище.
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
RETURNS TABLE(id uuid, created boolean, thread_id text, needs_parse boolean, has_files boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  existing_id uuid;
  existing_pending boolean;
  existing_files boolean;
  parent_thread text;
  new_id uuid;
  new_thread text;
BEGIN
  IF nullif(btrim(coalesce(p_external_message_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'У письма нет Message-ID' USING ERRCODE = '23514';
  END IF;
  SELECT m.id, m.thread_id, (m.status = 'pending' AND m.parsed_at IS NULL), m.raw_storage_key IS NOT NULL
    INTO existing_id, new_thread, existing_pending, existing_files
    FROM public.mail_messages AS m WHERE m.external_message_id = p_external_message_id;
  IF existing_id IS NOT NULL THEN
    RETURN QUERY SELECT existing_id, false, new_thread, existing_pending, existing_files;
    RETURN;
  END IF;
  -- Цепочка: ищем известное письмо среди In-Reply-To и References.
  SELECT coalesce(m.thread_id, m.external_message_id) INTO parent_thread
    FROM public.mail_messages AS m
   WHERE m.external_message_id = p_in_reply_to
      OR m.external_message_id = ANY (coalesce(p_references, ARRAY[]::text[]))
   ORDER BY m.received_at
   LIMIT 1;
  new_thread := coalesce(parent_thread, p_external_message_id);
  INSERT INTO public.mail_messages (external_message_id, thread_id, in_reply_to, sender, subject, body, received_at, status)
  VALUES (p_external_message_id, new_thread, p_in_reply_to, btrim(p_sender), coalesce(p_subject, ''), coalesce(p_body, ''), coalesce(p_received_at, now()), 'pending')
  ON CONFLICT (external_message_id) DO NOTHING
  RETURNING mail_messages.id INTO new_id;
  IF new_id IS NULL THEN
    -- Письмо одновременно вставила другая копия службы: она его и разберёт.
    SELECT m.id INTO new_id FROM public.mail_messages AS m WHERE m.external_message_id = p_external_message_id;
    RETURN QUERY SELECT new_id, false, new_thread, false, false;
    RETURN;
  END IF;
  RETURN QUERY SELECT new_id, true, new_thread, true, false;
END
$$;

CREATE OR REPLACE FUNCTION public.set_mail_attachments(p_id uuid, p_raw_storage_key text, p_attachments jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.mail_messages
     SET raw_storage_key = p_raw_storage_key,
         attachments = coalesce(p_attachments, '[]'::jsonb)
   WHERE id = p_id;
$$;

-- Прибор по заводскому номеру: та же нормализация, что у equipment.serial_number_normalized.
CREATE OR REPLACE FUNCTION public.find_equipment_by_serial(p_serial text)
RETURNS TABLE(id uuid, serial_number text, model text, manufacturer text, site_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT e.id, e.serial_number, m.name, mf.name, s.name
    FROM public.equipment AS e
    LEFT JOIN public.equipment_models AS m ON m.id = e.model_id
    LEFT JOIN public.manufacturers AS mf ON mf.id = e.manufacturer_id
    LEFT JOIN public.sites AS s ON s.id = e.current_site_id
   WHERE e.serial_number_normalized = upper(regexp_replace(btrim(coalesce(p_serial, '')), E'\\s+', '', 'g'))
     AND btrim(coalesce(p_serial, '')) <> ''
   LIMIT 1;
$$;

-- Результат разбора: черновик заявки и уверенность. Письмо, по которому уже
-- создана задача или которое отмечено «не требует работы», не трогаем.
CREATE OR REPLACE FUNCTION public.set_mail_parse_result(p_id uuid, p_payload jsonb, p_confidence numeric, p_status text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_status NOT IN ('parsed', 'failed') THEN
    RAISE EXCEPTION 'Недопустимый статус разбора: %', p_status USING ERRCODE = '23514';
  END IF;
  UPDATE public.mail_messages
     SET parsed_payload = coalesce(p_payload, '{}'::jsonb),
         ai_confidence = CASE WHEN p_confidence IS NULL OR p_confidence = 'NaN'::numeric THEN 0 ELSE greatest(0, least(1, p_confidence)) END,
         status = p_status,
         parsed_at = now()
   WHERE id = p_id AND status = 'pending';
END
$$;

-- Автоответы: письма, по которым создана задача, а ответ ещё не отправлялся.
-- Отметка ставится до отправки (не больше одного письма отправителю).
CREATE OR REPLACE FUNCTION public.claim_mail_autoreplies(p_limit integer)
RETURNS TABLE(id uuid, sender text, subject text, external_message_id text, task_number text, task_title text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH due AS (
    SELECT m.id
      FROM public.mail_messages AS m
      JOIN public.tasks AS t ON t.id = m.task_id
     WHERE m.status = 'converted'
       AND m.autoreply_sent_at IS NULL
       AND m.autoreply_error IS NULL
     ORDER BY m.received_at
     LIMIT least(greatest(coalesce(p_limit, 1), 1), 100)
     FOR UPDATE OF m SKIP LOCKED
  ), claimed AS (
    UPDATE public.mail_messages AS m
       SET autoreply_sent_at = now()
      FROM due
     WHERE m.id = due.id
    RETURNING m.id, m.sender, m.subject, m.external_message_id, m.task_id
  )
  SELECT c.id, c.sender, c.subject, c.external_message_id, t.number, t.title
    FROM claimed AS c
    JOIN public.tasks AS t ON t.id = c.task_id;
$$;

CREATE OR REPLACE FUNCTION public.fail_mail_autoreply(p_id uuid, p_error text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.mail_messages SET autoreply_error = left(p_error, 200) WHERE id = p_id;
$$;

-- Файлы писем в хранилище (mail/<id>/...): читают те, кто разбирает почту.
-- Записывает только служба (ключ сервиса), правил на запись для сотрудников нет.
CREATE OR REPLACE FUNCTION public.app_storage_object_access(p_name text, p_write boolean)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  first_part text := split_part(coalesce(p_name, ''), '/', 1);
  target_id uuid;
BEGIN
  IF first_part = 'mail' THEN
    RETURN NOT p_write AND public.app_has_any_permission(ARRAY['tasks.read_all', 'tasks.assign']);
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

-- Координатор отмечает письмо (создана задача, не требует работы, вернуть в работу)
-- и не может подменить служебные поля разбора и автоответа.
CREATE OR REPLACE FUNCTION public.guard_mail_message_columns()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.external_message_id IS DISTINCT FROM OLD.external_message_id
     OR NEW.sender IS DISTINCT FROM OLD.sender
     OR NEW.body IS DISTINCT FROM OLD.body
     OR NEW.raw_storage_key IS DISTINCT FROM OLD.raw_storage_key
     OR NEW.attachments IS DISTINCT FROM OLD.attachments
     OR NEW.autoreply_sent_at IS DISTINCT FROM OLD.autoreply_sent_at
     OR NEW.autoreply_error IS DISTINCT FROM OLD.autoreply_error THEN
    RAISE EXCEPTION 'Недостаточно прав: исходное письмо и автоответ меняет только служба'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS mail_messages_guard_columns ON public.mail_messages;
CREATE TRIGGER mail_messages_guard_columns
  BEFORE UPDATE ON public.mail_messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_mail_message_columns();

DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.ingest_mail_message(text, text, text[], text, text, text, timestamptz)',
    'public.set_mail_attachments(uuid, text, jsonb)',
    'public.find_equipment_by_serial(text)',
    'public.set_mail_parse_result(uuid, jsonb, numeric, text)',
    'public.claim_mail_autoreplies(integer)',
    'public.fail_mail_autoreply(uuid, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO medtech_worker', fn);
  END LOOP;
  EXECUTE 'REVOKE EXECUTE ON FUNCTION public.guard_mail_message_columns() FROM PUBLIC, anon, authenticated';
END
$$;
