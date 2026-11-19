-- 0075. Удаление вида работ — руководителю и администратору (вторая встреча 18.11.2026).
--
-- Что было. Вид работ в справочнике можно было только скрыть. Добавленный по ошибке или
-- для пробы вид так и оставался в справочнике и в прайсе.
--
-- Что стало. Функция delete_work_type удаляет вид работ, если он нигде не использован:
-- ни в задачах (основным или дополнительным видом), ни в плане ТО, ни в счетах, ни в КП.
-- Использованный вид работ удалить нельзя — он держит историю, его можно только скрыть;
-- отказ говорит, где он встречается. Цены неиспользованного вида работ ни на что не
-- влияли и уходят вместе с ним. Встроенные виды («ТО по сервисной документации», «Прочие
-- работы») не удаляются (0033). Удаляют руководитель и администратор с правом вести
-- справочники: у координатора это право тоже есть, но удаление ему не нужно.

CREATE OR REPLACE FUNCTION public.app_can_delete_work_types()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.app_has_permission('references.write') AND EXISTS (
    SELECT 1
      FROM public.users AS u
      LEFT JOIN public.access_roles AS r ON r.key = u.access_role_key
     WHERE u.id = auth.uid()
       AND u.is_active
       AND coalesce(r.base_role::text, u.role::text) IN ('admin', 'supervisor')
  );
$$;

COMMENT ON FUNCTION public.app_can_delete_work_types() IS
  'Удалять виды работ могут руководитель и администратор с правом вести справочники (0075).';

REVOKE ALL ON FUNCTION public.app_can_delete_work_types() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.app_can_delete_work_types() TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_work_type(p_code text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  kind public.work_types%ROWTYPE;
  used_tasks integer;
  used_plans integer;
  used_invoices integer;
  used_quotes integer;
  places text[] := '{}';
BEGIN
  IF NOT public.app_can_delete_work_types() THEN
    RAISE EXCEPTION 'Удалять виды работ могут только руководитель и администратор'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO kind FROM public.work_types WHERE code = p_code FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Вид работ не найден: возможно, его уже удалили'
      USING ERRCODE = 'P0002';
  END IF;
  IF kind.is_builtin THEN
    RAISE EXCEPTION 'Вид работ «%» встроен в работу системы: удалить его нельзя', kind.name
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO used_tasks FROM public.tasks
   WHERE work_type_code = p_code OR p_code = ANY (extra_work_type_codes);
  SELECT count(*) INTO used_plans FROM public.maintenance_plans WHERE work_type_code = p_code;
  SELECT count(*) INTO used_invoices FROM public.invoice_items WHERE work_type_code = p_code;
  SELECT count(*) INTO used_quotes FROM public.quote_items WHERE work_type_code = p_code;

  IF used_tasks > 0 THEN places := places || format('в задачах: %s', used_tasks); END IF;
  IF used_plans > 0 THEN places := places || format('в плане ТО: %s', used_plans); END IF;
  IF used_invoices > 0 THEN places := places || format('в строках счетов: %s', used_invoices); END IF;
  IF used_quotes > 0 THEN places := places || format('в строках КП: %s', used_quotes); END IF;
  IF cardinality(places) > 0 THEN
    RAISE EXCEPTION 'Вид работ «%» уже использован (%): удалить нельзя, его можно только скрыть',
      kind.name, array_to_string(places, ', ')
      USING ERRCODE = '23503';
  END IF;

  -- Цены неиспользованного вида работ ни в один счёт не попали: убираем вместе с ним.
  -- Прямую запись в прайс страж 0031 пускает только с этим флагом, он живёт до конца транзакции.
  PERFORM set_config('app.price_chain', 'on', true);
  DELETE FROM public.price_list WHERE work_type_code = p_code;
  PERFORM set_config('app.price_chain', 'off', true);

  DELETE FROM public.work_types WHERE code = p_code;
END
$$;

COMMENT ON FUNCTION public.delete_work_type(text) IS
  'Удалить вид работ (0075): только неиспользованный и не встроенный, руководитель или администратор. Цены уходят вместе с ним.';

REVOKE ALL ON FUNCTION public.delete_work_type(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_work_type(text) TO authenticated;

-- Напрямую строку вида работ не удалить никому: только функцией, которая проверяет, где он
-- использован (дополнительные виды работ задачи лежат массивом, внешний ключ их не держит).
DROP POLICY IF EXISTS role_delete ON public.work_types;
