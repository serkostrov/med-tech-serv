-- Штучная запчасть не делится (миграция 0065).
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/countable_parts.sql
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
DECLARE fuse uuid; tube uuid; fuse_lot uuid; tube_lot uuid;
BEGIN
  INSERT INTO parts (article_number, name) VALUES ('FUSE-5A', 'Предохранитель') RETURNING id INTO fuse;
  INSERT INTO parts (article_number, name, is_countable) VALUES ('TUBE-SIL', 'Трубка, метр', false) RETURNING id INTO tube;
  INSERT INTO stock_lots (part_id, part_condition) VALUES (fuse, 'N') RETURNING id INTO fuse_lot;
  INSERT INTO stock_lots (part_id, part_condition) VALUES (tube, 'N') RETURNING id INTO tube_lot;
  INSERT INTO ids VALUES ('fuse', fuse), ('tube', tube), ('fuse_lot', fuse_lot), ('tube_lot', tube_lot);
END $$;

SELECT pg_temp.check((SELECT is_countable FROM parts WHERE id = pg_temp.uid('fuse')), 'новая запчасть по умолчанию считается штуками');

SELECT pg_temp.expect_message(
  format('INSERT INTO stock_movements (idempotency_key, movement_type, lot_id, part_id, part_condition, quantity, on_hand_delta) VALUES (%L, %L, %L, %L, %L, 1.5, 1.5)',
    'r-fuse-1', 'receipt', pg_temp.uid('fuse_lot'), pg_temp.uid('fuse'), 'N'),
  'Запчасть «FUSE-5A» считается штуками: укажите целое количество. Если её меряют метрами или литрами, снимите в карточке запчасти галочку «Считается штуками»',
  'полтора предохранителя не оприходовать');

INSERT INTO stock_movements (idempotency_key, movement_type, lot_id, part_id, part_condition, quantity, on_hand_delta)
VALUES ('r-fuse-2', 'receipt', pg_temp.uid('fuse_lot'), pg_temp.uid('fuse'), 'N', 3, 3),
       ('r-tube-1', 'receipt', pg_temp.uid('tube_lot'), pg_temp.uid('tube'), 'N', 2.5, 2.5);
SELECT pg_temp.check((SELECT sum(quantity) = 5.5 FROM stock_movements WHERE idempotency_key IN ('r-fuse-2', 'r-tube-1')),
  'целые штуки и метры дробью проходят');

SELECT pg_temp.expect_message(
  format('INSERT INTO stock_reservations (part_id, part_condition, quantity) VALUES (%L, %L, 0.5)', pg_temp.uid('fuse'), 'N'),
  'Запчасть «FUSE-5A» считается штуками: укажите целое количество. Если её меряют метрами или литрами, снимите в карточке запчасти галочку «Считается штуками»',
  'полпредохранителя не зарезервировать');

ROLLBACK;
