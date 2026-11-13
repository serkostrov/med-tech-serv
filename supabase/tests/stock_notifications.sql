-- Складская цепочка уведомлений (миграция 0029): кладовщику — новый резерв,
-- инженеру — «запчасть можно забрать».
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/stock_notifications.sql
-- Всё выполняется в транзакции и откатывается. Ошибка = проверка не прошла.
-- Проверки смотрят только на свои тестовые записи, поэтому другие данные в базе не мешают.

BEGIN;

CREATE FUNCTION pg_temp.check(p_ok boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'ПРОВАЛ: %', p_label;
  END IF;
  RAISE NOTICE 'ok: %', p_label;
END $$;

CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid);

-- Событие в outbox по агрегату и коду.
CREATE FUNCTION pg_temp.event_of(p_key text, p_code text) RETURNS uuid LANGUAGE sql AS $$
  SELECT event.id FROM public.integration_outbox event
   WHERE event.event_type = p_code
     AND event.aggregate_id = (SELECT id FROM ids WHERE k = p_key)
$$;

-- Адресаты плана одной строкой по алфавиту: так проверка читается целиком.
CREATE FUNCTION pg_temp.email_to(p_key text, p_code text) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(plan.recipient_address, ', ' ORDER BY plan.recipient_address), 'никто')
    FROM public.load_email_event_plan(pg_temp.event_of(p_key, p_code)) plan
$$;

CREATE FUNCTION pg_temp.telegram_to(p_key text, p_code text) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(plan.recipient_address, ', ' ORDER BY plan.recipient_address), 'никто')
    FROM public.load_telegram_event_plan(pg_temp.event_of(p_key, p_code)) plan
$$;

-- Переменная шаблона для одного адресата.
CREATE FUNCTION pg_temp.email_var(p_key text, p_code text, p_address text, p_name text) RETURNS text LANGUAGE sql AS $$
  SELECT plan.variables ->> p_name
    FROM public.load_email_event_plan(pg_temp.event_of(p_key, p_code)) plan
   WHERE plan.recipient_address = p_address
$$;

CREATE FUNCTION pg_temp.telegram_var(p_key text, p_code text, p_address text, p_name text) RETURNS text LANGUAGE sql AS $$
  SELECT plan.variables ->> p_name
    FROM public.load_telegram_event_plan(pg_temp.event_of(p_key, p_code)) plan
   WHERE plan.recipient_address = p_address
$$;

DO $$
DECLARE
  coord uuid := gen_random_uuid();
  eng uuid := gen_random_uuid();
  eng2 uuid := gen_random_uuid();
  store1 uuid := gen_random_uuid();
  store2 uuid := gen_random_uuid();
  store3 uuid := gen_random_uuid();
  org uuid; site uuid; payer uuid; manuf uuid; model uuid; eq uuid; wt text;
  part uuid; task uuid; solo uuid; agreement uuid;
  res uuid; res_solo uuid; res_contract uuid;
BEGIN
  INSERT INTO auth.users (id, email, aud, role) VALUES
    (coord, 'coord@stock.test', 'authenticated', 'authenticated'),
    (eng, 'eng@stock.test', 'authenticated', 'authenticated'),
    (eng2, 'eng2@stock.test', 'authenticated', 'authenticated'),
    (store1, 'store1@stock.test', 'authenticated', 'authenticated'),
    (store2, 'store2@stock.test', 'authenticated', 'authenticated'),
    (store3, 'store3@stock.test', 'authenticated', 'authenticated');
  -- Два кладовщика на смене (у второго нет Telegram), третий уволен;
  -- второй инженер не на этой задаче — ему забирать нечего.
  INSERT INTO public.users (id, full_name, role, email, telegram_chat_id, is_active, access_role_key) VALUES
    (coord, 'Тест координатор', 'coordinator', 'coord@stock.test', NULL, true, 'coordinator'),
    (eng, 'Тест инженер', 'engineer', 'eng@stock.test', '7000001', true, 'engineer'),
    (eng2, 'Другой инженер', 'engineer', 'eng2@stock.test', '7000002', true, 'engineer'),
    (store1, 'Кладовщик один', 'warehouse', 'store1@stock.test', '7000003', true, 'warehouse'),
    (store2, 'Кладовщик два', 'warehouse', 'store2@stock.test', NULL, true, 'warehouse'),
    (store3, 'Кладовщик уволен', 'warehouse', 'store3@stock.test', '7000004', false, 'warehouse');

  INSERT INTO organizations (name) VALUES ('Тестовая больница склада') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('ГКБ № 1', org) RETURNING id INTO site;
  INSERT INTO payers (name) VALUES ('Плательщик склада') RETURNING id INTO payer;
  INSERT INTO manufacturers (name) VALUES ('Склад-Производитель') RETURNING id INTO manuf;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (manuf, 'BS-620') RETURNING id INTO model;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  VALUES ('SN-STOCK-1', manuf, model, site, payer) RETURNING id INTO eq;
  SELECT code INTO wt FROM work_types WHERE is_active ORDER BY code LIMIT 1;
  INSERT INTO parts (article_number, name) VALUES ('115-107131-00', 'клапан') RETURNING id INTO part;

  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, initiator_id, created_by, call_date, deadline_from, deadline_to, status_code)
  VALUES ('Ремонт BS-620', wt, eq, site, payer, eng, coord, coord, '2026-11-01', '2026-11-05', '2026-11-12', 'assigned') RETURNING id INTO task;
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, created_by, call_date, deadline_from, deadline_to, status_code)
  VALUES ('Задача без инженера', wt, eq, site, payer, coord, '2026-11-01', '2026-11-05', '2026-11-12', 'new') RETURNING id INTO solo;
  INSERT INTO contracts (name, site_id, payer_id, created_by)
  VALUES ('Договор на обслуживание', site, payer, coord) RETURNING id INTO agreement;

  -- INSERT резерва ставит в очередь stock_reservation_created (0001).
  INSERT INTO stock_reservations (part_id, part_condition, quantity, task_id, requested_by)
  VALUES (part, 'N', 1, task, coord) RETURNING id INTO res;
  INSERT INTO stock_reservations (part_id, part_condition, quantity, task_id, requested_by)
  VALUES (part, 'N', 2, solo, coord) RETURNING id INTO res_solo;
  INSERT INTO stock_reservations (part_id, part_condition, quantity, contract_id, requested_by)
  VALUES (part, 'N', 3, agreement, coord) RETURNING id INTO res_contract;

  -- Кнопка склада «Собрано»: created -> warehouse_notified, инженеру можно забирать.
  UPDATE stock_reservations SET status = 'warehouse_notified'
   WHERE id IN (res, res_solo, res_contract);

  INSERT INTO ids VALUES ('res', res), ('solo', res_solo), ('contract', res_contract), ('task', task);
END $$;

-- Оба события встали в очередь: без них проверять нечего.
SELECT pg_temp.check(pg_temp.event_of('res', 'stock_reservation_created') IS NOT NULL, 'резерв создан: событие в очереди');
SELECT pg_temp.check(pg_temp.event_of('res', 'stock_reservation_ready') IS NOT NULL, 'отметка «Собрано»: событие в очереди');

-- Новый резерв собирает склад.
SELECT pg_temp.check(pg_temp.email_to('res', 'stock_reservation_created') = 'store1@stock.test, store2@stock.test', 'новый резерв: письмо активным кладовщикам');
SELECT pg_temp.check(pg_temp.telegram_to('res', 'stock_reservation_created') = '7000003', 'новый резерв: в Telegram кладовщику с номером чата');
SELECT pg_temp.check(pg_temp.email_to('res', 'stock_reservation_created') NOT LIKE '%store3%', 'уволенный кладовщик ничего не получает');
SELECT pg_temp.check(pg_temp.telegram_to('res', 'stock_reservation_created') NOT LIKE '%7000004%', 'уволенный кладовщик не получает и в Telegram');

-- Собранную запчасть забирает инженер задачи, больше никто.
SELECT pg_temp.check(pg_temp.email_to('res', 'stock_reservation_ready') = 'eng@stock.test', '«можно забрать»: письмо инженеру задачи');
SELECT pg_temp.check(pg_temp.telegram_to('res', 'stock_reservation_ready') = '7000001', '«можно забрать»: в Telegram инженеру задачи');
SELECT pg_temp.check(pg_temp.email_to('res', 'stock_reservation_ready') NOT LIKE '%store%', 'кладовщики второе уведомление не получают');
SELECT pg_temp.check(pg_temp.email_to('res', 'stock_reservation_ready') NOT LIKE '%eng2%', 'инженер чужой задачи уведомление не получает');

-- Переменные шаблона: что собрать, сколько и для какой задачи.
SELECT pg_temp.check(pg_temp.email_var('res', 'stock_reservation_created', 'store1@stock.test', 'recipientName') = 'Кладовщик один', 'в переменных есть имя получателя');
SELECT pg_temp.check(pg_temp.email_var('res', 'stock_reservation_created', 'store1@stock.test', 'reservationNumber') LIKE 'Р-%', 'в переменных есть номер резерва');
SELECT pg_temp.check(pg_temp.email_var('res', 'stock_reservation_created', 'store1@stock.test', 'partArticle') = '115-107131-00', 'в переменных есть артикул запчасти');
SELECT pg_temp.check(pg_temp.email_var('res', 'stock_reservation_created', 'store1@stock.test', 'partName') = 'клапан', 'в переменных есть название запчасти');
SELECT pg_temp.check(pg_temp.email_var('res', 'stock_reservation_created', 'store1@stock.test', 'quantity') = '1', 'количество без лишних нулей');
SELECT pg_temp.check(pg_temp.email_var('res', 'stock_reservation_created', 'store1@stock.test', 'condition') = 'новая', 'состояние запчасти словом, как в CRM');
SELECT pg_temp.check(pg_temp.email_var('res', 'stock_reservation_created', 'store1@stock.test', 'taskNumber') LIKE 'З-%', 'в переменных есть номер задачи');
SELECT pg_temp.check(pg_temp.email_var('res', 'stock_reservation_created', 'store1@stock.test', 'taskTitle') = 'Ремонт BS-620', 'в переменных есть название задачи');
SELECT pg_temp.check(pg_temp.email_var('res', 'stock_reservation_created', 'store1@stock.test', 'siteName') = 'ГКБ № 1', 'в переменных есть площадка');
SELECT pg_temp.check(pg_temp.email_var('res', 'stock_reservation_created', 'store1@stock.test', 'engineerName') = 'Тест инженер', 'в переменных есть инженер задачи');
SELECT pg_temp.check(pg_temp.telegram_var('res', 'stock_reservation_ready', '7000001', 'partName') = 'клапан', 'те же переменные уходят в Telegram');
SELECT pg_temp.check(pg_temp.telegram_var('res', 'stock_reservation_ready', '7000001', 'recipientName') = 'Тест инженер', 'в Telegram имя получателя — инженер');

-- Задача резерва нужна worker-у: по ней он строит ссылку на карточку.
SELECT pg_temp.check(
  (SELECT bool_and(plan.task_id = (SELECT id FROM ids WHERE k = 'task'))
     FROM public.load_email_event_plan(pg_temp.event_of('res', 'stock_reservation_created')) plan),
  'в плане стоит задача резерва');

-- Текст берётся из шаблона события, а не из кода worker-а.
SELECT pg_temp.check(
  (SELECT bool_and(plan.body_template LIKE '%{{reservationNumber}}%' AND plan.subject_template <> '')
     FROM public.load_email_event_plan(pg_temp.event_of('res', 'stock_reservation_created')) plan),
  'письмо собирается из шаблона stock_reservation_created');
SELECT pg_temp.check(
  (SELECT bool_and('reservationNumber' = ANY (plan.allowed_variables) AND 'condition' = ANY (plan.allowed_variables))
     FROM public.load_telegram_event_plan(pg_temp.event_of('res', 'stock_reservation_ready')) plan),
  'переменные резерва разрешены в шаблоне');

-- Канал можно отключить себе, как и для задачных событий.
INSERT INTO notification_preferences (user_id, event_code, channel, is_enabled)
SELECT id, 'stock_reservation_created', 'telegram', false FROM public.users WHERE email = 'store1@stock.test';
SELECT pg_temp.check(pg_temp.telegram_to('res', 'stock_reservation_created') = 'никто', 'отключённый Telegram кладовщика молчит');
SELECT pg_temp.check(pg_temp.email_to('res', 'stock_reservation_created') = 'store1@stock.test, store2@stock.test', 'отключение Telegram не трогает почту');
DELETE FROM notification_preferences WHERE event_code = 'stock_reservation_created';

-- Задача без инженера: собирать резерв надо, а забирать его некому.
SELECT pg_temp.check(pg_temp.email_to('solo', 'stock_reservation_created') = 'store1@stock.test, store2@stock.test', 'резерв по задаче без инженера кладовщики видят');
SELECT pg_temp.check(pg_temp.email_to('solo', 'stock_reservation_ready') = 'никто', 'у задачи без инженера забирать запчасть некому');
SELECT pg_temp.check(pg_temp.telegram_to('solo', 'stock_reservation_ready') = 'никто', 'то же в Telegram');

-- Резерв по договору задачи не имеет: адресата пока нет ни в одном канале.
SELECT pg_temp.check(pg_temp.email_to('contract', 'stock_reservation_created') = 'никто', 'резерв по договору писем не даёт');
SELECT pg_temp.check(pg_temp.telegram_to('contract', 'stock_reservation_ready') = 'никто', 'резерв по договору сообщений не даёт');

-- Уволенному инженеру уведомление не уходит.
UPDATE public.users SET is_active = false WHERE email = 'eng@stock.test';
SELECT pg_temp.check(pg_temp.email_to('res', 'stock_reservation_ready') = 'никто', 'уволенный инженер «можно забрать» не получает');
SELECT pg_temp.check(pg_temp.telegram_to('res', 'stock_reservation_ready') = 'никто', 'уволенный инженер не получает и в Telegram');
UPDATE public.users SET is_active = true WHERE email = 'eng@stock.test';

-- Задачные события не изменились: назначение по-прежнему уходит инициатору и инженеру.
SELECT pg_temp.check(pg_temp.email_to('task', 'task_engineer_assigned') = 'coord@stock.test, eng@stock.test', 'назначение инженера: адресаты задачи прежние');
SELECT pg_temp.check(pg_temp.telegram_to('task', 'task_engineer_assigned') = '7000001', 'назначение инженера: Telegram прежний');
SELECT pg_temp.check(pg_temp.email_var('task', 'task_engineer_assigned', 'eng@stock.test', 'taskTitle') = 'Ремонт BS-620', 'переменные задачи прежние');
SELECT pg_temp.check(pg_temp.email_var('task', 'task_engineer_assigned', 'eng@stock.test', 'reservationNumber') IS NULL, 'в задачном событии складских переменных нет');

-- Планы рассылки читает только служба.
SELECT pg_temp.check(has_function_privilege('medtech_worker', 'public.load_email_event_plan(uuid)', 'execute'), 'служба читает план почты');
SELECT pg_temp.check(has_function_privilege('medtech_worker', 'public.load_telegram_event_plan(uuid)', 'execute'), 'служба читает план Telegram');
SELECT pg_temp.check(NOT has_function_privilege('anon', 'public.load_email_event_plan(uuid)', 'execute'), 'гость план почты не читает');
SELECT pg_temp.check(NOT has_function_privilege('authenticated', 'public.load_email_event_plan(uuid)', 'execute'), 'вошедший пользователь план почты не читает');
SELECT pg_temp.check(NOT has_function_privilege('medtech_api', 'public.load_email_event_plan(uuid)', 'execute'), 'роль API план почты не читает');
SELECT pg_temp.check(NOT has_function_privilege('anon', 'public.load_telegram_event_plan(uuid)', 'execute'), 'гость план Telegram не читает');
SELECT pg_temp.check(NOT has_function_privilege('authenticated', 'public.load_telegram_event_plan(uuid)', 'execute'), 'вошедший пользователь план Telegram не читает');
SELECT pg_temp.check(NOT has_function_privilege('medtech_api', 'public.load_telegram_event_plan(uuid)', 'execute'), 'роль API план Telegram не читает');

ROLLBACK;
