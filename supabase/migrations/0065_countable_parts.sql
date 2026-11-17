-- Штучная запчасть не делится (аудит 17.11.2026, находка 92).
--
-- Что было не так. Количество на складе — numeric(14, 3), и предохранитель можно было
-- списать «1,5 шт.», принять накладной «2,5» или зарезервировать дробью. Для трубки,
-- которую меряют метрами, дробь уместна, для лампы и насоса — нет: остаток в штуках
-- с дробью не сойдётся с 1С.
--
-- Что делаем.
--   1. parts.is_countable — «считается штуками». По умолчанию да: так почти у всех
--      запчастей. Снимают в карточке запчасти, если её меряют метрами или литрами.
--   2. Страж движений и резервов: у штучной запчасти количество целое. Отказ называет
--      артикул и говорит, где снять признак. Прошлые движения не проверяются.
-- Миграцию можно применить повторно.

ALTER TABLE public.parts ADD COLUMN IF NOT EXISTS is_countable boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.parts.is_countable IS
  'Считается штуками (0065): количество в движениях и резервах целое. Снимают у запчастей, которые меряют метрами или литрами.';

-- Если запчасть уже лежит дробью, признак сразу снимаем: иначе её нельзя было бы ни
-- выдать, ни списать до последней доли.
UPDATE public.parts AS part
   SET is_countable = false
 WHERE part.is_countable
   AND EXISTS (SELECT 1 FROM public.stock_movements AS m
                WHERE m.part_id = part.id AND m.quantity <> trunc(m.quantity));

CREATE OR REPLACE FUNCTION public.guard_countable_part_quantity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  part_row public.parts%ROWTYPE;
BEGIN
  IF NEW.quantity = trunc(NEW.quantity) THEN
    RETURN NEW;
  END IF;
  SELECT * INTO part_row FROM public.parts WHERE id = NEW.part_id;
  IF part_row.is_countable THEN
    RAISE EXCEPTION 'Запчасть «%» считается штуками: укажите целое количество. Если её меряют метрами или литрами, снимите в карточке запчасти галочку «Считается штуками»',
      part_row.article_number
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.guard_countable_part_quantity() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.guard_countable_part_quantity() IS
  'Страж (0065): у штучной запчасти количество движения и резерва целое.';

DROP TRIGGER IF EXISTS stock_movements_countable_quantity ON public.stock_movements;
CREATE TRIGGER stock_movements_countable_quantity
  BEFORE INSERT ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.guard_countable_part_quantity();

DROP TRIGGER IF EXISTS stock_reservations_countable_quantity ON public.stock_reservations;
CREATE TRIGGER stock_reservations_countable_quantity
  BEFORE INSERT OR UPDATE OF quantity ON public.stock_reservations
  FOR EACH ROW EXECUTE FUNCTION public.guard_countable_part_quantity();

NOTIFY pgrst, 'reload schema';
