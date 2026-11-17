-- Акт во вложении письма «Работы завершены» (ТЗ 4.2).
--
-- Что было не так. Письмо «Работы завершены» уходит клиенту, когда координатор принял акт
-- и задача закрылась (0018), но сам акт к письму не прикладывался: клиент видел только
-- текст и ссылку, а подписанный акт координатор пересылал руками.
--
-- Что делаем. Служба уведомлений по номеру события узнаёт файл принятого акта задачи
-- (task_closures.act_file_id) и прикладывает его к письму. Сам файл служба берёт из
-- хранилища ключом сервиса; база отдаёт только его ключ, имя, тип и размер.
-- Только для события task_work_completed: в остальных письмах акта нет.
-- Миграцию можно применить повторно.

CREATE OR REPLACE FUNCTION public.task_act_for_event(p_event_id uuid)
RETURNS TABLE (task_number text, storage_key text, original_name text, content_type text, byte_size bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT task.number::text, act.storage_key, act.original_name, act.content_type, act.byte_size
    FROM public.integration_outbox AS event
    JOIN public.tasks AS task ON task.id = event.aggregate_id
    JOIN public.task_closures AS closure ON closure.task_id = task.id
    JOIN public.files AS act ON act.id = closure.act_file_id AND act.kind = 'act'
   WHERE event.id = p_event_id
     AND event.aggregate_type = 'task'
     AND event.event_type = 'task_work_completed'
$$;

REVOKE EXECUTE ON FUNCTION public.task_act_for_event(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.task_act_for_event(uuid) TO medtech_worker;
COMMENT ON FUNCTION public.task_act_for_event(uuid) IS
  'Файл принятого акта для письма «Работы завершены» (0068): ключ в хранилище, имя, тип, размер. Только для службы уведомлений.';
