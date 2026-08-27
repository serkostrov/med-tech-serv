-- Администратор создаёт сотрудника без публичной регистрации GoTrue
-- (enable_signup = false). Функция пишет auth.users и профиль public.users.

CREATE OR REPLACE FUNCTION public.create_access_user(
  p_email text,
  p_password text,
  p_full_name text,
  p_access_role_key text,
  p_organization_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, auth
AS $$
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

  IF NOT EXISTS (
    SELECT 1
      FROM public.users AS actor
      JOIN public.access_role_permissions AS perm
        ON perm.role_key = coalesce(actor.access_role_key, actor.role::text)
     WHERE actor.id = actor_id
       AND actor.is_active
       AND perm.permission_code = 'users.write'
  ) THEN
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
$$;

REVOKE ALL ON FUNCTION public.create_access_user(text, text, text, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_access_user(text, text, text, text, uuid[]) TO authenticated;

COMMENT ON FUNCTION public.create_access_user(text, text, text, text, uuid[]) IS
  'Создаёт учётную запись GoTrue и профиль сотрудника. Доступно только с правом users.write.';

NOTIFY pgrst, 'reload schema';
