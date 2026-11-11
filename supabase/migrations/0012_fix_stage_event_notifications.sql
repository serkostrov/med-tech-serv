-- Исправление: уведомления не раскладывались по получателям.
-- В stage_event_notifications (обе версии, новая вызывает старую) колонки результата
-- (idempotency_key и др.) совпадают с колонками notifications, и
-- ON CONFLICT (idempotency_key) падал с «column reference is ambiguous».
-- Указание #variable_conflict use_column снимает неоднозначность.
-- Плюс свежие доставки выравниваются по времени прохода обработчика (см. ниже).

CREATE OR REPLACE FUNCTION public.stage_event_notifications(p_event_id uuid, p_commands jsonb)
 RETURNS TABLE(id uuid, outbox_event_id uuid, idempotency_key text, event_code text, recipient_user_id uuid, channel notification_channel, recipient_address text, subject text, body text, task_id uuid, equipment_id uuid, reservation_id uuid, attempts integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
#variable_conflict use_column
DECLARE
  stored_event_type text;
BEGIN
  IF p_commands IS NULL OR jsonb_typeof(p_commands) <> 'array' THEN
    RAISE EXCEPTION 'Команды доставки должны быть JSON-массивом'
      USING ERRCODE = '22023';
  END IF;
  SELECT event.event_type INTO stored_event_type
    FROM public.integration_outbox event
   WHERE event.id = p_event_id;
  IF stored_event_type IS NULL THEN
    RAISE EXCEPTION 'Событие outbox не найдено'
      USING ERRCODE = '23503';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_commands) item(value)
     WHERE item.value ->> 'eventCode' <> stored_event_type
        OR nullif(btrim(item.value ->> 'idempotencyKey'), '') IS NULL
        OR nullif(btrim(item.value ->> 'recipientAddress'), '') IS NULL
        OR nullif(btrim(item.value ->> 'body'), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'Команда доставки не соответствует событию outbox'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.notifications (
    idempotency_key, event_code, recipient_user_id, channel,
    recipient_address, subject, body, task_id, equipment_id,
    reservation_id, outbox_event_id, status
  )
  SELECT value ->> 'idempotencyKey', value ->> 'eventCode',
         nullif(value ->> 'recipientUserId', '')::uuid,
         (value ->> 'channel')::public.notification_channel,
         value ->> 'recipientAddress', coalesce(value ->> 'subject', ''),
         value ->> 'body', nullif(value ->> 'taskId', '')::uuid,
         nullif(value ->> 'equipmentId', '')::uuid,
         nullif(value ->> 'reservationId', '')::uuid, p_event_id, 'queued'
    FROM jsonb_array_elements(p_commands) item(value)
  ON CONFLICT (idempotency_key) DO NOTHING;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_commands) item(value)
      LEFT JOIN public.notifications notification
        ON notification.idempotency_key = item.value ->> 'idempotencyKey'
       AND notification.outbox_event_id = p_event_id
     WHERE notification.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Idempotency key доставки уже занят другим событием'
      USING ERRCODE = '23505';
  END IF;

  RETURN QUERY
  SELECT notification.id, notification.outbox_event_id,
         notification.idempotency_key, notification.event_code,
         notification.recipient_user_id, notification.channel,
         notification.recipient_address, notification.subject, notification.body,
         notification.task_id, notification.equipment_id,
         notification.reservation_id, notification.attempts
    FROM public.notifications notification
   WHERE notification.outbox_event_id = p_event_id
     AND notification.status IN ('queued', 'failed')
   ORDER BY notification.created_at, notification.id;
END
$function$;

CREATE OR REPLACE FUNCTION public.stage_event_notifications(p_event_id uuid, p_commands jsonb, p_now timestamp with time zone)
 RETURNS TABLE(id uuid, outbox_event_id uuid, idempotency_key text, event_code text, recipient_user_id uuid, channel notification_channel, recipient_address text, subject text, body text, task_id uuid, equipment_id uuid, reservation_id uuid, attempts integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
#variable_conflict use_column
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'Время восстановления доставки обязательно'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.notifications notification
     SET status = 'failed',
         last_error = 'notification_delivery_lease_expired',
         scheduled_at = p_now,
         retry_allowed = false
   WHERE notification.outbox_event_id = p_event_id
     AND notification.status = 'sending'
     AND notification.scheduled_at <= p_now;

  PERFORM 1 FROM public.stage_event_notifications(p_event_id, p_commands);

  -- Только что созданные доставки получают время базы, которое позже p_now
  -- обработчика. Без выравнивания они не попадали в отправку, а событие
  -- считалось обработанным, и уведомление навсегда оставалось в очереди.
  UPDATE public.notifications notification
     SET scheduled_at = p_now
   WHERE notification.outbox_event_id = p_event_id
     AND notification.status = 'queued'
     AND notification.attempts = 0
     AND notification.scheduled_at > p_now;

  RETURN QUERY
  SELECT notification.id, notification.outbox_event_id, notification.idempotency_key,
         notification.event_code, notification.recipient_user_id, notification.channel,
         notification.recipient_address, notification.subject, notification.body,
         notification.task_id, notification.equipment_id, notification.reservation_id,
         notification.attempts
    FROM public.notifications notification
   WHERE notification.outbox_event_id = p_event_id
     AND notification.status IN ('queued', 'failed')
     AND notification.scheduled_at <= p_now
     AND notification.retry_allowed
   ORDER BY notification.created_at, notification.id;
END
$function$;
