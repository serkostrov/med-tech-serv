-- Свой номер чата Telegram сотрудник вписывает сам, в «Моём профиле».
--
-- Сотрудник пишет боту /start, бот присылает номер чата, сотрудник вставляет его в профиль.
-- Раньше номер мог вписать только администратор (раздел «Сотрудники»): триггер
-- guard_user_restricted_columns запрещает остальным менять telegram_chat_id.
--
-- Теперь есть функция set_my_telegram_chat_id: меняет только номер чата и только у того,
-- кто вошёл в CRM (auth.uid() из токена входа, его нельзя подставить). Роль, почту и прочее
-- по-прежнему меняет только администратор. Триггер пропускает смену номера, только если
-- строка своя и изменение идёт из этой функции (метка на время транзакции, через API её не задать).
--
-- Функции, как все служебные (0009, 0014), работают от владельца схемы:
-- CREATE OR REPLACE сбрасывает это свойство, поэтому оно задано здесь же.

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
     OR (NEW.telegram_chat_id IS DISTINCT FROM OLD.telegram_chat_id
         -- Метки может не быть вовсе (свежее соединение): тогда это NULL, а не 'on', и смена запрещена.
         AND NOT (OLD.id = auth.uid() AND coalesce(current_setting('app.own_telegram_chat', true), '') = 'on'))
     OR NEW.manager_id IS DISTINCT FROM OLD.manager_id
  THEN
    RAISE EXCEPTION 'Недостаточно прав: роль и учётные данные сотрудника меняет администратор'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.set_my_telegram_chat_id(p_chat_id text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me uuid := auth.uid();
  chat text := nullif(btrim(coalesce(p_chat_id, '')), '');
  saved text;
  changed integer;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'Войдите в систему, чтобы сохранить номер чата' USING ERRCODE = '42501';
  END IF;
  -- Только личный чат с ботом (номер без минуса): уведомления с данными клиентов не уходят
  -- в группу. Номер группы, если он нужен, вписывает администратор.
  IF chat IS NOT NULL AND chat !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'Впишите номер личного чата с ботом: только цифры, без минуса' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.own_telegram_chat', 'on', true);
  UPDATE public.users SET telegram_chat_id = chat WHERE id = me AND is_active RETURNING telegram_chat_id INTO saved;
  GET DIAGNOSTICS changed = ROW_COUNT;
  PERFORM set_config('app.own_telegram_chat', 'off', true);
  IF changed = 0 THEN
    RAISE EXCEPTION 'Профиль не найден или отключён' USING ERRCODE = 'P0001';
  END IF;
  RETURN saved;
END
$$;

-- Страж вызывается только как триггер, как остальные служебные функции (0020).
REVOKE EXECUTE ON FUNCTION public.guard_user_restricted_columns() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.set_my_telegram_chat_id(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_my_telegram_chat_id(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_my_telegram_chat_id(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
