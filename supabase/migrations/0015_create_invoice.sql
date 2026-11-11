-- Создание счёта одной операцией и честный автор замены плательщика.
--
-- 1. Интерфейс создавал счёт и привязывал задачи двумя запросами. Если привязка
--    падала, в базе оставался пустой черновик, который нельзя удалить из интерфейса.
--    Теперь create_invoice делает всё в одной транзакции: либо счёт с задачами, либо ничего.
-- 2. Право на замену плательщика проверялось по старой таблице role_permissions и по
--    сотруднику, которого прислал клиент. Теперь автор замены всегда вошедший
--    пользователь, а право — payer.override из матрицы ролей (access_role_permissions).

-- Право на замену плательщика: для запросов из интерфейса — по текущему пользователю.
CREATE OR REPLACE FUNCTION public.actor_can_override_payer(p_actor_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN auth.uid() IS NOT NULL THEN
      p_actor_id = auth.uid() AND public.app_has_permission('payer.override')
    ELSE
      -- Служебные операции без пользователя (импорт, миграции): прежняя проверка.
      EXISTS (
        SELECT 1
          FROM public.users AS actor
          JOIN public.role_permissions AS permission
            ON permission.role = actor.role
           AND permission.permission_code = 'payer.override'
         WHERE actor.id = p_actor_id
           AND actor.is_active
      )
  END
$$;

-- Автор замены плательщика — тот, кто вошёл, а не тот, кого прислал клиент.
-- Имя с aa_: срабатывает раньше заполнения снимка плательщика.
CREATE OR REPLACE FUNCTION public.set_payer_override_author()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NOT NULL
     AND NEW.payer_overridden_by IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.payer_overridden_by IS DISTINCT FROM OLD.payer_overridden_by) THEN
    NEW.payer_overridden_by := auth.uid();
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS invoices_aa_override_author ON public.invoices;
CREATE TRIGGER invoices_aa_override_author
  BEFORE INSERT OR UPDATE OF payer_overridden_by ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.set_payer_override_author();

DROP TRIGGER IF EXISTS tasks_aa_override_author ON public.tasks;
CREATE TRIGGER tasks_aa_override_author
  BEFORE INSERT OR UPDATE OF payer_overridden_by ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_payer_override_author();

-- Счёт по закрытым задачам одной транзакцией. Выполняется с правами вызывающего:
-- создать может только тот, у кого есть finance.write (правила строк invoices).
CREATE OR REPLACE FUNCTION public.create_invoice(
  p_payer_id uuid,
  p_task_ids uuid[],
  p_payer_override_reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  source_equipment uuid;
  invoice_id uuid;
  reason text := nullif(btrim(coalesce(p_payer_override_reason, '')), '');
BEGIN
  IF p_payer_id IS NULL THEN
    RAISE EXCEPTION 'Выберите плательщика' USING ERRCODE = '23514';
  END IF;
  IF p_task_ids IS NULL OR cardinality(p_task_ids) = 0 THEN
    RAISE EXCEPTION 'Выберите хотя бы одну закрытую задачу' USING ERRCODE = '23514';
  END IF;
  IF (SELECT count(*) FROM public.tasks WHERE id = ANY (p_task_ids)) <> cardinality(ARRAY(SELECT DISTINCT unnest(p_task_ids))) THEN
    RAISE EXCEPTION 'Задачи счёта не найдены или недоступны' USING ERRCODE = '42501';
  END IF;

  -- Прибор-источник снимка: сначала тот, чей плательщик совпадает с выбранным,
  -- затем любой с плательщиком. Порядок задан, результат не зависит от запроса.
  SELECT task.equipment_id INTO source_equipment
    FROM public.tasks AS task
    JOIN public.equipment AS equipment ON equipment.id = task.equipment_id
   WHERE task.id = ANY (p_task_ids)
     AND equipment.current_payer_id IS NOT NULL
   ORDER BY (equipment.current_payer_id = p_payer_id) DESC, task.id
   LIMIT 1;
  IF source_equipment IS NULL THEN
    RAISE EXCEPTION 'У приборов выбранных задач не указан плательщик' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.invoices (payer_id, status, source_equipment_id, payer_override_reason, payer_overridden_by)
  VALUES (p_payer_id, 'draft', source_equipment, reason, CASE WHEN reason IS NULL THEN NULL ELSE auth.uid() END)
  RETURNING id INTO invoice_id;

  INSERT INTO public.invoice_tasks (invoice_id, task_id)
  SELECT invoice_id, task_id FROM (SELECT DISTINCT unnest(p_task_ids) AS task_id) AS selected;

  -- Отложенная проверка снимка срабатывает сейчас, а не при завершении запроса:
  -- ошибка откатит и счёт, и привязки, и придёт понятным сообщением.
  SET CONSTRAINTS invoice_tasks_payer_snapshot_valid IMMEDIATE;
  RETURN invoice_id;
END
$$;

REVOKE ALL ON FUNCTION public.create_invoice(uuid, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invoice(uuid, uuid[], text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.set_payer_override_author() FROM PUBLIC, anon, authenticated;
-- actor_can_override_payer вызывается из триггеров снимка с правами вызывающего.
REVOKE ALL ON FUNCTION public.actor_can_override_payer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.actor_can_override_payer(uuid) TO authenticated;
