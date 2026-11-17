-- Календарь инженеров: незакрытая просрочка занимает инженера и сегодня (аудит 17.11.2026, № 81).
--
-- Что было не так. Календарь (0051) клал задачу только в дни её срока. Просроченная, но
-- не сданная работа оставалась в прошлых неделях, а на текущей инженер с двумя хвостами
-- выглядел «Свободен». Срочные неназначенные задачи с прошедшим сроком не попадали
-- в «Ещё не назначены». По тому же расчёту окно выбора инженера подсказывало
-- «свободного» человека.
--
-- Что делаем. Конец занятости задачи считает одна функция task_calendar_day_to: пока задача
-- на инженере (запланирована, новая, назначена, в работе), а срок прошёл, она тянется
-- до сегодняшнего дня по Москве. Сданная на проверку, закрытая и отменённая — по сроку,
-- как раньше. engineer_calendar и engineer_period_load отбирают задачи по этому концу;
-- раскладку по дням делает интерфейс тем же правилом (taskCalendarSpan).
-- Миграцию можно применить повторно.

CREATE OR REPLACE FUNCTION public.task_calendar_day_to(
  p_deadline_to date,
  p_deadline_from date,
  p_visit_date date,
  p_status_code text
)
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_status_code IN ('planned', 'new', 'assigned', 'in_progress')
     AND coalesce(p_deadline_to, p_deadline_from, p_visit_date) < public.company_today()
    THEN public.company_today()
    ELSE coalesce(p_deadline_to, p_deadline_from, p_visit_date)
  END
$$;

REVOKE ALL ON FUNCTION public.task_calendar_day_to(date, date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.task_calendar_day_to(date, date, date, text) TO authenticated;
COMMENT ON FUNCTION public.task_calendar_day_to(date, date, date, text) IS
  'Последний день, который задача занимает инженера (0064): срок, а для незакрытой просрочки на инженере — сегодня по Москве.';

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
  is_overdue boolean
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_all boolean := public.app_has_permission('tasks.read_all');
BEGIN
  PERFORM public.assert_engineer_calendar_access();
  PERFORM public.assert_engineer_calendar_period(p_from, p_to);
  RETURN QUERY
  WITH scope AS (
    SELECT s.engineer_id AS id, s.engineer_name AS full_name, s.engineer_is_active AS is_active
      FROM public.engineer_calendar_scope() AS s
  ), candidates AS (
    -- Отбор идёт четырьмя ветвями, а не одним условием с OR: так у каждой ветви свой
    -- индекс (по инженеру и дням задачи, по инженеру и этапу), и на стенде с тысячами
    -- задач календарь не перебирает весь реестр. Сами строки задач берутся потом,
    -- по первичному ключу, чтобы длинный список колонок не повторялся четыре раза.
    --
    -- Задачи инженеров сетки, занимающие хотя бы один день периода.
    SELECT t.id
      FROM public.tasks AS t
      JOIN scope AS s ON s.id = t.engineer_id
     WHERE t.status_code <> 'cancelled'
       AND coalesce(t.deadline_from, t.deadline_to, t.visit_date) <= p_to
       AND public.task_calendar_day_to(t.deadline_to, t.deadline_from, t.visit_date, t.status_code) >= p_from
    UNION
    -- Их же открытые задачи без срока: дня у них нет, но они уже ждут выезда.
    SELECT t.id
      FROM public.tasks AS t
      JOIN scope AS s ON s.id = t.engineer_id
     WHERE t.deadline_from IS NULL AND t.deadline_to IS NULL AND t.visit_date IS NULL
       AND t.status_code NOT IN ('closed', 'cancelled')
    UNION
    -- Нераспределённые задачи периода — только тому, кто видит всех инженеров.
    SELECT t.id
      FROM public.tasks AS t
     WHERE v_all AND t.engineer_id IS NULL
       AND t.status_code <> 'cancelled'
       AND coalesce(t.deadline_from, t.deadline_to, t.visit_date) <= p_to
       AND public.task_calendar_day_to(t.deadline_to, t.deadline_from, t.visit_date, t.status_code) >= p_from
    UNION
    SELECT t.id
      FROM public.tasks AS t
     WHERE v_all AND t.engineer_id IS NULL
       AND t.deadline_from IS NULL AND t.deadline_to IS NULL AND t.visit_date IS NULL
       AND t.status_code NOT IN ('closed', 'cancelled')
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
      public.service_task_is_overdue(t.deadline_to, t.status_code, public.company_today()) AS overdue
    FROM public.tasks AS t
    JOIN candidates AS c ON c.id = t.id
  ), decorated AS (
    SELECT
      p.id,
      p.owner_id,
      p.number,
      p.title,
      p.status_code,
      p.priority_text,
      p.deadline_from,
      p.deadline_to,
      p.visit_date,
      site.name AS site_name,
      nullif(concat_ws(' · ', nullif(btrim(concat_ws(' ', manufacturer.name, model.name)), ''), equipment.serial_number), '') AS equipment_label,
      p.overdue
    FROM picked AS p
    LEFT JOIN public.sites AS site ON site.id = p.site_id
    LEFT JOIN public.equipment AS equipment ON equipment.id = p.equipment_id
    LEFT JOIN public.manufacturers AS manufacturer ON manufacturer.id = equipment.manufacturer_id
    LEFT JOIN public.equipment_models AS model ON model.id = equipment.model_id
  ), calendar_rows AS (
    SELECT
      s.id AS engineer_id,
      s.full_name AS engineer_name,
      s.is_active AS engineer_is_active,
      d.id AS task_id,
      d.number AS task_number,
      d.title AS task_title,
      d.status_code AS task_status,
      d.priority_text AS priority_code,
      d.deadline_from AS period_from,
      d.deadline_to AS period_to,
      d.visit_date AS visit_date,
      d.site_name AS site_name,
      d.equipment_label AS equipment_label,
      coalesce(d.overdue, false) AS is_overdue
    FROM scope AS s
    LEFT JOIN decorated AS d ON d.owner_id = s.id
    WHERE s.is_active OR d.id IS NOT NULL
    UNION ALL
    SELECT
      NULL::uuid, NULL::text, NULL::boolean,
      d.id, d.number, d.title, d.status_code, d.priority_text,
      d.deadline_from, d.deadline_to, d.visit_date, d.site_name, d.equipment_label,
      coalesce(d.overdue, false)
    FROM decorated AS d
    WHERE d.owner_id IS NULL
  )
  -- Нераспределённые задачи (без имени инженера) идут последними.
  SELECT
    r.engineer_id, r.engineer_name, r.engineer_is_active,
    r.task_id, r.task_number, r.task_title, r.task_status, r.priority_code,
    r.period_from, r.period_to, r.visit_date, r.site_name, r.equipment_label,
    r.is_overdue
  FROM calendar_rows AS r
  -- Однофамильцы не должны меняться местами между запросами, поэтому в порядке есть id.
  ORDER BY r.engineer_name NULLS LAST, r.engineer_id, r.period_from NULLS LAST, r.task_number;
END
$$;
COMMENT ON FUNCTION public.engineer_calendar(date, date) IS
  'Строки календаря загрузки за период: инженер и занимающие его дни задачи; у инженера без задач одна пустая строка. С правами вызывающего (0051).';
REVOKE ALL ON FUNCTION public.engineer_calendar(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engineer_calendar(date, date) TO authenticated;

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
  PERFORM public.assert_engineer_calendar_access();
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
      public.task_calendar_day_to(t.deadline_to, t.deadline_from, t.visit_date, t.status_code) AS day_to,
      public.service_task_is_overdue(t.deadline_to, t.status_code, public.company_today()) AS overdue
    FROM public.tasks AS t
    WHERE t.engineer_id IN (SELECT s.id FROM scope AS s)
      AND t.status_code <> 'cancelled'
      AND (p_ignore_task_id IS NULL OR t.id <> p_ignore_task_id)
      AND coalesce(t.deadline_from, t.deadline_to, t.visit_date) <= p_to
      AND public.task_calendar_day_to(t.deadline_to, t.deadline_from, t.visit_date, t.status_code) >= p_from
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
  -- Однофамильцы не должны меняться местами между запросами, поэтому в порядке есть id.
  ORDER BY s.full_name, s.id;
END
$$;
COMMENT ON FUNCTION public.engineer_period_load(date, date, uuid) IS
  'Занятость инженеров за период для подсказки при назначении: задачи, самый занятый день, свободные рабочие дни. С правами вызывающего (0051).';
REVOKE ALL ON FUNCTION public.engineer_period_load(date, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.engineer_period_load(date, date, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
