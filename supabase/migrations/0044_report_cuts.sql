-- Разрезы отчётов за период считает база (блок 10 ТЗ: отчёты и справочники).
--
-- Что было не так. Раздел «Отчёты» грузил в браузер все задачи периода (operationsReport
-- читал tasks страницами по 1000) и считал разбивки на устройстве. На стенде это тысячи
-- задач за полгода: лишний трафик, память и секунды ожидания на каждом открытии отчёта.
-- Разрезов из ТЗ при этом не было совсем — ни причин обращений, ни гарантийности работ
-- и замен, ни загрузки инженеров.
--
-- Что делаем. Разрезы считает база и отдаёт готовые строки с понятными именами столбцов:
--   report_period_tasks    — задачи периода одним набором (на нём стоят остальные),
--   report_task_summary    — цифры шапки отчёта,
--   report_task_breakdown  — все разбивки по задачам одним запросом: этапы, виды работ,
--                            месяцы, причины обращений, гарантийность работ (Г/Н),
--                            приборы, площадки, инженеры,
--   report_part_warranty   — гарантийность замен запчастей (Г/Н/Б),
--   report_engineer_load   — загрузка инженеров за период.
-- Деньги в отчётах (затраты по приборам и плательщикам) — отдельная миграция 0045:
-- у них своё право finance.read, и смешивать их с операционными разрезами нельзя.
--
-- Период. Границы включительные и считаются по часам компании (Москва), как «сегодня»
-- в остальных расчётах: день начинается в московскую полночь. Отбор идёт сравнением
-- created_at с границами-моментами, а не выражением над столбцом, — так работает индекс.
--
-- Права. Функции работают с правами вызывающего (SECURITY INVOKER): правила строк задач
-- сами решают, чьи задачи видно. Инженер с tasks.read_own увидит в отчёте только свои
-- задачи, а не чужие. Никаких денег эти функции не отдают.
--
-- Миграцию можно применить повторно.

-- ---------------------------------------------------------------------------
-- 1. Начало дня по часам компании
-- ---------------------------------------------------------------------------

-- Момент московской полуночи заданного дня. Нужен, чтобы отбирать задачи периода
-- условием `created_at >= начало_первого_дня AND created_at < начало_дня_после_последнего`:
-- такое условие ложится на обычный индекс по created_at, а `(created_at AT TIME ZONE …)::date`
-- заставил бы читать всю таблицу.
CREATE OR REPLACE FUNCTION public.company_day_start(p_day date)
RETURNS timestamptz
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT p_day::timestamp AT TIME ZONE 'Europe/Moscow'
$$;

COMMENT ON FUNCTION public.company_day_start(date) IS
  'Московская полночь заданного дня (0044). По ней отчёты отбирают период по created_at: условие с границами-моментами использует индекс, а выражение над столбцом — нет.';

REVOKE ALL ON FUNCTION public.company_day_start(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.company_day_start(date) TO authenticated;

-- Отчёт отбирает задачи по дню создания, поэтому нужен индекс именно по created_at:
-- прежние индексы задач начинаются с этапа, инженера, площадки или вида работ.
CREATE INDEX IF NOT EXISTS tasks_created_at_idx ON public.tasks (created_at);

-- Загрузка инженеров отбирает по сроку выполнения, а не по дню создания, и смотрит
-- только назначенные неотменённые задачи. Прежний индекс по инженеру начинается
-- с engineer_id, и по одному лишь периоду им не воспользоваться.
CREATE INDEX IF NOT EXISTS tasks_engineer_load_idx
  ON public.tasks (deadline_to, deadline_from)
  WHERE engineer_id IS NOT NULL AND status_code <> 'cancelled';

-- ---------------------------------------------------------------------------
-- 2. Задачи периода
-- ---------------------------------------------------------------------------

-- Один набор задач периода со всем, что нужно разрезам. Остальные функции отчёта стоят
-- на нём, чтобы правило «что считается задачей периода» лежало в одном месте.
-- Планировщик её не подставляет в запрос (из-за SET search_path функция не инлайнится),
-- поэтому каждая функция отчёта проходит по задачам периода отдельно. Проходов три
-- на открытие отчёта, и отбор идёт по индексу tasks_created_at_idx — этого достаточно;
-- снимать SET search_path ради инлайнинга не будем, это защита от подмены объектов.
CREATE OR REPLACE FUNCTION public.report_period_tasks(p_from date, p_to date)
RETURNS TABLE (
  task_id uuid,
  task_number text,
  status_code text,
  work_type_code text,
  reason_code text,
  work_modifier public.work_modifier,
  equipment_id uuid,
  site_id uuid,
  payer_id uuid,
  engineer_id uuid,
  created_day date,
  created_month text,
  deadline_from date,
  deadline_to date,
  completed_day date,
  work_hours numeric,
  is_closed boolean,
  is_cancelled boolean,
  is_overdue boolean,
  closed_on_time boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT
    task.id,
    task.number,
    task.status_code,
    task.work_type_code,
    task.reason_code,
    task.work_modifier,
    task.equipment_id,
    task.site_id,
    task.payer_id,
    task.engineer_id,
    (task.created_at AT TIME ZONE 'Europe/Moscow')::date,
    to_char(task.created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM'),
    task.deadline_from,
    task.deadline_to,
    (task.completed_at AT TIME ZONE 'Europe/Moscow')::date,
    task.hours,
    task.status_code = 'closed',
    task.status_code = 'cancelled',
    -- Просрочена к концу периода, но не позже сегодняшнего дня: период может
    -- заканчиваться в будущем, и тогда «просрочено» считается на сегодня.
    public.service_task_is_overdue(
      task.deadline_to, task.status_code,
      least(p_to, public.company_today())),
    -- Закрыта вовремя: день окончания работ не позже конца срока. Без срока
    -- или без даты окончания — NULL: такие задачи в проценте не участвуют.
    CASE
      WHEN task.status_code <> 'closed' OR task.completed_at IS NULL OR task.deadline_to IS NULL THEN NULL
      ELSE (task.completed_at AT TIME ZONE 'Europe/Moscow')::date <= task.deadline_to
    END
    FROM public.tasks AS task
   WHERE p_from IS NOT NULL AND p_to IS NOT NULL AND p_to >= p_from
     AND task.created_at >= public.company_day_start(p_from)
     AND task.created_at < public.company_day_start(p_to + 1)
$$;

COMMENT ON FUNCTION public.report_period_tasks(date, date) IS
  'Задачи периода для отчётов (0044): созданные с p_from по p_to включительно по часам компании, с готовыми признаками «закрыта», «отменена», «просрочена», «закрыта вовремя». Права вызывающего: чужих задач не покажет.';

REVOKE ALL ON FUNCTION public.report_period_tasks(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_period_tasks(date, date) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Цифры шапки отчёта
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.report_task_summary(p_from date, p_to date)
RETURNS TABLE (
  task_count integer,
  closed_count integer,
  cancelled_count integer,
  open_count integer,
  overdue_count integer,
  closed_on_time_count integer,
  closed_dated_count integer,
  closed_on_time_percent integer,
  engineer_count integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT
    count(*)::integer,
    count(*) FILTER (WHERE task.is_closed)::integer,
    count(*) FILTER (WHERE task.is_cancelled)::integer,
    count(*) FILTER (WHERE NOT task.is_closed AND NOT task.is_cancelled)::integer,
    count(*) FILTER (WHERE task.is_overdue)::integer,
    count(*) FILTER (WHERE task.closed_on_time)::integer,
    count(*) FILTER (WHERE task.closed_on_time IS NOT NULL)::integer,
    -- Процент «вовремя» — от закрытых со сроком и датой окончания, а не от всех:
    -- иначе задачи без срока опускали бы показатель, хотя их никто не просрочил.
    CASE
      WHEN count(*) FILTER (WHERE task.closed_on_time IS NOT NULL) = 0 THEN 0
      ELSE round(
        100.0 * count(*) FILTER (WHERE task.closed_on_time)
             / count(*) FILTER (WHERE task.closed_on_time IS NOT NULL))::integer
    END,
    count(DISTINCT task.engineer_id)::integer
    FROM public.report_period_tasks(p_from, p_to) AS task
$$;

COMMENT ON FUNCTION public.report_task_summary(date, date) IS
  'Цифры шапки отчёта за период (0044): всего, закрыто, отменено, открытые, просрочено, доля закрытых вовремя и число занятых инженеров.';

REVOKE ALL ON FUNCTION public.report_task_summary(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_task_summary(date, date) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Разбивки по задачам
-- ---------------------------------------------------------------------------

-- Все разбивки отчёта одним запросом: столбец section говорит, какой это разрез.
-- Разрезы перечислены в ТЗ (блок 10): выезды за период по приборам, площадкам,
-- инженерам и видам работ, причины обращений, гарантийность работ.
--   status     — этапы задач;
--   work_type  — виды работ;
--   month      — месяцы периода (пустые месяцы дописывает интерфейс);
--   reason     — причина обращения из акта (износ / вина пользователя / гарантия);
--   modifier   — гарантийность работ: Г, Н и «не отмечено»;
--   equipment  — приборы (прибор не указан идёт одной строкой);
--   site       — площадки;
--   engineer   — инженеры (без инженера — одна строка).
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
    SELECT 'work_type', task.work_type_code,
           coalesce(work_type.name, task.work_type_code),
           task.is_closed, task.is_overdue
      FROM period AS task
      LEFT JOIN public.work_types AS work_type ON work_type.code = task.work_type_code
    UNION ALL
    SELECT 'month', task.created_month, task.created_month, task.is_closed, task.is_overdue
      FROM period AS task
    UNION ALL
    SELECT 'reason', coalesce(task.reason_code, 'unset'),
           CASE WHEN task.reason_code IS NULL THEN 'Причина не указана'
                ELSE coalesce(reason.name, task.reason_code) END,
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
  'Разбивки отчёта по задачам за период (0044): section = status | work_type | month | reason | modifier | equipment | site | engineer, по строке на значение разреза с числом задач, закрытых и просроченных.';

REVOKE ALL ON FUNCTION public.report_task_breakdown(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_task_breakdown(date, date) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Гарантийность замен запчастей (Г/Н/Б)
-- ---------------------------------------------------------------------------

-- По работам отметка одна («Г» или «Н»), а по запчастям состояний три: гарантийная,
-- новая и бывшая в употреблении. Считаем по запчастям задач периода: сколько позиций,
-- сколько штук и в скольких задачах встречалось каждое состояние.
CREATE OR REPLACE FUNCTION public.report_part_warranty(p_from date, p_to date)
RETURNS TABLE (
  condition_code text,
  condition_name text,
  task_count integer,
  position_count integer,
  quantity numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT
    part.part_condition::text,
    CASE part.part_condition
      WHEN 'G' THEN 'Г · гарантийная'
      WHEN 'N' THEN 'Н · новая'
      ELSE 'Б · бывшая в употреблении'
    END,
    count(DISTINCT part.task_id)::integer,
    count(*)::integer,
    sum(part.quantity)::numeric(14, 3)
    FROM public.report_period_tasks(p_from, p_to) AS task
    JOIN public.task_parts AS part ON part.task_id = task.task_id
   GROUP BY part.part_condition
   ORDER BY count(*) DESC, part.part_condition
$$;

COMMENT ON FUNCTION public.report_part_warranty(date, date) IS
  'Гарантийность замен запчастей за период (0044): по строке на состояние Г/Н/Б с числом задач, позиций и суммарным количеством. Денег не отдаёт: цены запчастей живут в счёте.';

REVOKE ALL ON FUNCTION public.report_part_warranty(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_part_warranty(date, date) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Загрузка инженеров за период
-- ---------------------------------------------------------------------------

-- Загрузка — это не «сколько заявок создали», а «сколько дней периода инженер занят».
-- Поэтому здесь другой отбор, чем в разбивках: берём задачи, чей период выполнения
-- пересекается с периодом отчёта, независимо от дня создания. У задачи без периода
-- выполнения занятым считается день создания — иначе инженер, закрывший срочную
-- заявку в тот же день, выглядел бы свободным.
CREATE OR REPLACE FUNCTION public.report_engineer_load(p_from date, p_to date)
RETURNS TABLE (
  engineer_id uuid,
  engineer_name text,
  task_count integer,
  closed_count integer,
  overdue_count integer,
  busy_days integer,
  period_days integer,
  work_hours numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT p_from AS period_from, p_to AS period_to,
           (p_to - p_from + 1) AS period_days
     WHERE p_from IS NOT NULL AND p_to IS NOT NULL AND p_to >= p_from
  ), engineer_tasks AS (
    SELECT
      task.id AS task_id,
      task.engineer_id,
      task.status_code = 'closed' AS is_closed,
      public.service_task_is_overdue(task.deadline_to, task.status_code,
        least(bounds.period_to, public.company_today())) AS is_overdue,
      task.hours AS work_hours,
      -- Занятые дни: пересечение периода выполнения с периодом отчёта.
      greatest(coalesce(task.deadline_from, (task.created_at AT TIME ZONE 'Europe/Moscow')::date),
               bounds.period_from) AS busy_from,
      least(coalesce(task.deadline_to, (task.created_at AT TIME ZONE 'Europe/Moscow')::date),
            bounds.period_to) AS busy_to
      FROM bounds
      JOIN public.tasks AS task ON task.engineer_id IS NOT NULL
       -- Отменённая задача инженера не занимает.
       AND task.status_code <> 'cancelled'
       -- Два условия по самим столбцам: они следуют из условий ниже (там, где срок
       -- задан, coalesce равен сроку), но планировщик видит их как диапазон и берёт
       -- индекс tasks_engineer_load_idx вместо чтения всей таблицы задач.
       AND (task.deadline_to IS NULL OR task.deadline_to >= bounds.period_from)
       AND (task.deadline_from IS NULL OR task.deadline_from <= bounds.period_to)
       AND coalesce(task.deadline_from, (task.created_at AT TIME ZONE 'Europe/Moscow')::date) <= bounds.period_to
       AND coalesce(task.deadline_to, (task.created_at AT TIME ZONE 'Europe/Moscow')::date) >= bounds.period_from
  ), busy AS (
    SELECT engineer_tasks.engineer_id, day::date AS busy_day
      FROM engineer_tasks,
           generate_series(engineer_tasks.busy_from, engineer_tasks.busy_to, interval '1 day') AS day
     GROUP BY engineer_tasks.engineer_id, day
  )
  SELECT
    engineer_tasks.engineer_id,
    coalesce(engineer.full_name, 'Инженер удалён'),
    count(*)::integer,
    count(*) FILTER (WHERE engineer_tasks.is_closed)::integer,
    count(*) FILTER (WHERE engineer_tasks.is_overdue)::integer,
    (SELECT count(*)::integer FROM busy WHERE busy.engineer_id = engineer_tasks.engineer_id),
    (SELECT period_days::integer FROM bounds),
    coalesce(sum(engineer_tasks.work_hours), 0)::numeric(10, 2)
    FROM engineer_tasks
    LEFT JOIN public.users AS engineer ON engineer.id = engineer_tasks.engineer_id
   GROUP BY engineer_tasks.engineer_id, engineer.full_name
   ORDER BY count(*) DESC, coalesce(engineer.full_name, 'Инженер удалён')
$$;

COMMENT ON FUNCTION public.report_engineer_load(date, date) IS
  'Загрузка инженеров за период (0044): задачи, чей период выполнения пересекается с периодом отчёта, число занятых дней из этого пересечения, длина периода и часы по «прочим работам». Отменённые задачи не считаются.';

REVOKE ALL ON FUNCTION public.report_engineer_load(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_engineer_load(date, date) TO authenticated;
