-- Событие «Задача просрочена» по дню компании (Москва), а не по часовому поясу сервера базы.
--
-- Доска, фильтр «Просроченные», страница инженеров и отчёты считают просрочку от сегодняшнего
-- дня по Москве. База брала день из p_now в поясе сервера (на стенде UTC), поэтому письмо и
-- сообщение в Telegram о просрочке уходили только после 03:00 по Москве, хотя на экране задача
-- была просроченной с полуночи. Теперь день берётся по Москве, на любом сервере одинаково.
--
-- Ключ события прежний (задача и срок), поэтому повторных писем по уже отправленным
-- просрочкам не будет. Права на функцию прежние: вызывает только служба (medtech_worker).

CREATE OR REPLACE FUNCTION public.enqueue_overdue_task_events(p_now timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  inserted_count integer;
BEGIN
  WITH overdue AS (
    SELECT task.id, task.deadline_to
      FROM public.tasks task
     WHERE public.service_task_is_overdue(task.deadline_to, task.status_code, (p_now AT TIME ZONE 'Europe/Moscow')::date)
  ), inserted AS (
    INSERT INTO public.integration_outbox (
      idempotency_key, aggregate_type, aggregate_id, event_type, event_version,
      payload, status, available_at, occurred_at
    )
    SELECT 'task_overdue:' || overdue.id::text || ':' || overdue.deadline_to::text,
           'task', overdue.id, 'task_overdue', catalog.current_version,
           jsonb_build_object('taskId', overdue.id, 'periodTo', overdue.deadline_to),
           'queued', p_now, p_now
      FROM overdue
      JOIN public.business_event_catalog catalog ON catalog.code = 'task_overdue' AND catalog.is_active
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer INTO inserted_count FROM inserted;
  RETURN inserted_count;
END
$$;

REVOKE ALL ON FUNCTION public.enqueue_overdue_task_events(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_overdue_task_events(timestamptz) FROM medtech_api, medtech_backup;
GRANT EXECUTE ON FUNCTION public.enqueue_overdue_task_events(timestamptz) TO medtech_worker;
COMMENT ON FUNCTION public.enqueue_overdue_task_events(timestamptz) IS
  'События «Задача просрочена» для службы: просрочка по дню компании (Москва), одно событие на задачу и срок (0027).';
