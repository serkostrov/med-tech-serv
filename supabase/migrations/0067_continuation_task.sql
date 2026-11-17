-- Продолжение работ в счёт первичной заявки создаёт связанную задачу (ТЗ 3.3).
--
-- Что было не так. В акте есть галочка «работа будет продолжена в счёт первичной заявки»,
-- и по ТЗ она создаёт связанную задачу. Галочка сохранялась, связь «первичная —
-- продолжение» в базе была (primary_task_id, одно продолжение на задачу, 0001 раздел 0034),
-- карточка задачи её показывала — но саму задачу-продолжение никто не заводил.
-- Координатор закрывал задачу, и продолжение терялось, если его не завели руками.
--
-- Что делаем. Когда задача с этой галочкой становится «Закрытой» (координатор принял акт),
-- база сама заводит задачу-продолжение:
--   * тот же прибор, площадка, плательщик, контакт, вид работ, срочность, гарантия, договор;
--   * тот же инженер — задача сразу «Назначена»; без инженера — «Новая»;
--   * срок: с сегодняшнего дня по Москве на неделю, координатор поправит;
--   * в причине вызова — откуда продолжение и рекомендации из акта первичной задачи;
--   * primary_task_id — первичная задача. Второе продолжение к той же задаче не заводится.
-- Уведомления о новой задаче уходят как обычно (заявка принята, инженер назначен).
-- Миграцию можно применить повторно.

CREATE OR REPLACE FUNCTION public.create_continuation_task()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  today date := public.company_today();
  reason text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.tasks AS t WHERE t.primary_task_id = NEW.id) THEN
    RETURN NULL;
  END IF;
  reason := 'Продолжение работ по задаче ' || NEW.number
    || coalesce('. Рекомендации из акта: ' || nullif(btrim(NEW.recommendations), ''), '');

  INSERT INTO public.tasks (
    title, work_type_code, extra_work_type_codes, priority, work_modifier, status_code,
    equipment_id, site_id, site_contact_id, initiator_contact_id, payer_id, contract_id,
    engineer_id, deadline_from, deadline_to, call_date, call_reason, primary_task_id, created_by
  ) VALUES (
    left('Продолжение ' || NEW.number || ': ' || NEW.title, 200),
    NEW.work_type_code, NEW.extra_work_type_codes, NEW.priority, NEW.work_modifier,
    CASE WHEN NEW.engineer_id IS NULL THEN 'new' ELSE 'assigned' END,
    NEW.equipment_id, NEW.site_id, NEW.site_contact_id, NEW.initiator_contact_id, NEW.payer_id, NEW.contract_id,
    NEW.engineer_id, today, today + 7, today, reason, NEW.id,
    coalesce(auth.uid(), NEW.created_by)
  );
  RETURN NULL;
END
$$;

REVOKE EXECUTE ON FUNCTION public.create_continuation_task() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.create_continuation_task() IS
  'Закрытие задачи с галочкой «продолжение в счёт первичной заявки» заводит связанную задачу-продолжение (0067).';

DROP TRIGGER IF EXISTS tasks_create_continuation ON public.tasks;
CREATE TRIGGER tasks_create_continuation
  AFTER UPDATE OF status_code ON public.tasks
  FOR EACH ROW
  WHEN (NEW.status_code = 'closed' AND OLD.status_code IS DISTINCT FROM 'closed' AND NEW.continued_in_primary)
  EXECUTE FUNCTION public.create_continuation_task();
