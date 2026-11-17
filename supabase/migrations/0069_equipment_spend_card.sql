-- Затраты в карточке прибора (ТЗ, блок 8: «суммарные затраты за период в карточке прибора и отчётах»).
--
-- Что было не так. Затраты по приборам были только в отчёте «Затраты по приборам» (0045).
-- В паспорте прибора денег не было: чтобы узнать, во что обошёлся прибор, приходилось
-- идти в отчёты и искать его в списке.
--
-- Что делаем. Функция для одного прибора с тем же расчётом, что у отчёта: позиции
-- неотменённых счетов по задачам прибора, отдельно работы и запчасти, период по дню счёта
-- в московских сутках, границы включительно, пустая граница — без ограничения.
-- Права вызывающего: без finance.read пусто, как у отчёта. Строка одна всегда (нули, если
-- счетов не было), кроме тех, кому деньги не видны.
-- Миграцию можно применить повторно.

CREATE OR REPLACE FUNCTION public.equipment_spend_summary(p_equipment_id uuid, p_from date, p_to date)
RETURNS TABLE (
  task_count integer,
  invoice_count integer,
  work_amount numeric,
  parts_amount numeric,
  total_amount numeric,
  last_billing_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT
    count(DISTINCT task.id)::integer,
    count(DISTINCT invoice.id)::integer,
    coalesce(sum(item.line_total) FILTER (WHERE item.item_type = 'work'), 0)::numeric(14, 2),
    coalesce(sum(item.line_total) FILTER (WHERE item.item_type = 'part'), 0)::numeric(14, 2),
    coalesce(sum(item.line_total), 0)::numeric(14, 2),
    max(invoice.billing_at)
    FROM public.tasks AS task
    JOIN public.invoice_items AS item ON item.task_id = task.id
    JOIN public.invoices AS invoice ON invoice.id = item.invoice_id
   WHERE task.equipment_id = p_equipment_id
     AND invoice.status <> 'cancelled'
     AND (p_from IS NULL OR invoice.billing_at >= public.company_day_start(p_from))
     AND (p_to IS NULL OR invoice.billing_at < public.company_day_start(p_to + 1))
  HAVING public.app_has_permission('finance.read')
$$;

COMMENT ON FUNCTION public.equipment_spend_summary(uuid, date, date) IS
  'Затраты одного прибора за период для его карточки (0069): как отчёт report_equipment_spend (0045) — позиции неотменённых счетов по задачам прибора, работы и запчасти отдельно, период по дню счёта. Без finance.read пусто.';

REVOKE ALL ON FUNCTION public.equipment_spend_summary(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_spend_summary(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
