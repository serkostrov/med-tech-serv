-- Журнал изменений: представление для экрана «Журналы» (ТЗ 6.3).
--
-- Зачем. Журнал аудита пишется с самого начала (write_audit_row, append_audit_event),
-- а с 0024 в нём верный автор. Но посмотреть его можно было только запросом к базе:
-- в интерфейсе журнала нет. Экрану нужно «кто, что, когда и как изменил» одной строкой,
-- с фильтрами и постранично, а записей на стенде будут десятки тысяч — значит отбор,
-- счёт и порядок делает база, а не браузер.
--
-- Почему представление, а не функция. Правило строк на audit_log уже есть (0009):
-- журнал читает только право «Просмотр аудита» (audit.read). Представление с
-- security_invoker = true работает правами вызывающего, то есть это же правило строк
-- и проверяет — права остаются в базе, а PostgREST сам умеет фильтры, count и range.
--
-- Что добавлено к таблице:
--   * имя автора (audit_log ссылку на users не держит: автор — исторический id, 0010),
--   * имя таблицы из metadata отдельным полем: «объект» в фильтре это тип сущности,
--     а по таблице видно, что именно поменяли внутри сущности,
--   * денежные поля. В журнале их почти нет: audit_sanitize_jsonb вырезает суммы,
--     цены и реквизиты из снимков. Исключение — счета (0019): для entity_type = 'invoice'
--     суммы в журнале сохраняются и по замыслу 0019 отдаются только тому, у кого есть
--     и audit.read, и finance.read. Это обещание выполняет само представление: без
--     finance.read снимок проходит через audit_sanitize_jsonb ещё раз, и money_hidden
--     говорит экрану, что по счёту показаны не все поля.
--
-- Миграцию можно применить повторно.

-- Снимок события для экрана: с деньгами или без них, по праву смотрящего.
-- Решение о финансах принимается один раз на запрос (подзапрос в представлении),
-- а не для каждой строки.
CREATE OR REPLACE FUNCTION public.audit_event_snapshot(
  p_value jsonb,
  p_entity_type text,
  p_with_money boolean
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  -- Деньги лежат только в событиях счёта: в остальных их вырезали при записи,
  -- и второй проход ничего не меняет.
  SELECT CASE
    WHEN p_value IS NULL THEN NULL
    WHEN p_with_money OR p_entity_type <> 'invoice' THEN p_value
    ELSE public.audit_sanitize_jsonb(p_value)
  END
$$;

COMMENT ON FUNCTION public.audit_event_snapshot(jsonb, text, boolean) IS
  'Снимок события журнала для экрана (0057): без finance.read денежные поля события счёта вырезаются ещё раз, остальные события от этого не меняются.';

-- Экранный журнал изменений. Правами вызывающего: правило строк audit_log (audit.read)
-- остаётся единственным решением о доступе.
DROP VIEW IF EXISTS public.audit_log_journal;
CREATE VIEW public.audit_log_journal
WITH (security_invoker = true)
AS
SELECT
  event.id,
  event.occurred_at,
  event.actor_type,
  event.actor_user_id,
  -- Сотрудника могли переименовать или отключить: имя берём текущее, а если автора
  -- в сотрудниках уже нет — пусто, и экран подписывает событие по actor_type.
  person.full_name AS actor_name,
  event.action,
  event.outcome,
  event.entity_type,
  event.entity_id,
  event.changed_fields,
  nullif(btrim(coalesce(event.metadata ->> 'table_name', '')), '') AS table_name,
  public.audit_event_snapshot(event.before_data, event.entity_type, (SELECT public.app_has_permission('finance.read'))) AS before_data,
  public.audit_event_snapshot(event.after_data, event.entity_type, (SELECT public.app_has_permission('finance.read'))) AS after_data,
  public.audit_event_snapshot(event.metadata, event.entity_type, (SELECT public.app_has_permission('finance.read'))) AS metadata,
  -- У события счёта без finance.read часть полей скрыта: экран говорит это прямо,
  -- а не делает вид, что показал всё.
  (event.entity_type = 'invoice' AND NOT (SELECT public.app_has_permission('finance.read'))) AS money_hidden,
  event.request_id,
  event.ip_address
FROM public.audit_log AS event
LEFT JOIN public.users AS person ON person.id = event.actor_user_id;

COMMENT ON VIEW public.audit_log_journal IS
  'Журнал изменений для экрана (0057): событие, автор по имени, таблица из metadata и снимки по праву смотрящего. Работает правами вызывающего, поэтому доступ решает правило строк audit_log (audit.read).';

-- Представление работает правами вызывающего, поэтому вызывающему нужны и функции,
-- которыми он смотрит: проверка права и вырезание денег.
GRANT EXECUTE ON FUNCTION public.audit_event_snapshot(jsonb, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.audit_sanitize_jsonb(jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.audit_event_snapshot(jsonb, text, boolean) FROM PUBLIC, anon;

-- Представление только читают: запись в журнал идёт служебными триггерами.
-- Простое представление по одной таблице PostgreSQL считает изменяемым, поэтому
-- права на запись снимаем явно, иначе через него можно было бы вставить событие.
REVOKE ALL ON public.audit_log_journal FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.audit_log_journal FROM authenticated;
GRANT SELECT ON public.audit_log_journal TO authenticated;

-- Поиск по журналу идёт по номеру объекта и действию: на стенде это десятки тысяч
-- строк, и отбирать их браузером нельзя. Индексы под фильтры «кто» и «объект» уже
-- есть (audit_log_actor_timeline_idx, audit_log_entity_timeline_idx, 0001).
CREATE INDEX IF NOT EXISTS audit_log_entity_id_trgm_idx
  ON public.audit_log USING gin (entity_id gin_trgm_ops);
CREATE INDEX IF NOT EXISTS audit_log_action_trgm_idx
  ON public.audit_log USING gin (action gin_trgm_ops);

NOTIFY pgrst, 'reload schema';
