-- Этапы задачи и минимум фото для сдачи на проверку (миграция 0023).
-- Подготовка данных та же, что в role_access.sql. Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/task_workflow.sql
-- Всё выполняется в транзакции и откатывается. Ошибка = проверка не прошла.


BEGIN;

-- Служебные функции теста
CREATE FUNCTION pg_temp.act_as(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE FUNCTION pg_temp.check(p_ok boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'ПРОВАЛ: %', p_label;
  END IF;
  RAISE NOTICE 'ok: %', p_label;
END $$;

-- Ожидаем ошибку прав при выполнении команды
CREATE FUNCTION pg_temp.expect_denied(p_sql text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN insufficient_privilege OR check_violation OR raise_exception THEN
    RAISE NOTICE 'ok: % (запрещено)', p_label;
    RETURN;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — команда прошла, а должна быть запрещена', p_label;
END $$;

-- Ожидаем именно отказ по правам (а не другую проверку данных)
CREATE FUNCTION pg_temp.expect_forbidden(p_sql text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'ok: % (нет прав)', p_label;
    RETURN;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — команда прошла, а должна быть запрещена', p_label;
END $$;

-- Сколько строк изменила команда
CREATE FUNCTION pg_temp.rows_affected(p_sql text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.check(boolean, text),
  pg_temp.expect_denied(text, text), pg_temp.expect_forbidden(text, text), pg_temp.rows_affected(text) TO authenticated, anon;

-- Данные (от владельца, RLS не действует)
CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid);
GRANT SELECT ON ids TO authenticated;

DO $$
DECLARE
  roles text[] := ARRAY['coordinator', 'engineer', 'engineer2', 'warehouse', 'supervisor', 'admin', 'initiator', 'inactive', 'customer', 'customer2'];
  r text; uid uuid; base text;
  org uuid; site uuid; payer uuid; manuf uuid; model uuid; eq uuid; wt text;
  t1 uuid; t2 uuid; inv uuid; part uuid; ctr uuid;
BEGIN
  FOREACH r IN ARRAY roles LOOP
    uid := gen_random_uuid();
    base := CASE r WHEN 'engineer2' THEN 'engineer' WHEN 'inactive' THEN 'coordinator' WHEN 'customer2' THEN 'customer' ELSE r END;
    INSERT INTO auth.users (id, email, aud, role) VALUES (uid, r || '@test.local', 'authenticated', 'authenticated');
    INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
    VALUES (uid, 'Тест ' || r, base::user_role, r || '@test.local', r <> 'inactive', base);
    INSERT INTO ids VALUES (r, uid);
  END LOOP;

  INSERT INTO organizations (name) VALUES ('Тестовая больница') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('Тестовая площадка', org) RETURNING id INTO site;
  INSERT INTO payers (name) VALUES ('Тестовый плательщик') RETURNING id INTO payer;
  INSERT INTO manufacturers (name) VALUES ('Тест-Производитель') RETURNING id INTO manuf;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (manuf, 'Модель-1') RETURNING id INTO model;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  VALUES ('SN-TEST-1', manuf, model, site, payer) RETURNING id INTO eq;
  SELECT code INTO wt FROM work_types WHERE is_active ORDER BY code LIMIT 1;

  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by, deadline_from, deadline_to, status_code)
  VALUES ('Задача инженера 1', wt, eq, site, payer, (SELECT id FROM ids WHERE k = 'engineer'), (SELECT id FROM ids WHERE k = 'coordinator'), current_date, current_date + 7, 'assigned')
  RETURNING id INTO t1;
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by, deadline_from, deadline_to, status_code)
  VALUES ('Задача инженера 2', wt, eq, site, payer, (SELECT id FROM ids WHERE k = 'engineer2'), (SELECT id FROM ids WHERE k = 'coordinator'), current_date, current_date + 7, 'assigned')
  RETURNING id INTO t2;
  INSERT INTO ids VALUES ('site', site);
  INSERT INTO customer_organization_access (customer_user_id, organization_id) VALUES ((SELECT id FROM ids WHERE k = 'customer'), org);

  INSERT INTO invoices (payer_id, payer_name) VALUES (payer, 'Тестовый плательщик') RETURNING id INTO inv;
  INSERT INTO price_list (work_type_code, valid_from, amount) VALUES (wt, current_date, 15000);
  INSERT INTO contracts (name, total_amount) VALUES ('Договор тест', 500000) RETURNING id INTO ctr;
  INSERT INTO parts (article_number, name) VALUES ('ART-1', 'Клапан тест') RETURNING id INTO part;

  INSERT INTO ids VALUES ('t1', t1), ('t2', t2), ('invoice', inv), ('part', part), ('equipment', eq), ('contract', ctr), ('payer', payer);
END $$;

-- ---------------------------------------------------------------- 0023: этапы задачи и фото
-- Файлы задачи t1: акт и фото (от владельца, как после загрузки).
CREATE FUNCTION pg_temp.add_file(p_task uuid, p_kind text, p_n int) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE fid uuid;
BEGIN
  INSERT INTO files (kind, task_id, storage_key, original_name, content_type, byte_size)
  VALUES (p_kind::file_kind, p_task, 'test/' || p_task || '/' || p_kind || '-' || p_n, p_kind || p_n || '.jpg', 'image/jpeg', 100)
  RETURNING id INTO fid;
  RETURN fid;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.add_file(uuid, text, int) TO authenticated;

SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'coordinator'));
SELECT pg_temp.expect_denied(format('UPDATE public.tasks SET status_code = %L WHERE id = %L', 'under_review', (SELECT id FROM ids WHERE k = 't1')), 'назначенную задачу нельзя сразу сдать на проверку');
SELECT pg_temp.expect_denied(format('UPDATE public.tasks SET status_code = %L WHERE id = %L', 'closed', (SELECT id FROM ids WHERE k = 't1')), 'назначенную задачу нельзя сразу закрыть');
SELECT pg_temp.check(pg_temp.rows_affected(format('UPDATE public.tasks SET status_code = %L WHERE id = %L', 'in_progress', (SELECT id FROM ids WHERE k = 't1'))) = 1, 'координатор переводит назначенную в работу');
RESET ROLE;
SELECT pg_temp.add_file((SELECT id FROM ids WHERE k = 't1'), 'act', 1);
INSERT INTO task_closures (task_id, act_file_id, submitted_by)
  SELECT (SELECT id FROM ids WHERE k = 't1'), f.id, (SELECT id FROM ids WHERE k = 'engineer') FROM files f WHERE f.task_id = (SELECT id FROM ids WHERE k = 't1') AND f.kind = 'act';
UPDATE tasks SET call_reason = 'Не включается', work_description = 'Заменён блок', work_finished_at = '2026-11-13 12:30:00+03' WHERE id = (SELECT id FROM ids WHERE k = 't1');
SELECT pg_temp.add_file((SELECT id FROM ids WHERE k = 't1'), 'photo', 1);
SELECT pg_temp.add_file((SELECT id FROM ids WHERE k = 't1'), 'photo', 2);

-- Инженер задачи: с двумя фото на проверку не сдать, с тремя можно.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer'));
SELECT pg_temp.expect_denied(format('UPDATE public.tasks SET status_code = %L WHERE id = %L', 'under_review', (SELECT id FROM ids WHERE k = 't1')), 'с двумя фото на проверку не сдать');
RESET ROLE;
SELECT pg_temp.add_file((SELECT id FROM ids WHERE k = 't1'), 'photo', 3);
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'engineer'));
SELECT pg_temp.check(pg_temp.rows_affected(format('UPDATE public.tasks SET status_code = %L WHERE id = %L', 'under_review', (SELECT id FROM ids WHERE k = 't1'))) = 1, 'с тремя фото инженер сдаёт на проверку');
RESET ROLE;
SELECT pg_temp.check((SELECT completed_at = '2026-11-13 12:30:00+03'::timestamptz FROM tasks WHERE id = (SELECT id FROM ids WHERE k = 't1')), 'дата окончания работ взята из времени окончания в акте');

-- Возврат на доработку и повторная сдача.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'coordinator'));
SELECT pg_temp.check(pg_temp.rows_affected(format('UPDATE public.tasks SET status_code = %L, rework_comment = %L WHERE id = %L', 'in_progress', 'Добавьте фото шильдика', (SELECT id FROM ids WHERE k = 't1'))) = 1, 'координатор возвращает на доработку');
SELECT pg_temp.check(pg_temp.rows_affected(format('UPDATE public.tasks SET status_code = %L WHERE id = %L', 'under_review', (SELECT id FROM ids WHERE k = 't1'))) = 1, 'повторная сдача проходит');

-- Отмена конечна.
SELECT pg_temp.check(pg_temp.rows_affected(format('UPDATE public.tasks SET status_code = %L, cancellation_reason = %L WHERE id = %L', 'cancelled', 'Дубль заявки', (SELECT id FROM ids WHERE k = 't2'))) = 1, 'координатор отменяет задачу с причиной');
SELECT pg_temp.expect_denied(format('UPDATE public.tasks SET status_code = %L WHERE id = %L', 'assigned', (SELECT id FROM ids WHERE k = 't2')), 'отменённую задачу не вернуть в «Назначена»');
SELECT pg_temp.expect_denied(format('UPDATE public.tasks SET status_code = %L WHERE id = %L', 'new', (SELECT id FROM ids WHERE k = 't2')), 'отменённую задачу не вернуть в «Новая»');
RESET ROLE;

-- Служба без входа (перевод ТО по сроку) работает как раньше.
SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
UPDATE tasks SET status_code = 'new' WHERE id = (SELECT id FROM ids WHERE k = 't2');
SELECT pg_temp.check((SELECT status_code FROM tasks WHERE id = (SELECT id FROM ids WHERE k = 't2')) = 'new', 'служба без входа меняет этап как раньше (импорт, плановые переводы)');

-- Свой этап из справочника не ограничен схемой.
SELECT pg_temp.check(NOT has_function_privilege('authenticated', 'public.enforce_task_status_transition()', 'EXECUTE'), 'проверку этапов напрямую не вызвать');
SELECT pg_temp.check((SELECT prosecdef FROM pg_proc WHERE proname = 'enforce_task_status_transition'), 'проверка этапов работает от владельца схемы');

-- Свой этап справочника: схема его не ограничивает, но на проверку и из него только с тремя фото.
INSERT INTO task_statuses (code, name, sort_order) VALUES ('waiting_parts', 'Ждёт запчасть', 35);
INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by, deadline_from, deadline_to, status_code, visit_date, call_reason, work_description)
VALUES ('Задача со своим этапом', (SELECT code FROM work_types WHERE is_active ORDER BY code LIMIT 1), (SELECT id FROM ids WHERE k = 'equipment'),
  (SELECT id FROM ids WHERE k = 'site'), (SELECT id FROM ids WHERE k = 'payer'), (SELECT id FROM ids WHERE k = 'engineer'),
  (SELECT id FROM ids WHERE k = 'coordinator'), current_date, current_date + 7, 'in_progress', current_date, 'Ошибка дозатора', 'Заменён шприц');
INSERT INTO ids SELECT 't5', id FROM tasks WHERE title = 'Задача со своим этапом';
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'coordinator'));
SELECT pg_temp.check(pg_temp.rows_affected(format('UPDATE public.tasks SET status_code = %L WHERE id = %L', 'waiting_parts', (SELECT id FROM ids WHERE k = 't5'))) = 1, 'свой этап справочника не ограничен схемой');
SELECT pg_temp.expect_denied(format('UPDATE public.tasks SET status_code = %L WHERE id = %L', 'under_review', (SELECT id FROM ids WHERE k = 't5')), 'из своего этапа на проверку без фото не сдать');
RESET ROLE;
SELECT pg_temp.add_file((SELECT id FROM ids WHERE k = 't5'), 'act', 1);
INSERT INTO task_closures (task_id, act_file_id, submitted_by)
  SELECT (SELECT id FROM ids WHERE k = 't5'), f.id, (SELECT id FROM ids WHERE k = 'engineer') FROM files f WHERE f.task_id = (SELECT id FROM ids WHERE k = 't5') AND f.kind = 'act';
SELECT pg_temp.add_file((SELECT id FROM ids WHERE k = 't5'), 'photo', 1);
SELECT pg_temp.add_file((SELECT id FROM ids WHERE k = 't5'), 'photo', 2);
SELECT pg_temp.add_file((SELECT id FROM ids WHERE k = 't5'), 'photo', 3);
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'coordinator'));
SELECT pg_temp.check(pg_temp.rows_affected(format('UPDATE public.tasks SET status_code = %L WHERE id = %L', 'under_review', (SELECT id FROM ids WHERE k = 't5'))) = 1, 'с тремя фото из своего этапа на проверку можно');
RESET ROLE;
SELECT pg_temp.check((SELECT completed_at = (visit_date + time '12:00') AT TIME ZONE 'Europe/Moscow' FROM tasks WHERE id = (SELECT id FROM ids WHERE k = 't5')), 'без времени окончания дата окончания работ: полдень дня выезда по Москве');

-- Доработка стирает дату окончания, повторная сдача и правка координатора её пересчитывают.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'coordinator'));
UPDATE public.tasks SET status_code = 'in_progress', rework_comment = 'Уточните время' WHERE id = (SELECT id FROM ids WHERE k = 't5');
RESET ROLE;
SELECT pg_temp.check((SELECT completed_at IS NULL FROM tasks WHERE id = (SELECT id FROM ids WHERE k = 't5')), 'после возврата на доработку даты окончания работ нет');
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'coordinator'));
UPDATE public.tasks SET status_code = 'under_review' WHERE id = (SELECT id FROM ids WHERE k = 't5');
UPDATE public.tasks SET work_finished_at = '2026-11-13 15:45:00+03' WHERE id = (SELECT id FROM ids WHERE k = 't5');
RESET ROLE;
SELECT pg_temp.check((SELECT completed_at = '2026-11-13 15:45:00+03'::timestamptz FROM tasks WHERE id = (SELECT id FROM ids WHERE k = 't5')), 'координатор поправил время окончания на проверке: дата окончания работ пересчитана');

-- Уход с проверки не в «Закрыта» стирает дату окончания; пересчёт работает от владельца схемы.
SELECT pg_temp.act_as((SELECT id FROM ids WHERE k = 'coordinator'));
UPDATE public.tasks SET status_code = 'cancelled', cancellation_reason = 'Клиент отказался' WHERE id = (SELECT id FROM ids WHERE k = 't5');
RESET ROLE;
SELECT pg_temp.check((SELECT completed_at IS NULL FROM tasks WHERE id = (SELECT id FROM ids WHERE k = 't5')), 'отмена задачи на проверке стирает дату окончания работ');
SELECT pg_temp.check(has_function_privilege('authenticated', 'public.task_work_completed_at(timestamptz, date, timestamptz)', 'EXECUTE'), 'расчёт даты окончания доступен вошедшим явно');
SELECT pg_temp.check((SELECT prosecdef FROM pg_proc WHERE proname = 'sync_task_completed_at'), 'пересчёт даты окончания работает от владельца схемы');
SELECT pg_temp.check(NOT has_function_privilege('anon', 'public.task_work_completed_at(timestamptz, date, timestamptz)', 'EXECUTE'), 'без входа расчёт даты окончания не вызвать');

ROLLBACK;
