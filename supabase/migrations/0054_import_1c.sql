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
  hidden_pair text;
  broken_row text;
  equipment_wanted integer;
  events_wanted integer;
  manufacturers_created integer := 0;
  models_created integer := 0;
  equipment_created integer := 0;
  events_created integer := 0;
  events_without_equipment integer := 0;
BEGIN
  IF NOT public.app_has_permission('equipment.write') THEN
    RAISE EXCEPTION 'Недостаточно прав: переносить приборы и их историю может тот, у кого есть право заводить приборы (equipment.write)'
      USING ERRCODE = '42501';
  END IF;
  IF source_name IS NULL OR char_length(source_name) > 200 THEN
    RAISE EXCEPTION 'Укажите имя файла выгрузки (до 200 символов)' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_equipment) IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_events) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Приборы и события передаются списками' USING ERRCODE = '22023';
  END IF;
  -- Каждая строка приборов и истории пишет ещё и строку аудита (триггеры 0001),
  -- поэтому за один запрос берём столько, сколько проходит до таймаута PostgREST.
  IF jsonb_array_length(p_equipment) > 2000 OR jsonb_array_length(p_events) > 10000 THEN
    RAISE EXCEPTION 'За один раз переносим не больше 2000 приборов и 10000 событий: разделите выгрузку'
      USING ERRCODE = '22023';
  END IF;

  -- Строка выгрузки должна быть полной: без серийного номера, производителя или модели
  -- прибор в реестре не создать, и молча пропускать такую строку нельзя.
  SELECT format('%s-я строка приборов (S/N «%s»)', list.row_no, coalesce(list.item ->> 'serialNumber', ''))
    INTO broken_row
    FROM jsonb_array_elements(p_equipment) WITH ORDINALITY AS list(item, row_no)
   WHERE jsonb_typeof(list.item) IS DISTINCT FROM 'object'
      OR nullif(btrim(coalesce(list.item ->> 'serialNumber', '')), '') IS NULL
      OR nullif(btrim(coalesce(list.item ->> 'manufacturer', '')), '') IS NULL
      OR nullif(btrim(coalesce(list.item ->> 'model', '')), '') IS NULL
   ORDER BY list.row_no
   LIMIT 1;
  IF broken_row IS NOT NULL THEN
    RAISE EXCEPTION 'У каждого прибора выгрузки нужны серийный номер, производитель и модель: не хватает в %', broken_row
      USING ERRCODE = '23514';
  END IF;
  -- Дата события приходит с часовым поясом: без него момент разобрался бы по
  -- поясу сервера, и московская полночь уехала бы на сутки назад.
  SELECT format('%s-я строка истории (S/N «%s»)', list.row_no, coalesce(list.item ->> 'serialNumber', ''))
    INTO broken_row
    FROM jsonb_array_elements(p_events) WITH ORDINALITY AS list(item, row_no)
   WHERE jsonb_typeof(list.item) IS DISTINCT FROM 'object'
      OR nullif(btrim(coalesce(list.item ->> 'serialNumber', '')), '') IS NULL
      OR nullif(btrim(coalesce(list.item ->> 'summary', '')), '') IS NULL
      OR coalesce(list.item ->> 'sourceKey', '') !~ '^[0-9a-f]{64}$'
      OR coalesce(list.item ->> 'happenedAt', '') !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$'
   ORDER BY list.row_no
   LIMIT 1;
  IF broken_row IS NOT NULL THEN
    RAISE EXCEPTION 'У каждого события выгрузки нужны прибор, дата с часовым поясом, краткое описание и ключ строки: не хватает в %', broken_row
      USING ERRCODE = '23514';
  END IF;

  -- Два импорта подряд не должны вперегонки заводить одного производителя,
  -- а проверка справочника — расходиться с тем, что увидит запись.
  PERFORM pg_advisory_xact_lock(hashtextextended('import_equipment_history', 0));

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

  -- Скрытую модель или скрытого производителя база на прибор не поставит
  -- (страж validate_active_equipment_references, 0001), а завести вторую такую же
  -- не даст уникальный индекс. Говорим об этом словами до записи.
  SELECT CASE
           WHEN NOT m.is_active THEN format('производитель «%s»', m.name)
           ELSE format('модель «%s» у производителя «%s»', em.name, m.name)
         END
    INTO hidden_pair
    FROM jsonb_array_elements(p_equipment) AS item
    JOIN public.manufacturers AS m
      ON lower(btrim(m.name)) = lower(btrim(item ->> 'manufacturer'))
    LEFT JOIN public.equipment_models AS em
      ON em.manufacturer_id = m.id
     AND lower(btrim(em.name)) = lower(btrim(item ->> 'model'))
   WHERE NOT m.is_active OR (em.id IS NOT NULL AND NOT em.is_active)
   LIMIT 1;
  IF hidden_pair IS NOT NULL THEN
    RAISE EXCEPTION 'В справочнике скрыт(а) %: верните запись кнопкой «Показать» и повторите импорт', hidden_pair
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.manufacturers (name, sort_order)
  SELECT wanted.name,
         (SELECT coalesce(max(m.sort_order), 0) FROM public.manufacturers AS m)
           + 10 * row_number() OVER (ORDER BY lower(wanted.name))
    FROM (
      SELECT DISTINCT ON (lower(btrim(item ->> 'manufacturer'))) btrim(item ->> 'manufacturer') AS name
        FROM jsonb_array_elements(p_equipment) AS item
       WHERE NOT EXISTS (
         SELECT 1 FROM public.manufacturers AS m
          WHERE lower(btrim(m.name)) = lower(btrim(item ->> 'manufacturer'))
       )
       ORDER BY lower(btrim(item ->> 'manufacturer'))
    ) AS wanted
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS manufacturers_created = ROW_COUNT;

  INSERT INTO public.equipment_models (manufacturer_id, name, sort_order)
  SELECT wanted.manufacturer_id,
         wanted.name,
         (SELECT coalesce(max(em.sort_order), 0)
            FROM public.equipment_models AS em
           WHERE em.manufacturer_id = wanted.manufacturer_id)
           + 10 * row_number() OVER (PARTITION BY wanted.manufacturer_id ORDER BY lower(wanted.name))
    FROM (
      SELECT DISTINCT ON (m.id, lower(btrim(item ->> 'model')))
             m.id AS manufacturer_id, btrim(item ->> 'model') AS name
        FROM jsonb_array_elements(p_equipment) AS item
        JOIN public.manufacturers AS m
          ON lower(btrim(m.name)) = lower(btrim(item ->> 'manufacturer'))
       WHERE NOT EXISTS (
         SELECT 1 FROM public.equipment_models AS em
          WHERE em.manufacturer_id = m.id
            AND lower(btrim(em.name)) = lower(btrim(item ->> 'model'))
       )
       ORDER BY m.id, lower(btrim(item ->> 'model'))
    ) AS wanted
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
         -- Площадку ищем подзапросом и берём, только если она одна: имя площадки
         -- уникально внутри организации, и у двух организаций оно может совпасть.
         -- Если таких площадок несколько, прибор создаётся без привязки, а пробный
         -- импорт предупреждает об этом заранее.
         (SELECT (array_agg(site.id ORDER BY site.created_at, site.id))[1]
            FROM public.sites AS site
           WHERE wanted.site IS NOT NULL
             AND site.is_active
             AND lower(btrim(site.name)) = lower(wanted.site)
          HAVING count(*) = 1),
         (SELECT (array_agg(payer.id ORDER BY payer.created_at, payer.id))[1]
            FROM public.payers AS payer
           WHERE wanted.payer IS NOT NULL
             AND payer.is_active
             AND lower(btrim(payer.name)) = lower(wanted.payer)
          HAVING count(*) = 1),
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
                  THEN CASE WHEN (item ->> 'meterReading')::numeric BETWEEN 0 AND 999999999999.99
                            THEN round((item ->> 'meterReading')::numeric, 2)
                       END
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

  SELECT count(DISTINCT upper(regexp_replace(btrim(item ->> 'serialNumber'), '\s+', '', 'g')))
    INTO equipment_wanted
    FROM jsonb_array_elements(p_equipment) AS item;

  SELECT count(DISTINCT (upper(regexp_replace(btrim(item ->> 'serialNumber'), '\s+', '', 'g')), item ->> 'sourceKey'))
    INTO events_wanted
    FROM jsonb_array_elements(p_events) AS item;

  SELECT count(DISTINCT (upper(regexp_replace(btrim(item ->> 'serialNumber'), '\s+', '', 'g')), item ->> 'sourceKey'))
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
    FROM jsonb_array_elements(p_events) WITH ORDINALITY AS list(item, row_no)
    JOIN public.equipment AS e
      ON e.serial_number_normalized
         = upper(regexp_replace(btrim(item ->> 'serialNumber'), '\s+', '', 'g'))
   ORDER BY list.row_no
  ON CONFLICT (equipment_id, source_key) WHERE source_key IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS events_created = ROW_COUNT;

  RETURN jsonb_build_object(
    'sourceName', source_name,
    'manufacturersCreated', manufacturers_created,
    'modelsCreated', models_created,
    'equipmentCreated', equipment_created,
    'equipmentAlready', equipment_wanted - equipment_created,
    'eventsCreated', events_created,
    'eventsAlready', greatest(events_wanted - events_created - events_without_equipment, 0),
    'eventsWithoutEquipment', events_without_equipment
  );
END
$$;

COMMENT ON FUNCTION public.import_equipment_history(text, jsonb, jsonb) IS
  'Импорт выгрузки 1С (0054): заводит недостающих производителей, модели, приборы и события истории одной транзакцией. Существующие приборы не переписывает, повторная загрузка того же файла ничего не добавляет (equipment.serial_number_normalized и equipment_history.source_key). Нужны права equipment.write, а для новых моделей ещё references.write.';

REVOKE ALL ON FUNCTION public.import_equipment_history(text, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_equipment_history(text, jsonb, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
