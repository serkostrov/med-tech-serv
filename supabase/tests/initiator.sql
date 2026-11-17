-- Менеджер-инициатор (ТЗ, раздел 2): своя заявка, свои статусы, чужого не видит, цен не видит.
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/initiator.sql
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

GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.act_as_nobody(), pg_temp.check(boolean, text),
  pg_temp.expect_message(text, text, text), pg_temp.uid(text) TO authenticated;

-- ---------------------------------------------------------------- Данные
DO $$
DECLARE r text; uid uuid; org uuid; site uuid; payer uuid; man uuid; model uuid; eq uuid;
BEGIN
  FOREACH r IN ARRAY ARRAY['coordinator', 'initiator', 'initiator2', 'engineer'] LOOP
    uid := gen_random_uuid();
    INSERT INTO auth.users (id, email, aud, role) VALUES (uid, 'ini-' || r || '@test.local', 'authenticated', 'authenticated');
    INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
    VALUES (uid, 'Инициатор ' || r, (CASE WHEN r = 'initiator2' THEN 'initiator' ELSE r END)::user_role, 'ini-' || r || '@test.local', true,
            CASE WHEN r = 'initiator2' THEN 'initiator' ELSE r END);
    INSERT INTO ids VALUES (r, uid);
  END LOOP;
  INSERT INTO organizations (name) VALUES ('Инициатор: больница') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('Инициатор: КДЛ', org) RETURNING id INTO site;
  INSERT INTO payers (name) VALUES ('Инициатор: плательщик') RETURNING id INTO payer;
  INSERT INTO manufacturers (name) VALUES ('Инициатор: производитель') RETURNING id INTO man;
  INSERT INTO equipment_models (manufacturer_id, name) VALUES (man, 'Инициатор: модель') RETURNING id INTO model;
  INSERT INTO equipment (serial_number, manufacturer_id, model_id, current_site_id, current_payer_id)
  VALUES ('INI-777', man, model, site, payer) RETURNING id INTO eq;
  INSERT INTO ids VALUES ('site', site), ('payer', payer), ('eq', eq);
  -- Цена нужна, чтобы проверить, что инициатор её не видит; на живой базе она уже может быть.
  INSERT INTO price_list (work_type_code, amount, valid_from)
  SELECT 'repair', 5000, current_date - 10
   WHERE NOT EXISTS (SELECT 1 FROM price_list WHERE work_type_code = 'repair');
END $$;

-- Координатор завёл свою задачу: инициатор её не увидит.
SELECT pg_temp.act_as(pg_temp.uid('coordinator'));
WITH created AS (
  INSERT INTO public.tasks (title, work_type_code, equipment_id, site_id, payer_id, created_by, call_date, call_reason, deadline_from, deadline_to)
  VALUES ('Чужая задача', 'repair', pg_temp.uid('eq'), pg_temp.uid('site'), pg_temp.uid('payer'), pg_temp.uid('coordinator'), current_date, 'Шумит', current_date, current_date + 7)
  RETURNING id)
INSERT INTO ids SELECT 'foreign', id FROM created;

-- Инициатор находит прибор по S/N и создаёт заявку так же, как экран «Новая заявка».
SELECT pg_temp.act_as(pg_temp.uid('initiator'));
SELECT pg_temp.check((SELECT count(*) = 1 FROM public.equipment WHERE serial_number = 'INI-777'),
  'инициатор находит прибор по S/N');
WITH created AS (
  INSERT INTO public.tasks (title, work_type_code, priority, equipment_id, site_id, payer_id, initiator_id, created_by, call_date, call_reason, deadline_from, deadline_to)
  VALUES ('Ремонт: Инициатор: модель S/N INI-777', 'repair', 'urgent', pg_temp.uid('eq'), pg_temp.uid('site'), pg_temp.uid('payer'),
          pg_temp.uid('initiator'), pg_temp.uid('initiator'), current_date, 'Не проходит калибровка', current_date, current_date + 1)
  RETURNING id)
INSERT INTO ids SELECT 'own', id FROM created;
SELECT pg_temp.check((SELECT status_code = 'new' AND engineer_id IS NULL AND initiator_id = pg_temp.uid('initiator')
                        FROM public.tasks WHERE id = pg_temp.uid('own')),
  'заявка инициатора — новая, без инженера, он в ней инициатор');
SELECT pg_temp.check((SELECT count(*) = 1 FROM public.tasks) AND (SELECT count(*) = 0 FROM public.tasks WHERE id = pg_temp.uid('foreign')),
  'инициатор видит только свою заявку');
SELECT pg_temp.expect_message(
  format('INSERT INTO public.tasks (title, work_type_code, equipment_id, site_id, payer_id, engineer_id, call_date, deadline_from, deadline_to) VALUES (%L, %L, %L, %L, %L, %L, current_date, current_date, current_date + 1)',
         'С инженером', 'repair', pg_temp.uid('eq'), pg_temp.uid('site'), pg_temp.uid('payer'), pg_temp.uid('engineer')),
  'Недостаточно прав: заявка создаётся новой, без инженера и договора, от своего имени',
  'инженера инициатор не назначает');
SELECT pg_temp.expect_message(
  format('UPDATE public.tasks SET engineer_id = %L, status_code = %L WHERE id = %L', pg_temp.uid('engineer'), 'assigned', pg_temp.uid('own')),
  'Недостаточно прав: назначение, клиента, плательщика, вид работ и сроки задачи меняет координатор',
  'назначить инженера на свою заявку инициатор тоже не может');
SELECT pg_temp.check((SELECT count(*) = 0 FROM public.price_list) AND (SELECT count(*) = 0 FROM public.invoices),
  'цен и счетов инициатор не видит');

-- Второй инициатор не видит заявку первого.
SELECT pg_temp.act_as(pg_temp.uid('initiator2'));
SELECT pg_temp.check((SELECT count(*) = 0 FROM public.tasks), 'чужие заявки другому инициатору не видны');

-- Координатор видит заявку инициатора и назначает инженера: статус меняется у инициатора.
SELECT pg_temp.act_as(pg_temp.uid('coordinator'));
UPDATE public.tasks SET engineer_id = pg_temp.uid('engineer'), status_code = 'assigned' WHERE id = pg_temp.uid('own');
SELECT pg_temp.act_as(pg_temp.uid('initiator'));
SELECT pg_temp.check((SELECT status_code = 'assigned' FROM public.tasks WHERE id = pg_temp.uid('own')),
  'инициатор видит, что координатор назначил инженера');
SELECT pg_temp.act_as_nobody();

ROLLBACK;
