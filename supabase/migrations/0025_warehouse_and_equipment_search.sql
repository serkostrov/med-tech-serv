-- Склад и приборы: фильтры, сортировку, сводку и поиск считает база, а не страница.
--
-- 1. Склад. Представление inventory_part_registry: запчасть с остатком на складе,
--    резервом, доступным количеством (на складе минус резерв, как в stock_balances;
--    у запчасти без партий всё по нулю), количеством у инженеров (выданные резервы)
--    и признаком «ниже минимума». По нему список склада фильтруется («Ниже минимума»,
--    «Неактивные»), сортируется по доступному остатку и листается страницами с верным
--    общим числом. Функция inventory_part_summary() считает карточки над списком
--    по всему складу: активные, ниже минимума (из активных), позиции у инженеров.
-- 2. Приборы. Представление equipment_search: строка прибора и текст для поиска
--    из S/N, модели, производителя, площадки, организации, плательщика и примечания.
--    Номер и модель лежат в тексте ещё и без пробелов и дефисов: «TC-7A 001284»
--    находится по «tc7a001». «Ё» в тексте записана как «е».
--
-- Оба представления работают с правами вызывающего (security_invoker), как остальные
-- представления схемы (0001): что видно, решают политики таблиц. Кладовщик без права
-- на приборы не находит приборов, сотрудник без права на склад не видит запчастей,
-- а плательщик или чужая организация, скрытые политиками, в поиск не попадают.
-- Функция сводки тоже с правами вызывающего, анониму закрыта.
-- Миграцию можно применить повторно и целиком одной транзакцией (BEGIN … COMMIT).

-- Представление склада опирается на stock_balances: оно тоже должно работать
-- с правами вызывающего, иначе остатки читались бы от владельца, мимо политик.
ALTER VIEW public.stock_balances SET (security_invoker = true);

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
    p.name
  ), 'Ёё', 'Ее') AS search_text
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
) AS issued ON issued.part_id = p.id;

COMMENT ON VIEW public.inventory_part_registry IS
  'Склад: остатки, резерв, доступно, у инженеров и «ниже минимума» по каждой запчасти. С правами вызывающего.';

REVOKE ALL ON public.inventory_part_registry FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.inventory_part_registry TO authenticated;

CREATE OR REPLACE FUNCTION public.inventory_part_summary()
RETURNS TABLE (active bigint, below_minimum bigint, with_engineers bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT
    count(*) FILTER (WHERE r.is_active),
    count(*) FILTER (WHERE r.is_active AND r.below_minimum),
    count(*) FILTER (WHERE r.with_engineers_quantity > 0)
  FROM public.inventory_part_registry AS r;
$$;

COMMENT ON FUNCTION public.inventory_part_summary() IS
  'Карточки над складом по всему складу: активные, ниже минимума из активных, позиции у инженеров. С правами вызывающего.';

REVOKE ALL ON FUNCTION public.inventory_part_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_part_summary() TO authenticated;

-- Все столбцы прибора, чтобы реестр выбирал из представления то же, что из таблицы,
-- вместе со связями (производитель, модель, площадка, плательщик) по ключам прибора.
CREATE OR REPLACE VIEW public.equipment_search
WITH (security_invoker = true) AS
SELECT
  e.id,
  e.serial_number,
  e.serial_number_normalized,
  e.manufacturer_id,
  e.model_id,
  e.guarantee_category_id,
  e.status_code,
  e.current_site_id,
  e.current_payer_id,
  e.last_meter_reading,
  e.notes,
  e.created_at,
  e.updated_at,
  translate(concat_ws(' ',
    e.serial_number,
    regexp_replace(e.serial_number, '[^[:alnum:]]+', '', 'g'),
    manufacturer.name,
    model.name,
    regexp_replace(model.name, '[^[:alnum:]]+', '', 'g'),
    site.name,
    organization.name,
    -- Плательщика ищут только те, кому его показывают (финансы, координация, правка приборов),
    -- иначе инженер находил бы приборы по скрытому от него плательщику.
    CASE WHEN (SELECT public.app_has_any_permission(ARRAY['finance.read', 'tasks.write', 'equipment.write'])) THEN payer.name END,
    e.notes
  ), 'Ёё', 'Ее') AS search_text
FROM public.equipment AS e
LEFT JOIN public.manufacturers AS manufacturer ON manufacturer.id = e.manufacturer_id
LEFT JOIN public.equipment_models AS model ON model.id = e.model_id
LEFT JOIN public.sites AS site ON site.id = e.current_site_id
LEFT JOIN public.organizations AS organization ON organization.id = site.organization_id
LEFT JOIN public.payers AS payer ON payer.id = e.current_payer_id;

COMMENT ON VIEW public.equipment_search IS
  'Приборы с текстом для поиска по S/N, модели, производителю, площадке, организации, плательщику и примечанию. С правами вызывающего.';

REVOKE ALL ON public.equipment_search FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.equipment_search TO authenticated;

-- Остатки без входа не читаются и без опоры на security_invoker (Supabase по умолчанию даёт anon SELECT).
REVOKE ALL ON public.stock_balances FROM anon;

NOTIFY pgrst, 'reload schema';
