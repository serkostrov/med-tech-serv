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
-- 1. Свой вход отключить нельзя: ни строкой сотрудника, ни отключением своей роли
--    доступа (роль с выключенным признаком не даёт прав вовсе, см. app_has_permission).
--    Отключает другой администратор — это и есть разделение обязанностей.
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
  IF TG_OP = 'UPDATE' AND auth.uid() IS NOT NULL AND NEW.id = auth.uid()
     AND OLD.is_active AND NOT NEW.is_active THEN
    RAISE EXCEPTION 'Себе вход отключать нельзя: вы сразу потеряете доступ к системе. Попросите другого администратора'
      USING ERRCODE = '23514', CONSTRAINT = 'users_no_self_lockout';
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

DROP TRIGGER IF EXISTS users_preserve_last_active_admin ON users;
CREATE TRIGGER users_preserve_last_active_admin
  BEFORE UPDATE OF role, is_active OR DELETE ON users
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
