-- Роль «Системный администратор» (миграция 0032): видит всё, администратора не трогает.
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/sysadmin_role.sql
-- Всё выполняется в транзакции и откатывается. Ошибка = проверка не прошла.


BEGIN;

CREATE FUNCTION pg_temp.act_as(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE FUNCTION pg_temp.act_as_nobody() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
END $$;

CREATE FUNCTION pg_temp.check(p_ok boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'ПРОВАЛ: %', p_label;
  END IF;
  RAISE NOTICE 'ok: %', p_label;
END $$;

CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid);
GRANT SELECT ON ids TO authenticated;
CREATE FUNCTION pg_temp.uid(p_key text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM ids WHERE k = p_key
$$;
GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.act_as_nobody(), pg_temp.check(boolean, text),
  pg_temp.uid(text) TO authenticated;

-- Данные: два человека, один прибор, одна задача, одна цена.
DO $$
DECLARE
  sysadmin uuid := gen_random_uuid();
  plain_admin uuid := gen_random_uuid();
  coord uuid := gen_random_uuid();
  org uuid; site uuid; payer uuid; manuf uuid; model uuid; eq uuid; wt text; task uuid;
BEGIN
  INSERT INTO ids VALUES ('sysadmin', sysadmin), ('admin', plain_admin), ('coord', coord);
  INSERT INTO auth.users (id, email, aud, role) VALUES
    (sysadmin, 'sysadmin@test.local', 'authenticated', 'authenticated'),
    (plain_admin, 'admin@test.local', 'authenticated', 'authenticated'),
    (coord, 'coord@test.local', 'authenticated', 'authenticated');
  INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key) VALUES
    (sysadmin, 'Тест системный администратор', 'admin', 'sysadmin@test.local', true, 'sysadmin'),
    (plain_admin, 'Тест администратор', 'admin', 'admin@test.local', true, 'admin'),
    (coord, 'Тест координатор', 'coordinator', 'coord@test.local', true, 'coordinator');

  INSERT INTO organizations (name) VALUES ('Тестовая больница') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('Тестовая площадка', org) RETURNING id INTO site;
  INSERT INTO payers (name) VALUES ('Тестовый плательщик') RETURNING id INTO payer;
  INSERT INTO manufacturers (name) VALUES ('Тест-Производитель') RETURNING id INTO manuf;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (manuf, 'Модель-1') RETURNING id INTO model;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  VALUES ('SN-SYSADMIN-1', manuf, model, site, payer) RETURNING id INTO eq;
  SELECT code INTO wt FROM work_types WHERE is_active ORDER BY code LIMIT 1;
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, created_by,
                     call_date, deadline_from, deadline_to, status_code)
  VALUES ('Задача для проверки прав', wt, eq, site, payer, coord,
          current_date, current_date, current_date + 7, 'new') RETURNING id INTO task;
  INSERT INTO ids VALUES ('task', task), ('equipment', eq);
END $$;

-- ---------------------------------------------------------------- Сама роль
SELECT pg_temp.check((SELECT is_builtin AND is_active AND base_role::text = 'admin'
                      FROM access_roles WHERE key = 'sysadmin'),
  'роль системного администратора заведена как встроенная и включённая');
SELECT pg_temp.check((SELECT name FROM access_roles WHERE key = 'sysadmin') = 'Системный администратор',
  'роль называется «Системный администратор»');
-- Рядом с ней «Главный администратор» читался наоборот: кажется, что он старший,
-- а права у него как раз урезанные.
SELECT pg_temp.check((SELECT name FROM access_roles WHERE key = 'admin') = 'Администратор',
  'встроенная роль администратора называется просто «Администратор»');
SELECT pg_temp.check(
  NOT EXISTS (SELECT 1 FROM permissions AS available
               WHERE NOT EXISTS (SELECT 1 FROM access_role_permissions AS granted
                                  WHERE granted.role_key = 'sysadmin' AND granted.permission_code = available.code)),
  'у системного администратора есть все права из справочника');

-- Администратора не тронули: у него по-прежнему только учётные записи и настройки.
SELECT pg_temp.check(
  NOT EXISTS (SELECT 1 FROM access_role_permissions
               WHERE role_key = 'admin'
                 AND permission_code IN ('tasks.read_all', 'finance.read', 'warehouse.read', 'equipment.read')),
  'у администратора не появилось прав на задачи, деньги, склад и приборы');

-- ---------------------------------------------------------------- Что видно на деле
SELECT pg_temp.act_as(pg_temp.uid('sysadmin'));
SELECT pg_temp.check((SELECT count(*) FROM tasks WHERE id = pg_temp.uid('task')) = 1,
  'системный администратор видит задачи');
SELECT pg_temp.check((SELECT count(*) FROM equipment WHERE id = pg_temp.uid('equipment')) = 1,
  'системный администратор видит приборы');
SELECT pg_temp.check(public.app_has_permission('finance.read') AND public.app_has_permission('price.write')
                 AND public.app_has_permission('warehouse.write') AND public.app_has_permission('users.write'),
  'системному администратору доступны и деньги, и прайс, и склад, и учётные записи');
SELECT pg_temp.act_as_nobody();

-- Для сравнения: обычный администратор задач и приборов не видит.
SELECT pg_temp.act_as(pg_temp.uid('admin'));
SELECT pg_temp.check((SELECT count(*) FROM tasks WHERE id = pg_temp.uid('task')) = 0,
  'обычный администратор задач не видит');
-- Приборы администратор видит, и это не новость от 0032: право видеть приборы даёт
-- в том числе references.write, а справочники администратор ведёт по ТЗ. Проверяем
-- это нарочно, чтобы правило было записано, а не всплывало сюрпризом.
SELECT pg_temp.check((SELECT count(*) FROM equipment WHERE id = pg_temp.uid('equipment')) = 1,
  'приборы администратору видны: их открывает право вести справочники');
SELECT pg_temp.check(NOT public.app_has_permission('finance.read'),
  'обычному администратору деньги по-прежнему недоступны');
SELECT pg_temp.act_as_nobody();

-- Новое право из будущей миграции достаётся системному администратору само.
INSERT INTO permissions (code, name, is_sensitive) VALUES ('future.thing', 'Право из будущей миграции', false);
SELECT pg_temp.check(
  EXISTS (SELECT 1 FROM access_role_permissions WHERE role_key = 'sysadmin' AND permission_code = 'future.thing'),
  'право, заведённое после миграции, сразу есть у системного администратора');
SELECT pg_temp.check(
  NOT EXISTS (SELECT 1 FROM access_role_permissions WHERE role_key = 'admin' AND permission_code = 'future.thing'),
  'обычному администратору новое право само не достаётся');

ROLLBACK;
