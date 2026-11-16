-- Себе вход не отключают.
--
-- Зачем. Администратор открывал «Сотрудники», находил в списке себя и нажимал
-- «Отключить». Защиты не было ни в базе, ни на экране: пока в системе есть второй
-- администратор, человек одним нажатием выключал себе вход и дальше ничего сделать
-- не мог. Последнего администратора база не отдавала, но сообщение говорило про
-- «удалить последнего активного администратора», хотя его отключали, и приходило
-- оно уже после подтверждения.
--
-- Что теперь.
-- 1. Свой вход отключить нельзя: ни строкой сотрудника, ни сменой себе роли доступа
--    на более слабую, ни отключением своей роли (роль с выключенным признаком не даёт
--    прав вовсе, см. app_has_permission), ни снятием прав со своей роли. Отключает
--    и переназначает другой администратор — это и есть разделение обязанностей.
-- 2. Отказ по последнему администратору написан под то действие, которое делают:
--    отключение, смена роли или удаление, — и подсказывает, что сделать сначала.
-- Служебные операции без входа (импорт, миграции, служба уведомлений) работают как раньше.
--
-- Похожие запреты: 0023 (переходы этапов), 0024 (деловые записи не удаляются),
-- 0033 (встроенные значения справочников).
-- Функции, как все служебные триггеры (0009), работают от владельца схемы:
-- CREATE OR REPLACE сбрасывает это свойство, поэтому оно задано здесь же.
-- Миграцию можно применить повторно.

-- ---------------------------------------------------------------------------
-- 1. Сотрудник не отключает себя, последний администратор остаётся
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.preserve_last_active_administrator()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- Что именно делают с записью: от этого зависит текст отказа.
  action_text text;
BEGIN
  -- Свой вход выключает только служба: со входом в CRM это потеря собственного доступа.
  IF TG_OP = 'UPDATE' AND auth.uid() IS NOT NULL AND NEW.id = auth.uid() THEN
    IF OLD.is_active AND NOT NEW.is_active THEN
      RAISE EXCEPTION 'Себе вход отключать нельзя: вы сразу потеряете доступ к системе. Попросите другого администратора'
        USING ERRCODE = '23514', CONSTRAINT = 'users_no_self_lockout';
    END IF;
    -- Роль себе тоже не меняют. Права считаются по access_role_key (0009), поэтому назначить
    -- себе роль послабее — та же потеря доступа, только другой кнопкой: единственный
    -- администратор одним щелчком оставлял систему вообще без управления учётными записями.
    IF NEW.access_role_key IS DISTINCT FROM OLD.access_role_key
       OR NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'Себе роль менять нельзя: так можно остаться без нужных прав. Попросите другого администратора'
        USING ERRCODE = '23514', CONSTRAINT = 'users_no_self_role_change';
    END IF;
  END IF;

  IF OLD.role = 'admin' AND OLD.is_active
    AND (TG_OP = 'DELETE' OR NOT NEW.is_active OR NEW.role <> 'admin') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('medtechservice:last-active-admin', 0));
    IF NOT EXISTS (
      SELECT 1 FROM users
       WHERE role = 'admin' AND is_active AND id <> OLD.id
    ) THEN
      action_text := CASE
        WHEN TG_OP = 'DELETE' THEN 'удалить'
        WHEN NOT NEW.is_active THEN 'отключить'
        ELSE 'сменить роль'
      END;
      RAISE EXCEPTION 'Нельзя % последнего администратора (%): без него некому вести учётные записи, роли и настройки. Сначала добавьте второго администратора и включите ему вход',
        action_text, OLD.full_name
        USING ERRCODE = '23514', CONSTRAINT = 'users_last_active_admin';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

-- Вызывать её напрямую никому не нужно: только как триггер.
REVOKE EXECUTE ON FUNCTION public.preserve_last_active_administrator() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.preserve_last_active_administrator() IS
  'Себе вход не отключают, последний активный администратор остаётся (0035). Отказ называет действие и подсказывает, что сделать сначала.';

-- Столбец access_role_key добавлен в список нарочно: без него смена роли себе проходила мимо.
DROP TRIGGER IF EXISTS users_preserve_last_active_admin ON users;
CREATE TRIGGER users_preserve_last_active_admin
  BEFORE UPDATE OF role, is_active, access_role_key OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION public.preserve_last_active_administrator();

-- ---------------------------------------------------------------------------
-- 2. Свою роль доступа тоже не отключают
-- ---------------------------------------------------------------------------

-- Роль с выключенным признаком не даёт никаких прав, то есть выключить свою роль —
-- это тот же запертый вход, только другой кнопкой.
CREATE OR REPLACE FUNCTION public.preserve_own_access_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.is_active AND NOT NEW.is_active AND EXISTS (
    SELECT 1 FROM users
     WHERE id = auth.uid()
       AND coalesce(access_role_key, CASE WHEN role::text = 'manager' THEN 'initiator' ELSE role::text END) = OLD.key
  ) THEN
    RAISE EXCEPTION 'Свою роль «%» отключать нельзя: вы сразу потеряете доступ к системе. Попросите другого администратора', OLD.name
      USING ERRCODE = '23514', CONSTRAINT = 'access_roles_no_self_lockout';
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.preserve_own_access_role() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.preserve_own_access_role() IS
  'Свою роль доступа не отключают: без активной роли прав нет вовсе (0035).';

DROP TRIGGER IF EXISTS access_roles_preserve_own ON access_roles;
CREATE TRIGGER access_roles_preserve_own
  BEFORE UPDATE OF is_active ON access_roles
  FOR EACH ROW EXECUTE FUNCTION public.preserve_own_access_role();

-- ---------------------------------------------------------------------------
-- 3. Права своей роли меняет тоже не её владелец
-- ---------------------------------------------------------------------------

-- Сама роль может остаться включённой и назначенной, а прав в ней не остаться: снять
-- «Изменение сотрудников» и «Управление ролями» со своей же роли — тот же запертый вход,
-- только третьей кнопкой. Хуже того, матрица прав сохраняется как «удалить все и записать
-- заново», и это два отдельных запроса: после первого человек уже без прав, и второй
-- ему не разрешат — роль осталась бы пустой совсем.
-- Поэтому права своей роли не меняет никто: ни убрать, ни добавить. Название роли
-- по-прежнему правится, чужие роли — как раньше.
CREATE OR REPLACE FUNCTION public.preserve_own_role_permissions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  touched_role constant text := CASE WHEN TG_OP = 'DELETE' THEN OLD.role_key ELSE NEW.role_key END;
  role_name text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF EXISTS (
    SELECT 1 FROM users
     WHERE id = auth.uid()
       AND coalesce(access_role_key, CASE WHEN role::text = 'manager' THEN 'initiator' ELSE role::text END) = touched_role
  ) THEN
    SELECT name INTO role_name FROM access_roles WHERE key = touched_role;
    RAISE EXCEPTION 'Права своей роли «%» менять нельзя: так можно остаться без доступа к системе. Попросите другого администратора', coalesce(role_name, touched_role)
      USING ERRCODE = '23514', CONSTRAINT = 'access_role_permissions_no_self_lockout';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

REVOKE EXECUTE ON FUNCTION public.preserve_own_role_permissions() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.preserve_own_role_permissions() IS
  'Права своей роли её владелец не меняет (0035): иначе два щелчка в матрице прав оставляют систему без управления учётными записями.';

DROP TRIGGER IF EXISTS access_role_permissions_preserve_own ON access_role_permissions;
CREATE TRIGGER access_role_permissions_preserve_own
  BEFORE INSERT OR UPDATE OR DELETE ON access_role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.preserve_own_role_permissions();
