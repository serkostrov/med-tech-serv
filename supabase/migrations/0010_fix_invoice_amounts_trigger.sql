-- Исправление: счёт не создавался.
-- В enforce_invoice_amounts() переменная line_total совпадала с колонкой invoice_items.line_total,
-- и любой INSERT/UPDATE счёта падал с ошибкой «column reference "line_total" is ambiguous».

CREATE OR REPLACE FUNCTION public.enforce_invoice_amounts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  items_total numeric;
BEGIN
  SELECT coalesce(sum(item.line_total), 0) INTO items_total
    FROM public.invoice_items AS item
   WHERE item.invoice_id = NEW.id;
  NEW.subtotal := items_total;
  NEW.total_amount := greatest(0::numeric, items_total + coalesce(NEW.adjustment_amount, 0));
  RETURN NEW;
END
$$;
