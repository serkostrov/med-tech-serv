-- КП — коммерческие предложения (ТЗ, блок 9: «позиции из номенклатуры и остатков, сумма,
-- статус, выгрузка»).
--
-- Что было. Таблицы quotes и quote_items есть с 0001: номер КП-000001, статусы
-- (черновик, отправлено, принято, отклонено, истёк срок), итог считается сам из позиций,
-- права — у тех, кто видит деньги или ведёт договоры (0009). Экрана не было, и база
-- ничего не сторожила: позиции отправленного клиенту КП можно было тихо поменять.
--
-- Что делаем.
--   1. Позиции меняются только в черновике. У штучной запчасти (0065) количество целое.
--   2. Статусы по порядку: черновик → отправлено → принято / отклонено / истёк срок;
--      ненужный черновик отменяют — он становится «Отклонено»; отправленное, отклонённое
--      и просроченное можно вернуть в черновик, принятое — нет. Пустое КП клиенту не отправить.
--   3. Название, клиент и срок действия меняются только в черновике. Удалять КП через API
--      нельзя с 0024 (деловые записи не удаляются); если владелец схемы удаляет руками —
--      только черновик.
--   4. Автор КП ставится сам, у позиции есть время добавления — по нему порядок в КП.
-- Миграцию можно применить повторно.

ALTER TABLE public.quotes ALTER COLUMN created_by SET DEFAULT auth.uid();
-- Позиции показываются в том порядке, в каком их добавили.
ALTER TABLE public.quote_items ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE INDEX IF NOT EXISTS quote_items_quote_order_idx ON public.quote_items (quote_id, created_at);

CREATE OR REPLACE FUNCTION public.quote_status_label(p_status public.quote_status)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE p_status
    WHEN 'draft' THEN 'Черновик'
    WHEN 'sent' THEN 'Отправлено'
    WHEN 'accepted' THEN 'Принято'
    WHEN 'rejected' THEN 'Отклонено'
    WHEN 'expired' THEN 'Истёк срок'
  END
$$;

COMMENT ON FUNCTION public.quote_status_label(public.quote_status) IS
  'Статус КП словом, как в интерфейсе (0071).';

CREATE OR REPLACE FUNCTION public.guard_quote()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Удалить можно только черновик КП: отправленное клиенту КП остаётся в истории'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Новое КП создаётся черновиком' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'draft' AND NEW.status IN ('sent', 'rejected'))
         OR (OLD.status = 'sent' AND NEW.status IN ('accepted', 'rejected', 'expired', 'draft'))
         OR (OLD.status IN ('rejected', 'expired') AND NEW.status = 'draft')) THEN
      RAISE EXCEPTION '% нельзя перевести из «%» в «%»',
        NEW.number, public.quote_status_label(OLD.status), public.quote_status_label(NEW.status)
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'sent' AND NOT EXISTS (SELECT 1 FROM public.quote_items AS item WHERE item.quote_id = NEW.id) THEN
      RAISE EXCEPTION 'В КП нет позиций: добавьте запчасти или работы, потом отправляйте клиенту'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status <> 'draft'
    AND (NEW.name, NEW.site_id, NEW.payer_id, NEW.valid_until) IS DISTINCT FROM (OLD.name, OLD.site_id, OLD.payer_id, OLD.valid_until) THEN
    RAISE EXCEPTION 'КП уже не черновик: название, клиента и срок действия меняют в черновике'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.guard_quote() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.guard_quote() IS
  'Страж КП (0071): создаётся черновиком, статусы по порядку, пустое не отправить, шапку меняют и удаляют только черновик.';

DROP TRIGGER IF EXISTS quotes_guard ON public.quotes;
CREATE TRIGGER quotes_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.guard_quote();

CREATE OR REPLACE FUNCTION public.guard_quote_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_status public.quote_status;
  part_row public.parts%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.quote_id IS DISTINCT FROM OLD.quote_id THEN
    RAISE EXCEPTION 'Позицию нельзя перенести в другое КП: удалите её и добавьте заново' USING ERRCODE = '23514';
  END IF;
  SELECT quote.status INTO current_status
    FROM public.quotes AS quote
   WHERE quote.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.quote_id ELSE NEW.quote_id END;
  -- КП удалили целиком: его строки уходят вместе с ним.
  IF FOUND AND current_status <> 'draft' THEN
    RAISE EXCEPTION 'КП уже не черновик: позиции меняют только в черновике. Верните КП в черновик, чтобы поправить'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.part_id IS NOT NULL AND NEW.quantity <> trunc(NEW.quantity) THEN
    SELECT * INTO part_row FROM public.parts WHERE id = NEW.part_id;
    IF part_row.is_countable THEN
      RAISE EXCEPTION 'Запчасть «%» считается штуками: укажите целое количество', part_row.article_number
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

REVOKE EXECUTE ON FUNCTION public.guard_quote_item() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.guard_quote_item() IS
  'Страж позиций КП (0071): меняются только в черновике, у штучной запчасти количество целое.';

DROP TRIGGER IF EXISTS quote_items_guard ON public.quote_items;
CREATE TRIGGER quote_items_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.quote_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_quote_item();

NOTIFY pgrst, 'reload schema';
