-- Инициатор заявки — человек из справочника «Клиенты» (контакт площадки).

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS initiator_contact_id uuid REFERENCES site_contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS initiator_name text;

CREATE INDEX IF NOT EXISTS tasks_initiator_contact_idx
  ON tasks (initiator_contact_id)
  WHERE initiator_contact_id IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_task_initiator_contact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  selected_contact site_contacts%ROWTYPE;
  initiator_changed boolean;
  site_changed boolean;
BEGIN
  initiator_changed := TG_OP = 'INSERT'
    OR NEW.initiator_contact_id IS DISTINCT FROM OLD.initiator_contact_id;
  site_changed := TG_OP = 'INSERT'
    OR NEW.site_id IS DISTINCT FROM OLD.site_id;

  IF NEW.initiator_contact_id IS NULL THEN
    IF initiator_changed THEN
      NEW.initiator_name := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.site_id IS NULL THEN
    RAISE EXCEPTION 'Инициатора задачи нельзя выбрать без площадки'
      USING ERRCODE = '23514';
  END IF;

  IF initiator_changed OR site_changed THEN
    SELECT * INTO selected_contact FROM site_contacts WHERE id = NEW.initiator_contact_id;
    IF NOT FOUND OR selected_contact.site_id <> NEW.site_id THEN
      RAISE EXCEPTION 'Инициатор задачи не относится к выбранной площадке'
        USING ERRCODE = '23514';
    END IF;
    NEW.initiator_name := selected_contact.full_name;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS tasks_initiator_contact ON tasks;
CREATE TRIGGER tasks_initiator_contact
  BEFORE INSERT OR UPDATE OF site_id, initiator_contact_id
  ON tasks
  FOR EACH ROW EXECUTE FUNCTION validate_task_initiator_contact();
