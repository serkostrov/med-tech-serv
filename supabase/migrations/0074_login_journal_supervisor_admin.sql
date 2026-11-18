-- 0074. Журнал входов — только руководителю и администратору (решение Тимура, 18.11.2026).
--
-- Что было. Журнал входов (0058) читался по праву «Просмотр аудита», а оно есть и у
-- координатора: ему нужен журнал изменений. Вместе с ним координатор видел, кто, когда
-- и с какого IP-адреса входил в систему.
--
-- Что стало. Журнал изменений — как раньше, по праву «Просмотр аудита». Журнал входов —
-- тому, у кого это право И базовая роль «Руководитель» или «Администратор» (системный
-- администратор — тоже администратор). Проверяет база: функция login_journal и правило
-- чтения строк самой таблицы login_events, чтобы журнал не прочитали в обход функции.

CREATE OR REPLACE FUNCTION public.app_can_read_login_journal()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.app_has_permission('audit.read') AND EXISTS (
    SELECT 1
      FROM public.users AS u
      LEFT JOIN public.access_roles AS r ON r.key = u.access_role_key
     WHERE u.id = auth.uid()
       AND u.is_active
       AND coalesce(r.base_role::text, u.role::text) IN ('admin', 'supervisor')
  );
$$;

COMMENT ON FUNCTION public.app_can_read_login_journal() IS
  'Журнал входов читают руководитель и администратор с правом «Просмотр аудита» (0074).';

REVOKE ALL ON FUNCTION public.app_can_read_login_journal() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.app_can_read_login_journal() TO authenticated;

-- Строки журнала входов напрямую — по тому же правилу.
DROP POLICY IF EXISTS role_read ON public.login_events;
CREATE POLICY role_read ON public.login_events
  FOR SELECT TO authenticated
  USING ((SELECT public.app_can_read_login_journal()));

-- Функция чтения журнала: всё как в 0058, кроме проверки в начале.
CREATE OR REPLACE FUNCTION public.login_journal(
  p_user_id uuid DEFAULT NULL,
  p_outcome text DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  outcome text := nullif(btrim(lower(coalesce(p_outcome, ''))), '');
  -- Знаки шаблона из строки поиска ищутся как знаки: «100%» это «100%», а не «любое».
  search text := nullif(replace(replace(replace(btrim(coalesce(p_search, '')), '\', '\\'), '%', '\%'), '_', '\_'), '');
  page_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  page_offset integer := greatest(coalesce(p_offset, 0), 0);
  gotrue_part text := '';
  gotrue_available boolean := false;
  result jsonb;
BEGIN
  IF NOT public.app_can_read_login_journal() THEN
    RAISE EXCEPTION 'Журнал входов открыт только руководителю и администратору'
      USING ERRCODE = '42501';
  END IF;
  IF outcome IS NOT NULL AND outcome NOT IN ('success', 'failure') THEN
    RAISE EXCEPTION 'Исход входа бывает только «success» или «failure»'
      USING ERRCODE = '22023';
  END IF;

  -- Таблицы журнала GoTrue может не быть (свежая база, где служба входа ещё не
  -- разворачивалась): тогда журнал покажет неудачные попытки и скажет, что удачные
  -- входы взять негде.
  IF to_regclass('auth.audit_log_entries') IS NOT NULL THEN
    gotrue_available := true;
    gotrue_part := $gotrue$
      UNION ALL
      SELECT 'gotrue:' || entry.id::text AS id,
             'gotrue'::text AS source,
             entry.created_at AS occurred_at,
             CASE WHEN (entry.payload ->> 'actor_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               THEN (entry.payload ->> 'actor_id')::uuid END AS user_id,
             lower(nullif(btrim(coalesce(entry.payload ->> 'actor_username', '')), '')) AS login,
             public.text_to_inet(entry.ip_address::text) AS ip_address,
             true AS success,
             NULL::text AS failure_reason
        FROM auth.audit_log_entries AS entry
       WHERE entry.payload ->> 'action' = 'login'
    $gotrue$;
  END IF;

  BEGIN
    EXECUTE format($query$
      WITH entries AS (
        SELECT 'app:' || event.id::text AS id,
               'app'::text AS source,
               event.occurred_at,
               event.user_id,
               event.attempted_login AS login,
               event.ip_address,
               event.success,
               event.failure_reason
          FROM public.login_events AS event
        %s
      ), named AS (
        SELECT entry.*,
               coalesce(person.full_name, '') AS full_name,
               coalesce(lower(person.email), '') AS person_email
          FROM entries AS entry
          LEFT JOIN public.users AS person ON person.id = entry.user_id
      ), filtered AS (
        SELECT *
          FROM named
         WHERE ($1 IS NULL OR user_id = $1)
           AND ($2 IS NULL OR ($2 = 'success') = success)
           AND ($3 IS NULL
                OR coalesce(login, '') ILIKE '%%' || $3 || '%%'
                OR full_name ILIKE '%%' || $3 || '%%'
                OR person_email ILIKE '%%' || $3 || '%%'
                OR coalesce(host(ip_address), '') ILIKE '%%' || $3 || '%%')
           AND ($4 IS NULL OR occurred_at >= $4)
           AND ($5 IS NULL OR occurred_at <= $5)
      )
      SELECT jsonb_build_object(
        'items', coalesce((
          SELECT jsonb_agg(to_jsonb(page) ORDER BY page."occurredAt" DESC, page.id DESC)
            FROM (
              SELECT id,
                     source,
                     occurred_at AS "occurredAt",
                     user_id AS "userId",
                     nullif(full_name, '') AS "userName",
                     coalesce(nullif(login, ''), nullif(person_email, '')) AS login,
                     host(ip_address) AS "ipAddress",
                     success,
                     failure_reason AS "failureReason"
                FROM filtered
               ORDER BY occurred_at DESC, id DESC
               LIMIT $6 OFFSET $7
            ) AS page
        ), '[]'::jsonb),
        'total', (SELECT count(*) FROM filtered),
        'limit', $6,
        'offset', $7,
        'successSourceAvailable', $8
      )
    $query$, gotrue_part)
      INTO result
      USING p_user_id, outcome, search, p_from, p_to, page_limit, page_offset, gotrue_available;
  EXCEPTION WHEN insufficient_privilege OR undefined_table THEN
    -- Журнал GoTrue есть, но прочитать его не дают (права на схему auth выданы иначе):
    -- показываем неудачные попытки и честно говорим, что удачные входы недоступны.
    IF NOT gotrue_available THEN
      RAISE;
    END IF;
    RETURN public.login_journal_without_gotrue(p_user_id, outcome, search, p_from, p_to, page_limit, page_offset);
  END;

  RETURN result;
END
$$;

COMMENT ON FUNCTION public.login_journal(uuid, text, text, timestamptz, timestamptz, integer, integer) IS
  'Журнал входов одной страницей (0058, права — 0074): руководитель и администратор с правом «Просмотр аудита».';

REVOKE ALL ON FUNCTION public.login_journal(uuid, text, text, timestamptz, timestamptz, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.login_journal(uuid, text, text, timestamptz, timestamptz, integer, integer) TO authenticated;
