-- Отчёт: разрез «Откуда задача» — из плана ТО или разовая заявка (встреча 16.11, 46:03).
--
-- Что было не так. На встрече заказчик вспоминал отчёт «виды заявок: запланированные или просто
-- новые». В отчёте были этапы «Запланировано» и «Новая», но задача из плана ТО, перешедшая
-- в работу, в этапах уже не отличается от разовой: признак «из плана ТО» в разрезы не попадал.
--
-- Что делаем. report_task_breakdown (последний раз 0060) получает разрез source по признаку
-- tasks.is_maintenance_plan: «Из плана ТО» (plan) и «Разовая заявка» (single). Остальные
-- разрезы и подпись функции прежние.
-- Миграцию можно применить повторно.

CREATE OR REPLACE FUNCTION public.report_task_breakdown(p_from date, p_to date)
RETURNS TABLE (
  section text,
  item_code text,
  item_name text,
  task_count integer,
  closed_count integer,
  overdue_count integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH period AS (
    SELECT * FROM public.report_period_tasks(p_from, p_to)
  ), cuts AS (
    SELECT 'status' AS section, task.status_code AS item_code,
           coalesce(status.name, task.status_code) AS item_name,
           task.is_closed, task.is_overdue
      FROM period AS task
      LEFT JOIN public.task_statuses AS status ON status.code = task.status_code
    UNION ALL
    -- Задача с несколькими видами работ считается в каждом своём виде (0060): «инсталляция
    -- и ремонт» — одна заявка и в инсталляции, и в ремонте. Сумма разреза может быть
    -- больше числа заявок, доли интерфейс считает от числа заявок периода.
    SELECT 'work_type', kind.code,
           coalesce(work_type.name, kind.code),
           task.is_closed, task.is_overdue
      FROM period AS task
      JOIN public.tasks AS source ON source.id = task.task_id
      CROSS JOIN LATERAL unnest(ARRAY[source.work_type_code] || source.extra_work_type_codes) AS kind(code)
      LEFT JOIN public.work_types AS work_type ON work_type.code = kind.code
    UNION ALL
    SELECT 'month', task.created_month, task.created_month, task.is_closed, task.is_overdue
      FROM period AS task
    UNION ALL
    -- Откуда задача (встреча 16.11, 46:03): из плана ТО или разовая заявка (письмо, вручную).
    SELECT 'source',
           CASE WHEN source.is_maintenance_plan THEN 'plan' ELSE 'single' END,
           CASE WHEN source.is_maintenance_plan THEN 'Из плана ТО' ELSE 'Разовая заявка' END,
           task.is_closed, task.is_overdue
      FROM period AS task
      JOIN public.tasks AS source ON source.id = task.task_id
    UNION ALL
    SELECT 'reason', coalesce(task.reason_code, 'unset'),
           CASE WHEN task.reason_code IS NULL THEN 'Причина не указана'
                ELSE coalesce(reason.name, 'Причина') END,
           task.is_closed, task.is_overdue
      FROM period AS task
      LEFT JOIN public.task_reasons AS reason ON reason.code = task.reason_code
    UNION ALL
    SELECT 'modifier', coalesce(task.work_modifier::text, 'unset'),
           CASE task.work_modifier
             WHEN 'G' THEN 'Г · гарантийные работы'
             WHEN 'N' THEN 'Н · вина пользователя'
             ELSE 'Не отмечено'
           END,
           task.is_closed, task.is_overdue
      FROM period AS task
    UNION ALL
    -- Названия: «не указан» говорим только тогда, когда ссылки в задаче и правда нет.
    -- Если ссылка есть, а строки не видно (правила строк справочника строже, чем задач),
    -- пишем родовое слово — сказать «не указан» значило бы соврать про данные.
    SELECT 'equipment', coalesce(task.equipment_id::text, 'unset'),
           CASE
             WHEN task.equipment_id IS NULL THEN 'Прибор не указан'
             ELSE coalesce(nullif(concat_ws(' · ',
                    nullif(concat_ws(' ', maker.name, model.name), ''),
                    equipment.serial_number), ''), 'Прибор')
           END,
           task.is_closed, task.is_overdue
      FROM period AS task
      LEFT JOIN public.equipment AS equipment ON equipment.id = task.equipment_id
      LEFT JOIN public.equipment_models AS model ON model.id = equipment.model_id
      LEFT JOIN public.manufacturers AS maker ON maker.id = equipment.manufacturer_id
    UNION ALL
    SELECT 'site', coalesce(task.site_id::text, 'unset'),
           CASE WHEN task.site_id IS NULL THEN 'Площадка не указана'
                ELSE coalesce(site.name, 'Площадка') END,
           task.is_closed, task.is_overdue
      FROM period AS task
      LEFT JOIN public.sites AS site ON site.id = task.site_id
    UNION ALL
    SELECT 'engineer', coalesce(task.engineer_id::text, 'unset'),
           CASE WHEN task.engineer_id IS NULL THEN 'Инженер не назначен'
                ELSE coalesce(engineer.full_name, 'Инженер') END,
           task.is_closed, task.is_overdue
      FROM period AS task
      LEFT JOIN public.users AS engineer ON engineer.id = task.engineer_id
  )
  SELECT
    cuts.section,
    cuts.item_code,
    cuts.item_name,
    count(*)::integer,
    count(*) FILTER (WHERE cuts.is_closed)::integer,
    count(*) FILTER (WHERE cuts.is_overdue)::integer
    FROM cuts
   GROUP BY cuts.section, cuts.item_code, cuts.item_name
   -- Сверху самые частые: интерфейс рисует полосы в этом порядке, месяцы он
   -- раскладывает сам по календарю.
   ORDER BY cuts.section, count(*) DESC, cuts.item_name
$$;

COMMENT ON FUNCTION public.report_task_breakdown(date, date) IS
  'Разбивки отчёта по задачам за период (0044, 0060, 0070): section = status | work_type | month | source | reason | modifier | equipment | site | engineer. В разрезе work_type задача считается в каждом своём виде работ — основном и дополнительных; source — из плана ТО (plan) или разовая заявка (single).';

NOTIFY pgrst, 'reload schema';
