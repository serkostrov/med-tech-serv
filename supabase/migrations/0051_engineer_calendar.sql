-- Календарь загрузки инженеров: выборку за период считает база, а не браузер.
--
-- На стенде задач будут тысячи, поэтому страница не читает все задачи и не раскладывает
-- их по дням на клиенте. Две функции отдают ровно то, что нужно экрану:
--
-- 1. engineer_calendar(p_from, p_to) — строки календаря: инженер и его задачи, которые
--    занимают хотя бы один день периода. Инженер без задач тоже приходит, одной строкой
--    с пустой задачей: иначе в сетке не было бы видно, у кого окно целиком. Открытые
--    задачи без срока и без даты выезда приходят отдельными строками с признаком
--    has_no_dates: ни на какой день их поставить нельзя, но координатор должен их видеть.
-- 2. engineer_period_load(p_from, p_to, p_ignore_task_id) — занятость каждого инженера
--    за период одной строкой: сколько задач, самый занятый день, сколько свободных
--    рабочих дней. Этим пользуется подсказка при назначении: ответ не зависит от числа
--    задач в периоде, поэтому подсказка одинаково быстрая и на неделю, и на месяц.
--    p_ignore_task_id исключает саму назначаемую задачу, чтобы она не считалась
--    занятостью инженера, которому её же и предлагают.
--
-- Дни считаются по московскому времени, как всё остальное в системе (миграции 0027 и 0037):
-- просрочка берётся от сегодняшнего дня компании (public.company_today()), а не от дня
-- сервера базы, который на стенде живёт в UTC.
--
-- Что считается днями задачи: период «с … по …» целиком (задача на три дня занимает
-- инженера три дня), а если периода нет — день выезда. Отменённые задачи не занимают
-- ничего: выезда не было. Закрытые остаются в прошедших днях, они действительно заняли
-- тот день. То же правило в src/engineer-calendar.ts, чтобы календарь и подсказка
-- считали одинаково.
--
-- Права. Функции работают с правами вызывающего (SECURITY INVOKER), задачи фильтруют
-- политики таблицы tasks (0014): кто видит только свои задачи, тот и в календаре увидит
-- только свои. Список инженеров функции ограничивают сами: с правом tasks.read_all
-- (координатор, руководитель, администратор) видно всех инженеров, инженеру — только
-- он сам, остальным отказ по-русски. Политика users разрешает сотруднику читать
-- карточки коллег, поэтому без этой проверки инженер увидел бы в сетке всех.
--
-- Миграцию можно применить повторно и целиком одной транзакцией (BEGIN … COMMIT).

-- Задачи календаря ищутся по инженеру и дням, которые задача занимает. Условие функции
-- написано теми же выражениями, что и индекс, иначе планировщик его не возьмёт.
CREATE INDEX IF NOT EXISTS tasks_calendar_days_idx
  ON public.tasks (
    engineer_id,
    (coalesce(deadline_from, deadline_to, visit_date)),
    (coalesce(deadline_to, deadline_from, visit_date))
  )
  WHERE status_code <> 'cancelled';

-- Открытые задачи без срока и без выезда: их мало, но искать их перебором всех задач не нужно.
CREATE INDEX IF NOT EXISTS tasks_calendar_undated_idx
  ON public.tasks (engineer_id)
  WHERE deadline_from IS NULL
    AND deadline_to IS NULL
    AND visit_date IS NULL
    AND status_code NOT IN ('closed', 'cancelled');

-- Период календаря: не пустой, по возрастанию и не длиннее 62 дней (два самых длинных
-- месяца). Тот же предел в src/engineer-calendar.ts: интерфейс повторяет правило базы.
CREATE OR REPLACE FUNCTION public.assert_engineer_calendar_period(p_from date, p_to date)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'Укажите начало и конец периода календаря' USING ERRCODE = '22023';
  END IF;
  IF p_to < p_from THEN
    RAISE EXCEPTION 'Конец периода не может быть раньше начала' USING ERRCODE = '22023';
  END IF;
  IF (p_to - p_from) + 1 > 62 THEN
    RAISE EXCEPTION 'Период календаря не длиннее 62 дней: выберите период короче' USING ERRCODE = '22023';
  END IF;
END
$$;

COMMENT ON FUNCTION public.assert_engineer_calendar_period(date, date) IS
  'Проверка периода календаря загрузки: не пустой, по возрастанию, не длиннее 62 дней (0051).';

REVOKE ALL ON FUNCTION public.assert_engineer_calendar_period(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assert_engineer_calendar_period(date, date) TO authenticated;

-- Кого показывает календарь вызывающему: всех инженеров (tasks.read_all) или только себя
-- (инженер). Остальным — отказ: календарь загрузки им не положен.
CREATE OR REPLACE FUNCTION public.engineer_calendar_scope()
RETURNS TABLE (engineer_id uuid, engineer_name text, engineer_is_active boolean)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_all boolean := public.app_has_permission('tasks.read_all');
  v_self uuid := auth.uid();
BEGIN
  IF NOT v_all AND NOT EXISTS (
    SELECT 1 FROM public.users AS u WHERE u.id = v_self AND u.role = 'engineer'
  ) THEN
    RAISE EXCEPTION 'Нет прав на календарь загрузки инженеров' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT u.id, u.full_name, u.is_active
      FROM public.users AS u
     WHERE u.role = 'engineer'
       AND (v_all OR u.id = v_self);
END
$$;

COMMENT ON FUNCTION public.engineer_calendar_scope() IS
  'Инженеры календаря загрузки: все при tasks.read_all, иначе только сам инженер (0051).';

REVOKE ALL ON FUNCTION public.engineer_calendar_scope() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engineer_calendar_scope() TO authenticated;

-- Строки календаря загрузки за период: инженер и его задачи, которые занимают хотя бы
-- один день периода, плюс его открытые задачи без срока. У инженера без задач приходит
-- одна строка с пустым task_id.
--
-- Неактивный инженер попадает в календарь только с задачами: пустые строки уволившихся
-- сетку не занимают.
CREATE OR REPLACE FUNCTION public.engineer_calendar(p_from date, p_to date)
RETURNS TABLE (
  engineer_id uuid,
  engineer_name text,
  engineer_is_active boolean,
  task_id uuid,
  task_number text,
  task_title text,
  task_status text,
  priority_code text,
  period_from date,
  period_to date,
  visit_date date,
  site_name text,
  equipment_label text,
  is_overdue boolean,
  has_no_dates boolean
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.assert_engineer_calendar_period(p_from, p_to);
  RETURN QUERY
  WITH scope AS (
    SELECT s.engineer_id AS id, s.engineer_name AS full_name, s.engineer_is_active AS is_active
      FROM public.engineer_calendar_scope() AS s
  ), picked AS (
    SELECT
      t.id,
      t.engineer_id AS owner_id,
      t.number,
      t.title,
      t.status_code,
      t.priority::text AS priority_text,
      t.deadline_from,
      t.deadline_to,
      t.visit_date,
      t.site_id,
      t.equipment_id,
      public.service_task_is_overdue(t.deadline_to, t.status_code, public.company_today()) AS overdue,
      (t.deadline_from IS NULL AND t.deadline_to IS NULL AND t.visit_date IS NULL) AS no_dates
    FROM public.tasks AS t
    WHERE t.engineer_id IN (SELECT s.id FROM scope AS s)
      AND (
        -- Задача занимает хотя бы один день периода: пересечение по дням задачи.
        (t.status_code <> 'cancelled'
          AND coalesce(t.deadline_from, t.deadline_to, t.visit_date) <= p_to
          AND coalesce(t.deadline_to, t.deadline_from, t.visit_date) >= p_from)
        -- Открытая задача без срока: дня у неё нет, но инженеру её уже отдали.
        OR (t.deadline_from IS NULL AND t.deadline_to IS NULL AND t.visit_date IS NULL
          AND t.status_code NOT IN ('closed', 'cancelled'))
      )
  )
  SELECT
    s.id,
    s.full_name,
    s.is_active,
    p.id,
    p.number,
    p.title,
    p.status_code,
    p.priority_text,
    p.deadline_from,
    p.deadline_to,
    p.visit_date,
    site.name,
    nullif(concat_ws(' · ', nullif(btrim(concat_ws(' ', manufacturer.name, model.name)), ''), equipment.serial_number), ''),
    coalesce(p.overdue, false),
    coalesce(p.no_dates, false)
  FROM scope AS s
  LEFT JOIN picked AS p ON p.owner_id = s.id
  LEFT JOIN public.sites AS site ON site.id = p.site_id
  LEFT JOIN public.equipment AS equipment ON equipment.id = p.equipment_id
  LEFT JOIN public.manufacturers AS manufacturer ON manufacturer.id = equipment.manufacturer_id
  LEFT JOIN public.equipment_models AS model ON model.id = equipment.model_id
  WHERE s.is_active OR p.id IS NOT NULL
  ORDER BY s.full_name, p.deadline_from NULLS LAST, p.number;
END
$$;

COMMENT ON FUNCTION public.engineer_calendar(date, date) IS
  'Строки календаря загрузки за период: инженер и занимающие его дни задачи; у инженера без задач одна пустая строка. С правами вызывающего (0051).';

REVOKE ALL ON FUNCTION public.engineer_calendar(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engineer_calendar(date, date) TO authenticated;

-- Занятость инженеров за период одной строкой на человека: для подсказки при назначении.
-- Ответ не зависит от числа задач в периоде, поэтому подсказка не тяжелеет на стенде
-- с тысячами задач.
--
-- Рабочие дни — с понедельника по пятницу: графика работ и отпусков в системе нет,
-- другого источника «не работает» взять негде. Порог перегруза здесь не зашит: база
-- отдаёт самый занятый день числом, а «перегружен» решает интерфейс
-- (OVERLOADED_TASKS_PER_DAY в src/engineer-calendar.ts).
CREATE OR REPLACE FUNCTION public.engineer_period_load(
  p_from date,
  p_to date,
  p_ignore_task_id uuid DEFAULT NULL
)
RETURNS TABLE (
  engineer_id uuid,
  engineer_name text,
  engineer_is_active boolean,
  task_count bigint,
  busiest_day_count bigint,
  busiest_day date,
  busy_day_count bigint,
  free_workday_count bigint,
  workday_count bigint,
  overdue_task_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.assert_engineer_calendar_period(p_from, p_to);
  RETURN QUERY
  WITH scope AS (
    SELECT s.engineer_id AS id, s.engineer_name AS full_name, s.engineer_is_active AS is_active
      FROM public.engineer_calendar_scope() AS s
  ), period_days AS (
    SELECT gs.moment::date AS day
      FROM generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') AS gs(moment)
  ), picked AS (
    SELECT
      t.id,
      t.engineer_id AS owner_id,
      coalesce(t.deadline_from, t.deadline_to, t.visit_date) AS day_from,
      coalesce(t.deadline_to, t.deadline_from, t.visit_date) AS day_to,
      public.service_task_is_overdue(t.deadline_to, t.status_code, public.company_today()) AS overdue
    FROM public.tasks AS t
    WHERE t.engineer_id IN (SELECT s.id FROM scope AS s)
      AND t.status_code <> 'cancelled'
      AND (p_ignore_task_id IS NULL OR t.id <> p_ignore_task_id)
      AND coalesce(t.deadline_from, t.deadline_to, t.visit_date) <= p_to
      AND coalesce(t.deadline_to, t.deadline_from, t.visit_date) >= p_from
  ), per_day AS (
    SELECT s.id AS owner_id, d.day AS day, count(p.id) AS tasks
      FROM scope AS s
      CROSS JOIN period_days AS d
      LEFT JOIN picked AS p
        ON p.owner_id = s.id
       AND d.day BETWEEN p.day_from AND p.day_to
     GROUP BY s.id, d.day
  )
  SELECT
    s.id,
    s.full_name,
    s.is_active,
    (SELECT count(*) FROM picked AS p WHERE p.owner_id = s.id),
    coalesce(peak.tasks, 0),
    peak.day,
    (SELECT count(*) FROM per_day AS d WHERE d.owner_id = s.id AND d.tasks > 0),
    (SELECT count(*) FROM per_day AS d
      WHERE d.owner_id = s.id AND d.tasks = 0 AND extract(isodow FROM d.day) < 6),
    (SELECT count(*) FROM period_days AS d WHERE extract(isodow FROM d.day) < 6),
    (SELECT count(*) FROM picked AS p WHERE p.owner_id = s.id AND p.overdue)
  FROM scope AS s
  LEFT JOIN LATERAL (
    SELECT d.day, d.tasks
      FROM per_day AS d
     WHERE d.owner_id = s.id AND d.tasks > 0
     ORDER BY d.tasks DESC, d.day
     LIMIT 1
  ) AS peak ON true
  ORDER BY s.full_name;
END
$$;

COMMENT ON FUNCTION public.engineer_period_load(date, date, uuid) IS
  'Занятость инженеров за период для подсказки при назначении: задачи, самый занятый день, свободные рабочие дни. С правами вызывающего (0051).';

REVOKE ALL ON FUNCTION public.engineer_period_load(date, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engineer_period_load(date, date, uuid) TO authenticated;
