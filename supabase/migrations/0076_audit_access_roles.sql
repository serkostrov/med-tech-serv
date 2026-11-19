-- 0076: журнал изменений доступа (встреча 19.11, пункт 9).
--
-- Сотрудники (users) в журнал попадали и раньше: создание, роль, отключение. Роли и их права
-- (access_roles, access_role_permissions) — нет: кто и когда дал роли право, видно не было.
-- Теперь их изменения пишет тот же write_audit_row, объект — «user» («Сотрудники и права»
-- в журнале), чтобы все изменения доступа отбирались одним фильтром и шли во вкладку «Доступ и права».
--
-- Обе функции — копии из 0001 с одной добавленной строкой (больше их нигде не меняли).
-- Права роли пишутся под ключом роли: все галочки одной роли — один объект журнала.

CREATE OR REPLACE FUNCTION public.audit_entity_type_for_table(p_table_name text, p_row jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_table_name IN (
      'tasks', 'task_status_history', 'task_assignments', 'task_closures', 'task_parts',
      'maintenance_plans'
    ) THEN 'task'
    WHEN p_table_name IN (
      'equipment', 'equipment_site_history', 'equipment_payer_history',
      'equipment_meter_readings', 'equipment_history'
    ) THEN 'equipment'
    WHEN p_table_name IN (
      'invoices', 'invoice_items', 'invoice_tasks', 'invoice_adjustments', 'invoice_status_history'
    ) THEN 'invoice'
    WHEN p_table_name IN (
      'parts', 'part_aliases', 'stock_lots', 'stock_reservations',
      'stock_reservation_history', 'stock_movements', 'contract_parts'
    ) THEN 'warehouse'
    WHEN p_table_name IN (
      'mail_messages', 'integration_messages', 'integration_outbox',
      'notifications', 'notification_templates', 'notification_preferences'
    ) THEN 'integration'
    WHEN p_table_name = 'files' AND p_row ->> 'task_id' IS NOT NULL THEN 'task'
    WHEN p_table_name = 'files' AND p_row ->> 'equipment_id' IS NOT NULL THEN 'equipment'
    WHEN p_table_name IN ('users', 'access_roles', 'access_role_permissions') THEN 'user'
    WHEN p_table_name IN ('audit_log') THEN 'audit'
    WHEN p_table_name IN (
      'work_types', 'manufacturers', 'equipment_models', 'guarantee_categories',
      'equipment_statuses', 'task_statuses', 'task_status_transitions', 'task_reasons',
      'organizations', 'sites', 'site_contacts', 'payers', 'price_list',
      'contracts', 'contract_equipment', 'quotes', 'quote_items', 'permissions',
      'role_permissions'
    ) THEN 'reference'
    ELSE p_table_name
  END
$$;

CREATE OR REPLACE FUNCTION public.audit_entity_id_for_row(p_table_name text, p_row jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_table_name
    WHEN 'task_status_history' THEN coalesce(p_row ->> 'task_id', 'unknown')
    WHEN 'task_assignments' THEN coalesce(p_row ->> 'task_id', 'unknown')
    WHEN 'task_closures' THEN coalesce(p_row ->> 'task_id', 'unknown')
    WHEN 'task_parts' THEN coalesce(p_row ->> 'task_id', 'unknown')
    WHEN 'maintenance_plans' THEN coalesce(p_row ->> 'equipment_id', p_row ->> 'id', 'unknown')
    WHEN 'equipment_site_history' THEN coalesce(p_row ->> 'equipment_id', 'unknown')
    WHEN 'equipment_payer_history' THEN coalesce(p_row ->> 'equipment_id', 'unknown')
    WHEN 'equipment_meter_readings' THEN coalesce(p_row ->> 'equipment_id', 'unknown')
    WHEN 'equipment_history' THEN coalesce(p_row ->> 'equipment_id', 'unknown')
    WHEN 'invoice_items' THEN coalesce(p_row ->> 'invoice_id', 'unknown')
    WHEN 'invoice_tasks' THEN coalesce(p_row ->> 'invoice_id', 'unknown')
    WHEN 'invoice_adjustments' THEN coalesce(p_row ->> 'invoice_id', 'unknown')
    WHEN 'invoice_status_history' THEN coalesce(p_row ->> 'invoice_id', 'unknown')
    WHEN 'stock_reservation_history' THEN coalesce(p_row ->> 'reservation_id', 'unknown')
    WHEN 'contract_equipment' THEN coalesce(p_row ->> 'contract_id', 'unknown')
    WHEN 'contract_parts' THEN coalesce(p_row ->> 'contract_id', 'unknown')
    WHEN 'quote_items' THEN coalesce(p_row ->> 'quote_id', 'unknown')
    WHEN 'role_permissions' THEN concat_ws(':', p_row ->> 'role', p_row ->> 'permission_code')
    WHEN 'access_roles' THEN coalesce(p_row ->> 'key', 'unknown')
    WHEN 'access_role_permissions' THEN coalesce(p_row ->> 'role_key', 'unknown')
    WHEN 'task_status_transitions' THEN concat_ws('->', p_row ->> 'from_status', p_row ->> 'to_status')
    ELSE coalesce(
      p_row ->> 'id',
      p_row ->> 'code',
      p_row ->> 'number',
      p_row ->> 'external_message_id',
      p_row ->> 'idempotency_key',
      'unknown'
    )
  END
$$;

DROP TRIGGER IF EXISTS audit_access_roles ON public.access_roles;
CREATE TRIGGER audit_access_roles
  AFTER INSERT OR UPDATE OR DELETE ON public.access_roles
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_row();

DROP TRIGGER IF EXISTS audit_access_role_permissions ON public.access_role_permissions;
CREATE TRIGGER audit_access_role_permissions
  AFTER INSERT OR UPDATE OR DELETE ON public.access_role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_row();
