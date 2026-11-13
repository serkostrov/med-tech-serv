-- Проверка автора действий (миграция 0024): журнал аудита, история прибора, корректировки
-- и история статусов счёта. Запуск на локальной базе с применёнными миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/audit_actor.sql
-- Всё в транзакции и откатывается. Ошибка = проверка не прошла.

BEGIN;

-- Вход сотрудника, как его передаёт PostgREST (токен в request.jwt.claims).
CREATE FUNCTION pg_temp.act_as(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;
-- Служебное соединение без входа (служба уведомлений, импорт): токена нет.
CREATE FUNCTION pg_temp.as_service(p_app_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('app.user_id', coalesce(p_app_user::text, ''), true);
END $$;
CREATE FUNCTION pg_temp.check(p_ok boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN RAISE EXCEPTION 'ПРОВАЛ: %', p_label; END IF;
  RAISE NOTICE 'ok: %', p_label;
END $$;
CREATE FUNCTION pg_temp.expect_error(p_sql text, p_label text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok: % (отказ: %)', p_label, SQLERRM;
    RETURN SQLERRM;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — команда прошла, а должна быть отклонена', p_label;
END $$;
-- Автор последней записи журнала по строке таблицы.
CREATE FUNCTION pg_temp.last_actor(p_table text, p_id uuid) RETURNS uuid LANGUAGE sql AS $$
  SELECT actor_user_id FROM public.audit_log
   WHERE metadata ->> 'table_name' = p_table AND entity_id = p_id::text
   ORDER BY id DESC LIMIT 1
$$;
CREATE FUNCTION pg_temp.last_actor_type(p_table text, p_id uuid) RETURNS text LANGUAGE sql AS $$
  SELECT actor_type FROM public.audit_log
   WHERE metadata ->> 'table_name' = p_table AND entity_id = p_id::text
   ORDER BY id DESC LIMIT 1
$$;
GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.check(boolean, text), pg_temp.expect_error(text, text) TO authenticated;

CREATE TEMP TABLE v (k text PRIMARY KEY, id uuid);
GRANT SELECT ON v TO authenticated;

DO $$
DECLARE
  coord uuid := gen_random_uuid(); sup uuid := gen_random_uuid(); eng uuid := gen_random_uuid();
  org uuid; site uuid; site2 uuid; payer uuid; manuf uuid; model uuid; eq uuid; task uuid; inv uuid; wt text;
BEGIN
  INSERT INTO auth.users (id, email, aud, role) VALUES
    (coord, 'actor-coord@test.local', 'authenticated', 'authenticated'),
    (sup, 'actor-sup@test.local', 'authenticated', 'authenticated'),
    (eng, 'actor-eng@test.local', 'authenticated', 'authenticated');
  INSERT INTO users (id, full_name, role, email, is_active, access_role_key) VALUES
    (coord, 'Координатор Автор', 'coordinator', 'actor-coord@test.local', true, 'coordinator'),
    (sup, 'Руководитель Создатель', 'supervisor', 'actor-sup@test.local', true, 'supervisor'),
    (eng, 'Инженер Служба', 'engineer', 'actor-eng@test.local', true, 'engineer');
  INSERT INTO organizations (name) VALUES ('Автор: организация') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('Автор: площадка', org) RETURNING id INTO site;
  INSERT INTO sites (name, organization_id) VALUES ('Автор: площадка 2', org) RETURNING id INTO site2;
  INSERT INTO payers (name) VALUES ('Автор: плательщик') RETURNING id INTO payer;
  INSERT INTO manufacturers (name) VALUES ('Автор: производитель') RETURNING id INTO manuf;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (manuf, 'Автор: модель') RETURNING id INTO model;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  VALUES ('ACTOR-1', manuf, model, site, payer) RETURNING id INTO eq;
  SELECT code INTO wt FROM work_types WHERE is_active AND NOT coalesce(requires_hours, false) ORDER BY code LIMIT 1;
  -- Задачу и счёт создал руководитель: автор изменений должен отличаться от создателя.
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, created_by, deadline_from, deadline_to)
  VALUES ('Автор: задача', wt, eq, site, payer, sup, current_date, current_date + 3) RETURNING id INTO task;
  INSERT INTO invoices (payer_id, payer_name, created_by) VALUES (payer, 'Автор: плательщик', sup) RETURNING id INTO inv;
  INSERT INTO v VALUES ('coord', coord), ('sup', sup), ('eng', eng), ('site', site), ('site2', site2), ('payer', payer),
    ('manuf', manuf), ('model', model), ('eq', eq), ('task', task), ('inv', inv);
END $$;

-- ---------------------------------------------------------------- Сотрудник вошёл в CRM
SELECT pg_temp.act_as((SELECT id FROM v WHERE k = 'coord'));
UPDATE tasks SET title = 'Автор: задача (исправлено)' WHERE id = (SELECT id FROM v WHERE k = 'task');
UPDATE equipment SET notes = 'Проверено координатором' WHERE id = (SELECT id FROM v WHERE k = 'eq');
INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
VALUES ('ACTOR-2', (SELECT id FROM v WHERE k = 'manuf'), (SELECT id FROM v WHERE k = 'model'), (SELECT id FROM v WHERE k = 'site'), (SELECT id FROM v WHERE k = 'payer'));
UPDATE equipment SET current_site_id = (SELECT id FROM v WHERE k = 'site2') WHERE id = (SELECT id FROM v WHERE k = 'eq');
-- Корректировка суммы счёта из интерфейса: раньше падала с «обязателен автор».
UPDATE invoices SET adjustment_amount = 700, correction_reason = 'Доплата за срочный выезд' WHERE id = (SELECT id FROM v WHERE k = 'inv');
UPDATE invoices SET status = 'issued' WHERE id = (SELECT id FROM v WHERE k = 'inv');
INSERT INTO invoices (payer_id, payer_name) VALUES ((SELECT id FROM v WHERE k = 'payer'), 'Автор: плательщик');
RESET ROLE;

SELECT pg_temp.check(pg_temp.last_actor('tasks', (SELECT id FROM v WHERE k = 'task')) = (SELECT id FROM v WHERE k = 'coord'),
  'правка задачи в журнале аудита — от координатора, а не от создателя задачи');
SELECT pg_temp.check(pg_temp.last_actor_type('tasks', (SELECT id FROM v WHERE k = 'task')) = 'user', 'автор правки задачи — сотрудник');
SELECT pg_temp.check(pg_temp.last_actor('equipment', (SELECT id FROM v WHERE k = 'eq')) = (SELECT id FROM v WHERE k = 'coord'),
  'правка прибора в журнале аудита — от координатора, а не «система»');
SELECT pg_temp.check((SELECT changed_by FROM equipment_site_history
                       WHERE equipment_id = (SELECT id FROM equipment WHERE serial_number = 'ACTOR-2') AND valid_to IS NULL)
                     = (SELECT id FROM v WHERE k = 'coord'),
  'новый прибор: первая запись места установки от координатора');
SELECT pg_temp.check((SELECT changed_by_name FROM equipment_site_history
                       WHERE equipment_id = (SELECT id FROM v WHERE k = 'eq') AND valid_to IS NULL) = 'Координатор Автор',
  'смена места прямой правкой: в истории прибора имя координатора');
SELECT pg_temp.check((SELECT count(*) FROM invoice_adjustments
                       WHERE invoice_id = (SELECT id FROM v WHERE k = 'inv')
                         AND author_id = (SELECT id FROM v WHERE k = 'coord')
                         AND reason = 'Доплата за срочный выезд') = 1,
  'корректировка счёта прошла, автор — координатор');
SELECT pg_temp.check((SELECT total_amount FROM invoices WHERE id = (SELECT id FROM v WHERE k = 'inv')) = 700, 'сумма счёта пересчитана');
SELECT pg_temp.check((SELECT changed_by FROM invoice_status_history
                       WHERE invoice_id = (SELECT id FROM v WHERE k = 'inv') AND from_status = 'draft' AND to_status = 'issued')
                     = (SELECT id FROM v WHERE k = 'coord'),
  'история статусов счёта: выставил координатор, а не создатель счёта');
SELECT pg_temp.check((SELECT h.changed_by FROM invoice_status_history AS h JOIN invoices AS i ON i.id = h.invoice_id
                       WHERE i.payer_name = 'Автор: плательщик' AND i.created_by IS NULL AND h.from_status IS NULL)
                     = (SELECT id FROM v WHERE k = 'coord'),
  'история статусов счёта: создание — от координатора');

-- Токен входа важнее служебной метки: подставить чужого автора нельзя.
SELECT pg_temp.act_as((SELECT id FROM v WHERE k = 'coord'));
SELECT set_config('app.user_id', (SELECT id FROM v WHERE k = 'eng')::text, true);
UPDATE equipment SET notes = 'Метка службы не подменяет вошедшего' WHERE id = (SELECT id FROM v WHERE k = 'eq');
RESET ROLE;
SELECT pg_temp.check(pg_temp.last_actor('equipment', (SELECT id FROM v WHERE k = 'eq')) = (SELECT id FROM v WHERE k = 'coord'),
  'при входе автор — вошедший, даже если задан app.user_id');

-- ---------------------------------------------------------------- Служба без входа
-- Служба задала автора (app.user_id): он и записывается.
SELECT pg_temp.as_service((SELECT id FROM v WHERE k = 'eng'));
UPDATE equipment SET notes = 'Правка службы с автором' WHERE id = (SELECT id FROM v WHERE k = 'eq');
SELECT pg_temp.check(pg_temp.last_actor('equipment', (SELECT id FROM v WHERE k = 'eq')) = (SELECT id FROM v WHERE k = 'eng'),
  'служба с app.user_id: автор — указанный ею сотрудник');
-- Служба указала несуществующего сотрудника: автор пустой, изменение проходит.
SELECT pg_temp.as_service(gen_random_uuid());
UPDATE invoices SET status = 'issued' WHERE payer_name = 'Автор: плательщик' AND created_by IS NULL;
SELECT pg_temp.check((SELECT h.changed_by FROM invoice_status_history AS h JOIN invoices AS i ON i.id = h.invoice_id
                       WHERE i.payer_name = 'Автор: плательщик' AND i.created_by IS NULL AND h.to_status = 'issued') IS NULL,
  'служба с неизвестным app.user_id: автор пустой, ошибки внешнего ключа нет');
-- Автора нет: как раньше, из полей строки или «система».
SELECT pg_temp.as_service(NULL);
UPDATE tasks SET title = 'Автор: правка службы' WHERE id = (SELECT id FROM v WHERE k = 'task');
UPDATE equipment SET notes = 'Правка службы без автора' WHERE id = (SELECT id FROM v WHERE k = 'eq');
SELECT pg_temp.check(pg_temp.last_actor('tasks', (SELECT id FROM v WHERE k = 'task')) = (SELECT id FROM v WHERE k = 'sup'),
  'служба без автора: правка задачи, как раньше, по полям задачи');
SELECT pg_temp.check(pg_temp.last_actor('equipment', (SELECT id FROM v WHERE k = 'eq')) IS NULL
  AND pg_temp.last_actor_type('equipment', (SELECT id FROM v WHERE k = 'eq')) = 'system',
  'служба без автора: правка прибора — «система»');
SELECT pg_temp.expect_error(format('UPDATE invoices SET adjustment_amount = 100, correction_reason = %L WHERE id = %L', 'Без автора', (SELECT id FROM v WHERE k = 'inv')),
  'корректировка счёта без автора по-прежнему отклоняется');
UPDATE invoices SET status = 'cancelled' WHERE id = (SELECT id FROM v WHERE k = 'inv');
SELECT pg_temp.check((SELECT changed_by FROM invoice_status_history
                       WHERE invoice_id = (SELECT id FROM v WHERE k = 'inv') AND to_status = 'cancelled') IS NULL,
  'служба без автора: отмена счёта — «система», а не создатель счёта');

-- Вход есть, но такого сотрудника нет: ссылка на несуществующего не пишется, правка проходит.
SELECT pg_temp.as_service(NULL);
SELECT set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
UPDATE equipment SET notes = 'Вход без карточки сотрудника' WHERE id = (SELECT id FROM v WHERE k = 'eq');
SELECT pg_temp.check(pg_temp.last_actor('equipment', (SELECT id FROM v WHERE k = 'eq')) IS NULL,
  'вход без карточки сотрудника: автор пустой, правка не падает');

ROLLBACK;
