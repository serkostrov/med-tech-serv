-- Автор действий, защита деловых записей от удаления и задача только в одном счёте.
--
-- 1. Автор в журнале аудита, корректировках и истории статусов счёта.
--    current_app_user_id() брал автора только из app.user_id, а с Supabase это значение
--    никто не задаёт: вход приходит токеном (auth.uid()). Поэтому журнал аудита записывал
--    вместо сотрудника автора из полей записи (у задачи — её создателя) или «систему»
--    (у прибора), корректировка суммы счёта из интерфейса падала с «обязателен автор»,
--    а в истории статусов счёта стоял его создатель.
--    Теперь автор — сотрудник, вошедший в CRM (auth.uid() из токена входа, его нельзя
--    подставить), если он есть среди сотрудников. Без входа (служба уведомлений, импорт,
--    миграции) автор, как раньше, из app.user_id (тоже только существующий сотрудник);
--    нет и его — из полей записи или «система».
-- 2. Деловые записи через API безвозвратно не удаляются: задачу отменяют, прибор
--    списывают (статус «Списан»), площадку, контакт, плательщика и сотрудника отключают,
--    счёт отменяют. Задачи и строки счёта меняются только пока счёт — черновик.
--    Журнал корректировок счёта пишет только триггер. Замена запчастей задачи и плана ТО,
--    отвязка плательщика от площадки, матрица прав и файлы открытых задач работают как раньше.
-- 3. Закрытая задача входит не больше чем в один действующий (не отменённый) счёт.
--    Отмена счёта освобождает его задачи. Строка счёта ссылается только на задачу этого счёта.
--
-- Служебные функции, как все триггеры (0009), работают от владельца схемы:
-- CREATE OR REPLACE сбрасывает это свойство, поэтому оно задано здесь же.
-- Миграцию можно применить повторно.

-- ---------------------------------------------------------------------------
-- 0. Проверка до изменений: задача уже в нескольких действующих счетах
-- ---------------------------------------------------------------------------

-- Уникальность (п. 3) не создать, пока такие задачи есть. Называем их, счета и статусы,
-- чтобы лишнее убрали до повторного запуска.
DO $$
DECLARE
  duplicates text;
BEGIN
  SELECT string_agg(format('%s — %s', dup.task_number, dup.invoices), '; ' ORDER BY dup.task_number)
    INTO duplicates
    FROM (
      SELECT coalesce(task.number, link.task_id::text) AS task_number,
             string_agg(format('%s (%s)', invoice.number, CASE invoice.status
                 WHEN 'draft' THEN 'черновик'
                 WHEN 'issued' THEN 'выставлен'
                 WHEN 'transferred_to_1c' THEN 'передан в 1С'
                 ELSE invoice.status::text
               END), ', ' ORDER BY invoice.number) AS invoices
        FROM public.invoice_tasks AS link
        JOIN public.invoices AS invoice ON invoice.id = link.invoice_id
        LEFT JOIN public.tasks AS task ON task.id = link.task_id
       WHERE invoice.status <> 'cancelled'
       GROUP BY link.task_id, task.number
      HAVING count(*) > 1
    ) AS dup;
  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION 'Миграция 0024 не применена: задачи входят сразу в несколько действующих счетов: %. Оставьте каждую задачу в одном счёте и запустите миграцию снова. Черновик и выставленный счёт можно отменить (status = ''cancelled''). Счёт, переданный в 1С, отменить нельзя: после сверки с бухгалтерией уберите из него задачу (DELETE FROM invoice_tasks WHERE invoice_id = <id счёта> AND task_id = <id задачи>).', duplicates
      USING ERRCODE = '23505';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. Автор действия
-- ---------------------------------------------------------------------------

-- Кто сделал изменение. Используется журналом аудита (write_audit_row → audit_actor_from_row,
-- append_audit_event), историей места и плательщика прибора, корректировками счёта
-- и историей статусов счёта. Функция с правами вызывающего, как и была.
CREATE OR REPLACE FUNCTION public.current_app_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(
    -- Вошедший сотрудник.
    (SELECT u.id FROM public.users AS u WHERE u.id = auth.uid()),
    -- Служебная операция без входа: автора задаёт сама служба.
    (SELECT u.id FROM public.users AS u
      WHERE u.id = CASE
        WHEN current_setting('app.user_id', true) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN current_setting('app.user_id', true)::uuid
      END)
  )
  -- Только тот, кто есть среди сотрудников: автора пишут в поля со ссылкой на users,
  -- ссылка на несуществующего сломала бы само изменение.
$$;

-- История статусов счёта: смену записываем на того, кто её сделал. Без входа и без
-- автора службы — «система», а не создатель счёта: этот статус менял не он.
CREATE OR REPLACE FUNCTION public.record_invoice_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  actor uuid := public.current_app_user_id();
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.invoice_status_history (invoice_id, from_status, to_status, changed_by)
    VALUES (NEW.id, NULL, NEW.status, coalesce(actor, NEW.created_by));
  ELSIF NEW.status <> OLD.status THEN
    INSERT INTO public.invoice_status_history (invoice_id, from_status, to_status, changed_by)
    VALUES (NEW.id, OLD.status, NEW.status, actor);
  END IF;
  RETURN NEW;
END
$$;

-- Вызывать её напрямую никому не нужно: только как триггер (0020).
REVOKE EXECUTE ON FUNCTION public.record_invoice_status_transition() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Деловые записи не удаляются через API
-- ---------------------------------------------------------------------------

-- Удаление стёрло бы историю: каскадом уходят история статусов, резервы, акты, фото,
-- строки и история счёта, а ссылки задач на прибор, площадку, контакт и договор
-- обнулились бы. Вместо удаления: задачу — отменить, прибор — списать, площадку,
-- контакт, плательщика и сотрудника — отключить, счёт и договор — отменить, КП — отклонить.
-- Владелец схемы (postgres) при необходимости удаляет запись вручную.
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'tasks', 'task_closures', 'equipment', 'equipment_history',
    'invoices', 'invoice_adjustments', 'contracts', 'quotes',
    'organizations', 'sites', 'site_contacts', 'payers', 'users'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS role_delete ON public.%I', tbl);
    EXECUTE format('REVOKE DELETE ON TABLE public.%I FROM PUBLIC, anon, authenticated', tbl);
    -- Без правила удаления и с включёнными правилами строк удалить нельзя, даже если право
    -- DELETE выдал другой владелец (такое REVOKE не снимает, а только предупреждает).
    IF NOT (SELECT c.relrowsecurity FROM pg_class AS c WHERE c.oid = format('public.%I', tbl)::regclass) THEN
      RAISE EXCEPTION 'Миграция 0024: у таблицы % выключены правила строк (RLS), удаление не закрыть', tbl;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies AS p WHERE p.schemaname = 'public' AND p.tablename = tbl AND p.cmd IN ('DELETE', 'ALL')) THEN
      RAISE EXCEPTION 'Миграция 0024: у таблицы % осталось правило удаления', tbl;
    END IF;
    IF has_table_privilege('authenticated', format('public.%I', tbl), 'DELETE')
       OR has_table_privilege('anon', format('public.%I', tbl), 'DELETE') THEN
      RAISE WARNING 'Миграция 0024: право DELETE на % у ролей API не снято (его выдал другой владелец). Удаление всё равно закрыто правилами строк.', tbl;
    END IF;
  END LOOP;
END
$$;

-- Журнал корректировок счёта пишет только триггер record_invoice_financial_correction:
-- добавить запись с чужим автором или поправить её через API нельзя.
DROP POLICY IF EXISTS role_insert ON public.invoice_adjustments;
DROP POLICY IF EXISTS role_update ON public.invoice_adjustments;
REVOKE INSERT, UPDATE ON TABLE public.invoice_adjustments FROM PUBLIC, anon, authenticated;

-- Задачи и строки счёта меняются только в черновике. Выставленный, переданный в 1С
-- или отменённый счёт не перестраивается: исправление — отмена и новый счёт
-- (или корректировка суммы с причиной).
DO $$
DECLARE
  tbl text;
  draft_only text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['invoice_tasks', 'invoice_items'] LOOP
    draft_only := format(
      '((SELECT public.app_has_permission(''finance.write'')) AND EXISTS ('
        || 'SELECT 1 FROM public.invoices AS parent WHERE parent.id = %I.invoice_id AND parent.status = ''draft''))',
      tbl);
    EXECUTE format('DROP POLICY IF EXISTS role_insert ON public.%I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS role_update ON public.%I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS role_delete ON public.%I', tbl);
    EXECUTE format('CREATE POLICY role_insert ON public.%I FOR INSERT TO authenticated WITH CHECK %s', tbl, draft_only);
    EXECUTE format('CREATE POLICY role_update ON public.%I FOR UPDATE TO authenticated USING %s WITH CHECK %s', tbl, draft_only, draft_only);
    EXECUTE format('CREATE POLICY role_delete ON public.%I FOR DELETE TO authenticated USING %s', tbl, draft_only);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Задача — не больше чем в одном действующем счёте
-- ---------------------------------------------------------------------------

-- Счёт связи не отменён: задача занята этим счётом. Значение ведёт база.
ALTER TABLE public.invoice_tasks
  ADD COLUMN IF NOT EXISTS invoice_active boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN public.invoice_tasks.invoice_active IS
  'Счёт не отменён: задача занята этим счётом. Ведут триггеры по статусу счёта, из запроса не задаётся.';

-- Проверка снимка плательщика нужна при привязке задачи к счёту, а не при отметке
-- об отмене счёта: иначе старый счёт нельзя было бы отменить после смены плательщика прибора.
DROP TRIGGER IF EXISTS invoice_tasks_payer_snapshot_valid ON public.invoice_tasks;
CREATE CONSTRAINT TRIGGER invoice_tasks_payer_snapshot_valid
  AFTER INSERT OR UPDATE OF invoice_id, task_id ON public.invoice_tasks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_invoice_task_payer_snapshot();

-- Отметка всегда по статусу счёта. Задачу, которая уже в действующем счёте,
-- в другой действующий счёт не добавить: понятная ошибка с номерами.
CREATE OR REPLACE FUNCTION public.set_invoice_task_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  active boolean;
  old_invoice uuid;
  old_task uuid;
  busy_task text;
  busy_invoice text;
BEGIN
  -- С блокировкой строки счёта: одновременная отмена этого счёта дождётся привязки
  -- и освободит и её, а привязка к отменяемому счёту увидит отмену.
  SELECT invoice.status <> 'cancelled' INTO active
    FROM public.invoices AS invoice
   WHERE invoice.id = NEW.invoice_id
     FOR SHARE;
  NEW.invoice_active := coalesce(active, true);
  IF TG_OP = 'UPDATE' THEN
    old_invoice := OLD.invoice_id;
    old_task := OLD.task_id;
  END IF;
  IF NEW.invoice_active THEN
    SELECT task.number, invoice.number
      INTO busy_task, busy_invoice
      FROM public.invoice_tasks AS other
      JOIN public.invoices AS invoice ON invoice.id = other.invoice_id
      LEFT JOIN public.tasks AS task ON task.id = other.task_id
     WHERE other.task_id = NEW.task_id
       AND other.invoice_active
       AND other.invoice_id <> NEW.invoice_id
       -- Перенос связи в другой черновик: прежняя версия этой же строки не в счёт.
       AND NOT (other.invoice_id IS NOT DISTINCT FROM old_invoice AND other.task_id IS NOT DISTINCT FROM old_task)
     LIMIT 1;
    IF busy_invoice IS NOT NULL THEN
      RAISE EXCEPTION 'Задача % уже есть в счёте %. Одна задача входит только в один счёт: чтобы выставить её заново, сначала отмените тот счёт.',
        coalesce(busy_task, NEW.task_id::text), busy_invoice
        USING ERRCODE = '23505', CONSTRAINT = 'invoice_tasks_one_active_invoice';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS invoice_tasks_aa_activity ON public.invoice_tasks;
CREATE TRIGGER invoice_tasks_aa_activity
  BEFORE INSERT OR UPDATE ON public.invoice_tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_invoice_task_activity();

-- Отмена счёта освобождает его задачи.
CREATE OR REPLACE FUNCTION public.sync_invoice_task_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.invoice_tasks
     SET invoice_active = (NEW.status <> 'cancelled')
   WHERE invoice_id = NEW.id
     AND invoice_active IS DISTINCT FROM (NEW.status <> 'cancelled');
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS invoices_task_activity ON public.invoices;
CREATE TRIGGER invoices_task_activity
  AFTER UPDATE OF status ON public.invoices
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION public.sync_invoice_task_activity();

-- Строка счёта по задаче — только по задаче этого же счёта, иначе одну задачу можно было бы
-- выставить второй раз строкой в другом счёте. Пока по задаче есть строки счёта, убрать
-- задачу из счёта нельзя.
CREATE OR REPLACE FUNCTION public.validate_invoice_item_task()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.task_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.invoice_tasks AS link
        WHERE link.invoice_id = NEW.invoice_id AND link.task_id = NEW.task_id) THEN
    RAISE EXCEPTION 'Строка счёта ссылается на задачу, которой нет в этом счёте. Сначала добавьте задачу в счёт.'
      USING ERRCODE = '23514', CONSTRAINT = 'invoice_items_task_in_invoice';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS invoice_items_task_in_invoice ON public.invoice_items;
CREATE TRIGGER invoice_items_task_in_invoice
  BEFORE INSERT OR UPDATE OF invoice_id, task_id ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public.validate_invoice_item_task();

CREATE OR REPLACE FUNCTION public.guard_invoice_task_items()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.invoice_id = OLD.invoice_id AND NEW.task_id = OLD.task_id THEN
    RETURN NEW;
  END IF;
  -- Счёт удаляет владелец схемы целиком: строки и связи уходят вместе с ним.
  IF EXISTS (SELECT 1 FROM public.invoices AS invoice WHERE invoice.id = OLD.invoice_id)
     AND EXISTS (SELECT 1 FROM public.invoice_items AS item
                  WHERE item.invoice_id = OLD.invoice_id AND item.task_id = OLD.task_id) THEN
    RAISE EXCEPTION 'По этой задаче в счёте есть строки: сначала уберите их, потом задачу из счёта.'
      USING ERRCODE = '23503', CONSTRAINT = 'invoice_items_task_in_invoice';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS invoice_tasks_items_guard ON public.invoice_tasks;
CREATE TRIGGER invoice_tasks_items_guard
  BEFORE DELETE OR UPDATE OF invoice_id, task_id ON public.invoice_tasks
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_task_items();

REVOKE EXECUTE ON FUNCTION public.set_invoice_task_activity() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_invoice_task_activity() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_invoice_item_task() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.guard_invoice_task_items() FROM PUBLIC, anon, authenticated;

-- Связи уже отменённых счетов задачу не занимают.
UPDATE public.invoice_tasks AS link
   SET invoice_active = false
  FROM public.invoices AS invoice
 WHERE invoice.id = link.invoice_id
   AND invoice.status = 'cancelled'
   AND link.invoice_active;

-- Гарантия базы, в том числе для одновременных запросов.
CREATE UNIQUE INDEX IF NOT EXISTS invoice_tasks_one_active_invoice_uq
  ON public.invoice_tasks (task_id)
  WHERE invoice_active;

-- Счёт по закрытым задачам (0015) с понятной ошибкой, если задача уже в другом счёте.
-- Как и раньше, с правами вызывающего: создать может только тот, у кого finance.write.
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
  busy text;
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

  -- Задача входит только в один действующий счёт: называем занятые задачи и их счета.
  SELECT string_agg(format('%s (счёт %s)', task.number, invoice.number), ', ' ORDER BY task.number)
    INTO busy
    FROM public.invoice_tasks AS link
    JOIN public.invoices AS invoice ON invoice.id = link.invoice_id
    JOIN public.tasks AS task ON task.id = link.task_id
   WHERE link.task_id = ANY (p_task_ids)
     AND link.invoice_active;
  IF busy IS NOT NULL THEN
    RAISE EXCEPTION 'Эти задачи уже есть в действующих счетах: %. Одна задача входит только в один счёт: чтобы выставить её заново, сначала отмените прежний счёт.', busy
      USING ERRCODE = '23505';
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

  BEGIN
    INSERT INTO public.invoice_tasks (invoice_id, task_id)
    SELECT invoice_id, task_id FROM (SELECT DISTINCT unnest(p_task_ids) AS task_id) AS selected;
  EXCEPTION WHEN unique_violation THEN
    -- Другой сотрудник только что выставил счёт по этой же задаче.
    RAISE EXCEPTION 'Задачу только что включили в другой счёт. Выберите задачи заново.'
      USING ERRCODE = '23505';
  END;

  -- Отложенная проверка снимка срабатывает сейчас, а не при завершении запроса:
  -- ошибка откатит и счёт, и привязки, и придёт понятным сообщением.
  SET CONSTRAINTS invoice_tasks_payer_snapshot_valid IMMEDIATE;
  RETURN invoice_id;
END
$$;

REVOKE ALL ON FUNCTION public.create_invoice(uuid, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invoice(uuid, uuid[], text) TO authenticated;

NOTIFY pgrst, 'reload schema';
