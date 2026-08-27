-- Если у прибора нет плательщика, выбор плательщика в задаче — это ручной выбор,
-- а не «замена». Раньше NULL IS DISTINCT FROM <payer_id> требовал причину override.

CREATE OR REPLACE FUNCTION fill_task_customer_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  selected_site sites%ROWTYPE;
  selected_contact site_contacts%ROWTYPE;
  selected_payer payers%ROWTYPE;
  equipment_payer_id uuid;
  site_changed boolean;
  contact_changed boolean;
  payer_changed boolean;
  equipment_changed boolean;
  snapshot_changed boolean;
BEGIN
  site_changed := TG_OP = 'INSERT'
    OR NEW.site_id IS DISTINCT FROM OLD.site_id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id;
  contact_changed := TG_OP = 'INSERT' OR NEW.site_contact_id IS DISTINCT FROM OLD.site_contact_id;
  payer_changed := TG_OP = 'INSERT' OR NEW.payer_id IS DISTINCT FROM OLD.payer_id;
  equipment_changed := TG_OP = 'INSERT' OR NEW.equipment_id IS DISTINCT FROM OLD.equipment_id;
  snapshot_changed := TG_OP = 'UPDATE' AND (
    NEW.payer_name IS DISTINCT FROM OLD.payer_name
    OR NEW.payer_requisites IS DISTINCT FROM OLD.payer_requisites
    OR NEW.inherited_payer_id IS DISTINCT FROM OLD.inherited_payer_id
    OR NEW.payer_snapshot_source IS DISTINCT FROM OLD.payer_snapshot_source
    OR NEW.payer_override_reason IS DISTINCT FROM OLD.payer_override_reason
    OR NEW.payer_overridden_by IS DISTINCT FROM OLD.payer_overridden_by
    OR NEW.payer_overridden_at IS DISTINCT FROM OLD.payer_overridden_at
  );

  IF NEW.site_id IS NULL AND NEW.site_contact_id IS NOT NULL THEN
    RAISE EXCEPTION 'Контакт задачи нельзя выбрать без площадки'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.site_id IS NOT NULL AND site_changed THEN
    SELECT * INTO selected_site FROM sites WHERE id = NEW.site_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Площадка задачи не найдена: %', NEW.site_id
        USING ERRCODE = '23503';
    END IF;
    IF NEW.organization_id IS NOT NULL AND selected_site.organization_id IS NOT NULL
       AND NEW.organization_id <> selected_site.organization_id THEN
      RAISE EXCEPTION 'Организация задачи не соответствует выбранной площадке'
        USING ERRCODE = '23514';
    END IF;
    NEW.organization_id := coalesce(NEW.organization_id, selected_site.organization_id);
    NEW.customer_name := selected_site.name;
    NEW.customer_address := selected_site.address;
  ELSIF NEW.site_id IS NULL AND site_changed THEN
    NEW.customer_name := NULL;
    NEW.customer_address := NULL;
  END IF;

  IF NEW.site_contact_id IS NOT NULL AND (site_changed OR contact_changed) THEN
    SELECT * INTO selected_contact FROM site_contacts WHERE id = NEW.site_contact_id;
    IF NOT FOUND OR selected_contact.site_id <> NEW.site_id THEN
      RAISE EXCEPTION 'Контакт задачи не относится к выбранной площадке'
        USING ERRCODE = '23514';
    END IF;
    NEW.contact_name := selected_contact.full_name;
    NEW.contact_phone := selected_contact.phone;
    NEW.contact_email := selected_contact.email;
  ELSIF NEW.site_contact_id IS NULL AND (site_changed OR contact_changed) THEN
    NEW.contact_name := NULL;
    NEW.contact_phone := NULL;
    NEW.contact_email := NULL;
  END IF;

  IF TG_OP = 'UPDATE' AND snapshot_changed AND NOT payer_changed AND NOT equipment_changed THEN
    RAISE EXCEPTION 'Снимок плательщика задачи нельзя изменить без выбора нового плательщика'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_payer_snapshot_immutable';
  END IF;

  IF payer_changed OR equipment_changed THEN
    equipment_payer_id := NULL;
    IF NEW.equipment_id IS NOT NULL THEN
      SELECT equipment.current_payer_id INTO equipment_payer_id
        FROM equipment
       WHERE equipment.id = NEW.equipment_id
       FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Прибор задачи не найден: %', NEW.equipment_id
          USING ERRCODE = '23503';
      END IF;
    END IF;

    IF NEW.equipment_id IS NOT NULL AND NEW.payer_id IS NULL THEN
      NEW.payer_id := equipment_payer_id;
    END IF;
    NEW.inherited_payer_id := equipment_payer_id;

    IF NEW.equipment_id IS NOT NULL
       AND equipment_payer_id IS NOT NULL
       AND NEW.payer_id IS DISTINCT FROM equipment_payer_id THEN
      IF nullif(btrim(coalesce(NEW.payer_override_reason, '')), '') IS NULL
        OR NEW.payer_overridden_by IS NULL THEN
        RAISE EXCEPTION 'Для замены плательщика задачи обязательны автор и причина'
          USING ERRCODE = '23514', CONSTRAINT = 'tasks_payer_override_audit_required';
      END IF;
      IF NOT actor_can_override_payer(NEW.payer_overridden_by) THEN
        RAISE EXCEPTION 'Недостаточно прав для замены плательщика задачи'
          USING ERRCODE = '42501', CONSTRAINT = 'tasks_payer_override_forbidden';
      END IF;
      NEW.payer_snapshot_source := 'override';
      NEW.payer_override_reason := btrim(NEW.payer_override_reason);
      NEW.payer_overridden_at := coalesce(NEW.payer_overridden_at, clock_timestamp());
    ELSIF NEW.equipment_id IS NOT NULL AND NEW.payer_id IS NOT DISTINCT FROM equipment_payer_id THEN
      NEW.payer_snapshot_source := 'equipment';
      NEW.payer_override_reason := NULL;
      NEW.payer_overridden_by := NULL;
      NEW.payer_overridden_at := NULL;
    ELSE
      NEW.payer_snapshot_source := 'manual';
      NEW.payer_override_reason := NULL;
      NEW.payer_overridden_by := NULL;
      NEW.payer_overridden_at := NULL;
    END IF;

    IF NEW.payer_id IS NOT NULL THEN
      SELECT * INTO selected_payer FROM payers WHERE id = NEW.payer_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Плательщик задачи не найден: %', NEW.payer_id
          USING ERRCODE = '23503';
      END IF;
      NEW.payer_name := selected_payer.name;
      NEW.payer_requisites := coalesce(selected_payer.requisites, '{}'::jsonb);
    ELSE
      NEW.payer_name := NULL;
      NEW.payer_requisites := '{}'::jsonb;
    END IF;
  END IF;

  RETURN NEW;
END
$$;
