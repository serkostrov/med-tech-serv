-- Приход накладной файлом и остаток отдельно по состояниям Г, Н и Б.
--
-- Что было не так.
--   1. Приход вводили по одной позиции в окне «Пополнить». Накладная на тридцать строк
--      это тридцать открытий окна, и ошибку в количестве замечали уже в остатках —
--      а движение склада не исправить, только встречным.
--   2. В списке склада стоял один общий остаток на позицию. Резервируют и выдают
--      запчасть в состоянии (Г, Н или Б), и «на складе 8» ничего не говорило о том,
--      можно ли выдать гарантийную: восемь могло лежать новыми. Кладовщик открывал
--      окно резерва, чтобы узнать, что в нужном состоянии ноль.
--
-- Что делаем.
--   1. preview_stock_receipt разбирает строки накладной и на каждую отвечает, что
--      распознал: какую запчасть нашёл, по артикулу или по псевдониму (0047), сколько
--      и в каком состоянии — или что с этой строкой не так. Ошибки приходят списком
--      по строкам, а не одной фразой на весь файл. Функция только читает: пока человек
--      не нажал «Оприходовать», на складе не меняется ничего.
--   2. receive_stock_batch оприходует весь файл одной транзакцией и сам проверяет строки
--      заново: ошибка хотя бы в одной — не проводится ни одна. Иначе из накладной
--      с опечаткой половина строк легла бы на склад, а исправить приход нельзя.
--   3. В inventory_part_registry появились остаток и доступное по каждому состоянию:
--      список склада показывает Г, Н и Б отдельно.
--
-- Разбор файла остаётся на странице: xlsx в браузере уже собирают (src/xlsx.ts),
-- база принимает уже разобранные строки и держит все проверки у себя — страница их
-- повторяет, чтобы человек увидел ошибки до отправки.
--
-- Цену прихода (0040) приём накладной пишет, но не читает: колонка закрыта от ролей API,
-- и обе функции с правами вызывающего (SECURITY INVOKER), как выдача резерва (0022)
-- и списание (0049). Миграцию можно применить повторно.

-- ---------------------------------------------------------------------------
-- 1. Состояние запчасти из клетки файла
-- ---------------------------------------------------------------------------

-- В накладной состояние пишут по-разному: «Н», «N», «новая», пусто. Пустое считаем
-- новой: такой приход и есть обычная поставка. Непонятное не угадываем — строка
-- вернётся с ошибкой, и человек поправит файл.
CREATE OR REPLACE FUNCTION public.part_condition_from_text(p_text text)
RETURNS public.part_condition
LANGUAGE sql
IMMUTABLE
SET search_path = pg_temp
AS $$
  SELECT CASE upper(btrim(coalesce(p_text, '')))
    WHEN '' THEN 'N'
    WHEN 'N' THEN 'N'
    WHEN 'Н' THEN 'N'
    WHEN 'НОВАЯ' THEN 'N'
    WHEN 'НОВЫЙ' THEN 'N'
    WHEN 'G' THEN 'G'
    WHEN 'Г' THEN 'G'
    WHEN 'ГАРАНТИЙНАЯ' THEN 'G'
    WHEN 'ГАРАНТИЯ' THEN 'G'
    WHEN 'B' THEN 'B'
    WHEN 'Б' THEN 'B'
    WHEN 'Б/У' THEN 'B'
    WHEN 'БУ' THEN 'B'
    ELSE NULL
  END::public.part_condition
$$;

COMMENT ON FUNCTION public.part_condition_from_text(text) IS
  'Состояние запчасти из клетки накладной (0050): Г/G/гарантийная, Н/N/новая (и пусто), Б/B/б-у. Непонятное — NULL, строка вернётся с ошибкой.';

REVOKE ALL ON FUNCTION public.part_condition_from_text(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.part_condition_from_text(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Что система распознала в файле
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.preview_stock_receipt(p_items jsonb)
RETURNS TABLE (
  row_no integer,
  article text,
  part_id uuid,
  part_article text,
  part_name text,
  matched_by text,
  part_condition public.part_condition,
  quantity numeric,
  unit_price numeric,
  comment text,
  error text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.app_has_permission('warehouse.write') THEN
    RAISE EXCEPTION 'Загружать приход накладной может только склад' USING ERRCODE = '42501';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'Строки накладной должны прийти списком' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'В файле нет ни одной строки с приходом' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(p_items) > 1000 THEN
    RAISE EXCEPTION 'За один раз оприходуется не больше 1000 строк: разделите файл'
      USING ERRCODE = '23514';
  END IF;

  RETURN QUERY
  WITH raw AS (
    SELECT
      -- Номер строки файла: его присылает страница, чтобы ошибка указывала на ту
      -- строку, которую человек видит в таблице. Нет номера — считаем по порядку.
      coalesce(nullif(item.value ->> 'row', '')::integer, item.ordinality::integer) AS row_no,
      btrim(coalesce(item.value ->> 'article', '')) AS article,
      item.value ->> 'condition' AS condition_text,
      item.value -> 'quantity' AS quantity_raw,
      item.value -> 'unit_price' AS price_raw,
      nullif(btrim(coalesce(item.value ->> 'comment', '')), '') AS comment
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS item(value, ordinality)
  ), parsed AS (
    SELECT
      raw.row_no,
      raw.article,
      raw.comment,
      public.part_condition_from_text(raw.condition_text) AS part_condition,
      raw.condition_text,
      -- Число из клетки: настоящим числом или строкой «5,5» — в накладных встречается
      -- и то и то. Что числом не становится, остаётся NULL и вернётся ошибкой строки.
      CASE
        WHEN jsonb_typeof(raw.quantity_raw) = 'number' THEN (raw.quantity_raw #>> '{}')::numeric
        WHEN jsonb_typeof(raw.quantity_raw) = 'string'
          AND btrim(replace(raw.quantity_raw #>> '{}', ' ', '')) ~ '^-?[0-9]+([.,][0-9]+)?$'
          THEN replace(btrim(replace(raw.quantity_raw #>> '{}', ' ', '')), ',', '.')::numeric
      END AS quantity,
      CASE
        WHEN jsonb_typeof(raw.price_raw) = 'number' THEN (raw.price_raw #>> '{}')::numeric
        WHEN jsonb_typeof(raw.price_raw) = 'string'
          AND btrim(replace(raw.price_raw #>> '{}', ' ', '')) ~ '^-?[0-9]+([.,][0-9]+)?$'
          THEN replace(btrim(replace(raw.price_raw #>> '{}', ' ', '')), ',', '.')::numeric
      END AS unit_price,
      -- Цена указана, но числом не читается: молча терять её нельзя, счёт берёт
      -- стоимость запчасти именно из неё (0040).
      (raw.price_raw IS NOT NULL AND jsonb_typeof(raw.price_raw) <> 'null'
        AND nullif(btrim(raw.price_raw #>> '{}'), '') IS NOT NULL) AS price_filled
    FROM raw
  ), matched AS (
    SELECT
      parsed.*,
      found.id AS part_id,
      found.article_number AS part_article,
      found.name AS part_name,
      found.is_active,
      found.matched_by
    FROM parsed
    LEFT JOIN LATERAL (
      -- Сначала артикул самой запчасти, потом псевдоним поставщика (0047):
      -- один и тот же артикул на двух позициях база не допускает, но если артикул
      -- позиции совпал, псевдоним чужой запчасти перебить его не должен.
      SELECT p.id, p.article_number, p.name, p.is_active, source.matched_by
        FROM (
          SELECT p1.id, 'article' AS matched_by, 1 AS priority
            FROM public.parts AS p1
           WHERE p1.article_number_normalized = upper(parsed.article)
          UNION ALL
          SELECT a.part_id, 'alias' AS matched_by, 2 AS priority
            FROM public.part_aliases AS a
           WHERE a.alias_normalized = upper(parsed.article)
        ) AS source
        JOIN public.parts AS p ON p.id = source.id
       ORDER BY source.priority
       LIMIT 1
    ) AS found ON true
  ), checked AS (
    SELECT
      matched.*,
      CASE
        WHEN matched.article = '' THEN 'Не указан артикул'
        WHEN matched.part_id IS NULL THEN
          'Артикул «' || matched.article || '» на складе не найден: добавьте запчасть или заведите ей псевдоним'
        WHEN NOT matched.is_active THEN
          'Запчасть «' || matched.part_article || ' · ' || matched.part_name || '» снята с учёта: приходовать её нельзя'
        WHEN matched.part_condition IS NULL THEN
          'Состояние «' || btrim(coalesce(matched.condition_text, '')) || '» непонятно: напишите Г, Н или Б'
        WHEN matched.quantity IS NULL THEN 'Количество должно быть числом, например 5 или 2,5'
        WHEN round(matched.quantity, 3) <= 0 THEN 'Количество должно быть больше нуля'
        WHEN matched.price_filled AND matched.unit_price IS NULL THEN
          'Цену укажите числом, например 1500,50 — или оставьте клетку пустой'
        WHEN matched.unit_price IS NOT NULL AND matched.unit_price < 0 THEN 'Цена не может быть отрицательной'
        -- Две строки на одну запчасть в одном состоянии: цена прихода у партии одна,
        -- и какую из двух взял бы счёт, по файлу не понять. Просим объединить.
        WHEN count(*) OVER (PARTITION BY matched.part_id, matched.part_condition) > 1 THEN
          'Этот артикул в том же состоянии есть в файле ещё раз (строки '
            || (SELECT string_agg(other.row_no::text, ', ' ORDER BY other.row_no)
                  FROM matched AS other
                 WHERE other.part_id = matched.part_id AND other.part_condition = matched.part_condition)
            || '): объедините их в одну'
      END AS error
    FROM matched
  )
  SELECT
    checked.row_no,
    checked.article,
    checked.part_id,
    checked.part_article,
    checked.part_name,
    checked.matched_by,
    checked.part_condition,
    CASE WHEN checked.quantity IS NULL THEN NULL ELSE trim_scale(round(checked.quantity, 3)) END,
    checked.unit_price,
    checked.comment,
    checked.error
  FROM checked
  ORDER BY checked.row_no;
END
$$;

COMMENT ON FUNCTION public.preview_stock_receipt(jsonb) IS
  'Разбор строк накладной перед приходом (0050): что система распознала в каждой строке и что в ней не так. Запчасть ищется по артикулу и по псевдониму (0047). Только читает: склад не меняется, пока человек не подтвердит.';

-- ---------------------------------------------------------------------------
-- 3. Оприходовать весь файл
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.receive_stock_batch(p_items jsonb)
RETURNS TABLE (
  part_id uuid,
  part_article text,
  part_name text,
  part_condition public.part_condition,
  quantity numeric,
  on_hand_after numeric
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  item record;
  broken integer;
  first_row integer;
  first_error text;
  lot uuid;
  batch text := gen_random_uuid()::text;
BEGIN
  IF NOT public.app_has_permission('warehouse.write') THEN
    RAISE EXCEPTION 'Оприходовать накладную может только склад' USING ERRCODE = '42501';
  END IF;

  -- Проверяем те же строки тем же разбором, что показывали человеку: страница могла
  -- показать одно, а прислать другое, и приход — последнее место, где это ещё видно.
  SELECT count(*), (array_agg(bad.row_no ORDER BY bad.row_no))[1], (array_agg(bad.error ORDER BY bad.row_no))[1]
    INTO broken, first_row, first_error
    FROM public.preview_stock_receipt(p_items) AS bad
   WHERE bad.error IS NOT NULL;
  IF broken > 0 THEN
    RAISE EXCEPTION 'В файле % %: на склад не попала ни одна строка. Строка %: %',
      broken,
      CASE WHEN broken % 10 = 1 AND broken % 100 <> 11 THEN 'ошибка'
           WHEN broken % 10 BETWEEN 2 AND 4 AND broken % 100 NOT BETWEEN 12 AND 14 THEN 'ошибки'
           ELSE 'ошибок' END,
      first_row, first_error
      USING ERRCODE = '23514';
  END IF;

  FOR item IN SELECT * FROM public.preview_stock_receipt(p_items) ORDER BY row_no LOOP
    -- Партия этой запчасти в этом состоянии; нет ни одной — заводим по умолчанию.
    lot := public.stock_lot_for_write(item.part_id, item.part_condition, true);
    IF item.unit_price IS NOT NULL THEN
      -- Приход этой запчасти в этом состоянии идёт в одну и ту же партию, поэтому
      -- цена здесь и есть «последняя цена прихода»: её же берёт счёт (0040).
      -- Склад цену пишет, читать её обратно не может — поэтому и не читаем.
      UPDATE public.stock_lots SET receipt_unit_price = item.unit_price WHERE id = lot;
    END IF;
    INSERT INTO public.stock_movements (
      idempotency_key, movement_type, lot_id, part_id, part_condition, quantity, on_hand_delta,
      performed_by, comment
    ) VALUES (
      'receipt:batch:' || batch || ':' || item.row_no::text, 'receipt', lot, item.part_id,
      item.part_condition, item.quantity, item.quantity, public.current_app_user_id(), item.comment
    );
  END LOOP;

  -- Разбор тот же, остаток уже с учётом проведённых движений: страница показывает,
  -- сколько стало на складе по каждой строке накладной.
  RETURN QUERY
  SELECT
    applied.part_id,
    applied.part_article,
    applied.part_name,
    applied.part_condition,
    trim_scale(applied.quantity),
    trim_scale(coalesce((
      SELECT sum(m.on_hand_delta) FROM public.stock_movements AS m
       WHERE m.part_id = applied.part_id AND m.part_condition = applied.part_condition
    ), 0))
  FROM public.preview_stock_receipt(p_items) AS applied
  ORDER BY applied.row_no;
END
$$;

COMMENT ON FUNCTION public.receive_stock_batch(jsonb) IS
  'Приход накладной файлом (0050): проводит все строки одной транзакцией после подтверждения человеком. Ошибка хотя бы в одной строке — не проводится ни одна: исправить приход нельзя, только встречным движением. Цену прихода пишет, не читая.';

REVOKE ALL ON FUNCTION public.preview_stock_receipt(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.receive_stock_batch(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_stock_receipt(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.receive_stock_batch(jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Остаток отдельно по состояниям Г, Н и Б
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.inventory_part_registry
WITH (security_invoker = true) AS
SELECT
  p.id,
  p.article_number,
  p.name,
  p.minimum_stock,
  p.notes,
  p.is_active,
  coalesce(balance.on_hand_quantity, 0)::numeric(14, 3) AS on_hand_quantity,
  coalesce(balance.reserved_quantity, 0)::numeric(14, 3) AS reserved_quantity,
  coalesce(balance.available_quantity, 0)::numeric(14, 3) AS available_quantity,
  coalesce(issued.quantity, 0)::numeric(14, 3) AS with_engineers_quantity,
  (coalesce(balance.available_quantity, 0) < p.minimum_stock) AS below_minimum,
  translate(concat_ws(' ',
    p.article_number,
    regexp_replace(p.article_number, '[^[:alnum:]]+', '', 'g'),
    p.name,
    -- (0047) Псевдонимы поставщиков: и как есть, и без пробелов и дефисов.
    alias.search_text
  ), 'Ёё', 'Ее') AS search_text,
  alias.alias_list AS aliases,
  -- (0050) Остаток и доступное по состояниям: резервируют и выдают именно в состоянии,
  -- и по общему числу не видно, есть ли гарантийная.
  coalesce(balance.on_hand_g, 0)::numeric(14, 3) AS on_hand_guarantee,
  coalesce(balance.on_hand_n, 0)::numeric(14, 3) AS on_hand_new,
  coalesce(balance.on_hand_b, 0)::numeric(14, 3) AS on_hand_used,
  coalesce(balance.available_g, 0)::numeric(14, 3) AS available_guarantee,
  coalesce(balance.available_n, 0)::numeric(14, 3) AS available_new,
  coalesce(balance.available_b, 0)::numeric(14, 3) AS available_used
FROM public.parts AS p
LEFT JOIN (
  SELECT
    b.part_id,
    sum(b.on_hand_quantity) AS on_hand_quantity,
    sum(b.reserved_quantity) AS reserved_quantity,
    sum(b.available_quantity) AS available_quantity,
    sum(b.on_hand_quantity) FILTER (WHERE b.part_condition = 'G') AS on_hand_g,
    sum(b.on_hand_quantity) FILTER (WHERE b.part_condition = 'N') AS on_hand_n,
    sum(b.on_hand_quantity) FILTER (WHERE b.part_condition = 'B') AS on_hand_b,
    sum(b.available_quantity) FILTER (WHERE b.part_condition = 'G') AS available_g,
    sum(b.available_quantity) FILTER (WHERE b.part_condition = 'N') AS available_n,
    sum(b.available_quantity) FILTER (WHERE b.part_condition = 'B') AS available_b
  FROM public.stock_balances AS b
  GROUP BY b.part_id
) AS balance ON balance.part_id = p.id
LEFT JOIN (
  SELECT r.part_id, sum(r.quantity) AS quantity
  FROM public.stock_reservations AS r
  WHERE r.status = 'issued'
  GROUP BY r.part_id
) AS issued ON issued.part_id = p.id
LEFT JOIN (
  -- Порядок задан: иначе псевдонимы в строке списка меняли бы местами от запроса к запросу.
  SELECT
    a.part_id,
    string_agg(btrim(a.alias), ', ' ORDER BY a.alias_normalized) AS alias_list,
    string_agg(btrim(a.alias) || ' ' || regexp_replace(a.alias, '[^[:alnum:]]+', '', 'g'), ' ' ORDER BY a.alias_normalized) AS search_text
  FROM public.part_aliases AS a
  GROUP BY a.part_id
) AS alias ON alias.part_id = p.id;

COMMENT ON VIEW public.inventory_part_registry IS
  'Склад: остатки, резерв, доступно, у инженеров, «ниже минимума», псевдонимы артикулов (0047) и остаток с доступным по состояниям Г, Н и Б (0050). С правами вызывающего.';

REVOKE ALL ON public.inventory_part_registry FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.inventory_part_registry TO authenticated;

NOTIFY pgrst, 'reload schema';
