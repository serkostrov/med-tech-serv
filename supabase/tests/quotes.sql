-- КП (ТЗ, блок 9, миграция 0071): права, итог, статусы, правка только в черновике.
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/quotes.sql
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
DECLARE r text; uid uuid; org uuid; site uuid; payer uuid; part uuid; piece uuid;
BEGIN
  FOREACH r IN ARRAY ARRAY['coordinator', 'engineer', 'warehouse', 'supervisor'] LOOP
    uid := gen_random_uuid();
    INSERT INTO auth.users (id, email, aud, role) VALUES (uid, 'kp-' || r || '@test.local', 'authenticated', 'authenticated');
    INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key)
    VALUES (uid, 'КП ' || r, r::user_role, 'kp-' || r || '@test.local', true, r);
    INSERT INTO ids VALUES (r, uid);
  END LOOP;
  INSERT INTO organizations (name) VALUES ('КП: больница') RETURNING id INTO org;
  INSERT INTO sites (name, organization_id) VALUES ('КП: КДЛ', org) RETURNING id INTO site;
  INSERT INTO payers (name) VALUES ('КП: плательщик') RETURNING id INTO payer;
  INSERT INTO parts (article_number, name) VALUES ('KP-LAMP', 'Лампа галогеновая') RETURNING id INTO piece;
  INSERT INTO parts (article_number, name, is_countable) VALUES ('KP-TUBE', 'Трубка силиконовая, м', false) RETURNING id INTO part;
  INSERT INTO ids VALUES ('site', site), ('payer', payer), ('lamp', piece), ('tube', part);
END $$;

-- Координатор заводит КП: черновик, автор ставится сам, номер КП-.
SELECT pg_temp.act_as(pg_temp.uid('coordinator'));
WITH created AS (
  INSERT INTO public.quotes (name, site_id, payer_id, valid_until)
  VALUES ('Лампы и трубки для КДЛ', pg_temp.uid('site'), pg_temp.uid('payer'), current_date + 14)
  RETURNING id)
INSERT INTO ids SELECT 'quote', id FROM created;
SELECT pg_temp.check((SELECT status = 'draft' AND number LIKE 'КП-%' AND created_by = pg_temp.uid('coordinator')
                        FROM public.quotes WHERE id = pg_temp.uid('quote')),
  'новое КП — черновик с номером и автором');
SELECT pg_temp.expect_message(
  format('UPDATE public.quotes SET status = %L WHERE id = %L', 'sent', pg_temp.uid('quote')),
  'В КП нет позиций: добавьте запчасти или работы, потом отправляйте клиенту',
  'пустое КП клиенту не отправить');
INSERT INTO public.quote_items (quote_id, part_id, description, quantity, unit_price)
VALUES (pg_temp.uid('quote'), pg_temp.uid('lamp'), 'Лампа галогеновая (KP-LAMP)', 2, 1500),
       (pg_temp.uid('quote'), pg_temp.uid('tube'), 'Трубка силиконовая, м (KP-TUBE)', 2.5, 100);
INSERT INTO public.quote_items (quote_id, work_type_code, description, quantity, unit_price)
VALUES (pg_temp.uid('quote'), 'repair', 'Ремонт', 1, 4000);
SELECT pg_temp.check((SELECT total_amount = 7250 FROM public.quotes WHERE id = pg_temp.uid('quote')),
  'итог КП считается сам: 2×1500 + 2,5×100 + 4000 = 7250');
SELECT pg_temp.expect_message(
  format('INSERT INTO public.quote_items (quote_id, part_id, description, quantity, unit_price) VALUES (%L, %L, %L, 1.5, 10)',
         pg_temp.uid('quote'), pg_temp.uid('lamp'), 'Лампа'),
  'Запчасть «KP-LAMP» считается штуками: укажите целое количество',
  'штучную запчасть дробью в КП не положить');

-- Инженер и кладовщик КП не видят и не заводят.
SELECT pg_temp.act_as(pg_temp.uid('engineer'));
SELECT pg_temp.check((SELECT count(*) = 0 FROM public.quotes) AND (SELECT count(*) = 0 FROM public.quote_items),
  'инженер КП и позиции не видит');
SELECT pg_temp.expect_message(
  format('INSERT INTO public.quotes (name) VALUES (%L)', 'Чужое КП'),
  'new row violates row-level security policy for table "quotes"',
  'инженер КП не заводит');
SELECT pg_temp.act_as(pg_temp.uid('warehouse'));
SELECT pg_temp.check((SELECT count(*) = 0 FROM public.quotes), 'кладовщик КП не видит');

-- Отправили клиенту: позиции и шапка заперты, удалить нельзя.
SELECT pg_temp.act_as(pg_temp.uid('coordinator'));
UPDATE public.quotes SET status = 'sent' WHERE id = pg_temp.uid('quote');
SELECT pg_temp.expect_message(
  format('UPDATE public.quote_items SET unit_price = 1 WHERE quote_id = %L', pg_temp.uid('quote')),
  'КП уже не черновик: позиции меняют только в черновике. Верните КП в черновик, чтобы поправить',
  'в отправленном КП позиции не меняются');
SELECT pg_temp.expect_message(
  format('UPDATE public.quotes SET name = %L WHERE id = %L', 'Другое', pg_temp.uid('quote')),
  'КП уже не черновик: название, клиента и срок действия меняют в черновике',
  'в отправленном КП шапка не меняется');
SELECT pg_temp.expect_message(
  format('DELETE FROM public.quotes WHERE id = %L', pg_temp.uid('quote')),
  'permission denied for table quotes',
  'КП через API не удаляется (0024): его отклоняют');

-- Вернули в черновик, поправили, снова отправили; клиент принял — это окончательно.
UPDATE public.quotes SET status = 'draft' WHERE id = pg_temp.uid('quote');
UPDATE public.quote_items SET unit_price = 1400 WHERE quote_id = pg_temp.uid('quote') AND part_id = pg_temp.uid('lamp');
SELECT pg_temp.check((SELECT total_amount = 7050 FROM public.quotes WHERE id = pg_temp.uid('quote')),
  'в черновике позицию поправили, итог пересчитан');
INSERT INTO public.quote_items (quote_id, work_type_code, description, quantity, unit_price)
VALUES (pg_temp.uid('quote'), 'diagnostics', 'Диагностика', 1, 999);
DELETE FROM public.quote_items WHERE quote_id = pg_temp.uid('quote') AND work_type_code = 'diagnostics';
SELECT pg_temp.check((SELECT total_amount = 7050 FROM public.quotes WHERE id = pg_temp.uid('quote')),
  'в черновике позицию можно удалить, итог пересчитан');
UPDATE public.quotes SET status = 'sent' WHERE id = pg_temp.uid('quote');
UPDATE public.quotes SET status = 'accepted' WHERE id = pg_temp.uid('quote');
SELECT pg_temp.expect_message(
  format('UPDATE public.quotes SET status = %L WHERE id = %L', 'draft', pg_temp.uid('quote')),
  (SELECT format('%s нельзя перевести из «Принято» в «Черновик»', number) FROM public.quotes WHERE id = pg_temp.uid('quote')),
  'принятое КП в черновик не вернуть');

-- Руководитель видит КП; ненужный черновик отменяют — он становится «Отклонено».
SELECT pg_temp.act_as(pg_temp.uid('supervisor'));
SELECT pg_temp.check((SELECT count(*) = 1 FROM public.quotes WHERE id = pg_temp.uid('quote')), 'руководитель видит КП');
WITH created AS (INSERT INTO public.quotes (name) VALUES ('Ненужный черновик') RETURNING id)
INSERT INTO ids SELECT 'draft2', id FROM created;
UPDATE public.quotes SET status = 'rejected' WHERE id = pg_temp.uid('draft2');
SELECT pg_temp.check((SELECT status = 'rejected' FROM public.quotes WHERE id = pg_temp.uid('draft2')),
  'черновик отменили: он отклонён и остаётся в истории');
SELECT pg_temp.act_as_nobody();

ROLLBACK;
