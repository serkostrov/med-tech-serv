-- Уведомления по задаче уходят и отправителю письма.
--
-- Что было не так. Задача из письма (0017) никак не связывала адрес отправителя с
-- рассылкой: план писем (0013, 0029) знал инициатора-сотрудника, инициатора из
-- справочника «Клиенты» и контакт площадки. Клиент, написавший на ящик заявок с
-- обычного рабочего адреса, после автоответа «заявка принята» больше ничего не получал:
-- ни назначения инженера, ни завершения работ. Он узнавал о работе по телефону.
--
-- Что делаем. В план писем добавлена ветка отправителя письма задачи: назначение
-- инженера, принятие задачи и завершение работ. Подтверждение приёма ему отправляет
-- автоответ службы (0017) — в той же цепочке, что его письмо, поэтому второй раз
-- то же самое из шаблона task_application_accepted не отправляем: два одинаковых письма
-- «заявка принята» клиенту не нужны, а ответ в его же цепочке ему понятнее. Цена
-- решения: с MAIL_AUTOREPLY_ENABLED=false о приёме заявки клиент не узнает — об этом
-- написано в README службы, а неудачный автоответ виден координатору в «Письмах».
-- (Событие приёма встаёт в очередь при создании задачи, а письмо связывается с ней
-- следующим запросом браузера: план читается в момент доставки, поэтому обычно адрес
-- уже на месте, но на самом раннем проходе очереди его может не быть.)
--
-- Остальные ветки плана повторяют 0029 без изменений. Адрес берём через
-- app_mail_address (0041): из «Имя <адрес>» остаётся адрес, мусор отбрасывается.
-- Повторы по адресу снимает тот же DISTINCT ON, что и раньше: если отправитель
-- письма — он же контакт площадки, письмо уйдёт одно.
-- В Telegram такому адресату писать некуда: номера чата у него нет, план Telegram не меняется.

CREATE OR REPLACE FUNCTION public.load_email_event_plan(p_event_id uuid)
 RETURNS TABLE(recipient_user_id uuid, recipient_address text, recipient_name text, subject_template text, body_template text, allowed_variables text[], task_id uuid, variables jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  WITH event AS (
    SELECT queued.id, queued.event_type, queued.aggregate_type, queued.aggregate_id, queued.payload
      FROM public.integration_outbox queued
     WHERE queued.id = p_event_id AND queued.aggregate_type IN ('task', 'stock_reservation')
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
     WHERE event.aggregate_type = 'task'
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
    -- Отправитель письма, из которого создана задача: он написал — ему и отвечать
    -- статусами. Получает то же, что инициатор заявки, кроме подтверждения приёма:
    -- о приёме ему уже ответила служба (автоответ 0017), и это ответ в его же письме.
    -- Имя берём из разбора письма, иначе обращаемся «коллеги», как к контакту площадки.
    SELECT context.event_type, context.id, NULL::uuid,
           public.app_mail_address(letter.sender),
           coalesce(nullif(btrim(letter.parsed_payload ->> 'contactName'), ''), 'коллеги'),
           context.payload, context.number, context.title, context.deadline_from,
           context.deadline_to, context.rework_comment, context.engineer_name,
           context.site_name
      FROM task_context context
      -- Письмо, из которого создана задача (самое раннее у задачи), а не каждое
      -- письмо переписки: уведомления уходят заявителю, а не всем, кто писал.
      JOIN LATERAL (
        SELECT m.sender, m.parsed_payload
          FROM public.mail_messages AS m
         WHERE m.task_id = context.id
           AND public.app_mail_address(m.sender) IS NOT NULL
         ORDER BY m.received_at, m.created_at
         LIMIT 1
      ) AS letter ON true
     WHERE context.event_type IN (
       'task_engineer_assigned', 'task_engineer_accepted', 'task_work_completed'
     )
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
  ), stock_context AS (
    -- Резерв по договору задачи не имеет, адресата у него пока нет: внутреннее
    -- соединение с задачей отбрасывает такое событие, и доставок не будет.
    SELECT event.event_type, task.id AS task_id, task.number AS task_number,
           task.title AS task_title, task.engineer_id, site.name AS site_name,
           engineer.full_name AS engineer_name,
           reservation.number AS reservation_number,
           part.article_number AS part_article, part.name AS part_name,
           -- Количество numeric(14,3): «1.000» в тексте уведомления не нужно.
           trim_scale(reservation.quantity)::text AS quantity,
           CASE reservation.part_condition
             WHEN 'N' THEN 'новая'
             WHEN 'G' THEN 'гарантийная'
             WHEN 'B' THEN 'б/у'
           END AS condition_label
      FROM event
      JOIN public.stock_reservations reservation ON reservation.id = event.aggregate_id
      JOIN public.parts part ON part.id = reservation.part_id
      JOIN public.tasks task ON task.id = reservation.task_id
      LEFT JOIN public.users engineer ON engineer.id = task.engineer_id
      LEFT JOIN public.sites site ON site.id = task.site_id
     WHERE event.aggregate_type = 'stock_reservation'
  ), stock_candidates AS (
    -- Новый резерв собирает склад: письмо идёт всем активным кладовщикам.
    SELECT context.event_type, context.task_id, user_account.id AS user_id,
           user_account.email AS address, user_account.full_name AS display_name,
           context.task_number, context.task_title, context.site_name,
           context.engineer_name, context.reservation_number, context.part_article,
           context.part_name, context.quantity, context.condition_label
      FROM stock_context context
      JOIN public.users user_account ON user_account.role = 'warehouse'
       AND user_account.is_active AND nullif(btrim(user_account.email), '') IS NOT NULL
     WHERE context.event_type = 'stock_reservation_created'
    UNION ALL
    -- «Можно забрать» нужно одному человеку: инженеру задачи.
    SELECT context.event_type, context.task_id, user_account.id,
           user_account.email, user_account.full_name,
           context.task_number, context.task_title, context.site_name,
           context.engineer_name, context.reservation_number, context.part_article,
           context.part_name, context.quantity, context.condition_label
      FROM stock_context context
      JOIN public.users user_account ON user_account.id = context.engineer_id
       AND user_account.is_active AND nullif(btrim(user_account.email), '') IS NOT NULL
     WHERE context.event_type = 'stock_reservation_ready'
  ), stock_enabled AS (
    SELECT candidate.*
      FROM stock_candidates candidate
      LEFT JOIN public.notification_preferences preference
        ON preference.user_id = candidate.user_id
       AND preference.event_code = candidate.event_type
       AND preference.channel = 'email'
     WHERE coalesce(preference.is_enabled, true)
  ), stock_deduplicated AS (
    SELECT DISTINCT ON (lower(btrim(address))) *
      FROM stock_enabled
     ORDER BY lower(btrim(address)), user_id
  ), plan AS (
    SELECT deduplicated.user_id, btrim(deduplicated.address) AS address,
           deduplicated.display_name, template.subject_template AS subject_text,
           template.body_template AS body_text, template.allowed_variables AS allowed,
           deduplicated.task_id AS task,
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
           )) AS vars
      FROM deduplicated
      JOIN public.notification_templates template
        ON template.code = deduplicated.event_type AND template.is_active
    UNION ALL
    -- У резерва те же поля карточки задачи плюс сама запчасть: worker рисует
    -- карточку из этих переменных, а task_id нужен ему для ссылки на задачу.
    SELECT stock.user_id, btrim(stock.address), stock.display_name,
           template.subject_template, template.body_template, template.allowed_variables,
           stock.task_id,
           jsonb_strip_nulls(jsonb_build_object(
             'recipientName', stock.display_name,
             'reservationNumber', stock.reservation_number,
             'partArticle', stock.part_article,
             'partName', stock.part_name,
             'quantity', stock.quantity,
             'condition', stock.condition_label,
             'taskNumber', stock.task_number,
             'taskTitle', stock.task_title,
             'siteName', stock.site_name,
             'engineerName', coalesce(stock.engineer_name, 'не назначен'),
             'taskId', stock.task_id
           ))
      FROM stock_deduplicated stock
      JOIN public.notification_templates template
        ON template.code = stock.event_type AND template.is_active
  )
  SELECT plan.user_id, plan.address, plan.display_name, plan.subject_text,
         plan.body_text, plan.allowed, plan.task, plan.vars
    FROM plan
   ORDER BY lower(btrim(plan.address))
$function$;

-- Права не меняются: CREATE OR REPLACE их сохраняет, но на стенде функция могла
-- создаваться заново, поэтому повторяем ровно то, что было в 0001, 0013 и 0029.
REVOKE ALL ON FUNCTION public.load_email_event_plan(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.load_email_event_plan(uuid) FROM medtech_api, medtech_backup;
GRANT EXECUTE ON FUNCTION public.load_email_event_plan(uuid) TO medtech_worker;
