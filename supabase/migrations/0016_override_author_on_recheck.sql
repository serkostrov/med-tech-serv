-- Автор замены плательщика при повторной проверке.
--
-- После 0015 право на замену проверяется у вошедшего пользователя. Но снимок
-- плательщика задачи (и счёта) перепроверяет замену и при смене прибора или
-- плательщика, а автором оставался прежний сотрудник. Поэтому изменить такую
-- задачу мог только тот, кто делал замену. Теперь при любой перепроверке автором
-- становится тот, кто вносит изменение, право проверяется у него, а время замены обновляется.

CREATE OR REPLACE FUNCTION public.set_payer_override_author()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  new_row jsonb := to_jsonb(NEW);
  old_row jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END;
  equipment_column text := CASE WHEN TG_TABLE_NAME = 'invoices' THEN 'source_equipment_id' ELSE 'equipment_id' END;
BEGIN
  IF auth.uid() IS NOT NULL
     AND NEW.payer_overridden_by IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR NEW.payer_overridden_by IS DISTINCT FROM OLD.payer_overridden_by
          OR new_row -> 'payer_id' IS DISTINCT FROM old_row -> 'payer_id'
          OR new_row -> equipment_column IS DISTINCT FROM old_row -> equipment_column) THEN
    NEW.payer_overridden_by := auth.uid();
    -- Время замены ставит снимок плательщика (текущее), чтобы автор, причина и время совпадали.
    NEW.payer_overridden_at := NULL;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS invoices_aa_override_author ON public.invoices;
CREATE TRIGGER invoices_aa_override_author
  BEFORE INSERT OR UPDATE OF payer_overridden_by, payer_id, source_equipment_id ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.set_payer_override_author();

DROP TRIGGER IF EXISTS tasks_aa_override_author ON public.tasks;
CREATE TRIGGER tasks_aa_override_author
  BEFORE INSERT OR UPDATE OF payer_overridden_by, payer_id, equipment_id ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_payer_override_author();

REVOKE EXECUTE ON FUNCTION public.set_payer_override_author() FROM PUBLIC, anon, authenticated;
