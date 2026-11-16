-- Роль «Системный администратор»: один вход, из которого видно всё.
--
-- Зачем. Встроенный «Главный администратор» по ТЗ ведёт учётные записи, роли,
-- справочники и настройки, а задачи, приборы, склад и деньги ему не положены:
-- это разделение обязанностей, и трогать его нельзя. Но при запуске и приёмке
-- нужен человек, который видит систему целиком, не входя под четырьмя ролями
-- по очереди. Для этого отдельная роль, а не расширение прав администратора:
-- так в журнале видно, кто смотрел всё, и так роль можно отключить одним щелчком,
-- не ломая работу администратора.
--
-- Права берём не списком, а все, какие есть в справочнике: если завтра появится
-- новое право, системный администратор получит и его, а список не забудут обновить.

INSERT INTO access_roles (key, name, base_role, is_builtin)
VALUES ('sysadmin', 'Системный администратор', 'admin', true)
ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO access_role_permissions (role_key, permission_code)
SELECT 'sysadmin', available.code
  FROM permissions AS available
ON CONFLICT DO NOTHING;

-- Чтобы «все права» не устарели: новое право из будущей миграции сразу достаётся
-- системному администратору. Без этого список прав разошёлся бы с обещанием роли,
-- и заметили бы это только тогда, когда он чего-то не увидел.
CREATE OR REPLACE FUNCTION public.grant_new_permission_to_sysadmin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.access_role_permissions (role_key, permission_code)
  VALUES ('sysadmin', NEW.code)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.grant_new_permission_to_sysadmin() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS permissions_grant_to_sysadmin ON permissions;
CREATE TRIGGER permissions_grant_to_sysadmin
  AFTER INSERT ON permissions
  FOR EACH ROW EXECUTE FUNCTION public.grant_new_permission_to_sysadmin();

COMMENT ON TABLE access_roles IS
  'Роли доступа. Встроенные: администратор ведёт учётные записи и настройки, системный администратор видит всё (0032), остальные роли работают по ТЗ.';
