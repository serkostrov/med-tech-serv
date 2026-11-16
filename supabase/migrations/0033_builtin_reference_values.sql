-- Встроенные значения справочников нельзя отключить и удалить.
--
-- Зачем. Этапы задачи, статусы приборов и часть видов работ — это не просто строки
-- справочника: на них держится работа базы. Проверка `validate_active_task_status`
-- (внутри 0001) не даёт перевести задачу в выключенный этап, поэтому один щелчок
-- «Скрыть» у строки «Закрыта» в справочнике статусов останавливал закрытие задач
-- по всей системе: инженер сдавал работу, а координатор получал отказ
-- «Статус задачи не активен: closed». Узнавали об этом не в справочнике, а через
-- несколько дней на первой несданной работе.
--
-- Что теперь. У таких значений есть признак `is_builtin`. Встроенное значение нельзя
-- выключить, переименовать по коду, удалить, а у этапа задачи — ещё и поменять признак
-- «последний этап». Отказ приходит понятным текстом по-русски и называет, что сломается
-- без этого значения. Признак `is_builtin` со входом в CRM нельзя ни снять, ни поставить:
-- иначе запрет обходился бы в два щелчка, а своя запись справочника становилась бы вечной.
-- Свои значения справочника (например, свой этап «Ждёт запчасть») отключаются и удаляются
-- как раньше. Служебные операции без входа (обновление базы, импорт) работают как раньше:
-- запрет защищает от щелчка в интерфейсе, а не от владельца схемы.
--
-- Заодно миграция включает обратно встроенные значения, если их уже успели скрыть:
-- на стенде это чинит остановленное закрытие задач. Легаси-этап `rework` встроенным
-- не считается и остаётся выключенным, как его выключили в 0001.
--
-- Похожие запреты: 0023 (переходы этапов задачи) и 0024 (деловые записи не удаляются).
-- Функция, как все служебные триггеры (0009), работает от владельца схемы.
-- Миграцию можно применить повторно.

-- ---------------------------------------------------------------------------
-- 1. Признак «встроенное значение»
-- ---------------------------------------------------------------------------

ALTER TABLE task_statuses ADD COLUMN IF NOT EXISTS is_builtin boolean NOT NULL DEFAULT false;
ALTER TABLE equipment_statuses ADD COLUMN IF NOT EXISTS is_builtin boolean NOT NULL DEFAULT false;
ALTER TABLE work_types ADD COLUMN IF NOT EXISTS is_builtin boolean NOT NULL DEFAULT false;

-- Этапы схемы ТЗ (п. 3.9), по которым база двигает задачу (0023). Без любого из них
-- встаёт либо создание задачи, либо её закрытие или отмена.
UPDATE task_statuses
   SET is_builtin = true
 WHERE code IN ('planned', 'new', 'assigned', 'in_progress', 'under_review', 'closed', 'cancelled')
   AND NOT is_builtin;

-- «В эксплуатации» — значение по умолчанию у нового прибора, «Списан» — то, чем прибор
-- заменяет удаление (0024). Без них прибор не заведёшь и не спишешь.
UPDATE equipment_statuses
   SET is_builtin = true
 WHERE code IN ('in_use', 'written_off')
   AND NOT is_builtin;

-- «ТО по сервисной документации» ставит план ТО при создании задач (0026, 0030),
-- «Прочие работы» — единственный вид работ, который требует часы (проверка в 0001).
UPDATE work_types
   SET is_builtin = true
 WHERE code IN ('maintenance', 'other')
   AND NOT is_builtin;

-- Починка стенда, где встроенное значение уже скрыли щелчком в справочнике.
UPDATE task_statuses SET is_active = true WHERE is_builtin AND NOT is_active;
UPDATE equipment_statuses SET is_active = true WHERE is_builtin AND NOT is_active;
UPDATE work_types SET is_active = true WHERE is_builtin AND NOT is_active;

COMMENT ON COLUMN task_statuses.is_builtin IS
  'Встроенный этап работы (0033): отключить, удалить и переименовать по коду нельзя, без него база не двигает задачи.';
COMMENT ON COLUMN equipment_statuses.is_builtin IS
  'Встроенный статус прибора (0033): отключить и удалить нельзя, на нём держатся заведение и списание прибора.';
COMMENT ON COLUMN work_types.is_builtin IS
  'Встроенный вид работ (0033): отключить и удалить нельзя, на нём держатся план ТО и учёт часов.';

-- ---------------------------------------------------------------------------
-- 2. Запрет
-- ---------------------------------------------------------------------------

-- Первый аргумент триггера — чем держится значение: текст попадает в отказ, чтобы
-- человек видел не «нельзя», а что именно сломается.
CREATE OR REPLACE FUNCTION public.guard_builtin_reference_value()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  reason constant text := TG_ARGV[0];
BEGIN
  -- Служебные операции без входа (обновление базы, импорт, миграции) не ограничиваем:
  -- запрет защищает от щелчка в справочнике, а не от владельца схемы. Иначе размеченную
  -- запись нельзя было бы ни поправить, ни убрать даже следующей миграцией.
  IF auth.uid() IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.is_builtin THEN
      RAISE EXCEPTION 'Встроенное значение справочника «%» удалить нельзя: %', OLD.name, reason
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Встроенные значения заводит только обновление базы: со входом в CRM их не создать.
    IF NEW.is_builtin THEN
      RAISE EXCEPTION 'Встроенные значения справочника заводит только обновление базы. Добавьте обычное значение'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT OLD.is_builtin THEN
    -- Признак нельзя и поставить: иначе любой свой этап одним PATCH становился бы вечным.
    IF NEW.is_builtin THEN
      RAISE EXCEPTION 'Признак «встроенное значение» ставит только обновление базы: со входом в CRM его не назначить'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT NEW.is_builtin THEN
    RAISE EXCEPTION 'Значение справочника «%» встроено в работу системы, этот признак снять нельзя: %', OLD.name, reason
      USING ERRCODE = '23514';
  END IF;
  IF NOT NEW.is_active THEN
    RAISE EXCEPTION 'Встроенное значение справочника «%» отключить нельзя: %', OLD.name, reason
      USING ERRCODE = '23514';
  END IF;
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'У встроенного значения справочника «%» нельзя менять код: %. Название менять можно', OLD.name, reason
      USING ERRCODE = '23514';
  END IF;
  -- Только у этапов задачи: «последний этап» решает, двигается ли задача дальше.
  IF (to_jsonb(NEW) ->> 'is_terminal') IS DISTINCT FROM (to_jsonb(OLD) ->> 'is_terminal') THEN
    RAISE EXCEPTION 'У встроенного этапа «%» нельзя менять признак «последний этап»: %', OLD.name, reason
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

-- Вызывать её напрямую никому не нужно: только как триггер.
REVOKE EXECUTE ON FUNCTION public.guard_builtin_reference_value() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.guard_builtin_reference_value() IS
  'Встроенные значения справочников не отключаются, не удаляются и не теряют признак (0033). Причина передаётся аргументом триггера.';

DROP TRIGGER IF EXISTS task_statuses_guard_builtin ON task_statuses;
CREATE TRIGGER task_statuses_guard_builtin
  BEFORE INSERT OR UPDATE OR DELETE ON task_statuses
  FOR EACH ROW EXECUTE FUNCTION public.guard_builtin_reference_value(
    'без него задачи не двигаются по этапам и не закрываются');

DROP TRIGGER IF EXISTS equipment_statuses_guard_builtin ON equipment_statuses;
CREATE TRIGGER equipment_statuses_guard_builtin
  BEFORE INSERT OR UPDATE OR DELETE ON equipment_statuses
  FOR EACH ROW EXECUTE FUNCTION public.guard_builtin_reference_value(
    'на нём держатся заведение и списание прибора');

DROP TRIGGER IF EXISTS work_types_guard_builtin ON work_types;
CREATE TRIGGER work_types_guard_builtin
  BEFORE INSERT OR UPDATE OR DELETE ON work_types
  FOR EACH ROW EXECUTE FUNCTION public.guard_builtin_reference_value(
    'на нём держатся план ТО и учёт часов');
