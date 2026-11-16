-- Дата вызова и дата события прибора не бывают из будущего.
--
-- Зачем. Верхней границы у этих дат не было нигде. В карточке прибора можно было
-- написать «Когда произошло: 01.01.2030», и запись вставала первой в истории прибора:
-- самое новое событие — из 2030 года, а история читается неправильно. В задаче так же
-- принималась «Дата вызова 01.01.2035» при сроке работ на эту неделю. Единственная
-- проверка, что была, работает в обратную сторону: она запрещает слишком раннюю дату,
-- а любую будущую пропускает.
--
-- Что теперь. Дата вызова заявки и дата события прибора (прошлое событие, смена места
-- установки, смена плательщика) не могут быть позже сегодняшнего дня по часам компании
-- (Москва, как и остальные расчёты дней в 0023 и 0027). Сегодняшний день целиком
-- разрешён: человек в другом поясе и часы на его устройстве не должны мешать работе.
--
-- Чего проверка не касается: срок работ и дата выезда — это планы, они и должны быть
-- в будущем, их сходимость сторожат прежние ограничения (выезд не раньше вызова,
-- конец периода не раньше начала).
--
-- Функции, как все служебные триггеры (0009), работают от владельца схемы.
-- Миграцию можно применить повторно.

-- Сегодня по часам компании: общая опора для проверок этой миграции. Прежние расчёты
-- (0027, 0031) остались со своими вставками `(now() AT TIME ZONE 'Europe/Moscow')::date`
-- и считают то же самое; переписывать их на эту функцию — отдельная уборка, не эта задача.
CREATE OR REPLACE FUNCTION public.company_today()
RETURNS date
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT (now() AT TIME ZONE 'Europe/Moscow')::date
$$;

COMMENT ON FUNCTION public.company_today() IS
  'Сегодняшний день по часам компании (Москва). По нему проверяются даты, которые не бывают из будущего (0037).';

REVOKE EXECUTE ON FUNCTION public.company_today() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.company_today() TO authenticated, medtech_api;

-- ---------------------------------------------------------------------------
-- 1. Дата вызова заявки (находка 34)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_task_call_date()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  today constant date := public.company_today();
BEGIN
  IF NEW.call_date IS NOT NULL AND NEW.call_date > today THEN
    RAISE EXCEPTION 'Дата вызова % из будущего: заявка не могла поступить позже сегодняшнего дня (%). Для планов есть срок работ',
      to_char(NEW.call_date, 'DD.MM.YYYY'), to_char(today, 'DD.MM.YYYY')
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_call_date_not_in_future';
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.guard_task_call_date() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.guard_task_call_date() IS
  'Дата вызова заявки не из будущего по часам компании (0037).';

DROP TRIGGER IF EXISTS tasks_call_date_not_in_future ON tasks;
CREATE TRIGGER tasks_call_date_not_in_future
  BEFORE INSERT OR UPDATE OF call_date ON tasks
  FOR EACH ROW EXECUTE FUNCTION public.guard_task_call_date();

-- ---------------------------------------------------------------------------
-- 2. Даты событий прибора (находка 2)
-- ---------------------------------------------------------------------------

-- Первый аргумент триггера — поле с моментом, второй — как событие называется на экране.
CREATE OR REPLACE FUNCTION public.guard_event_moment_not_in_future()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  field constant text := TG_ARGV[0];
  label constant text := TG_ARGV[1];
  moment constant timestamptz := (to_jsonb(NEW) ->> field)::timestamptz;
  today constant date := public.company_today();
BEGIN
  IF moment IS NOT NULL AND (moment AT TIME ZONE 'Europe/Moscow')::date > today THEN
    RAISE EXCEPTION '% % из будущего: событие не могло произойти позже сегодняшнего дня (%)',
      label, to_char(moment AT TIME ZONE 'Europe/Moscow', 'DD.MM.YYYY'), to_char(today, 'DD.MM.YYYY')
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_event_not_in_future';
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.guard_event_moment_not_in_future() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.guard_event_moment_not_in_future() IS
  'Дата события прибора не из будущего по часам компании (0037). Название события передаётся аргументом триггера.';

DROP TRIGGER IF EXISTS equipment_history_not_in_future ON equipment_history;
CREATE TRIGGER equipment_history_not_in_future
  BEFORE INSERT OR UPDATE OF happened_at ON equipment_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_event_moment_not_in_future('happened_at', 'Дата события');

DROP TRIGGER IF EXISTS equipment_site_history_not_in_future ON equipment_site_history;
CREATE TRIGGER equipment_site_history_not_in_future
  BEFORE INSERT OR UPDATE OF valid_from ON equipment_site_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_event_moment_not_in_future('valid_from', 'Дата смены места установки');

DROP TRIGGER IF EXISTS equipment_payer_history_not_in_future ON equipment_payer_history;
CREATE TRIGGER equipment_payer_history_not_in_future
  BEFORE INSERT OR UPDATE OF valid_from ON equipment_payer_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_event_moment_not_in_future('valid_from', 'Дата смены плательщика');

DROP TRIGGER IF EXISTS equipment_meter_readings_not_in_future ON equipment_meter_readings;
CREATE TRIGGER equipment_meter_readings_not_in_future
  BEFORE INSERT OR UPDATE OF measured_at ON equipment_meter_readings
  FOR EACH ROW EXECUTE FUNCTION public.guard_event_moment_not_in_future('measured_at', 'Дата показания счётчика');
