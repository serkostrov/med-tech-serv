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
-- При сдаче записывается дата окончания работ: время окончания из акта, иначе полдень дня
-- выезда по Москве, иначе момент сдачи. При возврате на доработку она стирается, а если
-- координатор поправит время окончания или дату выезда на проверке, пересчитывается.
--
-- Функция, как все служебные триггеры (0009), работает от владельца схемы.

-- Дата окончания работ для отчётов: время окончания из акта, иначе полдень дня выезда
-- по Москве (дата не сдвинется ни в каком поясе), иначе запасное значение.
CREATE OR REPLACE FUNCTION public.task_work_completed_at(p_work_finished_at timestamptz, p_visit_date date, p_fallback timestamptz)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(p_work_finished_at, (p_visit_date + time '12:00') AT TIME ZONE 'Europe/Moscow', p_fallback)
$$;

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

  -- На проверку (в том числе из своего этапа справочника) только с тремя фото с выезда.
  IF NEW.status_code = 'under_review' THEN
    SELECT count(*) INTO photo_count FROM public.files WHERE task_id = NEW.id AND kind = 'photo';
    IF photo_count < 3 THEN
      RAISE EXCEPTION 'Для передачи на проверку нужны минимум три фото с выезда, сейчас %', photo_count
        USING ERRCODE = '23514';
    END IF;
    NEW.completed_at := public.task_work_completed_at(NEW.work_finished_at, NEW.visit_date, now());
  ELSIF OLD.status_code = 'under_review' AND NEW.status_code = 'in_progress' THEN
    -- Вернули на доработку: работа ещё не окончена.
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END
$$;

-- Вызывать её напрямую никому не нужно: только как триггер.
REVOKE EXECUTE ON FUNCTION public.enforce_task_status_transition() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.enforce_task_status_transition() IS
  'Этапы задачи по схеме ТЗ для стандартных этапов (0023): закрытая и отменённая конечны, на проверку только с тремя фото. Свои этапы справочника и служба без входа не ограничены.';

-- Координатор поправил время окончания или дату выезда у задачи на проверке или закрытой:
-- дата окончания работ для отчётов пересчитывается.
CREATE OR REPLACE FUNCTION public.sync_task_completed_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status_code IN ('under_review', 'closed')
     AND (NEW.work_finished_at IS DISTINCT FROM OLD.work_finished_at OR NEW.visit_date IS DISTINCT FROM OLD.visit_date) THEN
    NEW.completed_at := public.task_work_completed_at(NEW.work_finished_at, NEW.visit_date, NEW.completed_at);
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS tasks_completed_at_sync ON public.tasks;
CREATE TRIGGER tasks_completed_at_sync
  BEFORE UPDATE OF work_finished_at, visit_date ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.sync_task_completed_at();

REVOKE EXECUTE ON FUNCTION public.sync_task_completed_at() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.task_work_completed_at(timestamptz, date, timestamptz) FROM PUBLIC, anon;
