-- Права по ролям на уровне базы (ТЗ, раздел 2: «права разграничиваются на уровне API,
-- инженер не может получить цены и финансовые данные никаким запросом»).
--
-- До этой миграции на всех таблицах была одна политика app_user_all: любой активный
-- сотрудник читал и менял всё. Теперь доступ строится на разрешениях ролей
-- (access_roles / access_role_permissions), которые администратор настраивает в интерфейсе.
--
-- Служебные триггеры (журнал аудита, история статусов, очередь событий, квоты файлов)
-- выполняются от владельца схемы: проверка прав делается на самом действии пользователя,
-- а служебные записи пишутся всегда.

-- ---------------------------------------------------------------------------
-- 1. Функции проверки прав
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.app_has_permission(p_code text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.users AS u
      JOIN public.access_roles AS r
        ON r.key = coalesce(u.access_role_key, CASE WHEN u.role::text = 'manager' THEN 'initiator' ELSE u.role::text END)
       AND r.is_active
      JOIN public.access_role_permissions AS p
        ON p.role_key = r.key
     WHERE u.id = auth.uid()
       AND u.is_active
       AND p.permission_code = p_code
  );
$$;

CREATE OR REPLACE FUNCTION public.app_has_any_permission(p_codes text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.users AS u
      JOIN public.access_roles AS r
        ON r.key = coalesce(u.access_role_key, CASE WHEN u.role::text = 'manager' THEN 'initiator' ELSE u.role::text END)
       AND r.is_active
      JOIN public.access_role_permissions AS p
        ON p.role_key = r.key
     WHERE u.id = auth.uid()
       AND u.is_active
       AND p.permission_code = ANY (p_codes)
  );
$$;

-- Задача видна: всем, кто видит все задачи или финансы (для счетов);
-- инженеру и инициатору — только свои; кладовщику — задачи с его резервами.
CREATE OR REPLACE FUNCTION public.app_can_read_task(p_task_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.app_has_any_permission(ARRAY['tasks.read_all', 'finance.read'])
      OR EXISTS (
           SELECT 1
             FROM public.tasks AS t
            WHERE t.id = p_task_id
              AND public.app_has_permission('tasks.read_own')
              AND auth.uid() IN (t.engineer_id, t.initiator_id, t.created_by)
         )
      OR (
           public.app_has_permission('warehouse.write')
           AND EXISTS (SELECT 1 FROM public.stock_reservations AS r WHERE r.task_id = p_task_id)
         )
      OR (
           public.app_has_permission('tasks.read_organization')
           AND EXISTS (
                 SELECT 1
                   FROM public.tasks AS t
                   LEFT JOIN public.sites AS s ON s.id = t.site_id
                   JOIN public.customer_organization_access AS a
                     ON a.organization_id = coalesce(t.organization_id, s.organization_id)
                  WHERE t.id = p_task_id
                    AND a.customer_user_id = auth.uid()
               )
         );
$$;

-- Менять задачу: координатор и руководитель (tasks.write) — любую;
-- инженер — свою (принять, закрыть, заполнить акт); инициатор — созданную им.
CREATE OR REPLACE FUNCTION public.app_can_write_task(p_task_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.app_has_permission('tasks.write')
      OR EXISTS (
           SELECT 1
             FROM public.tasks AS t
            WHERE t.id = p_task_id
              AND (
                (t.engineer_id = auth.uid()
                  AND public.app_has_any_permission(ARRAY['tasks.write_own', 'tasks.accept', 'tasks.close']))
                OR (auth.uid() IN (t.initiator_id, t.created_by)
                  AND public.app_has_permission('tasks.write_own'))
              )
         );
$$;

CREATE OR REPLACE FUNCTION public.app_can_read_equipment()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.app_has_any_permission(ARRAY[
    'equipment.read', 'equipment.write', 'tasks.read_all', 'tasks.create', 'references.write'
  ]);
$$;

CREATE OR REPLACE FUNCTION public.app_can_write_equipment()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.app_has_any_permission(ARRAY['equipment.write', 'tasks.write', 'references.write']);
$$;

-- Файлы в Storage: задачи лежат как tasks/<task_id>/..., приборы как <equipment_id>/...
CREATE OR REPLACE FUNCTION public.app_storage_object_access(p_name text, p_write boolean)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  first_part text := split_part(coalesce(p_name, ''), '/', 1);
  target_id uuid;
BEGIN
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

REVOKE ALL ON FUNCTION public.app_has_permission(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_has_any_permission(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_can_read_task(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_can_write_task(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_can_read_equipment() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_can_write_equipment() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_storage_object_access(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_has_permission(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_has_any_permission(text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_can_read_task(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_can_write_task(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_can_read_equipment() TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_can_write_equipment() TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_storage_object_access(text, boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Служебные триггеры выполняются от владельца схемы
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
      FROM pg_proc AS p
      JOIN pg_namespace AS n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prorettype = 'trigger'::regtype
       AND NOT p.prosecdef
  LOOP
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER SET search_path = public, pg_temp', fn.signature);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Политики доступа
-- ---------------------------------------------------------------------------

-- Снимаем общую политику «всё всем».
DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS app_user_all ON public.%I', tbl);
  END LOOP;
END
$$;

-- Хелпер: создать политики для набора таблиц по шаблонам условий.
-- read / ins / upd / del — SQL-условия; NULL означает «операция запрещена».
CREATE OR REPLACE FUNCTION pg_temp.apply_policies(
  p_tables text[], p_read text, p_ins text, p_upd text, p_del text
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY p_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS role_read ON public.%I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS role_insert ON public.%I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS role_update ON public.%I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS role_delete ON public.%I', tbl);
    IF p_read IS NOT NULL THEN
      EXECUTE format('CREATE POLICY role_read ON public.%I FOR SELECT TO authenticated USING (%s)', tbl, p_read);
    END IF;
    IF p_ins IS NOT NULL THEN
      EXECUTE format('CREATE POLICY role_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (%s)', tbl, p_ins);
    END IF;
    IF p_upd IS NOT NULL THEN
      EXECUTE format('CREATE POLICY role_update ON public.%I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)', tbl, p_upd, p_upd);
    END IF;
    IF p_del IS NOT NULL THEN
      EXECUTE format('CREATE POLICY role_delete ON public.%I FOR DELETE TO authenticated USING (%s)', tbl, p_del);
    END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  app_user constant text := '(SELECT public.is_app_user())';
  refs_write constant text := '(SELECT public.app_has_permission(''references.write''))';
  equip_read constant text := '(SELECT public.app_can_read_equipment())';
  equip_write constant text := '(SELECT public.app_can_write_equipment())';
  task_read constant text := 'public.app_can_read_task(task_id)';
  task_write constant text := 'public.app_can_write_task(task_id)';
  finance_read constant text := '(SELECT public.app_has_permission(''finance.read''))';
  finance_write constant text := '(SELECT public.app_has_permission(''finance.write''))';
  contracts_read constant text := '(SELECT public.app_has_any_permission(ARRAY[''finance.read'', ''contracts.write'']))';
  contracts_write constant text := '(SELECT public.app_has_permission(''contracts.write''))';
  wh_read constant text := '(SELECT public.app_has_any_permission(ARRAY[''warehouse.read'', ''warehouse.write'', ''tasks.read_all'']))';
  wh_write constant text := '(SELECT public.app_has_permission(''warehouse.write''))';
  audit_read constant text := '(SELECT public.app_has_permission(''audit.read''))';
  users_write constant text := '(SELECT public.app_has_permission(''users.write''))';
  roles_write constant text := '(SELECT public.app_has_any_permission(ARRAY[''roles.write'', ''users.write'']))';
BEGIN
  -- Справочники: читают все сотрудники, меняет тот, у кого references.write.
  PERFORM pg_temp.apply_policies(
    ARRAY['manufacturers', 'equipment_models', 'guarantee_categories', 'equipment_statuses', 'work_types',
          'task_statuses', 'task_status_transitions', 'task_reasons', 'organizations'],
    app_user, refs_write, refs_write, refs_write);

  -- Клиенты и плательщики: читают все, меняют координаторы и справочники.
  PERFORM pg_temp.apply_policies(
    ARRAY['sites', 'site_contacts', 'site_payers', 'payers'],
    app_user,
    '(SELECT public.app_has_any_permission(ARRAY[''references.write'', ''tasks.write'']))',
    '(SELECT public.app_has_any_permission(ARRAY[''references.write'', ''tasks.write'']))',
    '(SELECT public.app_has_any_permission(ARRAY[''references.write'', ''tasks.write'']))');

  PERFORM pg_temp.apply_policies(ARRAY['business_event_catalog'], app_user, NULL, NULL, NULL);

  PERFORM pg_temp.apply_policies(
    ARRAY['notification_templates'],
    app_user,
    '(SELECT public.app_has_any_permission(ARRAY[''notification_settings.write'', ''references.write'']))',
    '(SELECT public.app_has_any_permission(ARRAY[''notification_settings.write'', ''references.write'']))',
    '(SELECT public.app_has_any_permission(ARRAY[''notification_settings.write'', ''references.write'']))');

  -- Приборы и их история.
  PERFORM pg_temp.apply_policies(
    ARRAY['equipment', 'equipment_site_history', 'equipment_payer_history'],
    equip_read, equip_write, equip_write, equip_write);
  PERFORM pg_temp.apply_policies(
    ARRAY['equipment_history', 'equipment_meter_readings'],
    equip_read,
    '(' || equip_write || ' OR (task_id IS NOT NULL AND public.app_can_write_task(task_id)))',
    equip_write, equip_write);
  PERFORM pg_temp.apply_policies(
    ARRAY['maintenance_plans'],
    equip_read,
    '(SELECT public.app_has_any_permission(ARRAY[''tasks.write'', ''tasks.assign'']))',
    '(SELECT public.app_has_any_permission(ARRAY[''tasks.write'', ''tasks.assign'']))',
    '(SELECT public.app_has_any_permission(ARRAY[''tasks.write'', ''tasks.assign'']))');

  -- Задачи.
  PERFORM pg_temp.apply_policies(
    ARRAY['tasks'],
    'public.app_can_read_task(id)',
    '(SELECT public.app_has_any_permission(ARRAY[''tasks.create'', ''tasks.write'']))',
    'public.app_can_write_task(id)',
    '(SELECT public.app_has_permission(''tasks.write''))');
  PERFORM pg_temp.apply_policies(
    ARRAY['task_parts', 'task_closures', 'task_status_history', 'task_assignments', 'task_file_quotas'],
    task_read, task_write, task_write, task_write);

  -- Файлы: по задаче или прибору; финансовые документы только с finance.read.
  PERFORM pg_temp.apply_policies(
    ARRAY['files'],
    '((CASE WHEN task_id IS NOT NULL THEN public.app_can_read_task(task_id) ELSE ' || equip_read || ' END)'
      || ' AND (NOT is_financial OR ' || finance_read || '))',
    '(CASE WHEN task_id IS NOT NULL THEN public.app_can_write_task(task_id) ELSE ' || equip_write || ' END)',
    '(CASE WHEN task_id IS NOT NULL THEN public.app_can_write_task(task_id) ELSE ' || equip_write || ' END)',
    '(CASE WHEN task_id IS NOT NULL THEN public.app_can_write_task(task_id) ELSE ' || equip_write || ' END)');

  -- Финансы: инженер и кладовщик не видят ничего.
  PERFORM pg_temp.apply_policies(
    ARRAY['invoices', 'invoice_tasks', 'invoice_items', 'invoice_adjustments', 'invoice_status_history'],
    finance_read, finance_write, finance_write, finance_write);
  PERFORM pg_temp.apply_policies(
    ARRAY['contracts', 'contract_equipment', 'contract_parts', 'quotes', 'quote_items'],
    contracts_read, contracts_write, contracts_write, contracts_write);
  PERFORM pg_temp.apply_policies(
    ARRAY['price_list'],
    '(SELECT public.app_has_any_permission(ARRAY[''price.read'', ''finance.read'']))',
    '(SELECT public.app_has_permission(''price.write''))',
    '(SELECT public.app_has_permission(''price.write''))',
    '(SELECT public.app_has_permission(''price.write''))');

  -- Склад.
  PERFORM pg_temp.apply_policies(
    ARRAY['parts', 'part_aliases', 'stock_lots', 'stock_movements', 'stock_reservations', 'stock_reservation_history'],
    wh_read, wh_write, wh_write, wh_write);

  -- Сотрудники, роли, компетенции.
  PERFORM pg_temp.apply_policies(
    ARRAY['users'],
    app_user,
    users_write,
    '(' || users_write || ' OR ((SELECT public.app_has_permission(''tasks.assign'')) AND role = ''engineer''))',
    users_write);
  PERFORM pg_temp.apply_policies(
    ARRAY['access_roles', 'access_role_permissions', 'permissions', 'role_permissions'],
    app_user, roles_write, roles_write, roles_write);
  PERFORM pg_temp.apply_policies(
    ARRAY['engineer_competencies'],
    app_user,
    '(SELECT public.app_has_any_permission(ARRAY[''users.write'', ''tasks.assign'']))',
    '(SELECT public.app_has_any_permission(ARRAY[''users.write'', ''tasks.assign'']))',
    '(SELECT public.app_has_any_permission(ARRAY[''users.write'', ''tasks.assign'']))');
  PERFORM pg_temp.apply_policies(ARRAY['customer_organization_access'], users_write, users_write, users_write, users_write);

  -- Уведомления: свои видит каждый, все — координатор, руководитель и настройщик уведомлений.
  PERFORM pg_temp.apply_policies(
    ARRAY['notifications'],
    '((SELECT public.app_has_permission(''notifications.read'')) AND (recipient_user_id = (SELECT auth.uid())'
      || ' OR (SELECT public.app_has_any_permission(ARRAY[''tasks.read_all'', ''audit.read'', ''notification_settings.write'']))))',
    NULL,
    '(SELECT public.app_has_permission(''notification_settings.write''))',
    NULL);
  PERFORM pg_temp.apply_policies(
    ARRAY['notification_preferences'],
    '(user_id = (SELECT auth.uid()) OR (SELECT public.app_has_permission(''notification_settings.write'')))',
    '(user_id = (SELECT auth.uid()) OR (SELECT public.app_has_permission(''notification_settings.write'')))',
    '(user_id = (SELECT auth.uid()) OR (SELECT public.app_has_permission(''notification_settings.write'')))',
    '(user_id = (SELECT auth.uid()) OR (SELECT public.app_has_permission(''notification_settings.write'')))');

  -- Почта: разбирают координаторы.
  PERFORM pg_temp.apply_policies(
    ARRAY['mail_messages'],
    '(SELECT public.app_has_any_permission(ARRAY[''tasks.read_all'', ''tasks.assign'']))',
    NULL,
    '(SELECT public.app_has_any_permission(ARRAY[''tasks.read_all'', ''tasks.assign'']))',
    NULL);

  -- Журналы и интеграции: читает аудит, пишут только служебные функции.
  PERFORM pg_temp.apply_policies(
    ARRAY['audit_log', 'login_events', 'integration_messages', 'integration_outbox'],
    audit_read, NULL, NULL, NULL);

  -- Учётные данные, сессии и тестовые наборы импорта клиенту недоступны.
  PERFORM pg_temp.apply_policies(
    ARRAY['user_credentials', 'user_sessions', 'import_test_datasets', 'import_test_equipment',
          'import_test_equipment_history', 'import_test_records'],
    NULL, NULL, NULL, NULL);
END
$$;

-- Таблицы, созданные позже миграцией 0005 со своей политикой app_user_all.
DROP POLICY IF EXISTS app_user_all ON public.site_payers;

-- Все таблицы схемы должны иметь RLS: новая таблица без политик закрыта по умолчанию.
DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. Ограничение полей
-- ---------------------------------------------------------------------------

-- Без tasks.write нельзя менять назначение, клиента, плательщика, сроки и связи задачи.
CREATE OR REPLACE FUNCTION public.guard_task_restricted_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.app_has_permission('tasks.write') THEN
    RETURN NEW;
  END IF;
  IF NEW.engineer_id IS DISTINCT FROM OLD.engineer_id
     OR NEW.site_id IS DISTINCT FROM OLD.site_id
     OR NEW.equipment_id IS DISTINCT FROM OLD.equipment_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.payer_id IS DISTINCT FROM OLD.payer_id
     OR NEW.payer_name IS DISTINCT FROM OLD.payer_name
     OR NEW.payer_requisites IS DISTINCT FROM OLD.payer_requisites
     OR NEW.inherited_payer_id IS DISTINCT FROM OLD.inherited_payer_id
     OR NEW.payer_override_reason IS DISTINCT FROM OLD.payer_override_reason
     OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
     OR NEW.initiator_id IS DISTINCT FROM OLD.initiator_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.priority IS DISTINCT FROM OLD.priority
     OR NEW.deadline_from IS DISTINCT FROM OLD.deadline_from
     OR NEW.deadline_to IS DISTINCT FROM OLD.deadline_to
     OR NEW.maintenance_plan_id IS DISTINCT FROM OLD.maintenance_plan_id
     OR NEW.primary_task_id IS DISTINCT FROM OLD.primary_task_id
  THEN
    RAISE EXCEPTION 'Недостаточно прав: назначение, клиента, плательщика и сроки задачи меняет координатор'
      USING ERRCODE = '42501';
  END IF;
  -- Статус без tasks.write: инженер принимает задачу и сдаёт её на проверку,
  -- инициатор отменяет ещё не взятую в работу. Закрывает и возвращает на доработку координатор.
  IF NEW.status_code IS DISTINCT FROM OLD.status_code THEN
    IF NOT coalesce(
         (public.app_has_permission('tasks.accept')
            AND OLD.status_code = 'assigned' AND NEW.status_code = 'in_progress')
      OR (public.app_has_permission('tasks.close')
            AND OLD.status_code IN ('in_progress', 'rework') AND NEW.status_code = 'under_review')
      OR (public.app_has_permission('tasks.review')
            AND OLD.status_code = 'under_review' AND NEW.status_code IN ('closed', 'in_progress'))
      OR (public.app_has_permission('tasks.write_own')
            AND auth.uid() IN (OLD.initiator_id, OLD.created_by)
            AND OLD.status_code IN ('planned', 'new') AND NEW.status_code = 'cancelled'),
         false
    ) THEN
      RAISE EXCEPTION 'Недостаточно прав: перевести задачу из «%» в «%» может только координатор', OLD.status_code, NEW.status_code
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS tasks_guard_restricted_columns ON public.tasks;
CREATE TRIGGER tasks_guard_restricted_columns
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.guard_task_restricted_columns();

-- Без users.write нельзя менять роль, e-mail и привязку сотрудника.
CREATE OR REPLACE FUNCTION public.guard_user_restricted_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.app_has_permission('users.write') THEN
    RETURN NEW;
  END IF;
  IF NEW.role IS DISTINCT FROM OLD.role
     OR NEW.access_role_key IS DISTINCT FROM OLD.access_role_key
     OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.site_id IS DISTINCT FROM OLD.site_id
  THEN
    RAISE EXCEPTION 'Недостаточно прав: роль и учётные данные сотрудника меняет администратор'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS users_guard_restricted_columns ON public.users;
CREATE TRIGGER users_guard_restricted_columns
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.guard_user_restricted_columns();

-- ---------------------------------------------------------------------------
-- 5. Файлы в Storage
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    EXECUTE 'DROP POLICY IF EXISTS medtech_files_all ON storage.objects';
    EXECUTE 'DROP POLICY IF EXISTS medtech_files_read ON storage.objects';
    EXECUTE 'DROP POLICY IF EXISTS medtech_files_insert ON storage.objects';
    EXECUTE 'DROP POLICY IF EXISTS medtech_files_update ON storage.objects';
    EXECUTE 'DROP POLICY IF EXISTS medtech_files_delete ON storage.objects';
    EXECUTE $p$CREATE POLICY medtech_files_read ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'medtech-files' AND public.app_storage_object_access(name, false))$p$;
    EXECUTE $p$CREATE POLICY medtech_files_insert ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'medtech-files' AND public.app_storage_object_access(name, true))$p$;
    EXECUTE $p$CREATE POLICY medtech_files_update ON storage.objects FOR UPDATE TO authenticated
      USING (bucket_id = 'medtech-files' AND public.app_storage_object_access(name, true))
      WITH CHECK (bucket_id = 'medtech-files' AND public.app_storage_object_access(name, true))$p$;
    EXECUTE $p$CREATE POLICY medtech_files_delete ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id = 'medtech-files' AND public.app_storage_object_access(name, true))$p$;
  EXCEPTION
    WHEN insufficient_privilege THEN
      -- Без этих правил файлы остаются открыты всем сотрудникам: не продолжаем молча.
      RAISE EXCEPTION 'Политики storage.objects не применены (%). Выполните миграцию от владельца storage (supabase_admin).', SQLERRM;
  END;
END
$$;

-- TRUNCATE, TRIGGER и REFERENCES идут в обход правил строк. Ролям API они не нужны.
REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLES FROM anon, authenticated;

-- Принять закрытие может только тот, у кого есть право проверки.
CREATE OR REPLACE FUNCTION public.guard_accept_task_closure()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NOT NULL
     AND NOT public.app_has_any_permission(ARRAY['tasks.review', 'tasks.write'])
     AND NEW.verified_at IS NOT NULL
     AND NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
    RAISE EXCEPTION 'Недостаточно прав: акт принимает координатор'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS task_closures_guard_accept ON public.task_closures;
CREATE TRIGGER task_closures_guard_accept
  BEFORE UPDATE ON public.task_closures
  FOR EACH ROW EXECUTE FUNCTION public.guard_accept_task_closure();
