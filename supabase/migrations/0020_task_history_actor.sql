-- История этапов задачи: кто сменил этап.
--
-- Раньше автор брался из tasks.updated_by, а приложение при смене этапа это поле не заполняет,
-- поэтому в истории задачи вместо сотрудника стояла «Система». Теперь автор: сотрудник,
-- вошедший в CRM и сделавший изменение (auth.uid() из токена входа, его нельзя подставить).
-- Для служебных изменений без входа (служба уведомлений, заявки из почты, задачи ТО)
-- автор, как раньше, из полей задачи. Старые записи истории не меняются.
--
-- Функция, как и все служебные триггеры (0009), работает от владельца схемы:
-- CREATE OR REPLACE сбрасывает это свойство, поэтому оно задано здесь же.

CREATE OR REPLACE FUNCTION public.record_task_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  transition_comment text;
  -- Вошедший сотрудник, если он есть среди сотрудников (иначе ссылка на него не сохранится).
  actor uuid := (SELECT u.id FROM public.users AS u WHERE u.id = auth.uid());
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO task_status_history (task_id, from_status, to_status, changed_by, comment)
    VALUES (NEW.id, NULL, NEW.status_code, coalesce(actor, NEW.created_by), NULL);
  ELSIF NEW.status_code <> OLD.status_code THEN
    transition_comment := CASE
      WHEN NEW.status_code = 'cancelled' THEN NEW.cancellation_reason
      WHEN OLD.status_code = 'under_review' AND NEW.status_code = 'in_progress' THEN NEW.rework_comment
      ELSE NULL
    END;
    INSERT INTO task_status_history (task_id, from_status, to_status, changed_by, comment)
    VALUES (NEW.id, OLD.status_code, NEW.status_code, coalesce(actor, NEW.updated_by), transition_comment);
  END IF;
  RETURN NEW;
END
$$;

-- Вызывать её напрямую никому не нужно: только как триггер.
REVOKE EXECUTE ON FUNCTION public.record_task_status_transition() FROM PUBLIC, anon, authenticated;
