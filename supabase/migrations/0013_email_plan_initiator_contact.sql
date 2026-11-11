-- Письма заявителю из справочника «Клиенты».
-- С 0007 инициатор задачи выбирается как контакт площадки (initiator_contact_id),
-- а не как сотрудник. Рассылка знала только сотрудника-инициатора, поэтому
-- заявитель не получал подтверждение. Теперь получает те же письма.

CREATE OR REPLACE FUNCTION public.load_email_event_plan(p_event_id uuid)
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
           task.engineer_id, task.initiator_id, task.initiator_contact_id, task.contact_name,
           task.contact_email, task.site_id, engineer.full_name AS engineer_name,
           site.name AS site_name
      FROM event
      JOIN public.tasks task ON task.id = event.aggregate_id
      LEFT JOIN public.users engineer ON engineer.id = task.engineer_id
      LEFT JOIN public.sites site ON site.id = task.site_id
  ), candidates AS (
    -- Инициатор получает подтверждение, назначение, принятие и результат.
    SELECT context.event_type, context.id AS task_id, user_account.id AS user_id,
           user_account.email AS address, user_account.full_name AS display_name,
           context.payload, context.number, context.title, context.deadline_from,
           context.deadline_to, context.rework_comment, context.engineer_name,
           context.site_name
      FROM task_context context
      JOIN public.users user_account ON user_account.id = context.initiator_id
       AND user_account.is_active AND nullif(btrim(user_account.email), '') IS NOT NULL
     WHERE context.event_type IN (
       'task_application_accepted', 'task_engineer_assigned',
       'task_engineer_accepted', 'task_work_completed'
     )
    UNION ALL
    -- Инициатор из справочника «Клиенты» (контакт площадки) получает то же, что инициатор-сотрудник.
    SELECT context.event_type, context.id, NULL::uuid, initiator_contact.email,
           coalesce(nullif(btrim(initiator_contact.full_name), ''), 'коллеги'),
           context.payload, context.number, context.title, context.deadline_from,
           context.deadline_to, context.rework_comment, context.engineer_name,
           context.site_name
      FROM task_context context
      JOIN public.site_contacts initiator_contact ON initiator_contact.id = context.initiator_contact_id
       AND initiator_contact.is_active AND nullif(btrim(initiator_contact.email), '') IS NOT NULL
     WHERE context.event_type IN (
       'task_application_accepted', 'task_engineer_assigned',
       'task_engineer_accepted', 'task_work_completed'
     )
    UNION ALL
    -- Координаторы получают подтверждение принятия, в том числе для задач ТО.
    SELECT context.event_type, context.id, user_account.id, user_account.email,
           user_account.full_name, context.payload, context.number, context.title,
           context.deadline_from, context.deadline_to, context.rework_comment,
           context.engineer_name, context.site_name
      FROM task_context context
      JOIN public.users user_account ON user_account.role = 'coordinator'
       AND user_account.is_active AND nullif(btrim(user_account.email), '') IS NOT NULL
     WHERE context.event_type = 'task_engineer_accepted'
    UNION ALL
    -- Инженер получает назначение и комментарий возврата.
    SELECT context.event_type, context.id, user_account.id, user_account.email,
           user_account.full_name, context.payload, context.number, context.title,
           context.deadline_from, context.deadline_to, context.rework_comment,
           context.engineer_name, context.site_name
      FROM task_context context
      JOIN public.users user_account ON user_account.id = context.engineer_id
       AND user_account.is_active AND nullif(btrim(user_account.email), '') IS NOT NULL
     WHERE context.event_type IN ('task_engineer_assigned', 'task_rework_requested')
    UNION ALL
    -- Контакт площадки получает подтверждение заявки и завершение работ.
    SELECT context.event_type, context.id, NULL::uuid, context.contact_email,
           coalesce(nullif(btrim(context.contact_name), ''), 'коллеги'),
           context.payload, context.number, context.title, context.deadline_from,
           context.deadline_to, context.rework_comment, context.engineer_name,
           context.site_name
      FROM task_context context
     WHERE context.event_type IN ('task_application_accepted', 'task_work_completed')
       AND nullif(btrim(context.contact_email), '') IS NOT NULL
    UNION ALL
    -- Просрочка эскалируется всем активным руководителям.
    SELECT context.event_type, context.id, user_account.id, user_account.email,
           user_account.full_name, context.payload, context.number, context.title,
           context.deadline_from, context.deadline_to, context.rework_comment,
           context.engineer_name, context.site_name
      FROM task_context context
      JOIN public.users user_account ON user_account.role = 'supervisor'
       AND user_account.is_active AND nullif(btrim(user_account.email), '') IS NOT NULL
     WHERE context.event_type = 'task_overdue'
  ), enabled AS (
    SELECT candidate.*
      FROM candidates candidate
      LEFT JOIN public.notification_preferences preference
        ON preference.user_id = candidate.user_id
       AND preference.event_code = candidate.event_type
       AND preference.channel = 'email'
     WHERE candidate.user_id IS NULL OR coalesce(preference.is_enabled, true)
  ), deduplicated AS (
    SELECT DISTINCT ON (lower(btrim(address))) *
      FROM enabled
     ORDER BY lower(btrim(address)), user_id NULLS LAST
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
   ORDER BY lower(btrim(deduplicated.address))
$function$;
