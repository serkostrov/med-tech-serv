-- Журналы не подчищают изнутри системы: ни строку удалить, ни строку поправить.
--
-- Так уже закрыты склад (0028), прайс (0031) и позиции счёта (0040). У журналов было
-- закрыто не всё:
--
-- 1. Представление audit_log_timeline (0010) создавалось обычным, то есть работало
--    правами своего владельца. Правило строк audit_log (audit.read) при чтении через
--    него не действовало: весь журнал аудита — с номерами задач, приборов и счетов —
--    доставался любому вошедшему, в том числе инженеру, кладовщику и заказчику. Простое
--    представление по одной таблице PostgreSQL ещё и считает изменяемым, поэтому через
--    него можно было вставить в журнал событие с чужим автором. Теперь представление
--    работает правами вызывающего (его решает то же правило строк), а права на запись
--    у ролей API сняты.
-- 2. Журнал входов (0058) защиты не имел вовсе: в него теперь пишут, значит строку надо
--    закрыть от правки и удаления так же, как строку журнала аудита.
--
-- Что остаётся возможным. Владелец схемы (postgres) в консоли базы по-прежнему может
-- всё: это обслуживание, а не работа системы, и отключение триггера видно в базе.
-- Закрыт путь «изнутри»: через API, через роль приложения и через представления.
--
-- Миграцию можно применить повторно.

-- ---------------------------------------------------------------------------
-- 1. Представления над журналами читают правами вызывающего
-- ---------------------------------------------------------------------------

ALTER VIEW public.audit_log_timeline SET (security_invoker = true);

REVOKE ALL ON public.audit_log_timeline FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.audit_log_timeline FROM authenticated;
GRANT SELECT ON public.audit_log_timeline TO authenticated;

COMMENT ON VIEW public.audit_log_timeline IS
  'Журнал аудита как поток событий. Работает правами вызывающего (0059): доступ решает правило строк audit_log (audit.read), запись через представление закрыта.';

-- ---------------------------------------------------------------------------
-- 2. Строка журнала входов не меняется и не удаляется
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reject_login_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '%',
    CASE TG_OP
      WHEN 'UPDATE' THEN 'Журнал входов неизменяем: запись о входе поправить нельзя'
      WHEN 'DELETE' THEN 'Журнал входов неизменяем: запись о входе удалить нельзя'
      ELSE 'Журнал входов неизменяем: очистить его нельзя'
    END
    USING ERRCODE = '42501';
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.reject_login_event_mutation() IS
  'Страж журнала входов (0059): UPDATE, DELETE и TRUNCATE по login_events отклоняются с ошибкой по-русски.';

REVOKE EXECUTE ON FUNCTION public.reject_login_event_mutation() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS login_events_append_only ON public.login_events;
CREATE TRIGGER login_events_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON public.login_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_login_event_mutation();

-- ---------------------------------------------------------------------------
-- 3. Права на запись в журналы у ролей API
-- ---------------------------------------------------------------------------

-- Правило строк на изменение и удаление журналам не выдавалось (0009), стражи
-- отклоняют даже выданное право. Снимаем и само право: отказ должен приходить
-- от прав, а не только от триггера.
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['audit_log', 'login_events'] LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.%I FROM PUBLIC, anon, authenticated', tbl);
    IF NOT (SELECT c.relrowsecurity FROM pg_class AS c WHERE c.oid = format('public.%I', tbl)::regclass) THEN
      RAISE EXCEPTION 'Миграция 0059: у таблицы % выключены правила строк (RLS), журнал не закрыть', tbl;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies AS p
                WHERE p.schemaname = 'public' AND p.tablename = tbl AND p.cmd IN ('UPDATE', 'DELETE', 'ALL')) THEN
      RAISE EXCEPTION 'Миграция 0059: у журнала % осталось правило изменения или удаления строк', tbl;
    END IF;
    IF has_table_privilege('authenticated', format('public.%I', tbl), 'UPDATE')
       OR has_table_privilege('authenticated', format('public.%I', tbl), 'DELETE')
       OR has_table_privilege('anon', format('public.%I', tbl), 'UPDATE')
       OR has_table_privilege('anon', format('public.%I', tbl), 'DELETE') THEN
      RAISE WARNING 'Миграция 0059: право изменения на % у ролей API не снято (его выдал другой владелец). Изменение всё равно отклоняет страж журнала.', tbl;
    END IF;
  END LOOP;
END
$$;

-- В журнал аудита через API не вставляют: события пишут служебные триггеры
-- от владельца схемы. Правила вставки у audit_log нет, проверяем, что так и осталось.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies AS p
              WHERE p.schemaname = 'public' AND p.tablename = 'audit_log' AND p.cmd IN ('INSERT', 'ALL')) THEN
    RAISE EXCEPTION 'Миграция 0059: в журнал аудита открыли вставку строк через API';
  END IF;
  EXECUTE 'REVOKE INSERT ON TABLE public.audit_log FROM PUBLIC, anon, authenticated';
END
$$;

-- ---------------------------------------------------------------------------
-- 4. Проверка на будущее: ни одно представление не обходит правило строк журнала
-- ---------------------------------------------------------------------------

-- Новое представление над журналом по умолчанию создаётся с правами владельца и
-- открывает журнал всем. Пусть миграция, которая так сделает, не применится.
DO $$
DECLARE
  leaky text;
BEGIN
  SELECT string_agg(DISTINCT view_name, ', ' ORDER BY view_name) INTO leaky
    FROM (
      SELECT v.relname AS view_name
        FROM pg_depend AS d
        JOIN pg_rewrite AS r ON r.oid = d.objid
        JOIN pg_class AS v ON v.oid = r.ev_class
       WHERE d.classid = 'pg_rewrite'::regclass
         AND d.refclassid = 'pg_class'::regclass
         AND d.refobjid IN ('public.audit_log'::regclass, 'public.login_events'::regclass)
         AND v.relkind IN ('v', 'm')
         AND v.oid <> d.refobjid
         AND NOT ('security_invoker=true' = ANY (coalesce(v.reloptions, ARRAY[]::text[])))
    ) AS views;
  IF leaky IS NOT NULL THEN
    RAISE EXCEPTION 'Миграция 0059: представления над журналом работают правами владельца и обходят право «Просмотр аудита»: %. Создавайте их с WITH (security_invoker = true).', leaky;
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
