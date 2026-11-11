-- Укрепление прав по итогам независимой проверки 0009.
-- Каждый пункт помечен номером из отчёта проверки.

-- ---------------------------------------------------------------------------
-- Хелперы
-- ---------------------------------------------------------------------------

-- Сотрудник (не клиент): активный пользователь с базовой ролью не customer.
CREATE OR REPLACE FUNCTION public.app_is_staff()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users AS u
     WHERE u.id = auth.uid() AND u.is_active AND u.role::text <> 'customer'
  );
$$;

-- Ключ роли текущего пользователя (для чтения своей матрицы прав).
CREATE OR REPLACE FUNCTION public.app_current_role_key()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT coalesce(u.access_role_key, CASE WHEN u.role::text = 'manager' THEN 'initiator' ELSE u.role::text END)
    FROM public.users AS u
   WHERE u.id = auth.uid() AND u.is_active;
$$;

-- Организации, к которым у клиента есть доступ.
CREATE OR REPLACE FUNCTION public.app_customer_organization_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT a.organization_id
    FROM public.customer_organization_access AS a
    JOIN public.users AS u ON u.id = a.customer_user_id AND u.is_active
   WHERE a.customer_user_id = auth.uid();
$$;

-- Задача ещё в работе (не закрыта и не отменена).
CREATE OR REPLACE FUNCTION public.app_task_is_open(p_task_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tasks AS t
     WHERE t.id = p_task_id AND t.status_code NOT IN ('closed', 'cancelled')
  );
$$;

-- Вызывающий — инженер этой задачи.
CREATE OR REPLACE FUNCTION public.app_is_task_engineer(p_task_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.tasks AS t WHERE t.id = p_task_id AND t.engineer_id = auth.uid());
$$;

-- Под задачу можно ставить резерв, пока она в работе (не сдана, не закрыта, не отменена).
CREATE OR REPLACE FUNCTION public.app_task_accepts_reservations(p_task_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tasks AS t
     WHERE t.id = p_task_id AND t.status_code NOT IN ('under_review', 'closed', 'cancelled')
  );
$$;

-- (11) Кладовщику задача видна только пока по ней есть действующий резерв.
CREATE OR REPLACE FUNCTION public.app_can_read_task(p_task_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT public.app_has_any_permission(ARRAY['tasks.read_all', 'finance.read'])
      OR EXISTS (
           SELECT 1 FROM public.tasks AS t
            WHERE t.id = p_task_id
              AND public.app_has_permission('tasks.read_own')
              AND auth.uid() IN (t.engineer_id, t.initiator_id, t.created_by)
         )
      OR (
           public.app_has_permission('warehouse.write')
           AND EXISTS (
                 SELECT 1 FROM public.stock_reservations AS r
                  WHERE r.task_id = p_task_id
                    AND r.status IN ('created', 'warehouse_notified', 'issued')
               )
         )
      OR (
           public.app_has_permission('tasks.read_organization')
           AND EXISTS (
                 SELECT 1 FROM public.tasks AS t
                   LEFT JOIN public.sites AS s ON s.id = t.site_id
                  WHERE t.id = p_task_id
                    AND coalesce(t.organization_id, s.organization_id) IN (SELECT public.app_customer_organization_ids())
               )
         );
$$;

-- (10) Без tasks.write менять задачу и её акт, фото, запчасти можно только пока
-- задача не сдана на проверку, не закрыта и не отменена.
CREATE OR REPLACE FUNCTION public.app_can_write_task(p_task_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT public.app_has_permission('tasks.write')
      OR EXISTS (
           SELECT 1 FROM public.tasks AS t
            WHERE t.id = p_task_id
              AND t.status_code NOT IN ('under_review', 'closed', 'cancelled')
              AND (
                (t.engineer_id = auth.uid()
                  AND public.app_has_any_permission(ARRAY['tasks.write_own', 'tasks.accept', 'tasks.close']))
                OR (auth.uid() IN (t.initiator_id, t.created_by)
                  AND public.app_has_permission('tasks.write_own'))
              )
         );
$$;

-- (5) Финансовые документы в Storage недоступны без finance.read, как и в таблице files.
CREATE OR REPLACE FUNCTION public.app_storage_object_access(p_name text, p_write boolean)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  first_part text := split_part(coalesce(p_name, ''), '/', 1);
  target_id uuid;
BEGIN
  IF NOT p_write
     AND EXISTS (SELECT 1 FROM public.files AS f WHERE f.storage_key = p_name AND f.is_financial)
     AND NOT public.app_has_permission('finance.read') THEN
    RETURN false;
  END IF;
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

-- (1) Приём закрытия: от владельца схемы, с явной проверкой права и автором из сессии.
CREATE OR REPLACE FUNCTION public.accept_task_closure(p_task_id uuid, p_verified_by uuid, p_verification_comment text, p_updated_at timestamp with time zone)
 RETURNS task_closures
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  task_before tasks%ROWTYPE;
  accepted_closure task_closures%ROWTYPE;
  photo_count integer;
BEGIN
  -- Принимает только тот, у кого есть право проверки; проверяющий — сам вызывающий.
  IF auth.uid() IS NOT NULL THEN
    IF NOT public.app_has_permission('tasks.review') THEN
      RAISE EXCEPTION 'Недостаточно прав: акт принимает координатор'
        USING ERRCODE = '42501';
    END IF;
    p_verified_by := auth.uid();
  END IF;

  SELECT * INTO task_before
    FROM tasks
   WHERE id = p_task_id
   FOR UPDATE;

  IF task_before.id IS NULL OR task_before.status_code <> 'under_review' THEN
    RAISE EXCEPTION 'Проверить и закрыть можно только задачу на проверке'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_accept_closure_under_review_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM task_closures closure
      JOIN files act_file
        ON act_file.id = closure.act_file_id
       AND act_file.task_id = closure.task_id
       AND act_file.kind = 'act'
       AND lower(btrim(split_part(act_file.content_type, ';', 1))) IN (
         'image/heic', 'image/heif', 'image/jpeg', 'image/png', 'image/webp'
       )
     WHERE closure.task_id = p_task_id
  ) THEN
    RAISE EXCEPTION 'Для закрытия задачи нужно фото акта'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_accept_closure_act_photo_required';
  END IF;

  SELECT count(*) INTO photo_count
    FROM files
   WHERE task_id = p_task_id AND kind = 'photo';
  IF photo_count < 3 THEN
    RAISE EXCEPTION 'Для закрытия нужны минимум три фото фотофиксации'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_accept_closure_photos_required';
  END IF;

  UPDATE task_closures
     SET verified_by = p_verified_by,
         verified_at = p_updated_at,
         verification_comment = nullif(btrim(p_verification_comment), '')
   WHERE task_id = p_task_id
  RETURNING * INTO accepted_closure;

  IF accepted_closure.task_id IS NULL THEN
    RAISE EXCEPTION 'Акт задачи не найден'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_accept_closure_required';
  END IF;

  UPDATE tasks
     SET status_code = 'closed',
         updated_at = p_updated_at,
         updated_by = p_verified_by
   WHERE id = p_task_id AND status_code = 'under_review';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Задача была изменена параллельно'
      USING ERRCODE = '40001';
  END IF;

  PERFORM append_audit_event(
    'task_closure_accepted',
    'task',
    p_task_id::text,
    jsonb_build_object('status', task_before.status_code, 'closureVerified', false),
    jsonb_build_object('status', 'closed', 'closureVerified', true),
    'success',
    jsonb_strip_nulls(jsonb_build_object(
      'verificationComment', nullif(btrim(p_verification_comment), '')
    )),
    p_verified_by
  );

  RETURN accepted_closure;
END
$function$;

-- (мелочь) Создание сотрудника: та же проверка прав, что и везде (учитывает отключённые роли).
CREATE OR REPLACE FUNCTION public.create_access_user(p_email text, p_password text, p_full_name text, p_access_role_key text, p_organization_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'extensions', 'auth'
AS $function$
DECLARE
  actor_id uuid := auth.uid();
  new_user_id uuid := gen_random_uuid();
  normalized_email text;
  normalized_name text;
  role_base public.user_role;
  role_active boolean;
  instance_uuid uuid := '00000000-0000-0000-0000-000000000000';
  identity_payload jsonb;
  hashed_password text;
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'Нужна сессия'
      USING ERRCODE = '28000';
  END IF;

  IF NOT public.app_has_permission('users.write') THEN
    RAISE EXCEPTION 'Недостаточно прав для этого действия.'
      USING ERRCODE = '42501';
  END IF;

  normalized_email := lower(btrim(coalesce(p_email, '')));
  normalized_name := btrim(coalesce(p_full_name, ''));

  IF normalized_name = '' OR char_length(normalized_name) > 200 THEN
    RAISE EXCEPTION 'Укажите ФИО сотрудника.'
      USING ERRCODE = '23514';
  END IF;

  IF normalized_email = ''
     OR char_length(normalized_email) > 254
     OR normalized_email !~ '^[^[:space:]<>@]+@[^[:space:]<>@]+[.][^[:space:]<>@]+$' THEN
    RAISE EXCEPTION 'Укажите корректный e-mail.'
      USING ERRCODE = '23514';
  END IF;

  IF p_password IS NULL OR char_length(p_password) < 8 THEN
    RAISE EXCEPTION 'Пароль должен быть не короче 8 символов.'
      USING ERRCODE = '23514';
  END IF;

  IF char_length(p_password) > 72 THEN
    RAISE EXCEPTION 'Пароль слишком длинный.'
      USING ERRCODE = '23514';
  END IF;

  SELECT access_roles.base_role, access_roles.is_active
    INTO role_base, role_active
    FROM public.access_roles
   WHERE access_roles.key = btrim(coalesce(p_access_role_key, ''));

  IF role_base IS NULL THEN
    RAISE EXCEPTION 'Роль не найдена.'
      USING ERRCODE = 'P0002';
  END IF;

  IF role_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Нельзя назначить неактивную роль.'
      USING ERRCODE = '23514';
  END IF;

  IF role_base = 'customer' AND coalesce(cardinality(p_organization_ids), 0) = 0 THEN
    RAISE EXCEPTION 'Для роли заказчика укажите хотя бы одну организацию.'
      USING ERRCODE = '23514';
  END IF;

  IF coalesce(cardinality(p_organization_ids), 0) > 0
     AND EXISTS (
       SELECT 1
         FROM unnest(p_organization_ids) AS org_id
        WHERE NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = org_id)
     ) THEN
    RAISE EXCEPTION 'Организация не найдена.'
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.users WHERE lower(btrim(email)) = normalized_email
     )
     OR (
       to_regclass('auth.users') IS NOT NULL
       AND EXISTS (SELECT 1 FROM auth.users WHERE lower(email) = normalized_email)
     ) THEN
    RAISE EXCEPTION 'Пользователь с таким e-mail уже есть.'
      USING ERRCODE = '23505';
  END IF;

  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'Схема Auth недоступна. Нельзя создать учётную запись.'
      USING ERRCODE = '42501';
  END IF;

  hashed_password := crypt(p_password, gen_salt('bf', 10));

  IF to_regclass('auth.instances') IS NOT NULL THEN
    SELECT id INTO instance_uuid FROM auth.instances LIMIT 1;
    instance_uuid := coalesce(instance_uuid, '00000000-0000-0000-0000-000000000000');
  END IF;

  BEGIN
    INSERT INTO auth.users (
      instance_id,
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at,
      confirmation_token,
      email_change,
      email_change_token_new,
      recovery_token
    ) VALUES (
      instance_uuid,
      new_user_id,
      'authenticated',
      'authenticated',
      normalized_email,
      hashed_password,
      clock_timestamp(),
      jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
      jsonb_build_object('full_name', normalized_name, 'email_verified', true),
      clock_timestamp(),
      clock_timestamp(),
      '',
      '',
      '',
      ''
    );

    identity_payload := jsonb_build_object(
      'sub', new_user_id::text,
      'email', normalized_email,
      'email_verified', true,
      'phone_verified', false
    );

    IF to_regclass('auth.identities') IS NOT NULL THEN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'auth' AND table_name = 'identities' AND column_name = 'provider_id'
      ) THEN
        INSERT INTO auth.identities (
          user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
        ) VALUES (
          new_user_id, identity_payload, 'email', new_user_id::text,
          clock_timestamp(), clock_timestamp(), clock_timestamp()
        );
      ELSE
        INSERT INTO auth.identities (
          id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
        ) VALUES (
          new_user_id::text, new_user_id, identity_payload, 'email',
          clock_timestamp(), clock_timestamp(), clock_timestamp()
        );
      END IF;
    END IF;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'Сервер Auth не позволяет создать пользователя из базы.'
        USING ERRCODE = '42501';
    WHEN unique_violation THEN
      RAISE EXCEPTION 'Пользователь с таким e-mail уже есть.'
        USING ERRCODE = '23505';
  END;

  INSERT INTO public.users (
    id, full_name, role, email, is_active, access_role_key, organization_id
  ) VALUES (
    new_user_id,
    normalized_name,
    role_base,
    normalized_email,
    true,
    btrim(p_access_role_key),
    CASE WHEN role_base = 'customer' THEN p_organization_ids[1] ELSE NULL END
  );

  IF role_base = 'customer' THEN
    INSERT INTO public.customer_organization_access (customer_user_id, organization_id)
    SELECT new_user_id, org_id
      FROM unnest(p_organization_ids) AS org_id
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'id', new_user_id,
    'full_name', normalized_name,
    'role', role_base,
    'email', normalized_email,
    'is_active', true,
    'access_role_key', btrim(p_access_role_key)
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- Политики
-- ---------------------------------------------------------------------------

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
  staff constant text := '(SELECT public.app_is_staff())';
  customer_orgs constant text := 'ARRAY(SELECT public.app_customer_organization_ids())';
  refs_write constant text := '(SELECT public.app_has_permission(''references.write''))';
  refs_or_tasks constant text := '(SELECT public.app_has_any_permission(ARRAY[''references.write'', ''tasks.write'']))';
  equip_read constant text := '(SELECT public.app_can_read_equipment())';
  equip_write constant text := '(SELECT public.app_can_write_equipment())';
  task_read constant text := 'public.app_can_read_task(task_id)';
  task_write constant text := 'public.app_can_write_task(task_id)';
  tasks_write_perm constant text := '(SELECT public.app_has_permission(''tasks.write''))';
  finance_read constant text := '(SELECT public.app_has_permission(''finance.read''))';
  finance_write constant text := '(SELECT public.app_has_permission(''finance.write''))';
  wh_read constant text := '(SELECT public.app_has_any_permission(ARRAY[''warehouse.read'', ''warehouse.write'', ''tasks.read_all'']))';
  wh_write constant text := '(SELECT public.app_has_permission(''warehouse.write''))';
  users_write constant text := '(SELECT public.app_has_permission(''users.write''))';
  roles_write constant text := '(SELECT public.app_has_any_permission(ARRAY[''roles.write'', ''users.write'']))';
  notif_settings constant text := '(SELECT public.app_has_any_permission(ARRAY[''notification_settings.write'', ''references.write'']))';
  assign_perm constant text := '(SELECT public.app_has_any_permission(ARRAY[''users.write'', ''tasks.assign'']))';
BEGIN
  -- (4) Клиент видит только свою организацию, её площадки и контакты.
  PERFORM pg_temp.apply_policies(ARRAY['organizations'],
    '(' || staff || ' OR id = ANY (' || customer_orgs || '))', refs_write, refs_write, refs_write);
  PERFORM pg_temp.apply_policies(ARRAY['sites'],
    '(' || staff || ' OR organization_id = ANY (' || customer_orgs || '))', refs_or_tasks, refs_or_tasks, refs_or_tasks);
  PERFORM pg_temp.apply_policies(ARRAY['site_contacts'],
    '(' || staff || ' OR site_id IN (SELECT s.id FROM public.sites AS s WHERE s.organization_id = ANY (' || customer_orgs || ')))',
    refs_or_tasks, refs_or_tasks, refs_or_tasks);
  PERFORM pg_temp.apply_policies(ARRAY['site_payers', 'payers'], staff, refs_or_tasks, refs_or_tasks, refs_or_tasks);
  PERFORM pg_temp.apply_policies(ARRAY['business_event_catalog'], staff, NULL, NULL, NULL);
  PERFORM pg_temp.apply_policies(ARRAY['notification_templates'], staff, notif_settings, notif_settings, notif_settings);

  -- (4) Сотрудников клиент видит только себя и инженеров своих задач.
  PERFORM pg_temp.apply_policies(ARRAY['users'],
    '(' || staff || ' OR ((SELECT public.is_app_user()) AND (id = (SELECT auth.uid()) OR EXISTS (SELECT 1 FROM public.tasks AS t WHERE t.engineer_id = users.id))))',
    users_write,
    '(' || users_write || ' OR ((SELECT public.app_has_permission(''tasks.assign'')) AND role = ''engineer''))',
    users_write);
  PERFORM pg_temp.apply_policies(ARRAY['access_roles'],
    '(' || staff || ' OR key = (SELECT public.app_current_role_key()))', roles_write, roles_write, roles_write);
  PERFORM pg_temp.apply_policies(ARRAY['access_role_permissions'],
    '(' || staff || ' OR role_key = (SELECT public.app_current_role_key()))', roles_write, roles_write, roles_write);
  PERFORM pg_temp.apply_policies(ARRAY['permissions'], app_user, roles_write, roles_write, roles_write);
  PERFORM pg_temp.apply_policies(ARRAY['role_permissions'], staff, roles_write, roles_write, roles_write);
  PERFORM pg_temp.apply_policies(ARRAY['engineer_competencies'], staff, assign_perm, assign_perm, assign_perm);
  -- (13) Клиент видит свои доступы (на них построено представление customer_task_scope).
  PERFORM pg_temp.apply_policies(ARRAY['customer_organization_access'],
    '(' || users_write || ' OR customer_user_id = (SELECT auth.uid()))', users_write, users_write, users_write);

  -- (2, 12) Задачи: условия по самой строке, без поиска по id. Работает для
  -- INSERT ... RETURNING и быстро на больших списках.
  PERFORM pg_temp.apply_policies(ARRAY['tasks'],
    '((SELECT public.app_has_any_permission(ARRAY[''tasks.read_all'', ''finance.read'']))'
      || ' OR ((SELECT public.app_has_permission(''tasks.read_own'')) AND (SELECT auth.uid()) IN (engineer_id, initiator_id, created_by))'
      || ' OR ((SELECT public.app_has_permission(''warehouse.write'')) AND EXISTS (SELECT 1 FROM public.stock_reservations AS r WHERE r.task_id = tasks.id AND r.status IN (''created'', ''warehouse_notified'', ''issued'')))'
      || ' OR ((SELECT public.app_has_permission(''tasks.read_organization'')) AND coalesce(organization_id, (SELECT s.organization_id FROM public.sites AS s WHERE s.id = site_id)) = ANY (' || customer_orgs || ')))',
    '(SELECT public.app_has_any_permission(ARRAY[''tasks.create'', ''tasks.write'']))',
    'public.app_can_write_task(id)',
    tasks_write_perm);
  -- Роль с правом проверки (без tasks.write) принимает и возвращает задачу на проверке.
  -- Что именно можно менять, ограничивает страж guard_task_restricted_columns.
  DROP POLICY IF EXISTS role_update ON public.tasks;
  CREATE POLICY role_update ON public.tasks FOR UPDATE TO authenticated
    USING (public.app_can_write_task(id)
           OR ((SELECT public.app_has_permission('tasks.review')) AND status_code = 'under_review'))
    WITH CHECK (public.app_can_write_task(id)
           OR (SELECT public.app_has_permission('tasks.review')));

  -- (11) Кладовщик видит заявки на запчасти по открытым задачам и привязывает резерв.
  PERFORM pg_temp.apply_policies(ARRAY['task_parts'],
    '(' || task_read || ' OR (' || wh_write || ' AND public.app_task_is_open(task_id)))',
    task_write,
    '(' || task_write || ' OR (' || wh_write || ' AND public.app_task_is_open(task_id)))',
    task_write);
  -- (8) Акт удаляет только координатор.
  -- Акт заполняет инженер задачи (или координатор), не инициатор.
  PERFORM pg_temp.apply_policies(ARRAY['task_closures'], task_read,
    '(' || tasks_write_perm || ' OR (public.app_is_task_engineer(task_id) AND ' || task_write || '))',
    '(' || tasks_write_perm || ' OR (public.app_is_task_engineer(task_id) AND ' || task_write || '))',
    tasks_write_perm);
  -- (9) Журналы и истории пишутся только триггерами.
  PERFORM pg_temp.apply_policies(ARRAY['task_status_history', 'task_assignments', 'task_file_quotas'], task_read, NULL, NULL, NULL);
  PERFORM pg_temp.apply_policies(ARRAY['equipment_site_history', 'equipment_payer_history', 'equipment_meter_readings'], equip_read, NULL, NULL, NULL);
  PERFORM pg_temp.apply_policies(ARRAY['equipment_history'], equip_read, equip_write, equip_write, equip_write);
  PERFORM pg_temp.apply_policies(ARRAY['invoice_status_history'], finance_read, NULL, NULL, NULL);
  PERFORM pg_temp.apply_policies(ARRAY['stock_reservation_history'], wh_read, NULL, NULL, NULL);
  -- (9) Движения склада только добавляются; исправление — встречным движением.
  PERFORM pg_temp.apply_policies(ARRAY['stock_movements'], wh_read, wh_write, NULL, NULL);
  -- (11) Новый резерв только под задачу в работе (перенос на другую задачу проверяет
  -- страж stock_reservations_guard_task). Существующий резерв кладовщик доводит до
  -- конца или отменяет при любом статусе задачи. Удаления нет: отмена через cancelled.
  PERFORM pg_temp.apply_policies(ARRAY['stock_reservations'], wh_read,
    '(' || wh_write || ' AND (task_id IS NULL OR public.app_task_accepts_reservations(task_id)))',
    wh_write,
    NULL);

  -- (мелочь) Файл привязывается только к объекту своей задачи или прибора, автор — сам загрузивший.
  PERFORM pg_temp.apply_policies(ARRAY['files'],
    '((CASE WHEN task_id IS NOT NULL THEN public.app_can_read_task(task_id) ELSE ' || equip_read || ' END)'
      || ' AND (NOT is_financial OR ' || finance_read || '))',
    '((CASE WHEN task_id IS NOT NULL'
      || ' THEN public.app_can_write_task(task_id) AND storage_key LIKE (''tasks/'' || task_id::text || ''/%'')'
      || ' AND (kind <> ''act'' OR ' || tasks_write_perm || ' OR public.app_is_task_engineer(task_id))'
      || ' ELSE ' || equip_write || ' AND equipment_id IS NOT NULL AND storage_key LIKE (equipment_id::text || ''/%'') END)'
      || ' AND (uploaded_by IS NULL OR uploaded_by = (SELECT auth.uid())))',
    '(CASE WHEN task_id IS NOT NULL'
      || ' THEN public.app_can_write_task(task_id) AND storage_key LIKE (''tasks/'' || task_id::text || ''/%'')'
      || ' AND (kind <> ''act'' OR ' || tasks_write_perm || ' OR public.app_is_task_engineer(task_id))'
      || ' ELSE ' || equip_write || ' AND equipment_id IS NOT NULL AND storage_key LIKE (equipment_id::text || ''/%'') END)',
    '(CASE WHEN task_id IS NOT NULL THEN public.app_can_write_task(task_id) ELSE ' || equip_write || ' END)');

  -- (мелочь) Настройки уведомлений только у активных сотрудников.
  PERFORM pg_temp.apply_policies(ARRAY['notification_preferences'],
    '((SELECT public.is_app_user()) AND (user_id = (SELECT auth.uid()) OR (SELECT public.app_has_permission(''notification_settings.write''))))',
    '((SELECT public.is_app_user()) AND (user_id = (SELECT auth.uid()) OR (SELECT public.app_has_permission(''notification_settings.write''))))',
    '((SELECT public.is_app_user()) AND (user_id = (SELECT auth.uid()) OR (SELECT public.app_has_permission(''notification_settings.write''))))',
    '((SELECT public.is_app_user()) AND (user_id = (SELECT auth.uid()) OR (SELECT public.app_has_permission(''notification_settings.write''))))');
END
$$;

-- ---------------------------------------------------------------------------
-- Стражи полей
-- ---------------------------------------------------------------------------

-- (7) Создание задачи без tasks.write: только новая заявка от своего имени,
-- без инженера, договора и чужой замены плательщика. Срабатывает первым (имя tasks_aa_*).
CREATE OR REPLACE FUNCTION public.guard_task_insert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.app_has_permission('tasks.write') THEN
    RETURN NEW;
  END IF;
  IF NEW.status_code IS DISTINCT FROM 'new'
     OR NEW.engineer_id IS NOT NULL
     OR NEW.contract_id IS NOT NULL
     OR NEW.maintenance_plan_id IS NOT NULL
     OR NEW.primary_task_id IS NOT NULL
     OR NEW.is_maintenance_plan
     OR (NEW.created_by IS NOT NULL AND NEW.created_by <> auth.uid())
     OR (NEW.initiator_id IS NOT NULL AND NEW.initiator_id <> auth.uid())
     OR (NEW.payer_overridden_by IS NOT NULL
         AND (NEW.payer_overridden_by <> auth.uid() OR NOT public.app_has_permission('payer.override')))
  THEN
    RAISE EXCEPTION 'Недостаточно прав: заявка создаётся новой, без инженера и договора, от своего имени'
      USING ERRCODE = '42501';
  END IF;
  NEW.created_by := auth.uid();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS tasks_aa_guard_insert ON public.tasks;
CREATE TRIGGER tasks_aa_guard_insert
  BEFORE INSERT ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.guard_task_insert();

-- (10) Изменение задачи без tasks.write.
CREATE OR REPLACE FUNCTION public.guard_task_restricted_columns()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  review_transition boolean;
BEGIN
  IF auth.uid() IS NULL OR public.app_has_permission('tasks.write') THEN
    RETURN NEW;
  END IF;
  -- Роль с правом проверки (без tasks.write) принимает или возвращает задачу на проверке.
  review_transition := OLD.status_code = 'under_review'
    AND NEW.status_code IN ('closed', 'in_progress')
    AND public.app_has_permission('tasks.review');
  -- При приёмке или возврате проверяющий меняет только статус и комментарий возврата.
  IF review_transition
     AND (to_jsonb(NEW) - ARRAY['status_code', 'rework_comment', 'updated_at', 'updated_by'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status_code', 'rework_comment', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'Недостаточно прав: при проверке меняются только статус и комментарий возврата'
      USING ERRCODE = '42501';
  END IF;
  -- Сданную, закрытую и отменённую задачу правит только координатор.
  IF OLD.status_code IN ('under_review', 'closed', 'cancelled') AND NOT review_transition THEN
    RAISE EXCEPTION 'Недостаточно прав: задача на проверке, закрыта или отменена, изменить её может координатор'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.engineer_id IS DISTINCT FROM OLD.engineer_id
     OR NEW.site_id IS DISTINCT FROM OLD.site_id
     OR NEW.site_contact_id IS DISTINCT FROM OLD.site_contact_id
     OR NEW.initiator_contact_id IS DISTINCT FROM OLD.initiator_contact_id
     OR NEW.equipment_id IS DISTINCT FROM OLD.equipment_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.payer_id IS DISTINCT FROM OLD.payer_id
     OR NEW.payer_name IS DISTINCT FROM OLD.payer_name
     OR NEW.payer_requisites IS DISTINCT FROM OLD.payer_requisites
     OR NEW.inherited_payer_id IS DISTINCT FROM OLD.inherited_payer_id
     OR NEW.payer_override_reason IS DISTINCT FROM OLD.payer_override_reason
     OR NEW.payer_overridden_by IS DISTINCT FROM OLD.payer_overridden_by
     OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
     OR NEW.initiator_id IS DISTINCT FROM OLD.initiator_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.work_type_code IS DISTINCT FROM OLD.work_type_code
     OR NEW.work_modifier IS DISTINCT FROM OLD.work_modifier
     OR NEW.priority IS DISTINCT FROM OLD.priority
     OR NEW.deadline_from IS DISTINCT FROM OLD.deadline_from
     OR NEW.deadline_to IS DISTINCT FROM OLD.deadline_to
     OR NEW.is_maintenance_plan IS DISTINCT FROM OLD.is_maintenance_plan
     OR NEW.maintenance_plan_id IS DISTINCT FROM OLD.maintenance_plan_id
     OR NEW.primary_task_id IS DISTINCT FROM OLD.primary_task_id
  THEN
    RAISE EXCEPTION 'Недостаточно прав: назначение, клиента, плательщика, вид работ и сроки задачи меняет координатор'
      USING ERRCODE = '42501';
  END IF;
  -- Результат работ и акт заполняет инженер задачи, а не инициатор.
  IF OLD.engineer_id IS DISTINCT FROM auth.uid() AND (
       NEW.call_reason IS DISTINCT FROM OLD.call_reason
    OR NEW.work_description IS DISTINCT FROM OLD.work_description
    OR NEW.recommendations IS DISTINCT FROM OLD.recommendations
    OR NEW.user_remarks IS DISTINCT FROM OLD.user_remarks
    OR NEW.work_completed IS DISTINCT FROM OLD.work_completed
    OR NEW.apparatus_approved IS DISTINCT FROM OLD.apparatus_approved
    OR NEW.customer_has_no_claims IS DISTINCT FROM OLD.customer_has_no_claims
    OR NEW.continued_in_primary IS DISTINCT FROM OLD.continued_in_primary
    OR NEW.meter_reading IS DISTINCT FROM OLD.meter_reading
    OR NEW.hours IS DISTINCT FROM OLD.hours
  ) THEN
    RAISE EXCEPTION 'Недостаточно прав: результат работ заполняет инженер задачи'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.status_code IS DISTINCT FROM OLD.status_code THEN
    IF NOT coalesce(
         review_transition
      OR (public.app_has_permission('tasks.accept')
            AND OLD.status_code = 'assigned' AND NEW.status_code = 'in_progress')
      OR (public.app_has_permission('tasks.close')
            AND OLD.status_code IN ('in_progress', 'rework') AND NEW.status_code = 'under_review')
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

-- (8) Отметку о приёмке акта ставит только проверяющий и только от своего имени,
-- в том числе при создании записи акта.
CREATE OR REPLACE FUNCTION public.guard_accept_task_closure()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF (NEW.verified_by IS NOT NULL OR NEW.verified_at IS NOT NULL)
     AND (TG_OP = 'INSERT'
          OR NEW.verified_by IS DISTINCT FROM OLD.verified_by
          OR NEW.verified_at IS DISTINCT FROM OLD.verified_at)
     AND (NOT public.app_has_permission('tasks.review') OR NEW.verified_by IS DISTINCT FROM auth.uid())
  THEN
    RAISE EXCEPTION 'Недостаточно прав: акт принимает координатор, от своего имени'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

-- Имя с aa_: страж срабатывает раньше проверок содержимого акта.
DROP TRIGGER IF EXISTS task_closures_guard_accept ON public.task_closures;
DROP TRIGGER IF EXISTS task_closures_aa_guard_accept ON public.task_closures;
DROP TRIGGER IF EXISTS task_closure_aa_guard_accept ON public.task_closures;
CREATE TRIGGER task_closure_aa_guard_accept
  BEFORE INSERT OR UPDATE ON public.task_closures
  FOR EACH ROW EXECUTE FUNCTION public.guard_accept_task_closure();

-- (11) Кладовщик в строке запчасти задачи меняет только резерв и отметку «установлено».
CREATE OR REPLACE FUNCTION public.guard_task_part_warehouse_columns()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.app_can_write_task(OLD.task_id) THEN
    RETURN NEW;
  END IF;
  IF NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.part_id IS DISTINCT FROM OLD.part_id
     OR NEW.part_condition IS DISTINCT FROM OLD.part_condition
     OR NEW.article_number_snapshot IS DISTINCT FROM OLD.article_number_snapshot
     OR NEW.name_snapshot IS DISTINCT FROM OLD.name_snapshot
     OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.position IS DISTINCT FROM OLD.position
     OR NEW.for_sale IS DISTINCT FROM OLD.for_sale
  THEN
    RAISE EXCEPTION 'Недостаточно прав: кладовщик меняет только резерв и отметку об установке'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS task_parts_guard_warehouse ON public.task_parts;
CREATE TRIGGER task_parts_guard_warehouse
  BEFORE UPDATE ON public.task_parts
  FOR EACH ROW EXECUTE FUNCTION public.guard_task_part_warehouse_columns();

-- (11) Перенести резерв можно только на задачу в работе. После выдачи запчасть,
-- её состояние и количество не меняются: запись должна сходиться с движениями.
CREATE OR REPLACE FUNCTION public.guard_reservation_task()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NOT NULL
     AND OLD.status NOT IN ('created', 'warehouse_notified')
     AND (NEW.quantity IS DISTINCT FROM OLD.quantity
          OR NEW.part_id IS DISTINCT FROM OLD.part_id
          OR NEW.part_condition IS DISTINCT FROM OLD.part_condition) THEN
    RAISE EXCEPTION 'После выдачи или отмены нельзя менять запчасть и количество резерва'
      USING ERRCODE = '42501';
  END IF;
  IF auth.uid() IS NOT NULL
     AND NEW.task_id IS NOT NULL
     AND NEW.task_id IS DISTINCT FROM OLD.task_id
     AND NOT public.app_task_accepts_reservations(NEW.task_id) THEN
    RAISE EXCEPTION 'Резерв можно привязать только к задаче в работе'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS stock_reservations_guard_task ON public.stock_reservations;
CREATE TRIGGER stock_reservations_guard_task
  BEFORE UPDATE ON public.stock_reservations
  FOR EACH ROW EXECUTE FUNCTION public.guard_reservation_task();

-- (мелочь) Координатор меняет у инженера только рабочие поля: не id, не Telegram, не руководителя.
CREATE OR REPLACE FUNCTION public.guard_user_restricted_columns()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.app_has_permission('users.write') THEN
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.access_role_key IS DISTINCT FROM OLD.access_role_key
     OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.site_id IS DISTINCT FROM OLD.site_id
     OR NEW.telegram_chat_id IS DISTINCT FROM OLD.telegram_chat_id
     OR NEW.manager_id IS DISTINCT FROM OLD.manager_id
  THEN
    RAISE EXCEPTION 'Недостаточно прав: роль и учётные данные сотрудника меняет администратор'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

-- (мелочь) Смена места и плательщика прибора: от владельца схемы, чтобы проверка
-- хронологии видела историю и давала понятное сообщение вместо сырой ошибки CHECK.
CREATE OR REPLACE FUNCTION public.change_equipment_site(p_equipment_id uuid, p_new_site_id uuid, p_happened_at timestamp with time zone, p_comment text, p_changed_by uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  previous_site_id uuid;
  open_since timestamptz;
  history_id uuid;
BEGIN
  -- Смену делает тот, у кого есть право менять приборы; автор — сам вызывающий.
  IF auth.uid() IS NOT NULL THEN
    IF NOT public.app_can_write_equipment() THEN
      RAISE EXCEPTION 'Недостаточно прав: менять место и плательщика прибора может координатор'
        USING ERRCODE = '42501';
    END IF;
    p_changed_by := auth.uid();
  END IF;

  IF p_happened_at IS NULL THEN
    RAISE EXCEPTION 'Дата смены места установки обязательна'
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_site_change_date_required';
  END IF;
  IF nullif(btrim(p_comment), '') IS NULL OR char_length(btrim(p_comment)) > 2000 THEN
    RAISE EXCEPTION 'Комментарий смены места установки обязателен и не должен превышать 2000 символов'
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_site_change_comment_invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_changed_by) THEN
    RAISE EXCEPTION 'Автор смены места установки не найден'
      USING ERRCODE = '23503', CONSTRAINT = 'equipment_site_change_actor_missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sites WHERE id = p_new_site_id) THEN
    RAISE EXCEPTION 'Новое место установки не найдено'
      USING ERRCODE = '23503', CONSTRAINT = 'equipment_site_change_target_missing';
  END IF;

  SELECT current_site_id
    INTO previous_site_id
    FROM equipment
   WHERE id = p_equipment_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Прибор не найден'
      USING ERRCODE = '23503', CONSTRAINT = 'equipment_site_change_equipment_missing';
  END IF;
  IF previous_site_id IS NOT DISTINCT FROM p_new_site_id THEN
    RAISE EXCEPTION 'Новое место установки совпадает с текущим'
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_site_change_same_value';
  END IF;

  SELECT valid_from
    INTO open_since
    FROM equipment_site_history
   WHERE equipment_id = p_equipment_id AND valid_to IS NULL
   FOR UPDATE;
  IF open_since IS NOT NULL AND p_happened_at <= open_since THEN
    RAISE EXCEPTION 'Дата смены места установки должна быть позже текущей записи истории'
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_site_change_chronology';
  END IF;

  PERFORM set_config('app.equipment_change_at', p_happened_at::text, true);
  PERFORM set_config('app.equipment_change_by', p_changed_by::text, true);
  PERFORM set_config('app.equipment_change_comment', btrim(p_comment), true);
  UPDATE equipment SET current_site_id = p_new_site_id WHERE id = p_equipment_id;
  PERFORM set_config('app.equipment_change_at', '', true);
  PERFORM set_config('app.equipment_change_by', '', true);
  PERFORM set_config('app.equipment_change_comment', '', true);

  SELECT id INTO history_id
    FROM equipment_site_history
   WHERE equipment_id = p_equipment_id AND valid_to IS NULL;
  RETURN history_id;
END
$function$;

CREATE OR REPLACE FUNCTION public.change_equipment_payer(p_equipment_id uuid, p_new_payer_id uuid, p_happened_at timestamp with time zone, p_comment text, p_changed_by uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  previous_payer_id uuid;
  open_since timestamptz;
  history_id uuid;
BEGIN
  -- Смену делает тот, у кого есть право менять приборы; автор — сам вызывающий.
  IF auth.uid() IS NOT NULL THEN
    IF NOT public.app_can_write_equipment() THEN
      RAISE EXCEPTION 'Недостаточно прав: менять место и плательщика прибора может координатор'
        USING ERRCODE = '42501';
    END IF;
    p_changed_by := auth.uid();
  END IF;

  IF p_happened_at IS NULL THEN
    RAISE EXCEPTION 'Дата смены плательщика обязательна'
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_payer_change_date_required';
  END IF;
  IF nullif(btrim(p_comment), '') IS NULL OR char_length(btrim(p_comment)) > 2000 THEN
    RAISE EXCEPTION 'Комментарий смены плательщика обязателен и не должен превышать 2000 символов'
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_payer_change_comment_invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_changed_by) THEN
    RAISE EXCEPTION 'Автор смены плательщика не найден'
      USING ERRCODE = '23503', CONSTRAINT = 'equipment_payer_change_actor_missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM payers WHERE id = p_new_payer_id) THEN
    RAISE EXCEPTION 'Новый плательщик не найден'
      USING ERRCODE = '23503', CONSTRAINT = 'equipment_payer_change_target_missing';
  END IF;

  SELECT current_payer_id
    INTO previous_payer_id
    FROM equipment
   WHERE id = p_equipment_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Прибор не найден'
      USING ERRCODE = '23503', CONSTRAINT = 'equipment_payer_change_equipment_missing';
  END IF;
  IF previous_payer_id IS NOT DISTINCT FROM p_new_payer_id THEN
    RAISE EXCEPTION 'Новый плательщик совпадает с текущим'
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_payer_change_same_value';
  END IF;

  SELECT valid_from
    INTO open_since
    FROM equipment_payer_history
   WHERE equipment_id = p_equipment_id AND valid_to IS NULL
   FOR UPDATE;
  IF open_since IS NOT NULL AND p_happened_at <= open_since THEN
    RAISE EXCEPTION 'Дата смены плательщика должна быть позже текущей записи истории'
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_payer_change_chronology';
  END IF;

  PERFORM set_config('app.equipment_change_at', p_happened_at::text, true);
  PERFORM set_config('app.equipment_change_by', p_changed_by::text, true);
  PERFORM set_config('app.equipment_change_comment', btrim(p_comment), true);
  UPDATE equipment SET current_payer_id = p_new_payer_id WHERE id = p_equipment_id;
  PERFORM set_config('app.equipment_change_at', '', true);
  PERFORM set_config('app.equipment_change_by', '', true);
  PERFORM set_config('app.equipment_change_comment', '', true);

  SELECT id INTO history_id
    FROM equipment_payer_history
   WHERE equipment_id = p_equipment_id AND valid_to IS NULL;
  RETURN history_id;
END
$function$;

-- ---------------------------------------------------------------------------
-- (3) Функции и последовательности
-- ---------------------------------------------------------------------------

-- Аноним не вызывает ничего из схемы public (кроме функций расширений).
-- Служебные функции SECURITY DEFINER вызывает только служба уведомлений (medtech_worker).
-- Интерфейсу оставлены проверки прав, создание сотрудника и приём закрытия.
DO $$
DECLARE
  f record;
  ui_functions constant text[] := ARRAY[
    'app_has_permission', 'app_has_any_permission', 'app_can_read_task', 'app_can_write_task',
    'app_can_read_equipment', 'app_can_write_equipment', 'app_storage_object_access',
    'app_is_staff', 'app_current_role_key', 'app_customer_organization_ids', 'app_task_is_open',
    'app_is_task_engineer', 'app_task_accepts_reservations',
    'is_app_user', 'create_access_user', 'accept_task_closure',
    'change_equipment_site', 'change_equipment_payer'
  ];
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS signature, p.proname, p.prosecdef
      FROM pg_proc AS p
      JOIN pg_namespace AS n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.prorettype <> 'trigger'::regtype
       AND NOT EXISTS (SELECT 1 FROM pg_depend AS d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', f.signature);
    IF f.proname = ANY (ui_functions) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f.signature);
    ELSIF f.prosecdef THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', f.signature);
    ELSE
      -- Обычные функции выполняются с правами вызывающего, под RLS.
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f.signature);
    END IF;
  END LOOP;
END
$$;

-- Функции будущих миграций: Supabase выдаёт EXECUTE всем глобальной записью роли
-- postgres, на уровне схемы она не снимается. Снимаем глобально для PUBLIC и anon;
-- новые SECURITY DEFINER функции для интерфейса нужно открывать явным GRANT.
-- Проверка в supabase/tests/role_access.sql ловит лишние доступы.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
DO $$
BEGIN
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon';
EXCEPTION WHEN insufficient_privilege OR undefined_object THEN
  RAISE NOTICE 'Права по умолчанию supabase_admin не изменены: %', SQLERRM;
END
$$;

-- Номера задач и счетов: аноним не трогает последовательности, никто из API не сдвигает их вручную.
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE UPDATE ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE UPDATE ON SEQUENCES FROM authenticated;

-- (6) Storage: TRUNCATE и прочие обходы правил строк ролям API не нужны.
DO $$
BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    BEGIN
      EXECUTE 'REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA storage FROM anon, authenticated';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'Права на схему storage не изменены (нужен владелец storage): %', SQLERRM;
    END;
  END IF;
END
$$;

-- (13) Администратор настраивает шаблоны уведомлений, поэтому видит и журнал отправки.
INSERT INTO public.access_role_permissions (role_key, permission_code)
SELECT 'admin', 'notifications.read'
 WHERE EXISTS (SELECT 1 FROM public.access_roles WHERE key = 'admin')
   AND EXISTS (SELECT 1 FROM public.permissions WHERE code = 'notifications.read')
   AND NOT EXISTS (SELECT 1 FROM public.access_role_permissions WHERE role_key = 'admin' AND permission_code = 'notifications.read');
