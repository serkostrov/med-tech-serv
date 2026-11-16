-- Перенос данных из 1С и Excel: запись приборов и их истории одной операцией.
--
-- Что было не так. Схема к импорту готова: у приборов уникален серийный номер без
-- пробелов и регистра (equipment.serial_number_normalized, 0001), у истории есть
-- source_key с уникальным индексом по прибору (0001, раздел 0016) и лента показывает
-- такие события как «Импорт» (0026). Но записать выгрузку было нечем: браузер ходит
-- в PostgREST отдельными запросами, а значит половина файла могла лечь в базу, а
-- половина — упасть на правах или на непонятной модели. Для переноса это худший
-- случай: человек не знает, что уже записано, и повторяет загрузку.
--
-- Что делаем. Одна функция, одна транзакция:
--   1. Права проверяем словами: приборы и историю заводит тот, у кого equipment.write;
--      если файл приносит новую модель или производителя — нужно ещё references.write.
--      Сами таблицы защищены правилами строк (0014), функция идёт с правами
--      вызывающего (SECURITY INVOKER) и ничего не обходит.
--   2. Справочник пополняем только тем, чего нет: производитель, затем модель.
--   3. Прибор создаём, если его серийного номера в базе нет. Существующий прибор не
--      переписываем никогда: расхождения с файлом видно в пробном импорте, решение за
--      человеком. Поэтому повторная загрузка того же файла не меняет реестр.
--   4. События пишем с source_key: тот же файл второй раз не добавит ни одной строки
--      (уникальный индекс equipment_history_import_source_uq).
--   5. Возвращаем, что действительно записано: по приборам, моделям и событиям, плюс
--      события, для которых прибора в базе так и не нашлось.
--
-- Боевой импорт запускает человек с экрана «Импорт» после пробного прогона: сначала
-- показываем, что появится, и только потом зовём эту функцию.

CREATE OR REPLACE FUNCTION public.import_equipment_history(
  p_source_name text,
  p_equipment jsonb,
  p_events jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  source_name text := nullif(btrim(coalesce(p_source_name, '')), '');
  needs_catalog boolean;
  manufacturers_created integer := 0;
  models_created integer := 0;
  equipment_created integer := 0;
  events_created integer := 0;
  events_without_equipment integer := 0;
BEGIN
  IF NOT public.app_has_permission('equipment.write') THEN
    RAISE EXCEPTION 'Недостаточно прав: приборы и их историю заводит координатор'
      USING ERRCODE = '42501';
  END IF;
  IF source_name IS NULL OR char_length(source_name) > 200 THEN
    RAISE EXCEPTION 'Укажите имя файла выгрузки (до 200 символов)' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_equipment) IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_events) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Приборы и события передаются списками' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_equipment) > 5000 OR jsonb_array_length(p_events) > 50000 THEN
    RAISE EXCEPTION 'За один раз переносим не больше 5000 приборов и 50000 событий: разделите выгрузку'
      USING ERRCODE = '22023';
  END IF;

  -- Строка выгрузки должна быть полной: без серийного номера, производителя или модели
  -- прибор в реестре не создать, и молча пропускать такую строку нельзя.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_equipment) AS item
     WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
        OR nullif(btrim(coalesce(item ->> 'serialNumber', '')), '') IS NULL
        OR nullif(btrim(coalesce(item ->> 'manufacturer', '')), '') IS NULL
        OR nullif(btrim(coalesce(item ->> 'model', '')), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'У каждого прибора выгрузки нужны серийный номер, производитель и модель'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_events) AS item
     WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
        OR nullif(btrim(coalesce(item ->> 'serialNumber', '')), '') IS NULL
        OR nullif(btrim(coalesce(item ->> 'summary', '')), '') IS NULL
        OR coalesce(item ->> 'sourceKey', '') !~ '^[0-9a-f]{64}$'
        OR coalesce(item ->> 'happenedAt', '') !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}'
  ) THEN
    RAISE EXCEPTION 'У каждого события выгрузки нужны прибор, дата, краткое описание и ключ строки'
      USING ERRCODE = '23514';
  END IF;

  -- Новая модель или производитель — это запись в справочник, а не в реестр приборов.
  SELECT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_equipment) AS item
     WHERE NOT EXISTS (
       SELECT 1
         FROM public.manufacturers AS m
         JOIN public.equipment_models AS em ON em.manufacturer_id = m.id
        WHERE lower(btrim(m.name)) = lower(btrim(item ->> 'manufacturer'))
          AND lower(btrim(em.name)) = lower(btrim(item ->> 'model'))
     )
  ) INTO needs_catalog;
  IF needs_catalog AND NOT public.app_has_permission('references.write') THEN
    RAISE EXCEPTION 'В выгрузке есть модель, которой нет в справочнике: её добавляет тот, кто ведёт справочники'
      USING ERRCODE = '42501';
  END IF;

  -- Два импорта подряд не должны вперегонки заводить одного производителя.
  PERFORM pg_advisory_xact_lock(hashtextextended('import_equipment_history', 0));

  INSERT INTO public.manufacturers (name)
  SELECT DISTINCT ON (lower(btrim(item ->> 'manufacturer'))) btrim(item ->> 'manufacturer')
    FROM jsonb_array_elements(p_equipment) AS item
   WHERE NOT EXISTS (
     SELECT 1 FROM public.manufacturers AS m
      WHERE lower(btrim(m.name)) = lower(btrim(item ->> 'manufacturer'))
   )
   ORDER BY lower(btrim(item ->> 'manufacturer'))
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS manufacturers_created = ROW_COUNT;

  INSERT INTO public.equipment_models (manufacturer_id, name)
  SELECT DISTINCT ON (m.id, lower(btrim(item ->> 'model'))) m.id, btrim(item ->> 'model')
    FROM jsonb_array_elements(p_equipment) AS item
    JOIN public.manufacturers AS m
      ON lower(btrim(m.name)) = lower(btrim(item ->> 'manufacturer'))
   WHERE NOT EXISTS (
     SELECT 1 FROM public.equipment_models AS em
      WHERE em.manufacturer_id = m.id
        AND lower(btrim(em.name)) = lower(btrim(item ->> 'model'))
   )
   ORDER BY m.id, lower(btrim(item ->> 'model'))
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS models_created = ROW_COUNT;

  -- Площадку и плательщика ставим, только если они уже есть в справочниках: импорт
  -- приборов не заводит клиентов. Чего не нашли — прибор создаётся без привязки,
  -- и пробный импорт говорит об этом заранее.
  INSERT INTO public.equipment (
    serial_number, manufacturer_id, model_id, current_site_id, current_payer_id,
    notes, last_meter_reading
  )
  SELECT wanted.serial_number,
         m.id,
         em.id,
         -- Площадку и плательщика ищем подзапросом, а не соединением: имя площадки
         -- уникально внутри организации, и у двух организаций оно может совпасть.
         (SELECT site.id
            FROM public.sites AS site
           WHERE wanted.site IS NOT NULL
             AND site.is_active
             AND lower(btrim(site.name)) = lower(wanted.site)
           ORDER BY site.created_at, site.id
           LIMIT 1),
         (SELECT payer.id
            FROM public.payers AS payer
           WHERE wanted.payer IS NOT NULL
             AND payer.is_active
             AND lower(btrim(payer.name)) = lower(wanted.payer)
           ORDER BY payer.created_at, payer.id
           LIMIT 1),
         wanted.notes,
         wanted.meter_reading
    FROM (
      SELECT DISTINCT ON (upper(regexp_replace(btrim(item ->> 'serialNumber'), '\s+', '', 'g')))
             btrim(item ->> 'serialNumber') AS serial_number,
             upper(regexp_replace(btrim(item ->> 'serialNumber'), '\s+', '', 'g')) AS serial_key,
             btrim(item ->> 'manufacturer') AS manufacturer,
             btrim(item ->> 'model') AS model,
             nullif(btrim(coalesce(item ->> 'site', '')), '') AS site,
             nullif(btrim(coalesce(item ->> 'payer', '')), '') AS payer,
             nullif(btrim(coalesce(item ->> 'notes', '')), '') AS notes,
             CASE WHEN jsonb_typeof(item -> 'meterReading') = 'number'
                    AND (item ->> 'meterReading')::numeric >= 0
                  THEN round((item ->> 'meterReading')::numeric, 2)
             END AS meter_reading
        FROM jsonb_array_elements(p_equipment) AS item
       ORDER BY upper(regexp_replace(btrim(item ->> 'serialNumber'), '\s+', '', 'g'))
    ) AS wanted
    JOIN public.manufacturers AS m ON lower(btrim(m.name)) = lower(wanted.manufacturer)
    JOIN public.equipment_models AS em
      ON em.manufacturer_id = m.id AND lower(btrim(em.name)) = lower(wanted.model)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.equipment AS existing
      WHERE existing.serial_number_normalized = wanted.serial_key
   )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS equipment_created = ROW_COUNT;

  SELECT count(*)
    INTO events_without_equipment
    FROM jsonb_array_elements(p_events) AS item
   WHERE NOT EXISTS (
     SELECT 1 FROM public.equipment AS e
      WHERE e.serial_number_normalized
            = upper(regexp_replace(btrim(item ->> 'serialNumber'), '\s+', '', 'g'))
   );

  -- Событие узнаётся по source_key: он посчитан по содержанию строки файла, поэтому
  -- повторная загрузка того же файла не добавляет истории.
  INSERT INTO public.equipment_history (
    equipment_id, event_type, happened_at, summary, details, source_key, created_by
  )
  SELECT e.id,
         'manual',
         (item ->> 'happenedAt')::timestamptz,
         btrim(item ->> 'summary'),
         jsonb_build_object(
           'import_source', source_name,
           'client', btrim(coalesce(item ->> 'client', '')),
           'description', coalesce(item ->> 'description', ''),
           'workType', btrim(coalesce(item ->> 'workType', ''))
         ),
         item ->> 'sourceKey',
         auth.uid()
    FROM jsonb_array_elements(p_events) WITH ORDINALITY AS list(item, position)
    JOIN public.equipment AS e
      ON e.serial_number_normalized
         = upper(regexp_replace(btrim(item ->> 'serialNumber'), '\s+', '', 'g'))
   ORDER BY position
  ON CONFLICT (equipment_id, source_key) WHERE source_key IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS events_created = ROW_COUNT;

  RETURN jsonb_build_object(
    'sourceName', source_name,
    'manufacturersCreated', manufacturers_created,
    'modelsCreated', models_created,
    'equipmentCreated', equipment_created,
    'equipmentAlready', jsonb_array_length(p_equipment) - equipment_created,
    'eventsCreated', events_created,
    'eventsAlready', jsonb_array_length(p_events) - events_created - events_without_equipment,
    'eventsWithoutEquipment', events_without_equipment
  );
END
$$;

COMMENT ON FUNCTION public.import_equipment_history(text, jsonb, jsonb) IS
  'Импорт выгрузки 1С (0054): заводит недостающих производителей, модели, приборы и события истории одной транзакцией. Существующие приборы не переписывает, повторная загрузка того же файла ничего не добавляет (equipment.serial_number_normalized и equipment_history.source_key). Нужны права equipment.write, а для новых моделей ещё references.write.';

REVOKE ALL ON FUNCTION public.import_equipment_history(text, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_equipment_history(text, jsonb, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
