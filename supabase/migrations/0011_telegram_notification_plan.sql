-- Получатели уведомлений в Telegram: те же сотрудники, что и для e-mail
-- (инициатор, координаторы, инженер, руководители при просрочке), но по полю
-- users.telegram_chat_id и с настройкой канала telegram. Контакт площадки
-- не сотрудник, номера чата у него нет, поэтому он получает только e-mail.

CREATE OR REPLACE FUNCTION public.load_telegram_event_plan(p_event_id uuid)
 RETURNS TABLE(recipient_user_id uuid, recipient_address text, recipient_name text, subject_template text, body_template text, allowed_variables text[], task_id uuid, variables jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  WITH event AS (
    SELECT queued.id, queued.event_type, queued.aggregate_id, queued.payload
      FROM public.integration_outbox queued
     WHERE queued.id = p_event_id AND queued.aggregate_type = 'task'
  ), task_context AS (
    SELECT event.event_type, event.payload, task.id, task.number, task.title,
           task.deadline_from, task.deadline_to, task.rework_comment,
           task.engineer_id, task.initiator_id, task.contact_name,
           task.contact_email, task.site_id, engineer.full_name AS engineer_name,
           site.name AS site_name
      FROM event
      JOIN public.tasks task ON task.id = event.aggregate_id
      LEFT JOIN public.users engineer ON engineer.id = task.engineer_id
      LEFT JOIN public.sites site ON site.id = task.site_id
  ), candidates AS (
    -- Инициатор получает подтверждение, назначение, принятие и результат.
    SELECT context.event_type, context.id AS task_id, user_account.id AS user_id,
           user_account.telegram_chat_id AS address, user_account.full_name AS display_name,
           context.payload, context.number, context.title, context.deadline_from,
           context.deadline_to, context.rework_comment, context.engineer_name,
           context.site_name
      FROM task_context context
      JOIN public.users user_account ON user_account.id = context.initiator_id
       AND user_account.is_active AND nullif(btrim(user_account.telegram_chat_id), '') IS NOT NULL
     WHERE context.event_type IN (
       'task_application_accepted', 'task_engineer_assigned',
       'task_engineer_accepted', 'task_work_completed'
     )
    UNION ALL
    -- Координаторы получают подтверждение принятия, в том числе для задач ТО.
    SELECT context.event_type, context.id, user_account.id, user_account.telegram_chat_id,
           user_account.full_name, context.payload, context.number, context.title,
           context.deadline_from, context.deadline_to, context.rework_comment,
           context.engineer_name, context.site_name
      FROM task_context context
      JOIN public.users user_account ON user_account.role = 'coordinator'
       AND user_account.is_active AND nullif(btrim(user_account.telegram_chat_id), '') IS NOT NULL
     WHERE context.event_type = 'task_engineer_accepted'
    UNION ALL
    -- Инженер получает назначение и комментарий возврата.
    SELECT context.event_type, context.id, user_account.id, user_account.telegram_chat_id,
           user_account.full_name, context.payload, context.number, context.title,
           context.deadline_from, context.deadline_to, context.rework_comment,
           context.engineer_name, context.site_name
      FROM task_context context
      JOIN public.users user_account ON user_account.id = context.engineer_id
       AND user_account.is_active AND nullif(btrim(user_account.telegram_chat_id), '') IS NOT NULL
     WHERE context.event_type IN ('task_engineer_assigned', 'task_rework_requested')
    UNION ALL
    -- Просрочка эскалируется всем активным руководителям.
    SELECT context.event_type, context.id, user_account.id, user_account.telegram_chat_id,
           user_account.full_name, context.payload, context.number, context.title,
           context.deadline_from, context.deadline_to, context.rework_comment,
           context.engineer_name, context.site_name
      FROM task_context context
      JOIN public.users user_account ON user_account.role = 'supervisor'
       AND user_account.is_active AND nullif(btrim(user_account.telegram_chat_id), '') IS NOT NULL
     WHERE context.event_type = 'task_overdue'
  ), enabled AS (
    SELECT candidate.*
      FROM candidates candidate
      LEFT JOIN public.notification_preferences preference
        ON preference.user_id = candidate.user_id
       AND preference.event_code = candidate.event_type
       AND preference.channel = 'telegram'
     WHERE coalesce(preference.is_enabled, true)
  ), deduplicated AS (
    SELECT DISTINCT ON (btrim(address)) *
      FROM enabled
     ORDER BY btrim(address), user_id NULLS LAST
  )
  SELECT deduplicated.user_id, btrim(deduplicated.address), deduplicated.display_name,
         template.subject_template, template.body_template, template.allowed_variables,
         deduplicated.task_id,
         jsonb_strip_nulls(jsonb_build_object(
           'recipientName', deduplicated.display_name,
           'taskNumber', deduplicated.number,
           'taskTitle', deduplicated.title,
           'siteName', deduplicated.site_name,
           'engineerName', coalesce(deduplicated.engineer_name, 'не назначен'),
           'periodFrom', deduplicated.deadline_from,
           'periodTo', deduplicated.deadline_to,
           'reworkComment', coalesce(deduplicated.payload ->> 'reworkComment', deduplicated.rework_comment),
           'taskId', deduplicated.task_id
         ))
    FROM deduplicated
    JOIN public.notification_templates template
      ON template.code = deduplicated.event_type AND template.is_active
   ORDER BY btrim(deduplicated.address)
$function$;

REVOKE ALL ON FUNCTION public.load_telegram_event_plan(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.load_telegram_event_plan(uuid) TO medtech_worker;

-- Номер чата Telegram: только цифры (у групп с минусом). Пусто = не получать в Telegram.
UPDATE public.users SET telegram_chat_id = NULL WHERE telegram_chat_id IS NOT NULL AND btrim(telegram_chat_id) = '';
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_telegram_chat_id_format;
ALTER TABLE public.users
  ADD CONSTRAINT users_telegram_chat_id_format
  CHECK (telegram_chat_id IS NULL OR telegram_chat_id ~ '^-?[0-9]{1,20}$') NOT VALID;
