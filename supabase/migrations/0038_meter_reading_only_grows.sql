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
-- прибора заменили или обнулили, историю правит владелец схемы: она закрыта от правки
-- и удаления ещё с 0001, поэтому там и так приходится снимать запрет руками. Вставку
-- без входа в CRM (обновление базы, импорт, перенос из 1С) проверка не трогает.
--
-- Сравниваем по времени измерения, а не с самым большим числом в журнале.
-- Журнал показаний — это шкала времени: `measured_at` у показания задачи равен моменту
-- сдачи работ, и паспорт прибора берёт из журнала последнее по этому времени. Сравнение
-- с максимумом сторожило бы порядок вставки, а он от порядка измерения не зависит:
-- ранний наряд мог ждать доснятых фото и быть принят после позднего. Такое сравнение
-- и дыру оставляет (принять наряды в обратном порядке — и в журнале снова убывающий ряд),
-- и отказывает на верных данных, предлагая человеку «поправить» правильное показание.
-- Поэтому у каждого показания два соседа по времени: оно не меньше любого снятого раньше
-- и не больше любого снятого позже.
--
-- Проверок две, и обе нужны.
-- 1. При вводе: инженер сразу узнаёт, что ошибся, а не через день от координатора.
-- 2. При приёмке, на самом журнале: по одному прибору бывает несколько открытых нарядов
--    (ремонт и ТО), и в момент ввода второго показания первое ещё нигде не записано —
--    обе проверки на вводе проходят. Запрет на журнале держит ряд при любом порядке
--    приёмки, потому что смотрит на время измерения.
--
-- Функции, как все служебные триггеры (0009), работают от владельца схемы.
-- Миграцию можно применить повторно.

-- ---------------------------------------------------------------------------
-- 1. Общее правило: одно место, где решается, годится ли показание
-- ---------------------------------------------------------------------------

-- Возвращает готовый отказ по-русски или пусто, если показание годится. Обе проверки
-- зовут её, поэтому формулировки у них совпадают слово в слово.
-- p_moment — время измерения: у записи журнала это её measured_at, у задачи — момент
-- сдачи работ, а пока работа не сдана — сейчас.
CREATE OR REPLACE FUNCTION public.meter_reading_conflict(
  p_equipment_id uuid,
  p_reading numeric,
  p_moment timestamptz,
  p_exclude_reading uuid,
  p_exclude_task uuid
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  earlier numeric;
  earlier_at timestamptz;
  earlier_task text;
  later numeric;
  later_at timestamptz;
  later_task text;
  legacy numeric;
BEGIN
  IF p_equipment_id IS NULL OR p_reading IS NULL OR p_moment IS NULL THEN
    RETURN NULL;
  END IF;

  -- Наибольшее из снятых раньше и наименьшее из снятых позже: показание должно встать
  -- между ними. Берём наибольшее и наименьшее, а не ближайших соседей, чтобы запрет
  -- держался и на журнале, где убывание уже успело накопиться.
  -- Снятое в тот же момент считается ранним: два показания одного мгновения спорить
  -- о порядке не могут, и равное или большее значение рядом с ними допустимо.
  SELECT record.reading, record.measured_at, task.number
    INTO earlier, earlier_at, earlier_task
    FROM public.equipment_meter_readings AS record
    LEFT JOIN public.tasks AS task ON task.id = record.task_id
   WHERE record.equipment_id = p_equipment_id
     AND record.measured_at <= p_moment
     AND (p_exclude_reading IS NULL OR record.id <> p_exclude_reading)
     AND (p_exclude_task IS NULL OR record.task_id IS NULL OR record.task_id <> p_exclude_task)
   ORDER BY record.reading DESC, record.measured_at DESC
   LIMIT 1;

  SELECT record.reading, record.measured_at, task.number
    INTO later, later_at, later_task
    FROM public.equipment_meter_readings AS record
    LEFT JOIN public.tasks AS task ON task.id = record.task_id
   WHERE record.equipment_id = p_equipment_id
     AND record.measured_at > p_moment
     AND (p_exclude_reading IS NULL OR record.id <> p_exclude_reading)
     AND (p_exclude_task IS NULL OR record.task_id IS NULL OR record.task_id <> p_exclude_task)
   ORDER BY record.reading ASC, record.measured_at ASC
   LIMIT 1;

  -- У прибора, заведённого до журнала (перенос из 1С), показание лежит только в паспорте.
  IF earlier IS NULL AND NOT EXISTS (
       SELECT 1 FROM public.equipment_meter_readings WHERE equipment_id = p_equipment_id) THEN
    SELECT last_meter_reading INTO legacy FROM public.equipment WHERE id = p_equipment_id;
    IF legacy IS NOT NULL AND p_reading < legacy THEN
      RETURN format('Показание счётчика %s меньше предыдущего (%s): счётчик прибора только растёт',
                    trim_scale(p_reading)::text, trim_scale(legacy)::text);
    END IF;
  END IF;

  -- Задачу-соседа называем, если она известна: иначе отказ звучит как «поправьте вот это»,
  -- а неверным может быть как раз соседнее показание, и человек исправит правильное.
  IF earlier IS NOT NULL AND p_reading < earlier THEN
    RETURN format('Показание счётчика %s меньше показания %s от %s%s: счётчик прибора только растёт',
                  trim_scale(p_reading)::text, trim_scale(earlier)::text,
                  to_char(earlier_at AT TIME ZONE 'Europe/Moscow', 'DD.MM.YYYY'),
                  coalesce(' (задача ' || earlier_task || ')', ''));
  END IF;

  IF later IS NOT NULL AND p_reading > later THEN
    RETURN format('Показание счётчика %s больше показания %s от %s%s, снятого позже: счётчик прибора только растёт',
                  trim_scale(p_reading)::text, trim_scale(later)::text,
                  to_char(later_at AT TIME ZONE 'Europe/Moscow', 'DD.MM.YYYY'),
                  coalesce(' (задача ' || later_task || ')', ''));
  END IF;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.meter_reading_conflict(uuid, numeric, timestamptz, uuid, uuid) IS
  'Годится ли показание счётчика на этот момент времени: отказ по-русски или пусто (0038). Общая для проверки при вводе и при приёмке.';

REVOKE EXECUTE ON FUNCTION public.meter_reading_conflict(uuid, numeric, timestamptz, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.meter_reading_conflict(uuid, numeric, timestamptz, uuid, uuid) TO authenticated, medtech_api;

-- ---------------------------------------------------------------------------
-- 2. При вводе: инженер узнаёт об ошибке сразу
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_task_meter_reading_growth()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  moment timestamptz;
  refusal text;
BEGIN
  IF NEW.meter_reading IS NULL OR NEW.equipment_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Показание попадёт в журнал с моментом сдачи работ; пока работа не сдана — с текущим.
  SELECT submitted_at INTO moment FROM public.task_closures WHERE task_id = NEW.id;
  refusal := public.meter_reading_conflict(NEW.equipment_id, NEW.meter_reading, coalesce(moment, now()), NULL, NEW.id);

  IF refusal IS NOT NULL THEN
    RAISE EXCEPTION '%. Проверьте значение на приборе', refusal
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_meter_reading_only_grows';
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.guard_task_meter_reading_growth() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.guard_task_meter_reading_growth() IS
  'Показание счётчика в результате работ встаёт по времени между соседними показаниями прибора (0038).';

DROP TRIGGER IF EXISTS tasks_meter_reading_only_grows ON tasks;
CREATE TRIGGER tasks_meter_reading_only_grows
  BEFORE INSERT OR UPDATE OF meter_reading, equipment_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION public.guard_task_meter_reading_growth();

-- ---------------------------------------------------------------------------
-- 3. При приёмке: ряд в журнале держится при любом порядке закрытия задач
-- ---------------------------------------------------------------------------

-- Сюда приходит всё, что становится историей счётчика: записывает её служебная функция
-- record_accepted_task_meter_reading при закрытии задачи (0001). Проверка на вводе
-- к этому моменту устарела, если по прибору закрыли другой наряд.
-- Правка и удаление истории закрыты отдельным запретом из 0001, поэтому триггер только
-- на вставку: на UPDATE первым всё равно отказал бы он.
CREATE OR REPLACE FUNCTION public.guard_meter_reading_history_growth()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  refusal text;
  task_number text;
BEGIN
  -- Поблажки «без входа» здесь нет нарочно: закрытие задачи бывает и служебным,
  -- а убывающий ряд портит наработку одинаково, кто бы его ни записал. Владельцу схемы
  -- этот запрет не помеха: историю всё равно приходится открывать руками, она закрыта
  -- от правки и удаления с 0001.
  refusal := public.meter_reading_conflict(NEW.equipment_id, NEW.reading, NEW.measured_at, NEW.id, NULL);
  IF refusal IS NOT NULL THEN
    SELECT number INTO task_number FROM public.tasks WHERE id = NEW.task_id;
    RAISE EXCEPTION '%.%', refusal,
      CASE WHEN task_number IS NULL THEN ' Проверьте, какое из показаний снято неверно, и поправьте его'
           ELSE ' Проверьте, где показание снято неверно — в задаче ' || task_number
                || ' или в соседней, — и поправьте его там' END
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_meter_readings_only_grow';
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.guard_meter_reading_history_growth() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.guard_meter_reading_history_growth() IS
  'В историю счётчика показание встаёт по времени между соседями (0038): ловит несколько открытых нарядов по одному прибору при любом порядке приёмки.';

DROP TRIGGER IF EXISTS equipment_meter_readings_only_grow ON equipment_meter_readings;
CREATE TRIGGER equipment_meter_readings_only_grow
  BEFORE INSERT ON equipment_meter_readings
  FOR EACH ROW EXECUTE FUNCTION public.guard_meter_reading_history_growth();
