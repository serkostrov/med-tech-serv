-- Прайс: кто ведёт цены и как они меняются во времени (ТЗ, экран «Прайс»).
--
-- Что было не так. Таблица price_list, права price.read и price.write и правила строк
-- по ним есть с 0001 и 0009, но вести прайс было некому и нечем: ни одна настраиваемая
-- роль этих прав не получила, а историю цен интерфейсу пришлось бы складывать прямыми
-- INSERT и UPDATE. Периоды действия цены разводит ограничение EXCLUDE, поэтому любая
-- ошибка в порядке записи (сначала завели новую цену, потом закрыли прошлую) падала бы
-- текстом ограничения про daterange, а не понятным отказом.
--
-- Что делаем.
--   1. Руководитель получает price.read и price.write: по ТЗ прайс ведёт он. Инженеру
--      и кладовщику цены не видны по-прежнему никаким запросом.
--   2. set_work_price — одна цена: закрывает прошлый период днём начала новой, правит
--      цену тем же числом вместо второй строки и не наступает на уже заведённую будущую.
--   3. bulk_update_work_prices — то же по списку позиций в одной транзакции.
--   4. delete_future_work_price — отменить ещё не начавшуюся цену. История не удаляется.
--   5. work_price_on — цена, действовавшая на дату: по категории гарантии, иначе общая.
--   6. Страж: прямая запись в price_list закрыта, как складская цепочка в 0028. Флаг
--      app.price_chain ставят на время записи только функции прайса, снаружи его не задать.
--
-- Функции работают с правами вызывающего (SECURITY INVOKER): правила строк price_list
-- и так пускают к записи только price.write, а понятный отказ по-русски даёт проверка
-- внутри функции. Писать цены может только тот, кому прайс ещё и виден: функции
-- возвращают записанную строку или читают её перед записью, а на чтение действует своё
-- правило (price.read или finance.read). Роль с одним price.write — ошибка настройки,
-- и про неё лучше сказать прямо, чем отдать сырой отказ правил строк по-английски.
-- Сутки считаем по Москве, как просрочку задач в 0027: цена, начавшаяся сегодня,
-- уже действует, даже если на сервере базы ещё вчерашний день.

-- ---------------------------------------------------------------------------
-- 1. Прайс ведёт руководитель
-- ---------------------------------------------------------------------------

-- Политики проверяют права по матрице access_role_permissions (0014) — она главная.
-- Старая таблица role_permissions осталась от первой схемы прав, и из неё заполняется
-- матрица на новой установке (0001), поэтому держим обе в одном состоянии.
INSERT INTO public.role_permissions (role, permission_code)
SELECT 'supervisor'::public.user_role, needed.code
  FROM (VALUES ('price.read'), ('price.write')) AS needed(code)
 WHERE EXISTS (SELECT 1 FROM public.permissions AS p WHERE p.code = needed.code)
ON CONFLICT DO NOTHING;

INSERT INTO public.access_role_permissions (role_key, permission_code)
SELECT 'supervisor', needed.code
  FROM (VALUES ('price.read'), ('price.write')) AS needed(code)
 WHERE EXISTS (SELECT 1 FROM public.access_roles AS r WHERE r.key = 'supervisor')
   AND EXISTS (SELECT 1 FROM public.permissions AS p WHERE p.code = needed.code)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Страж: цены меняются только функциями прайса
-- ---------------------------------------------------------------------------

-- Иначе интерфейс (или любой запрос с правом price.write) мог бы завести вторую цену
-- с того же числа, оставить прошлую незакрытой или удалить историю. Сделано так же, как
-- страж складской цепочки в 0028: транзакционный флаг плюс триггер с отказом по-русски.
CREATE OR REPLACE FUNCTION public.guard_price_list_direct_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Без вошедшего пользователя идут миграции и перенос данных: им страж не мешает,
  -- как и стражам 0014 и 0028. Флаг app.price_chain ставят только функции прайса на
  -- время своей записи; из браузера его не задать — PostgREST пускает к select и rpc,
  -- а set_config в схеме public не лежит.
  IF auth.uid() IS NULL
     OR coalesce(current_setting('app.price_chain', true), 'off') = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '%',
    CASE TG_OP
      WHEN 'INSERT' THEN 'Цену заводят только через прайс: добавить строку напрямую нельзя'
      WHEN 'UPDATE' THEN 'Цену меняют только через прайс: править строку напрямую нельзя'
      ELSE 'Цену удаляют только через прайс: удалить строку напрямую нельзя'
    END
    USING ERRCODE = '42501';
END
$$;

REVOKE EXECUTE ON FUNCTION public.guard_price_list_direct_write() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.guard_price_list_direct_write() IS
  'Страж прайса (0031): прямые INSERT, UPDATE и DELETE по price_list запрещены, писать можно только изнутри функций прайса (флаг app.price_chain). Служебные операции без вошедшего пользователя страж пропускает.';

DROP TRIGGER IF EXISTS price_list_guard_direct_write ON public.price_list;
CREATE TRIGGER price_list_guard_direct_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.price_list
  FOR EACH ROW EXECUTE FUNCTION public.guard_price_list_direct_write();

-- ---------------------------------------------------------------------------
-- 3. Одна цена: завести, исправить, запланировать
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_work_price(
  p_work_type_code text,
  p_guarantee_category_id uuid,
  p_amount numeric,
  p_valid_from date,
  p_include_guarantee_work boolean DEFAULT false
)
RETURNS TABLE (id uuid, valid_from date, valid_to date, amount numeric)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- Тот же ключ области, что в генерируемом столбце scope_key: цена «для всех» это '*'.
  scope text := coalesce(p_guarantee_category_id::text, '*');
  -- Без numeric(14, 2): иначе слишком большая цена падала бы на присваивании сюда
  -- словами «numeric field overflow» вместо понятного отказа ниже.
  price numeric;
  guarantee boolean := coalesce(p_include_guarantee_work, false);
  saved public.price_list%ROWTYPE;
  next_from date;
  -- Флаг возвращаем как было, а не в 'off': если эту функцию когда-нибудь вызовут
  -- изнутри другой записи прайса, сброс закрыл бы стражем её собственные строки.
  outer_flag text := coalesce(current_setting('app.price_chain', true), 'off');
BEGIN
  IF NOT public.app_has_permission('price.write') THEN
    RAISE EXCEPTION 'Недостаточно прав: прайс ведёт руководитель' USING ERRCODE = '42501';
  END IF;
  -- Функция возвращает записанную строку, а читать прайс — отдельное право. Без него
  -- запись упала бы на правилах строк сырым английским текстом про row-level security.
  IF NOT public.app_has_any_permission(ARRAY['price.read', 'finance.read']) THEN
    RAISE EXCEPTION 'Недостаточно прав: менять цены может только тот, кому виден прайс'
      USING ERRCODE = '42501';
  END IF;
  IF p_valid_from IS NULL THEN
    RAISE EXCEPTION 'Укажите дату, с которой действует цена' USING ERRCODE = '22004';
  END IF;
  IF p_amount IS NULL THEN
    RAISE EXCEPTION 'Укажите цену' USING ERRCODE = '22004';
  END IF;
  IF p_amount < 0 THEN
    RAISE EXCEPTION 'Цена не может быть отрицательной' USING ERRCODE = '23514';
  END IF;
  -- В таблице цена с двумя знаками. Округляем до проверки на слишком большую, иначе
  -- 999999999999.994 получило бы отказ, хотя в столбец она прекрасно влезает.
  price := round(p_amount, 2);
  IF price > 999999999999.99 THEN
    RAISE EXCEPTION 'Цена слишком большая' USING ERRCODE = '23514';
  END IF;

  -- Вид работ и категорию проверяем сами: иначе вместо отказа пришёл бы текст внешнего
  -- ключа. Снятые с учёта позиции не отсекаем — по ним тоже правят цены и историю,
  -- а что предлагать в списке, решает экран прайса.
  IF NOT EXISTS (SELECT 1 FROM public.work_types AS w WHERE w.code = p_work_type_code) THEN
    RAISE EXCEPTION 'Вид работ не найден в справочнике' USING ERRCODE = 'P0002';
  END IF;
  IF p_guarantee_category_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.guarantee_categories AS g WHERE g.id = p_guarantee_category_id) THEN
    RAISE EXCEPTION 'Категория гарантии не найдена в справочнике' USING ERRCODE = 'P0002';
  END IF;

  -- Два одновременных сохранения цены по одной позиции идут по очереди: иначе они
  -- столкнулись бы на ограничении EXCLUDE текстом про периоды, а не по-человечески.
  PERFORM pg_advisory_xact_lock(hashtextextended('price_list:' || p_work_type_code || ':' || scope, 0));

  -- Цену прошедшего дня не переписываем. Исправить опечатку тем же числом или поправить
  -- ещё не начавшуюся цену можно, а менять сумму, по которой уже считали счета, нельзя:
  -- прежнего значения потом не найти, журнал изменений денежные поля намеренно вырезает.
  -- Нужна другая цена — её заводят с новой даты, и прошлая остаётся в истории как была.
  IF p_valid_from < (now() AT TIME ZONE 'Europe/Moscow')::date
     AND EXISTS (
       SELECT 1 FROM public.price_list AS was
        WHERE was.work_type_code = p_work_type_code
          AND was.scope_key = scope
          AND was.valid_from = p_valid_from
     ) THEN
    RAISE EXCEPTION 'Цена с этого числа уже действовала, её сумму не переписываем: заведите цену с новой даты'
      USING ERRCODE = '23514';
  END IF;

  PERFORM set_config('app.price_chain', 'on', true);

  -- Исправление цены тем же числом: правим ту же строку, а не плодим вторую. Второй
  -- период с тем же началом всё равно не пустило бы ограничение EXCLUDE, а вместе с
  -- ним откатился бы весь вызов. Автора и дату записи не меняем: период тот же.
  UPDATE public.price_list AS same_day
     SET amount = price,
         include_guarantee_work = guarantee
   WHERE same_day.work_type_code = p_work_type_code
     AND same_day.scope_key = scope
     AND same_day.valid_from = p_valid_from
  RETURNING same_day.* INTO saved;

  IF saved.id IS NULL THEN
    -- Цена и так такая: второго периода с той же суммой заводить не нужно. Иначе
    -- «Сохранить» без единой правки резало бы действующий период надвое, и в истории
    -- появлялись бы две одинаковые записи подряд. Возвращаем ту строку, что уже есть.
    SELECT * INTO saved
      FROM public.price_list AS current_row
     WHERE current_row.work_type_code = p_work_type_code
       AND current_row.scope_key = scope
       AND current_row.valid_from <= p_valid_from
       AND (current_row.valid_to IS NULL OR current_row.valid_to > p_valid_from)
       AND current_row.amount = price
       AND current_row.include_guarantee_work = guarantee;
  END IF;

  IF saved.id IS NULL THEN
    -- Если впереди уже заведена цена, новая действует только до её начала: иначе
    -- периоды пересеклись бы. Период полуоткрытый, «[с, до)».
    SELECT min(ahead.valid_from) INTO next_from
      FROM public.price_list AS ahead
     WHERE ahead.work_type_code = p_work_type_code
       AND ahead.scope_key = scope
       AND ahead.valid_from > p_valid_from;

    -- Прошлая цена закрывается днём начала новой: этот день уже считается по новой цене.
    -- Закрытые раньше периоды не трогаем, даже если между ними и новой ценой есть разрыв.
    UPDATE public.price_list AS past
       SET valid_to = p_valid_from
     WHERE past.work_type_code = p_work_type_code
       AND past.scope_key = scope
       AND past.valid_from < p_valid_from
       AND (past.valid_to IS NULL OR past.valid_to > p_valid_from);

    INSERT INTO public.price_list (
      work_type_code, guarantee_category_id, valid_from, valid_to,
      amount, include_guarantee_work, created_by
    )
    VALUES (p_work_type_code, p_guarantee_category_id, p_valid_from, next_from,
            price, guarantee, auth.uid())
    RETURNING * INTO saved;
  END IF;

  PERFORM set_config('app.price_chain', outer_flag, true);

  RETURN QUERY SELECT saved.id, saved.valid_from, saved.valid_to, saved.amount;
END
$$;

REVOKE ALL ON FUNCTION public.set_work_price(text, uuid, numeric, date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_work_price(text, uuid, numeric, date, boolean) TO authenticated;

COMMENT ON FUNCTION public.set_work_price(text, uuid, numeric, date, boolean) IS
  'Цена вида работ с указанной даты (0031): закрывает прошлый период днём начала новой цены, цену сегодняшним или будущим числом правит в той же строке, перед уже заведённой будущей ценой останавливается её началом. Цену прошедшего дня переписать нельзя, а если цена на эту дату уже ровно такая, новый период не заводится и возвращается существующая строка. Работает с правами вызывающего: нужны price.write и право видеть прайс, автор — вошедший пользователь.';

-- ---------------------------------------------------------------------------
-- 4. Массовое изменение цен
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bulk_update_work_prices(p_items jsonb, p_valid_from date)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  item record;
  changed integer := 0;
BEGIN
  IF NOT public.app_has_permission('price.write') THEN
    RAISE EXCEPTION 'Недостаточно прав: прайс ведёт руководитель' USING ERRCODE = '42501';
  END IF;
  IF NOT public.app_has_any_permission(ARRAY['price.read', 'finance.read']) THEN
    RAISE EXCEPTION 'Недостаточно прав: менять цены может только тот, кому виден прайс'
      USING ERRCODE = '42501';
  END IF;
  IF p_valid_from IS NULL THEN
    RAISE EXCEPTION 'Укажите дату, с которой действуют новые цены' USING ERRCODE = '22004';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Позиции прайса передаются списком' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Выберите хотя бы одну позицию прайса' USING ERRCODE = '23514';
  END IF;

  -- Разбираем список целиком до первой записи: иначе часть цен уже сменилась бы,
  -- а отказ по десятой позиции откатил бы всё, и человек не понял бы, что произошло.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) AS entry
     WHERE jsonb_typeof(entry) IS DISTINCT FROM 'object'
        OR nullif(btrim(coalesce(entry ->> 'work_type_code', '')), '') IS NULL
        OR jsonb_typeof(entry -> 'amount') IS DISTINCT FROM 'number'
  ) THEN
    RAISE EXCEPTION 'В каждой позиции прайса нужен вид работ и цена' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) AS entry
     WHERE coalesce(jsonb_typeof(entry -> 'include_guarantee_work'), 'null') NOT IN ('boolean', 'null')
  ) THEN
    RAISE EXCEPTION 'Пометка про работу по гарантии в позиции прайса должна быть «да» или «нет»'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) AS entry
     WHERE nullif(entry ->> 'guarantee_category_id', '') IS NOT NULL
       AND (entry ->> 'guarantee_category_id')
           !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION 'Категория гарантии в позиции прайса указана неверно' USING ERRCODE = '22023';
  END IF;
  -- Одна позиция дважды в списке — почти всегда ошибка экрана: вторая строка молча
  -- переписала бы цену первой, и в ответе было бы непонятное число изменённых позиций.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) AS entry
     GROUP BY entry ->> 'work_type_code',
              coalesce(nullif(lower(entry ->> 'guarantee_category_id'), ''), '*')
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Одна и та же позиция прайса встречается в списке дважды' USING ERRCODE = '23505';
  END IF;

  -- Код вида работ берём как пришёл, без обрезки пробелов: он приходит из справочника,
  -- а не из набора руками, и правка по одной цене его тоже не нормализует — лучше
  -- понятный отказ «вид работ не найден», чем молчаливое исправление чужих данных.
  FOR item IN
    SELECT entry ->> 'work_type_code' AS work_type_code,
           nullif(entry ->> 'guarantee_category_id', '')::uuid AS guarantee_category_id,
           round((entry ->> 'amount')::numeric, 2) AS amount,
           coalesce((entry ->> 'include_guarantee_work')::boolean, false) AS include_guarantee_work
      FROM jsonb_array_elements(p_items) AS entry
  LOOP
    -- Позицию, где с этого же числа уже стоит ровно та же цена и та же пометка про
    -- гарантию, не трогаем: записи не нужно, а в ответе интерфейсу важно именно число
    -- реально изменённых позиций (экран показывает его после массового изменения).
    -- Условие то же, что в set_work_price: цена, действующая на эту дату, уже такая.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.price_list AS price_row
       WHERE price_row.work_type_code = item.work_type_code
         AND price_row.scope_key = coalesce(item.guarantee_category_id::text, '*')
         AND price_row.valid_from <= p_valid_from
         AND (price_row.valid_to IS NULL OR price_row.valid_to > p_valid_from)
         AND price_row.amount = item.amount
         AND price_row.include_guarantee_work = item.include_guarantee_work
    );
    -- Логика одной цены ровно та же, что при правке по одной: отдельной копии нет.
    -- Отказ по любой позиции откатывает весь вызов — цены меняются целиком или никак.
    PERFORM public.set_work_price(item.work_type_code, item.guarantee_category_id,
                                  item.amount, p_valid_from, item.include_guarantee_work);
    changed := changed + 1;
  END LOOP;

  RETURN changed;
END
$$;

REVOKE ALL ON FUNCTION public.bulk_update_work_prices(jsonb, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bulk_update_work_prices(jsonb, date) TO authenticated;

COMMENT ON FUNCTION public.bulk_update_work_prices(jsonb, date) IS
  'Массовое изменение цен с указанной даты (0031): к каждой позиции списка применяется та же логика, что в set_work_price, всё в одной транзакции. Возвращает число реально изменённых позиций: позиция, где с этого числа уже стоит та же цена и та же пометка про гарантию, не считается. Нужны price.write и право видеть прайс.';

-- ---------------------------------------------------------------------------
-- 5. Отмена ещё не начавшейся цены
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.delete_future_work_price(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  doomed public.price_list%ROWTYPE;
  next_from date;
  -- Сутки по Москве, как просрочка задач в 0027: на стенде сервер базы живёт в UTC,
  -- и по его календарю цена, начавшаяся сегодня утром по Москве, ещё «будущая».
  company_today date := (now() AT TIME ZONE 'Europe/Moscow')::date;
  outer_flag text := coalesce(current_setting('app.price_chain', true), 'off');
BEGIN
  IF NOT public.app_has_permission('price.write') THEN
    RAISE EXCEPTION 'Недостаточно прав: прайс ведёт руководитель' USING ERRCODE = '42501';
  END IF;
  -- Без права смотреть прайс строку не прочитать, и вместо отказа по правам пришло бы
  -- «Цена не найдена»: правила строк просто не показали бы её этому пользователю.
  IF NOT public.app_has_any_permission(ARRAY['price.read', 'finance.read']) THEN
    RAISE EXCEPTION 'Недостаточно прав: менять цены может только тот, кому виден прайс'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO doomed FROM public.price_list AS price_row WHERE price_row.id = p_id;
  IF doomed.id IS NULL THEN
    RAISE EXCEPTION 'Цена не найдена' USING ERRCODE = 'P0002';
  END IF;
  IF doomed.valid_from <= company_today THEN
    RAISE EXCEPTION 'Удалить можно только цену, которая ещё не начала действовать: история цен из прайса не удаляется'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('price_list:' || doomed.work_type_code || ':' || doomed.scope_key, 0));
  -- Пока ждали замок, ту же цену мог отменить другой вызов: молча «успешно» ничего
  -- не делать нельзя, человек должен увидеть тот же отказ, что и при первом промахе.
  IF NOT EXISTS (SELECT 1 FROM public.price_list AS price_row WHERE price_row.id = p_id) THEN
    RAISE EXCEPTION 'Цена не найдена' USING ERRCODE = 'P0002';
  END IF;

  SELECT min(ahead.valid_from) INTO next_from
    FROM public.price_list AS ahead
   WHERE ahead.work_type_code = doomed.work_type_code
     AND ahead.scope_key = doomed.scope_key
     AND ahead.valid_from > doomed.valid_from;

  PERFORM set_config('app.price_chain', 'on', true);

  DELETE FROM public.price_list AS price_row WHERE price_row.id = p_id;

  -- Отменённая цена закрыла прошлый период своим началом. Без неё прошлая цена снова
  -- действует до следующей заведённой цены или бессрочно: иначе с этого дня у вида
  -- работ не осталось бы цены вообще. Закончиться ровно в этот день мог только один
  -- период — пересекающихся не бывает.
  UPDATE public.price_list AS past
     SET valid_to = next_from
   WHERE past.work_type_code = doomed.work_type_code
     AND past.scope_key = doomed.scope_key
     AND past.valid_to = doomed.valid_from;

  PERFORM set_config('app.price_chain', outer_flag, true);
END
$$;

REVOKE ALL ON FUNCTION public.delete_future_work_price(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_future_work_price(uuid) TO authenticated;

COMMENT ON FUNCTION public.delete_future_work_price(uuid) IS
  'Отмена ещё не начавшейся цены (0031): удаляет строку прайса, только если её дата начала позже сегодняшнего дня по Москве, и возвращает прошлой цене её прежнее окончание. Действующую цену и историю не удаляет. Работает с правами вызывающего: нужны price.write и право видеть прайс.';

-- ---------------------------------------------------------------------------
-- 6. Цена, действовавшая на дату
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.work_price_on(
  p_work_type_code text,
  p_guarantee_category_id uuid,
  p_on date
)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  -- Сначала цена для самой категории гарантии, и только если такой строки нет — общая
  -- (scope_key '*'). coalesce годится: ноль ценой тоже бывает, а NULL здесь бывает
  -- только от «строки нет». Больше одной строки ни один из запросов не найдёт —
  -- пересекающиеся периоды по позиции запрещены ограничением EXCLUDE.
  -- Права вызывающего: кому цены не видны по правилам строк, тот получит NULL.
  SELECT coalesce(
    (SELECT exact.amount
       FROM public.price_list AS exact
      WHERE exact.work_type_code = p_work_type_code
        AND exact.scope_key = coalesce(p_guarantee_category_id::text, '*')
        AND exact.valid_from <= p_on
        AND (exact.valid_to IS NULL OR exact.valid_to > p_on)),
    (SELECT common.amount
       FROM public.price_list AS common
      WHERE common.work_type_code = p_work_type_code
        AND common.scope_key = '*'
        AND common.valid_from <= p_on
        AND (common.valid_to IS NULL OR common.valid_to > p_on))
  )
$$;

REVOKE ALL ON FUNCTION public.work_price_on(text, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.work_price_on(text, uuid, date) TO authenticated;

COMMENT ON FUNCTION public.work_price_on(text, uuid, date) IS
  'Цена вида работ, действовавшая на дату (0031): сначала строка по категории гарантии, если её нет — строка «для всех». Работает с правами вызывающего: кому прайс не виден, тот получит NULL.';

NOTIFY pgrst, 'reload schema';
