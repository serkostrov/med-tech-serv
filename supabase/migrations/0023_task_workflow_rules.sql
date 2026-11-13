-- Этапы задачи по правилам ТЗ (п. 3.9) и минимум фото для сдачи на проверку.
--
-- С 0048 (внутри 0001) база пропускала любой переход этапа: координатор и массовые
-- операции могли, например, вернуть закрытую задачу в «Назначена». Теперь для стандартных
-- этапов действует та же схема, что на экране:
--   Запланировано → Новая или Отменена
--   Новая → Назначена или Отменена
--   Назначена → В работе или Отменена
--   В работе → На проверке или Отменена
--   На проверке → Закрыта, В работе (на доработку) или Отменена
-- Закрытая и отменённая задача дальше не двигается. Свои этапы из справочника (не из этого
-- списка) по-прежнему не ограничены. Служба без входа (перевод ТО в «Новая» по сроку) работает
-- как раньше.
--
-- Сдать на проверку можно, только когда к задаче приложено минимум три фото с выезда:
-- без них координатор всё равно не закроет задачу (проверка при закрытии в 0014).
-- При сдаче записывается дата окончания работ: время окончания из акта, иначе момент сдачи.
--
-- Функция, как все служебные триггеры (0009), работает от владельца схемы.

CREATE OR REPLACE FUNCTION public.enforce_task_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  standard constant text[] := ARRAY['planned', 'new', 'assigned', 'in_progress', 'under_review', 'closed', 'cancelled'];
  photo_count integer;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status_code IS NOT DISTINCT FROM OLD.status_code THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NOT NULL THEN
    IF OLD.status_code IN ('closed', 'cancelled') THEN
      RAISE EXCEPTION 'Закрытую или отменённую задачу нельзя вернуть в работу. Если по прибору нужна новая работа, создайте новую задачу'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.status_code = ANY (standard) AND NEW.status_code = ANY (standard) AND NOT (
         (OLD.status_code = 'planned' AND NEW.status_code IN ('new', 'cancelled'))
      OR (OLD.status_code = 'new' AND NEW.status_code IN ('assigned', 'cancelled'))
      OR (OLD.status_code = 'assigned' AND NEW.status_code IN ('in_progress', 'cancelled'))
      OR (OLD.status_code = 'in_progress' AND NEW.status_code IN ('under_review', 'cancelled'))
      OR (OLD.status_code = 'under_review' AND NEW.status_code IN ('closed', 'in_progress', 'cancelled'))
    ) THEN
      RAISE EXCEPTION 'Недопустимый переход задачи: % -> %', OLD.status_code, NEW.status_code
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD.status_code = 'in_progress' AND NEW.status_code = 'under_review' THEN
    SELECT count(*) INTO photo_count FROM public.files WHERE task_id = NEW.id AND kind = 'photo';
    IF photo_count < 3 THEN
      RAISE EXCEPTION 'Для передачи на проверку нужны минимум три фото с выезда, сейчас %', photo_count
        USING ERRCODE = '23514';
    END IF;
    NEW.completed_at := coalesce(NEW.work_finished_at, now());
  END IF;
  RETURN NEW;
END
$$;

-- Вызывать её напрямую никому не нужно: только как триггер.
REVOKE EXECUTE ON FUNCTION public.enforce_task_status_transition() FROM PUBLIC, anon, authenticated;
