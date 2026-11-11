-- Смена инженера у назначенной задачи или задачи в работе: новый инженер получает
-- то же уведомление «Инженер назначен», что и при первом назначении.
-- Раньше событие ставилось только при смене статуса, и о смене инженера никто не узнавал.

CREATE OR REPLACE FUNCTION enqueue_task_business_events()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event_code text;
  event_time timestamptz;
  event_payload jsonb;
BEGIN
  event_payload := jsonb_strip_nulls(jsonb_build_object(
    'taskId', NEW.id,
    'taskNumber', NEW.number,
    'engineerId', NEW.engineer_id,
    'initiatorId', NEW.initiator_id,
    'siteId', NEW.site_id,
    'periodFrom', NEW.deadline_from,
    'periodTo', NEW.deadline_to
  ));

  IF TG_OP = 'INSERT' AND NEW.status_code IN ('new', 'assigned') THEN
    event_time := NEW.created_at;
    PERFORM enqueue_business_event(
      'task_application_accepted:' || NEW.id::text || ':'
        || floor(extract(epoch FROM event_time) * 1000000)::bigint::text,
      'task', NEW.id, 'task_application_accepted', event_payload, event_time
    );
    IF NEW.status_code = 'assigned' THEN
      PERFORM enqueue_business_event(
        'task_engineer_assigned:' || NEW.id::text || ':'
          || floor(extract(epoch FROM event_time) * 1000000)::bigint::text,
        'task', NEW.id, 'task_engineer_assigned', event_payload, event_time
      );
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' AND OLD.status_code = 'planned' AND NEW.status_code = 'new' THEN
    event_code := 'task_application_accepted';
    event_time := NEW.updated_at;
  ELSIF TG_OP = 'UPDATE' AND OLD.status_code = 'new' AND NEW.status_code = 'assigned' THEN
    event_code := 'task_engineer_assigned';
    event_time := NEW.updated_at;
  ELSIF TG_OP = 'UPDATE' AND OLD.status_code = 'assigned' AND NEW.status_code = 'in_progress' THEN
    event_code := 'task_engineer_accepted';
    event_time := NEW.updated_at;
  ELSIF TG_OP = 'UPDATE' AND OLD.status_code = 'under_review' AND NEW.status_code = 'closed' THEN
    event_code := 'task_work_completed';
    event_time := NEW.updated_at;
  ELSIF TG_OP = 'UPDATE' AND OLD.status_code = 'under_review' AND NEW.status_code = 'in_progress' THEN
    event_code := 'task_rework_requested';
    event_time := NEW.updated_at;
  ELSIF TG_OP = 'UPDATE'
        AND OLD.status_code = NEW.status_code
        AND NEW.status_code IN ('assigned', 'in_progress')
        AND NEW.engineer_id IS NOT NULL
        AND OLD.engineer_id IS DISTINCT FROM NEW.engineer_id THEN
    event_code := 'task_engineer_assigned';
    event_time := coalesce(NEW.updated_at, now());
  ELSE
    RETURN NEW;
  END IF;

  IF event_code = 'task_rework_requested' THEN
    event_payload := event_payload || jsonb_build_object('reworkComment', NEW.rework_comment);
  END IF;

  PERFORM enqueue_business_event(
    event_code || ':' || NEW.id::text || ':'
      || floor(extract(epoch FROM event_time) * 1000000)::bigint::text,
    'task', NEW.id, event_code, event_payload, event_time
  );
  RETURN NEW;
END
$$;

-- Триггер теперь срабатывает и на смену инженера, а не только статуса.
DROP TRIGGER IF EXISTS tasks_enqueue_business_events ON tasks;
CREATE TRIGGER tasks_enqueue_business_events
AFTER INSERT OR UPDATE OF status_code, engineer_id ON tasks
FOR EACH ROW EXECUTE FUNCTION enqueue_task_business_events();
