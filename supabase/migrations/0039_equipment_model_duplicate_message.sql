-- Вторая модель прибора с тем же названием у того же производителя: понятный отказ.
--
-- Зачем. В базе дубль запрещён индексом equipment_models_manufacturer_name_ci_uq
-- (внутри 0001), так что вторая «AU 680» у Beckman Coulter не создастся. Но в приложении
-- проверки нет, и человек видел не «Такая модель уже есть», а сырое сообщение базы
-- о нарушении уникальности: в понятный текст переводится только часть случаев, и этот
-- в их число не входил. Если же первая запись скрыта, подсказка нужна тем более:
-- в списке её не видно, и причина отказа выглядит выдумкой.
--
-- Что теперь. Проверка идёт до записи и называет производителя, модель и состояние
-- найденной записи. Сам индекс остаётся: он и есть гарантия, триггер лишь объясняет.
-- Регистр и лишние пробелы не учитываются — так же, как в индексе и как в проверке
-- серийного номера прибора.
--
-- Похожие объяснения вместо сырых ошибок: 0030 (удаление периода плана ТО),
-- 0033 (встроенные значения справочников).
-- Функция, как все служебные триггеры (0009), работает от владельца схемы.
-- Миграцию можно применить повторно.

CREATE OR REPLACE FUNCTION public.guard_equipment_model_duplicate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  existing record;
BEGIN
  SELECT model.is_active, maker.name AS manufacturer_name
    INTO existing
    FROM public.equipment_models AS model
    JOIN public.manufacturers AS maker ON maker.id = model.manufacturer_id
   WHERE model.manufacturer_id = NEW.manufacturer_id
     AND lower(btrim(model.name)) = lower(btrim(NEW.name))
     AND model.id <> NEW.id
   LIMIT 1;

  IF existing IS NOT NULL THEN
    RAISE EXCEPTION 'Модель «%» у производителя «%» уже есть в справочнике%. Регистр и пробелы при проверке не учитываются',
      btrim(NEW.name), existing.manufacturer_name,
      CASE WHEN existing.is_active THEN '' ELSE ', но скрыта: верните её кнопкой «Показать»' END
      USING ERRCODE = '23505', CONSTRAINT = 'equipment_models_manufacturer_name_ci_uq';
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.guard_equipment_model_duplicate() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.guard_equipment_model_duplicate() IS
  'Дубль модели прибора у одного производителя объясняется по-русски вместо сырой ошибки уникальности (0039).';

DROP TRIGGER IF EXISTS equipment_models_duplicate_message ON equipment_models;
CREATE TRIGGER equipment_models_duplicate_message
  BEFORE INSERT OR UPDATE OF name, manufacturer_id ON equipment_models
  FOR EACH ROW EXECUTE FUNCTION public.guard_equipment_model_duplicate();
