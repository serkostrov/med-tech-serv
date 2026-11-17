-- Скорость на большой базе (ТЗ 6.4): 1500 приборов, 15 000 задач, 30 000 записей истории.
-- Замеряет запросы, которые делает интерфейс, под ролью координатора (с правилами строк).
-- Запуск: TEST_SQL=supabase/perf/large_base.sql node ../tools/pgtest/rev-full-role-access.mjs .
--   или на настоящей базе: psql -U supabase_admin -v ON_ERROR_STOP=1 -f supabase/perf/large_base.sql
-- Всё выполняется в транзакции и откатывается. Ошибка = проверка не прошла.

BEGIN;

CREATE FUNCTION pg_temp.act_as(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE FUNCTION pg_temp.act_as_nobody() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
END $$;

CREATE FUNCTION pg_temp.check(p_ok boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'ПРОВАЛ: %', p_label;
  END IF;
  RAISE NOTICE 'ok: %', p_label;
END $$;

-- Ожидаем отказ с конкретным текстом: интерфейс показывает его пользователю дословно.
CREATE FUNCTION pg_temp.expect_message(p_sql text, p_message text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE got text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    got := SQLERRM;
    IF got <> p_message THEN
      RAISE EXCEPTION 'ПРОВАЛ: % — сообщение «%», ожидалось «%»', p_label, got, p_message;
    END IF;
    RAISE NOTICE 'ok: % («%»)', p_label, got;
    RETURN;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — команда прошла, а должна быть отклонена', p_label;
END $$;

CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON ids TO authenticated;

CREATE FUNCTION pg_temp.uid(p_key text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM ids WHERE k = p_key
$$;


GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.act_as_nobody(), pg_temp.check(boolean, text), pg_temp.uid(text) TO authenticated;

-- Время запроса: второй прогон (первый прогревает кэш), в миллисекундах.
CREATE TEMP TABLE timings (label text, ms numeric);
GRANT SELECT, INSERT ON timings TO authenticated;
CREATE FUNCTION pg_temp.timed(p_label text, p_sql text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE started timestamptz; elapsed numeric; dummy bigint;
BEGIN
  EXECUTE 'SELECT count(*) FROM (' || p_sql || ') AS q' INTO dummy;
  started := clock_timestamp();
  EXECUTE 'SELECT count(*) FROM (' || p_sql || ') AS q' INTO dummy;
  elapsed := round(extract(epoch FROM clock_timestamp() - started)::numeric * 1000, 1);
  INSERT INTO timings VALUES (p_label, elapsed);
  RAISE NOTICE 'time: % ms — % (строк %)', elapsed, p_label, dummy;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.timed(text, text) TO authenticated;

-- ---------------------------------------------------------------- Данные
DO $$
DECLARE
  coord uuid := gen_random_uuid(); uid uuid; i integer; started timestamptz := clock_timestamp();
BEGIN
  PERFORM set_config('session_replication_role', 'replica', true);
  INSERT INTO auth.users (id, email, aud, role) VALUES (coord, 'perf-coord@test.local', 'authenticated', 'authenticated');
  INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
  VALUES (coord, 'Скорость координатор', 'coordinator', 'perf-coord@test.local', true, 'coordinator');
  INSERT INTO ids VALUES ('coordinator', coord);
  FOR i IN 1..20 LOOP
    uid := gen_random_uuid();
    INSERT INTO auth.users (id, email, aud, role) VALUES (uid, 'perf-eng' || i || '@test.local', 'authenticated', 'authenticated');
    INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
    VALUES (uid, 'Инженер ' || i, 'engineer', 'perf-eng' || i || '@test.local', true, 'engineer');
  END LOOP;

  CREATE TEMP TABLE perf_orgs AS SELECT gen_random_uuid() AS id, n FROM generate_series(1, 20) AS n;
  INSERT INTO public.organizations (id, name) SELECT id, 'Скорость: больница ' || n FROM perf_orgs;
  CREATE TEMP TABLE perf_sites AS SELECT gen_random_uuid() AS id, n, (SELECT id FROM perf_orgs o WHERE o.n = 1 + (s.n % 20)) AS org FROM generate_series(1, 60) AS s(n);
  INSERT INTO public.sites (id, name, organization_id) SELECT id, 'Скорость: КДЛ ' || n, org FROM perf_sites;
  CREATE TEMP TABLE perf_payers AS SELECT gen_random_uuid() AS id, n FROM generate_series(1, 30) AS n;
  INSERT INTO public.payers (id, name) SELECT id, 'Скорость: плательщик ' || n FROM perf_payers;
  CREATE TEMP TABLE perf_makers AS SELECT gen_random_uuid() AS id, n FROM generate_series(1, 10) AS n;
  INSERT INTO public.manufacturers (id, name) SELECT id, 'Производитель ' || n FROM perf_makers;
  CREATE TEMP TABLE perf_models AS SELECT gen_random_uuid() AS id, n, (SELECT id FROM perf_makers m WHERE m.n = 1 + (x.n % 10)) AS maker FROM generate_series(1, 50) AS x(n);
  INSERT INTO public.equipment_models (id, manufacturer_id, name) SELECT id, maker, 'Модель ' || n FROM perf_models;

  CREATE TEMP TABLE perf_eq AS
    SELECT gen_random_uuid() AS id, n,
           (SELECT id FROM perf_models m WHERE m.n = 1 + (e.n % 50)) AS model,
           (SELECT id FROM perf_sites s WHERE s.n = 1 + (e.n % 60)) AS site,
           (SELECT id FROM perf_payers p WHERE p.n = 1 + (e.n % 30)) AS payer
      FROM generate_series(1, 1500) AS e(n);
  INSERT INTO public.equipment (id, serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  SELECT e.id, 'PERF-' || lpad(e.n::text, 5, '0'), m.maker, e.model, e.site, e.payer
    FROM perf_eq e JOIN perf_models m ON m.id = e.model;

  -- 10 задач на прибор за два года: этапы вперемешку, у части срок прошёл.
  INSERT INTO public.tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by,
                            call_date, deadline_from, deadline_to, status_code, priority, created_at, updated_at)
  SELECT 'Скорость: работа ' || t.k || ' по ' || e.n,
         (ARRAY['repair', 'diagnostics', 'maintenance'])[1 + (t.k % 3)],
         e.id, e.site, e.payer,
         (SELECT u.id FROM public.users u WHERE u.full_name = 'Инженер ' || (1 + (e.n + t.k) % 20)),
         coord,
         current_date - (t.k * 70 + e.n % 60),
         current_date - (t.k * 70 + e.n % 60),
         current_date - (t.k * 70 + e.n % 60) + 7,
         (ARRAY['closed', 'closed', 'closed', 'closed', 'closed', 'closed', 'in_progress', 'assigned', 'under_review', 'new'])[1 + t.k],
         CASE WHEN t.k % 4 = 0 THEN 'urgent' ELSE 'planned' END::public.task_priority,
         now() - make_interval(days => t.k * 70 + e.n % 60),
         now() - make_interval(days => t.k * 70 + e.n % 60)
    FROM perf_eq e CROSS JOIN generate_series(0, 9) AS t(k);
  UPDATE public.tasks SET engineer_id = NULL WHERE status_code = 'new' AND title LIKE 'Скорость:%';

  -- 20 записей истории на прибор: задачи, замены, перемещения, счётчик.
  INSERT INTO public.equipment_history (equipment_id, event_type, happened_at, summary, details, created_by)
  SELECT e.id,
         (ARRAY['task', 'part_movement', 'site_change', 'meter', 'manual'])[1 + (h.k % 5)],
         now() - make_interval(days => h.k * 35 + e.n % 30),
         'Скорость: событие ' || h.k,
         '{}'::jsonb, coord
    FROM perf_eq e CROSS JOIN generate_series(1, 20) AS h(k);

  PERFORM set_config('session_replication_role', 'origin', true);
  RAISE NOTICE 'данные: % приборов, % задач, % записей истории за % с',
    (SELECT count(*) FROM public.equipment), (SELECT count(*) FROM public.tasks),
    (SELECT count(*) FROM public.equipment_history),
    round(extract(epoch FROM clock_timestamp() - started)::numeric, 1);
END $$;
ANALYZE;

-- ---------------------------------------------------------------- Замеры под координатором
SELECT pg_temp.act_as(pg_temp.uid('coordinator'));
SELECT pg_temp.timed('Приборы: первая страница, 50 строк с моделью, площадкой, плательщиком',
  $q$SELECT e.id, e.serial_number, m.name AS model, mk.name AS maker, s.name AS site, p.name AS payer
       FROM public.equipment e
       LEFT JOIN public.equipment_models m ON m.id = e.model_id
       LEFT JOIN public.manufacturers mk ON mk.id = e.manufacturer_id
       LEFT JOIN public.sites s ON s.id = e.current_site_id
       LEFT JOIN public.payers p ON p.id = e.current_payer_id
      ORDER BY e.serial_number LIMIT 50$q$);
SELECT pg_temp.timed('Приборы: число строк для «N из M»', $q$SELECT count(*) FROM public.equipment$q$);
SELECT pg_temp.timed('Приборы: поиск по S/N «PERF-0123»',
  $q$SELECT id FROM public.equipment_search WHERE search_text ILIKE '%perf-0123%' ORDER BY serial_number LIMIT 50$q$);
SELECT pg_temp.timed('Приборы: поиск по площадке «КДЛ 17»',
  $q$SELECT id FROM public.equipment_search WHERE search_text ILIKE '%кдл 17%' ORDER BY serial_number LIMIT 50$q$);
SELECT pg_temp.timed('Карточка прибора: 25 последних событий истории',
  $q$SELECT * FROM public.equipment_history_feed WHERE equipment_id = (SELECT id FROM public.equipment WHERE serial_number = 'PERF-00777') ORDER BY happened_at DESC LIMIT 25$q$);
SELECT pg_temp.timed('Карточка прибора: открытые задачи',
  $q$SELECT id FROM public.tasks WHERE equipment_id = (SELECT id FROM public.equipment WHERE serial_number = 'PERF-00777') AND status_code NOT IN ('closed', 'cancelled') ORDER BY deadline_to LIMIT 20$q$);
SELECT pg_temp.timed('Задачи: список, 50 последних обновлённых',
  $q$SELECT t.id, t.number, t.title, s.name, e.serial_number, u.full_name FROM public.tasks t
       LEFT JOIN public.sites s ON s.id = t.site_id LEFT JOIN public.equipment e ON e.id = t.equipment_id
       LEFT JOIN public.users u ON u.id = t.engineer_id ORDER BY t.updated_at DESC LIMIT 50$q$);
SELECT pg_temp.timed('Задачи: число строк', $q$SELECT count(*) FROM public.tasks$q$);
SELECT pg_temp.timed('Задачи: колонка доски «В работе», 30 по сроку',
  $q$SELECT id FROM public.tasks WHERE status_code = 'in_progress' ORDER BY deadline_to LIMIT 30$q$);
SELECT pg_temp.timed('Задачи: поиск по номеру',
  $q$SELECT id FROM public.tasks WHERE number ILIKE '%0123%' OR title ILIKE '%0123%' ORDER BY updated_at DESC LIMIT 50$q$);
SELECT pg_temp.timed('Плашка «Требуют внимания»: просроченные',
  $q$SELECT count(*) FROM public.tasks WHERE deadline_to < current_date AND status_code NOT IN ('closed', 'cancelled')$q$);
SELECT pg_temp.timed('Отчёт: сводка за год',
  $q$SELECT * FROM public.report_task_summary(current_date - 365, current_date)$q$);
SELECT pg_temp.timed('Отчёт: все разрезы за год',
  $q$SELECT * FROM public.report_task_breakdown(current_date - 365, current_date)$q$);
SELECT pg_temp.timed('Календарь инженеров: месяц',
  $q$SELECT * FROM public.engineer_calendar(date_trunc('month', current_date)::date, (date_trunc('month', current_date) + interval '1 month - 1 day')::date)$q$);
SELECT pg_temp.act_as_nobody();

SELECT pg_temp.check((SELECT max(ms) FROM timings) < 1000, 'ни один запрос не дольше секунды');
SELECT pg_temp.check((SELECT count(*) FROM timings) = 14, 'замерены все 14 запросов');

ROLLBACK;
