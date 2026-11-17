-- Прайс без категорий гарантии и без нулевых цен (аудит 17.11.2026, находки 39 и 65).
--
-- Что было не так.
--   1. На встрече 16.11 категорию гарантии убрали из паспорта прибора: гарантия
--      «плавающая», её проверяют у производителя по каждой заявке. Но счёт по-прежнему
--      искал цену сначала по категории прибора (0031, 0040, 0060). Категорию теперь
--      нельзя ни увидеть, ни поменять, а новому прибору она ставится сама — и счёт мог
--      выйти по цене категории, и никто бы не понял почему.
--   2. Цену можно было сделать нулевой. Строка работы с нулём уходила клиенту бесплатно,
--      хотя бесплатную работу отмечают гарантией в задаче.
--
-- Что делаем.
--   1. work_price_on и invoice_work_billable берут только цену «для всех» (scope '*').
--      Подписи функций прежние: их вызывают сборка счёта (0060) и проверки.
--   2. Страж price_list: новая цена — больше нуля и без категории гарантии. Старые строки
--      категорий не трогаем: они остаются в истории, закрывать их периоды можно.
--
-- Колонка guarantee_category_id остаётся: ТЗ просит заложить цены по категориям, если
-- заказчик о них попросит. Тогда вернуть их — правка этих двух функций и стража.
-- Миграцию можно применить повторно.

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
  SELECT common.amount
    FROM public.price_list AS common
   WHERE common.work_type_code = p_work_type_code
     AND common.scope_key = '*'
     AND common.valid_from <= p_on
     AND (common.valid_to IS NULL OR common.valid_to > p_on)
$$;

COMMENT ON FUNCTION public.work_price_on(text, uuid, date) IS
  'Цена вида работ, действовавшая на дату: цена «для всех» (0063). Категорию гарантии не учитываем — её с 17.11 не ведут в паспорте прибора; параметр оставлен ради прежних вызовов. Права вызывающего: кому прайс не виден, тот получит NULL.';

CREATE OR REPLACE FUNCTION public.invoice_work_billable(
  p_modifier public.work_modifier,
  p_work_type_code text,
  p_guarantee_category_id uuid,
  p_on date
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_modifier IS DISTINCT FROM 'G'::public.work_modifier THEN true
    ELSE coalesce(
      (SELECT common.include_guarantee_work
         FROM public.price_list AS common
        WHERE common.work_type_code = p_work_type_code
          AND common.scope_key = '*'
          AND common.valid_from <= p_on
          AND (common.valid_to IS NULL OR common.valid_to > p_on)),
      false)
  END
$$;

COMMENT ON FUNCTION public.invoice_work_billable(public.work_modifier, text, uuid, date) IS
  'ПРЕДПОЛОЖЕНИЕ (0040, ждёт созвона с бухгалтерией): идёт ли работа в сумму счёта. Негарантийная — всегда; гарантийная («Г») — только если у действующей цены «для всех» include_guarantee_work = true (0063: без категорий гарантии). Правило одно на всю базу.';

CREATE OR REPLACE FUNCTION public.guard_price_list_values()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.amount <= 0 THEN
    RAISE EXCEPTION 'Цена должна быть больше нуля: работу, за которую клиент не платит, отмечают гарантией в задаче, а не нулевой ценой'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.guarantee_category_id IS NOT NULL THEN
    RAISE EXCEPTION 'Цены по категориям гарантии не ведутся: категорию гарантии не отмечают в паспорте прибора, цена одна для всех приборов'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.guard_price_list_values() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.guard_price_list_values() IS
  'Страж прайса (0063): новая цена больше нуля и без категории гарантии. Закрытие периода прошлой цены (valid_to) страж не трогает.';

DROP TRIGGER IF EXISTS price_list_values_valid ON public.price_list;
CREATE TRIGGER price_list_values_valid
  BEFORE INSERT OR UPDATE OF amount, guarantee_category_id ON public.price_list
  FOR EACH ROW EXECUTE FUNCTION public.guard_price_list_values();

NOTIFY pgrst, 'reload schema';
