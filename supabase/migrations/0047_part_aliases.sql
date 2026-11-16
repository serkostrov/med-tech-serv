-- Псевдонимы артикулов: одна запчасть под артикулами разных поставщиков.
--
-- Что было не так. Таблица part_aliases есть с самого начала (0001), и индекс
-- part_aliases_lookup_idx под поиск по ней тоже, но искать по псевдонимам было
-- нечем: search_text склада (0025) собирался только из артикула и наименования.
-- Кладовщик, у которого в накладной поставщика стоит «12V20W-AU», своей лампы
-- «AU-LAMP-12V20W» не находил и заводил вторую позицию — остаток расходился
-- по двум карточкам, и минимум ни по одной не срабатывал.
--
-- Что делаем.
--   1. Псевдонимы попадают в search_text склада: и как есть, и без пробелов
--      и дефисов, как артикул («12V20W AU» находится по «12v20wau»). Отдельной
--      колонкой aliases их видно в строке списка — чтобы человек понимал,
--      почему запчасть нашлась по чужому артикулу.
--   2. Понятные отказы вместо сырой ошибки уникальности, как в 0039:
--      псевдоним не повторяет артикул своей запчасти (толку нет), не занимает
--      артикул другой позиции и не отобран другой запчастью. Иначе один и тот же
--      артикул указывал бы на две запчасти, и поиск отдавал бы обе.
--   3. Своё правило дубля — и для самой номенклатуры: артикул, уже заведённый
--      как псевдоним другой запчасти, тоже отказывается по-русски.
--
-- Представление, как остальные (0025), работает с правами вызывающего: кому склад
-- не виден, тот не найдёт запчасть и по псевдониму. Триггеры, как все служебные
-- (0009), работают от владельца схемы: им нужно видеть и ту запчасть, которая
-- занимает артикул, даже если по правам она вызывающему не видна — иначе отказ
-- выглядел бы выдумкой.
--
-- Повторно эту миграцию применяют только до 0050: та пересобирает то же
-- представление с остатками по состояниям, а CREATE OR REPLACE VIEW убрать
-- столбцы не умеет и честно откажет («cannot drop columns from view»). Так и надо:
-- откатывать склад к виду без Г, Н и Б молча было бы хуже — список перестал бы
-- показывать то, что просит у базы. Чтобы пересобрать представление, применяйте 0050.

-- ---------------------------------------------------------------------------
-- 1. Понятные отказы по псевдонимам
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_part_alias()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  alias_key text := upper(btrim(NEW.alias));
  own_article text;
  busy record;
BEGIN
  SELECT p.article_number INTO own_article FROM public.parts AS p WHERE p.id = NEW.part_id;
  IF own_article IS NULL THEN
    RAISE EXCEPTION 'Запчасть не найдена в справочнике: псевдоним привязывать не к чему'
      USING ERRCODE = '23503';
  END IF;
  IF upper(btrim(own_article)) = alias_key THEN
    RAISE EXCEPTION 'Это и есть артикул самой запчасти: в псевдонимы пишут артикул поставщика'
      USING ERRCODE = '23514';
  END IF;

  -- Артикул другой позиции. Регистр и крайние пробелы не учитываются: так же
  -- считают оба уникальных индекса (parts_article_number_uq, part_aliases_alias_uq).
  SELECT p.article_number, p.name, p.is_active INTO busy
    FROM public.parts AS p
   WHERE p.article_number_normalized = alias_key
     AND p.id <> NEW.part_id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Артикул «%» занят запчастью «% · %»%: псевдоним должен отличаться от артикулов других позиций',
      btrim(NEW.alias), busy.article_number, busy.name,
      CASE WHEN busy.is_active THEN '' ELSE ' (она скрыта)' END
      USING ERRCODE = '23505';
  END IF;

  -- Псевдоним другой позиции.
  SELECT p.article_number, p.name, p.is_active INTO busy
    FROM public.part_aliases AS a
    JOIN public.parts AS p ON p.id = a.part_id
   WHERE a.alias_normalized = alias_key
     AND a.id <> NEW.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Псевдоним «%» уже закреплён за запчастью «% · %»%',
      btrim(NEW.alias), busy.article_number, busy.name,
      CASE WHEN busy.is_active THEN '' ELSE ' (она скрыта)' END
      USING ERRCODE = '23505', CONSTRAINT = 'part_aliases_alias_uq';
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.guard_part_alias() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.guard_part_alias() IS
  'Псевдоним артикула (0047): не повторяет артикул своей запчасти, не занимает артикул и не отобран псевдонимом другой позиции. Отказы по-русски вместо сырой ошибки уникальности.';

DROP TRIGGER IF EXISTS part_aliases_guard ON public.part_aliases;
CREATE TRIGGER part_aliases_guard
  BEFORE INSERT OR UPDATE OF alias, part_id ON public.part_aliases
  FOR EACH ROW EXECUTE FUNCTION public.guard_part_alias();

-- Обратная сторона: артикул номенклатуры, занятый псевдонимом другой запчасти.
-- Уникальный индекс такой случай не ловит — таблицы разные, а поиск после этого
-- отдавал бы по одному артикулу две позиции.
CREATE OR REPLACE FUNCTION public.guard_part_article_alias_conflict()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  busy record;
BEGIN
  SELECT p.article_number, p.name, p.is_active INTO busy
    FROM public.part_aliases AS a
    JOIN public.parts AS p ON p.id = a.part_id
   WHERE a.alias_normalized = upper(btrim(NEW.article_number))
     AND a.part_id <> NEW.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Артикул «%» уже заведён псевдонимом у запчасти «% · %»%: уберите псевдоним или возьмите другой артикул',
      btrim(NEW.article_number), busy.article_number, busy.name,
      CASE WHEN busy.is_active THEN '' ELSE ' (она скрыта)' END
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.guard_part_article_alias_conflict() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.guard_part_article_alias_conflict() IS
  'Артикул новой запчасти, уже заведённый псевдонимом у другой позиции (0047): отказ по-русски, иначе один артикул указывал бы на две запчасти.';

DROP TRIGGER IF EXISTS parts_article_alias_conflict ON public.parts;
CREATE TRIGGER parts_article_alias_conflict
  BEFORE INSERT OR UPDATE OF article_number ON public.parts
  FOR EACH ROW EXECUTE FUNCTION public.guard_part_article_alias_conflict();

-- ---------------------------------------------------------------------------
-- 2. Склад находит запчасть по любому её артикулу
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
  alias.alias_list AS aliases
FROM public.parts AS p
LEFT JOIN (
  SELECT
    b.part_id,
    sum(b.on_hand_quantity) AS on_hand_quantity,
    sum(b.reserved_quantity) AS reserved_quantity,
    sum(b.available_quantity) AS available_quantity
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
  'Склад: остатки, резерв, доступно, у инженеров, «ниже минимума» и псевдонимы артикулов (0047). Поиск по search_text находит запчасть по артикулу любого поставщика. С правами вызывающего.';

REVOKE ALL ON public.inventory_part_registry FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.inventory_part_registry TO authenticated;

NOTIFY pgrst, 'reload schema';
