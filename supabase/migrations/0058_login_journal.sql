-- Журнал входов: кто, когда, с какого адреса и чем закончилось (ТЗ 6.3).
--
-- Что было. Таблица login_events есть с самого начала (0001), но в неё никто не писал:
-- вход в CRM идёт через GoTrue (Supabase Auth), а он про эту таблицу не знает.
--
-- Откуда берутся входы теперь.
--   * Удачные — из журнала самого GoTrue (auth.audit_log_entries, действие login).
--     Это запись сервера входа: время, адрес и кто вошёл там уже есть, подделать их
--     из браузера нельзя. Дублировать их своей записью не нужно и вредно: получилось бы
--     две строки на один вход, а приложение могло бы записать удачный вход, которого не было.
--   * Неудачные — своей записью: GoTrue неудачные попытки не сохраняет вовсе, а по ТЗ
--     они нужны. Их пишет сам экран входа после отказа.
--
-- Что храним о неудачной попытке: время, адрес обращения, набранный e-mail, сотрудника,
-- если такой e-mail есть в CRM, и причину отказа из короткого списка. Пароль, его длину,
-- хэш и любые обрывки не храним и в функцию не передаём. Браузер (user_agent) тоже не пишем:
-- по ТЗ он не нужен, а это отпечаток устройства.
--
-- Почему запись неудачной попытки открыта без входа. У неудачной попытки сессии нет,
-- значит писать её может только анонимное обращение. Чтобы этим нельзя было
-- воспользоваться, строку формирует не браузер, а сама база: триггер подставляет время,
-- адрес и сотрудника, приводит причину к списку и отбрасывает всё остальное.
-- Поток попыток журнал не раздувает и не вытесняет из него чужие записи — как это
-- устроено, написано у самого предела в fill_login_event.
--
-- Чего журнал не доказывает. Набранный адрес в неудачной попытке — это то, что ввели
-- в поле входа, а не подтверждённый сотрудник: совпадение с e-mail сотрудника находит
-- база, но набрать чужой адрес может кто угодно. Адрес обращения приходит из заголовка
-- обратного прокси. Экран об этом говорит прямо, чтобы журнал не читали как доказательство.
--
-- Миграцию можно применить повторно.

-- ---------------------------------------------------------------------------
-- 1. Что хранит таблица
-- ---------------------------------------------------------------------------

ALTER TABLE public.login_events
  ADD COLUMN IF NOT EXISTS attempted_login text;

-- Автор строки — исторический идентификатор, как в audit_log (0010): ссылка
-- с ON DELETE SET NULL правила бы уже записанное событие при удалении сотрудника,
-- а журнал не меняется. Имя для экрана подбирается по сотрудникам при чтении.
ALTER TABLE public.login_events
  DROP CONSTRAINT IF EXISTS login_events_user_id_fkey,
  DROP CONSTRAINT IF EXISTS login_events_session_id_fkey;

ALTER TABLE public.login_events
  DROP CONSTRAINT IF EXISTS login_events_failure_reason_check,
  ADD CONSTRAINT login_events_failure_reason_check CHECK (
    failure_reason IS NULL OR failure_reason IN (
      'invalid_credentials', 'email_not_confirmed', 'user_disabled', 'too_many_attempts',
      'service_unavailable', 'unknown'
    )
  ),
  DROP CONSTRAINT IF EXISTS login_events_outcome_known_check,
  ADD CONSTRAINT login_events_outcome_known_check CHECK (success OR failure_reason IS NOT NULL),
  DROP CONSTRAINT IF EXISTS login_events_attempted_login_check,
  ADD CONSTRAINT login_events_attempted_login_check CHECK (
    attempted_login IS NULL
    OR (length(attempted_login) <= 320 AND attempted_login ~ '^[^[:space:]@]+@[^[:space:]@]+$')
  );

COMMENT ON TABLE public.login_events IS
  'Журнал входов (0058): неудачные попытки пишет экран входа через record_failed_login, удачные берутся из журнала GoTrue при чтении (login_journal). Строка не меняется и не удаляется.';
COMMENT ON COLUMN public.login_events.attempted_login IS
  'Набранный при попытке входа e-mail в нижнем регистре. Нужен, чтобы видеть попытки под несуществующими адресами; подставляется базой, не из запроса.';
COMMENT ON COLUMN public.login_events.user_id IS
  'Сотрудник, под которым входили, если такой e-mail есть в CRM. Исторический идентификатор без ссылки на users: запись журнала не меняется вслед за сотрудником.';
COMMENT ON COLUMN public.login_events.user_agent IS
  'Не заполняется: по ТЗ в журнале нужны время, адрес и исход, а строка браузера — отпечаток устройства.';
COMMENT ON COLUMN public.login_events.failure_reason IS
  'Причина отказа из списка: invalid_credentials, email_not_confirmed, user_disabled, too_many_attempts, service_unavailable, unknown.';

-- ---------------------------------------------------------------------------
-- 2. Адрес обращения
-- ---------------------------------------------------------------------------

-- Что не адрес, то не адрес: приводим текст к inet, не роняя запрос.
CREATE OR REPLACE FUNCTION public.text_to_inet(p_value text)
RETURNS inet
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN nullif(btrim(coalesce(p_value, '')), '')::inet;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.text_to_inet(text) IS
  'Текст в адрес (0058): пусто или не адрес — NULL, запрос не падает.';

-- Адрес, с которого пришёл запрос. PostgREST отдаёт заголовки запроса, адрес в них
-- ставит обратный прокси (X-Forwarded-For). Первое значение в цепочке — клиент,
-- но если прокси не затирает присланный заголовок, его можно подменить: адрес в журнале
-- стоит читать как «адрес, который передал прокси», а не как доказательство.
CREATE OR REPLACE FUNCTION public.request_ip_address()
RETURNS inet
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  headers jsonb;
BEGIN
  BEGIN
    headers := nullif(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN others THEN
    headers := NULL;
  END;
  RETURN coalesce(
    public.text_to_inet(split_part(coalesce(headers ->> 'x-forwarded-for', ''), ',', 1)),
    public.text_to_inet(headers ->> 'x-real-ip'),
    -- Служебные соединения без PostgREST (миграции, служба уведомлений) задают адрес сами.
    public.text_to_inet(current_setting('app.ip_address', true))
  );
END
$$;

COMMENT ON FUNCTION public.request_ip_address() IS
  'Адрес обращения (0058): из заголовков запроса PostgREST (X-Forwarded-For, X-Real-IP), иначе из app.ip_address.';

REVOKE ALL ON FUNCTION public.text_to_inet(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_ip_address() FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- 3. Строку журнала формирует база, а не запрос
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fill_login_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  login text := lower(btrim(coalesce(NEW.attempted_login, '')));
  caller_ip inet := public.request_ip_address();
  -- Предел на пару «адрес + набранный логин»: столько попыток в минуту ещё пишем.
  pair_limit constant integer := 20;
  -- Общий предел на журнал: даёт потолок росту, если адреса и логины перебирают.
  total_limit constant integer := 500;
  recent integer;
  pair_exceeded boolean;
  marked boolean;
BEGIN
  -- Запись о входе всегда в тот момент, когда она случилась.
  NEW.occurred_at := now();
  NEW.ip_address := caller_ip;
  -- Строку браузера не храним, даже если её прислали.
  NEW.user_agent := NULL;
  NEW.session_id := NULL;

  -- Из запроса принимается только набранный адрес и причина отказа. Длиннее
  -- почтового адреса (254 знака по RFC 5321) это уже не адрес, а мусор в журнале.
  IF login !~ '^[^[:space:]@]+@[^[:space:]@]+$' OR length(login) > 254 THEN
    login := NULL;
  END IF;
  NEW.attempted_login := login;
  -- Удачный вход в эту таблицу не пишется: удачные берутся из журнала GoTrue,
  -- иначе из браузера можно было бы записать вход, которого не было.
  NEW.success := false;
  IF NEW.failure_reason IS NULL OR NEW.failure_reason NOT IN (
       'invalid_credentials', 'email_not_confirmed', 'user_disabled', 'too_many_attempts',
       'service_unavailable', 'unknown') THEN
    NEW.failure_reason := 'unknown';
  END IF;

  -- Кто это был: сотрудника подбирает база по набранному адресу. Из запроса
  -- сотрудника не задать — иначе чужую попытку можно было бы записать на любого.
  NEW.user_id := CASE WHEN login IS NULL THEN NULL ELSE (
    SELECT person.id FROM public.users AS person WHERE lower(person.email) = login LIMIT 1
  ) END;

  -- Журнал нельзя завалить потоком попыток, но и затереть потоком — тоже.
  --
  -- Предел считается по паре «адрес + набранный логин», а не по одному адресу:
  -- адрес приходит из заголовка обратного прокси, и если его подменить на адрес
  -- офиса, предел по адресу погасил бы запись настоящих попыток из этого офиса
  -- (а на общем адресе офиса предел достижим и без подмены). По паре вытеснить
  -- чужую попытку можно, только зная и адрес, и логин, и в журнале это всё равно
  -- останется видно.
  --
  -- Сверх предела строка не теряется молча: один раз на минуту и пару пишется
  -- отметка «слишком много попыток», и по ней видно, что счёт попыток оборвался.
  -- Параллельные попытки считаются по очереди: без блокировки предел можно было бы
  -- проскочить несколькими запросами разом.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'medtechservice:login-journal:' || coalesce(host(caller_ip), '') || '|' || coalesce(login, ''), 0));

  SELECT count(*) INTO recent
    FROM public.login_events AS earlier
   WHERE earlier.occurred_at > now() - interval '1 minute'
     AND earlier.ip_address IS NOT DISTINCT FROM caller_ip
     AND earlier.attempted_login IS NOT DISTINCT FROM login;
  pair_exceeded := recent >= pair_limit;
  IF NOT pair_exceeded THEN
    -- Общий потолок журнала: перебор адресов и логинов мимо парного предела
    -- не должен раздувать таблицу без конца.
    SELECT count(*) INTO recent
      FROM public.login_events AS earlier
     WHERE earlier.occurred_at > now() - interval '1 minute';
    IF recent < total_limit THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Отметка об обрыве счёта: при парном пределе — одна на пару, при общем потолке —
  -- одна на весь журнал, иначе перебор пар снова раздул бы таблицу отметками.
  SELECT EXISTS (
    SELECT 1 FROM public.login_events AS earlier
     WHERE earlier.occurred_at > now() - interval '1 minute'
       AND earlier.failure_reason = 'too_many_attempts'
       AND (NOT pair_exceeded
            OR (earlier.ip_address IS NOT DISTINCT FROM caller_ip
                AND earlier.attempted_login IS NOT DISTINCT FROM login)))
    INTO marked;
  IF marked THEN
    RETURN NULL;
  END IF;
  NEW.failure_reason := 'too_many_attempts';
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.fill_login_event() IS
  'Строка журнала входов (0058): время, адрес и сотрудника подставляет база, причину приводит к списку, удачный вход через API не пишется. Сверх 20 попыток в минуту с одной пары «адрес + логин» (или 500 на весь журнал) пишется одна отметка «слишком много попыток», дальше строки не добавляются.';

REVOKE EXECUTE ON FUNCTION public.fill_login_event() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS login_events_fill ON public.login_events;
CREATE TRIGGER login_events_fill
  BEFORE INSERT ON public.login_events
  FOR EACH ROW EXECUTE FUNCTION public.fill_login_event();

-- Записать неудачную попытку может и обращение без входа: сессии у неудачной попытки нет.
-- Правило строк разрешает ровно такую строку, остальное отсекает триггер выше.
DROP POLICY IF EXISTS role_insert ON public.login_events;
CREATE POLICY role_insert ON public.login_events
  FOR INSERT TO anon, authenticated
  WITH CHECK (NOT success AND failure_reason IS NOT NULL);

GRANT INSERT ON TABLE public.login_events TO anon, authenticated;
-- Читать журнал анониму незачем: правило чтения и так требует audit.read.
REVOKE SELECT, UPDATE, DELETE, TRUNCATE ON TABLE public.login_events FROM anon;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.login_events FROM authenticated;

-- ---------------------------------------------------------------------------
-- 4. Запись неудачной попытки из экрана входа
-- ---------------------------------------------------------------------------

-- Правами вызывающего: ничего, кроме записи в журнал, функция не делает, а подстановку
-- и проверки берёт на себя триггер. Так анониму не достаётся ни одной функции
-- от владельца схемы (это проверяет supabase/tests/role_access.sql).
CREATE OR REPLACE FUNCTION public.record_failed_login(p_login text, p_reason text DEFAULT 'invalid_credentials')
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.login_events (attempted_login, success, failure_reason)
  VALUES (p_login, false, p_reason)
$$;

COMMENT ON FUNCTION public.record_failed_login(text, text) IS
  'Запись неудачной попытки входа (0058). Принимает только набранный e-mail и причину отказа; время, адрес и сотрудника подставляет база. Пароль не передаётся и не хранится.';

REVOKE ALL ON FUNCTION public.record_failed_login(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_failed_login(text, text) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Чтение журнала входов
-- ---------------------------------------------------------------------------

-- Удачные входы лежат в схеме auth, которую PostgREST не отдаёт и читать которую
-- сотруднику нельзя: иначе ему досталась бы вся служебная история GoTrue. Поэтому
-- чтение идёт одной функцией от владельца схемы, а право «Просмотр аудита» она
-- проверяет сама, первой же строкой. Отбор, счёт и страница — в базе.
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
  IF NOT public.app_has_permission('audit.read') THEN
    RAISE EXCEPTION 'Журнал входов открыт только с правом «Просмотр аудита»'
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

-- Тот же отбор, но только по своей таблице: нужен, когда журнал GoTrue недоступен.
CREATE OR REPLACE FUNCTION public.login_journal_without_gotrue(
  p_user_id uuid,
  p_outcome text,
  p_search text,
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer,
  p_offset integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH named AS (
    SELECT 'app:' || event.id::text AS id,
           'app'::text AS source,
           event.occurred_at,
           event.user_id,
           event.attempted_login AS login,
           event.ip_address,
           event.success,
           event.failure_reason,
           coalesce(person.full_name, '') AS full_name,
           coalesce(lower(person.email), '') AS person_email
      FROM public.login_events AS event
      LEFT JOIN public.users AS person ON person.id = event.user_id
  ), filtered AS (
    SELECT *
      FROM named
     WHERE (p_user_id IS NULL OR user_id = p_user_id)
       AND (p_outcome IS NULL OR (p_outcome = 'success') = success)
       AND (p_search IS NULL
            OR coalesce(login, '') ILIKE '%' || p_search || '%'
            OR full_name ILIKE '%' || p_search || '%'
            OR person_email ILIKE '%' || p_search || '%'
            OR coalesce(host(ip_address), '') ILIKE '%' || p_search || '%')
       AND (p_from IS NULL OR occurred_at >= p_from)
       AND (p_to IS NULL OR occurred_at <= p_to)
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
           LIMIT p_limit OFFSET p_offset
        ) AS page
    ), '[]'::jsonb),
    'total', (SELECT count(*) FROM filtered),
    'limit', p_limit,
    'offset', p_offset,
    'successSourceAvailable', false
  )
$$;

COMMENT ON FUNCTION public.login_journal(uuid, text, text, timestamptz, timestamptz, integer, integer) IS
  'Журнал входов для экрана (0058): удачные входы из журнала GoTrue, неудачные попытки из login_events, одной страницей. Право «Просмотр аудита» проверяет сама.';
COMMENT ON FUNCTION public.login_journal_without_gotrue(uuid, text, text, timestamptz, timestamptz, integer, integer) IS
  'Журнал входов без журнала GoTrue (0058): служебная часть login_journal, напрямую не вызывается.';

REVOKE ALL ON FUNCTION public.login_journal(uuid, text, text, timestamptz, timestamptz, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.login_journal(uuid, text, text, timestamptz, timestamptz, integer, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.login_journal_without_gotrue(uuid, text, text, timestamptz, timestamptz, integer, integer) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
