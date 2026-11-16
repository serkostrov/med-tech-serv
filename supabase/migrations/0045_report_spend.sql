-- Затраты в отчётах: по приборам и по плательщикам (блок 10 ТЗ), только для finance.read.
--
-- Что было. По деньгам в базе была одна функция — equipment_spend (0040): суммы по одному
-- прибору за период, для его карточки. Отчёта «на что уходят деньги» не было: ни списка
-- приборов по затратам, ни разреза по плательщикам. ТЗ требует оба.
--
-- Что делаем. Две функции считают суммы в базе и отдают готовые строки:
--   report_equipment_spend — затраты по приборам за период,
--   report_payer_spend     — затраты по плательщикам за период.
--
-- Откуда суммы. Из позиций неотменённых счетов: отменённый счёт не платят. Дата счёта —
-- день выставления, а у черновика день создания, по московским суткам: так же считает
-- equipment_spend (0040), и так же сверяет период бухгалтерия.
--
-- Права. Деньги показываем только тому, у кого есть finance.read. Правила строк на
-- invoices и invoice_items это и так обеспечивают (функции работают с правами
-- вызывающего), но здесь стоит и явная проверка: инженеру и кладовщику функция
-- возвращает пустой набор, а не «нули по всем приборам», из которых видно, по каким
-- приборам счета вообще есть. Одно правило в одном месте — и его видно в тесте.
--
-- Миграцию можно применить повторно.

-- ---------------------------------------------------------------------------
-- 1. Затраты по приборам
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.report_equipment_spend(p_from date, p_to date)
RETURNS TABLE (
  equipment_id uuid,
  serial_number text,
  equipment_name text,
  site_name text,
  payer_name text,
  task_count integer,
  invoice_count integer,
  work_amount numeric,
  parts_amount numeric,
  total_amount numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT
    equipment.id,
    equipment.serial_number,
    nullif(concat_ws(' ', maker.name, model.name), ''),
    site.name,
    payer.name,
    count(DISTINCT task.id)::integer,
    count(DISTINCT invoice.id)::integer,
    coalesce(sum(item.line_total) FILTER (WHERE item.item_type = 'work'), 0)::numeric(14, 2),
    coalesce(sum(item.line_total) FILTER (WHERE item.item_type = 'part'), 0)::numeric(14, 2),
    coalesce(sum(item.line_total), 0)::numeric(14, 2)
    FROM public.invoice_items AS item
    JOIN public.invoices AS invoice ON invoice.id = item.invoice_id
    JOIN public.tasks AS task ON task.id = item.task_id
    JOIN public.equipment AS equipment ON equipment.id = task.equipment_id
    LEFT JOIN public.equipment_models AS model ON model.id = equipment.model_id
    LEFT JOIN public.manufacturers AS maker ON maker.id = equipment.manufacturer_id
    LEFT JOIN public.sites AS site ON site.id = equipment.current_site_id
    LEFT JOIN public.payers AS payer ON payer.id = equipment.current_payer_id
   WHERE public.app_has_permission('finance.read')
     AND invoice.status <> 'cancelled'
     AND (p_from IS NULL
          OR (coalesce(invoice.issued_at, invoice.created_at) AT TIME ZONE 'Europe/Moscow')::date >= p_from)
     AND (p_to IS NULL
          OR (coalesce(invoice.issued_at, invoice.created_at) AT TIME ZONE 'Europe/Moscow')::date <= p_to)
   GROUP BY equipment.id, equipment.serial_number, maker.name, model.name, site.name, payer.name
   ORDER BY coalesce(sum(item.line_total), 0) DESC, equipment.serial_number
$$;

COMMENT ON FUNCTION public.report_equipment_spend(date, date) IS
  'Затраты по приборам за период (0045): суммы позиций неотменённых счетов по задачам прибора, отдельно работы и запчасти. Период по дню счёта (выставлен, у черновика создан) в московских сутках, границы включительно. Без finance.read возвращает пустой набор.';

REVOKE ALL ON FUNCTION public.report_equipment_spend(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_equipment_spend(date, date) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Затраты по плательщикам
-- ---------------------------------------------------------------------------

-- У плательщика считаем и итог счёта, а не только сумму позиций: ручная корректировка
-- (adjustment_amount) — это тоже его деньги, и в разрезе «кому выставляем» она должна
-- быть видна. Поэтому позиции и итоги считаются отдельно и сводятся по плательщику:
-- иначе соединение позиций с счётом размножило бы итог на число позиций.
CREATE OR REPLACE FUNCTION public.report_payer_spend(p_from date, p_to date)
RETURNS TABLE (
  payer_id uuid,
  payer_name text,
  invoice_count integer,
  task_count integer,
  work_amount numeric,
  parts_amount numeric,
  adjustment_amount numeric,
  total_amount numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH allowed AS (
    SELECT invoice.id, invoice.payer_id, invoice.adjustment_amount, invoice.total_amount
      FROM public.invoices AS invoice
     WHERE public.app_has_permission('finance.read')
       AND invoice.status <> 'cancelled'
       AND (p_from IS NULL
            OR (coalesce(invoice.issued_at, invoice.created_at) AT TIME ZONE 'Europe/Moscow')::date >= p_from)
       AND (p_to IS NULL
            OR (coalesce(invoice.issued_at, invoice.created_at) AT TIME ZONE 'Europe/Moscow')::date <= p_to)
  ), lines AS (
    SELECT
      allowed.payer_id,
      coalesce(sum(item.line_total) FILTER (WHERE item.item_type = 'work'), 0) AS work_amount,
      coalesce(sum(item.line_total) FILTER (WHERE item.item_type = 'part'), 0) AS parts_amount,
      count(DISTINCT item.task_id)::integer AS task_count
      FROM allowed
      LEFT JOIN public.invoice_items AS item ON item.invoice_id = allowed.id
     GROUP BY allowed.payer_id
  ), totals AS (
    SELECT
      allowed.payer_id,
      count(*)::integer AS invoice_count,
      sum(allowed.adjustment_amount) AS adjustment_amount,
      sum(allowed.total_amount) AS total_amount
      FROM allowed
     GROUP BY allowed.payer_id
  )
  SELECT
    totals.payer_id,
    coalesce(payer.name, 'Плательщик удалён'),
    totals.invoice_count,
    coalesce(lines.task_count, 0),
    coalesce(lines.work_amount, 0)::numeric(14, 2),
    coalesce(lines.parts_amount, 0)::numeric(14, 2),
    coalesce(totals.adjustment_amount, 0)::numeric(14, 2),
    coalesce(totals.total_amount, 0)::numeric(14, 2)
    FROM totals
    LEFT JOIN lines ON lines.payer_id = totals.payer_id
    LEFT JOIN public.payers AS payer ON payer.id = totals.payer_id
   ORDER BY coalesce(totals.total_amount, 0) DESC, coalesce(payer.name, 'Плательщик удалён')
$$;

COMMENT ON FUNCTION public.report_payer_spend(date, date) IS
  'Затраты по плательщикам за период (0045): по строке на плательщика — счетов, задач, суммы работ и запчастей, ручная корректировка и итог неотменённых счетов. Период по дню счёта в московских сутках. Без finance.read возвращает пустой набор.';

REVOKE ALL ON FUNCTION public.report_payer_spend(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_payer_spend(date, date) TO authenticated;
