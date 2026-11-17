-- Возврат части выданной запчасти (миграция 0066).
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/partial_return.sql
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

-- Работы в счёте одной строкой: «вид×цена=сумма» через « | », по виду работ.
CREATE FUNCTION pg_temp.works(p_invoice uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(string_agg(format('%s×%s=%s', item.work_type_code, trim_scale(item.unit_price), trim_scale(item.line_total)),
                             ' | ' ORDER BY item.work_type_code), '')
    FROM public.invoice_items AS item
   WHERE item.invoice_id = p_invoice AND item.item_type = 'work'
$$;

GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.act_as_nobody(), pg_temp.check(boolean, text),
  pg_temp.expect_message(text, text, text), pg_temp.uid(text), pg_temp.works(uuid) TO authenticated;

-- ---------------------------------------------------------------- Данные
DO $$
DECLARE
  r text; uid uuid;
  org uuid; site uuid; payer uuid; man uuid; model uuid; eq uuid; task uuid; part uuid; lot uuid;
BEGIN
  FOREACH r IN ARRAY ARRAY['coordinator', 'engineer', 'warehouse'] LOOP
    uid := gen_random_uuid();
    INSERT INTO auth.users (id, email, aud, role) VALUES (uid, 'ret-' || r || '@test.local', 'authenticated', 'authenticated');
    INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
    VALUES (uid, 'Возврат ' || r, r::user_role, 'ret-' || r || '@test.local', true, r);
    INSERT INTO ids VALUES (r, uid);
  END LOOP;
  INSERT INTO organizations (name) VALUES ('Возврат: организация') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('Возврат: площадка', org) RETURNING id INTO site;
  INSERT INTO payers (name) VALUES ('Возврат: плательщик') RETURNING id INTO payer;
  INSERT INTO manufacturers (name) VALUES ('Возврат: производитель') RETURNING id INTO man;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (man, 'Возврат: модель') RETURNING id INTO model;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  VALUES ('RET-1', man, model, site, payer) RETURNING id INTO eq;
  INSERT INTO tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, created_by,
    deadline_from, deadline_to, status_code, visit_date, call_reason, work_description)
  VALUES ('Замена фильтров', 'repair', eq, site, payer, (SELECT id FROM ids WHERE k = 'engineer'), (SELECT id FROM ids WHERE k = 'coordinator'),
    current_date, current_date + 7, 'in_progress', current_date, 'Грязные фильтры', 'Заменён фильтр')
  RETURNING id INTO task;
  INSERT INTO parts (article_number, name) VALUES ('FLT-1', 'Фильтр') RETURNING id INTO part;
  INSERT INTO stock_lots (part_id, part_condition) VALUES (part, 'N') RETURNING id INTO lot;
  INSERT INTO stock_movements (idempotency_key, movement_type, lot_id, part_id, part_condition, quantity, on_hand_delta)
  VALUES ('ret:receipt', 'receipt', lot, part, 'N', 10, 10);
  INSERT INTO ids VALUES ('task', task), ('part', part);
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

CREATE FUNCTION pg_temp.on_hand() RETURNS numeric LANGUAGE sql AS $$
  SELECT coalesce(sum(on_hand_delta), 0) FROM stock_movements WHERE part_id = (SELECT id FROM ids WHERE k = 'part')
$$;
GRANT EXECUTE ON FUNCTION pg_temp.on_hand() TO authenticated;

-- Выдали инженеру три фильтра, он отметил их установленными.
SELECT pg_temp.act_as(pg_temp.uid('warehouse'));
DO $$
DECLARE res uuid;
BEGIN
  SELECT created.id INTO res FROM public.create_task_part_reservation(pg_temp.uid('task'), pg_temp.uid('part'), 'N', 3) AS created;
  INSERT INTO ids VALUES ('res', res);
END $$;
UPDATE public.stock_reservations SET status = 'warehouse_notified' WHERE id = pg_temp.uid('res');
SELECT public.issue_stock_reservation(pg_temp.uid('res'));
SELECT pg_temp.act_as(pg_temp.uid('engineer'));
SELECT public.set_task_parts_installed(pg_temp.uid('task'), ARRAY[pg_temp.uid('res')]::uuid[]);
SELECT pg_temp.act_as_nobody();
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.check(pg_temp.on_hand() = 7, 'выдали 3 из 10');
SELECT pg_temp.check((SELECT quantity = 3 AND installed FROM task_parts WHERE reservation_id = pg_temp.uid('res')), 'в задаче 3 установлено');

-- Один не пригодился: вернули 1 из 3.
SELECT pg_temp.act_as(pg_temp.uid('warehouse'));
SELECT public.return_stock_reservation(pg_temp.uid('res'), 1);
SELECT pg_temp.act_as_nobody();
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.check((SELECT status = 'issued' AND quantity = 2 FROM stock_reservations WHERE id = pg_temp.uid('res')),
  'резерв остался у инженера: 2 шт.');
SELECT pg_temp.check(pg_temp.on_hand() = 8, 'на склад вернулся 1');
SELECT pg_temp.check((SELECT quantity = 2 FROM task_parts WHERE reservation_id = pg_temp.uid('res')),
  'в карточке задачи установлено 2 — по остатку');
SELECT pg_temp.check((SELECT count(*) = 1 FROM stock_movements m JOIN stock_document_lines l ON l.movement_id = m.id
                       JOIN stock_documents d ON d.id = l.document_id
                      WHERE m.reservation_id = pg_temp.uid('res') AND m.movement_type = 'return' AND m.quantity = 1 AND d.kind = 'return'),
  'возврат части попал в документ возврата');

-- Отказы.
SELECT pg_temp.act_as(pg_temp.uid('warehouse'));
SELECT pg_temp.expect_message(format('SELECT public.return_stock_reservation(%L, 5)', pg_temp.uid('res')),
  'Выдано 2: вернуть больше нельзя', 'больше выданного не вернуть');
SELECT pg_temp.expect_message(format('SELECT public.return_stock_reservation(%L, 0)', pg_temp.uid('res')),
  'Укажите, сколько вернули: больше нуля', 'ноль не возврат');
SELECT pg_temp.expect_message(format('SELECT public.return_stock_reservation(%L, 0.5)', pg_temp.uid('res')),
  'Запчасть «FLT-1» считается штуками: укажите целое количество. Если её меряют метрами или литрами, снимите в карточке запчасти галочку «Считается штуками»',
  'полфильтра не вернуть');
-- Кладовщик сам количество выданного резерва не меняет: только через возврат.
SELECT pg_temp.expect_message(format('UPDATE public.stock_reservations SET quantity = 1 WHERE id = %L', pg_temp.uid('res')),
  'После выдачи или отмены нельзя менять запчасть и количество резерва', 'напрямую количество выданного не поменять');

-- Остаток вернули целиком: как раньше, резерв «Возвращена», строка из задачи ушла.
SELECT public.return_stock_reservation(pg_temp.uid('res'));
SELECT pg_temp.act_as_nobody();
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.check((SELECT status = 'returned' FROM stock_reservations WHERE id = pg_temp.uid('res')), 'остаток вернули — резерв закрыт');
SELECT pg_temp.check(pg_temp.on_hand() = 10, 'на складе снова 10');
SELECT pg_temp.check((SELECT count(*) = 0 FROM task_parts WHERE task_id = pg_temp.uid('task') AND reservation_id IS NOT NULL),
  'в задаче не осталось установленных');

ROLLBACK;
