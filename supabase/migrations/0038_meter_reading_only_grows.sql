-- Показание счётчика прибора только растёт.
--
-- Зачем. В результате работ инженер вписывал в «Показание счётчика» что угодно:
-- у прибора с последним показанием 152 300 принималась единица. Отрицательные числа
-- поле не брало, а любое меньшее предыдущего — пожалуйста. После закрытия задачи это
-- значение уходит в паспорт прибора и в историю счётчика, где появляется отрицательный
-- прирост, и наработка прибора перестаёт что-либо значить: по ней считают ресурс узлов
-- и планируют ТО.
--
-- Что решили: уменьшение не разрешаем вовсе, подтверждения нет.
-- Счётчик наработки физически только растёт, а кнопка «всё равно сохранить» в форме
-- инженера нажималась бы не глядя — именно так проходят мимо предупреждений. Если счётчик
-- прибора заменили или обнулили (событие редкое и это изменение паспорта, а не строка
-- в отчёте инженера), запись правит владелец схемы вручную, и это видно в журнале аудита.
--
-- Проверок две, и обе нужны.
-- 1. При вводе: инженер сразу узнаёт, что ошибся, а не через день от координатора.
-- 2. При приёмке: по одному прибору бывает несколько открытых нарядов (ремонт и ТО),
--    и в момент ввода второго показания первое ещё нигде не записано — обе проверки
--    на вводе проходят, а в журнал ложится убывающий ряд. Поэтому в журнал показаний
--    значение меньше уже записанного не попадает ни при каком порядке закрытия.
--
-- Функция, как все служебные триггеры (0009), работает от владельца схемы.
-- Миграцию можно применить повторно.

CREATE OR REPLACE FUNCTION public.guard_task_meter_reading_growth()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous numeric;
BEGIN
  IF NEW.meter_reading IS NULL OR NEW.equipment_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Последнее известное показание прибора: наибольшее из журнала показаний (кроме
  -- показания этой же задачи) и производного значения в паспорте.
  SELECT greatest(
           (SELECT max(reading) FROM public.equipment_meter_readings
             WHERE equipment_id = NEW.equipment_id
               AND (task_id IS NULL OR task_id <> NEW.id)),
           (SELECT last_meter_reading FROM public.equipment WHERE id = NEW.equipment_id))
    INTO previous;

  IF previous IS NOT NULL AND NEW.meter_reading < previous THEN
    RAISE EXCEPTION 'Показание счётчика % меньше предыдущего (%): счётчик прибора только растёт. Проверьте значение на приборе',
      trim_scale(NEW.meter_reading)::text, trim_scale(previous)::text
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_meter_reading_only_grows';
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.guard_task_meter_reading_growth() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.guard_task_meter_reading_growth() IS
  'Показание счётчика в результате работ не меньше предыдущего показания прибора (0038).';

DROP TRIGGER IF EXISTS tasks_meter_reading_only_grows ON tasks;
CREATE TRIGGER tasks_meter_reading_only_grows
  BEFORE INSERT OR UPDATE OF meter_reading, equipment_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION public.guard_task_meter_reading_growth();

-- ---------------------------------------------------------------------------
-- Вторая проверка: при приёмке, на самом журнале показаний
-- ---------------------------------------------------------------------------

-- Сюда приходит всё, что становится историей счётчика: записывает её служебная функция
-- record_accepted_task_meter_reading при закрытии задачи (0001). Проверка на вводе
-- к этому моменту устарела, если по прибору закрыли другой наряд.
CREATE OR REPLACE FUNCTION public.guard_meter_reading_history_growth()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous numeric;
  task_number text;
BEGIN
  SELECT max(reading) INTO previous
    FROM public.equipment_meter_readings
   WHERE equipment_id = NEW.equipment_id
     AND id <> NEW.id;

  IF previous IS NOT NULL AND NEW.reading < previous THEN
    SELECT number INTO task_number FROM public.tasks WHERE id = NEW.task_id;
    RAISE EXCEPTION 'Показание счётчика % меньше ранее записанного (%): счётчик прибора только растёт.%',
      trim_scale(NEW.reading)::text, trim_scale(previous)::text,
      CASE WHEN task_number IS NULL THEN ' Проверьте значение на приборе'
           ELSE ' Поправьте показание в задаче ' || task_number || ', тогда её можно будет принять' END
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_meter_readings_only_grow';
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.guard_meter_reading_history_growth() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.guard_meter_reading_history_growth() IS
  'В историю счётчика не попадает показание меньше уже записанного (0038): ловит случай нескольких открытых нарядов по одному прибору.';

DROP TRIGGER IF EXISTS equipment_meter_readings_only_grow ON equipment_meter_readings;
CREATE TRIGGER equipment_meter_readings_only_grow
  BEFORE INSERT OR UPDATE OF reading, equipment_id ON equipment_meter_readings
  FOR EACH ROW EXECUTE FUNCTION public.guard_meter_reading_history_growth();
