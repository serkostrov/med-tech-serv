-- Встроенные значения справочников не отключаются и не удаляются (миграция 0033).
-- Запуск на базе со всеми миграциями:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/builtin_reference_values.sql
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

-- Ожидаем отказ и проверяем, что он написан по-русски и без внутренних кодов.
CREATE FUNCTION pg_temp.expect_russian_refusal(p_sql text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  message text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN check_violation OR raise_exception OR insufficient_privilege THEN
    message := SQLERRM;
    IF message !~ '[а-яё]' THEN
      RAISE EXCEPTION 'ПРОВАЛ: % — отказ не по-русски: %', p_label, message;
    END IF;
    RAISE NOTICE 'ok: % (отказ: %)', p_label, message;
    RETURN;
  END;
  RAISE EXCEPTION 'ПРОВАЛ: % — команда прошла, а должна быть запрещена', p_label;
END $$;

CREATE FUNCTION pg_temp.rows_affected(p_sql text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid);
GRANT SELECT ON ids TO authenticated;
CREATE FUNCTION pg_temp.uid(p_key text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM ids WHERE k = p_key
$$;
GRANT EXECUTE ON FUNCTION pg_temp.act_as(uuid), pg_temp.act_as_nobody(), pg_temp.check(boolean, text),
  pg_temp.expect_russian_refusal(text, text), pg_temp.rows_affected(text), pg_temp.uid(text) TO authenticated;

-- Данные: администратор (ведёт справочники) и координатор (справочники не ведёт).
DO $$
DECLARE
  admin_id uuid := gen_random_uuid();
  coord uuid := gen_random_uuid();
BEGIN
  INSERT INTO ids VALUES ('admin', admin_id), ('coord', coord);
  INSERT INTO auth.users (id, email, aud, role) VALUES
    (admin_id, 'admin@test.local', 'authenticated', 'authenticated'),
    (coord, 'coord@test.local', 'authenticated', 'authenticated');
  INSERT INTO public.users (id, full_name, role, email, is_active, access_role_key) VALUES
    (admin_id, 'Тест администратор', 'admin', 'admin@test.local', true, 'admin'),
    (coord, 'Тест координатор', 'coordinator', 'coord@test.local', true, 'coordinator');
END $$;

-- -------------------------------------------------------------- Разметка справочников
SELECT pg_temp.check((SELECT count(*) FROM task_statuses WHERE is_builtin) = 7,
  'все семь этапов схемы ТЗ помечены встроенными');
SELECT pg_temp.check((SELECT is_builtin AND is_active FROM task_statuses WHERE code = 'closed'),
  'этап «Закрыта» встроенный и включён');
SELECT pg_temp.check(NOT (SELECT is_builtin FROM task_statuses WHERE code = 'rework'),
  'легаси-этап «На доработке» встроенным не считается и остаётся выключенным');
SELECT pg_temp.check(NOT (SELECT is_active FROM task_statuses WHERE code = 'rework'),
  'миграция не включила обратно легаси-этап «На доработке»');
SELECT pg_temp.check((SELECT bool_and(is_builtin AND is_active) FROM equipment_statuses WHERE code IN ('in_use', 'written_off')),
  'статусы прибора «В эксплуатации» и «Списан» встроенные и включены');
SELECT pg_temp.check((SELECT bool_and(is_builtin AND is_active) FROM work_types WHERE code IN ('maintenance', 'other')),
  'виды работ «ТО по сервисной документации» и «Прочие работы» встроенные и включены');

-- -------------------------------------------------------------- Чего больше нельзя
SELECT pg_temp.act_as(pg_temp.uid('admin'));
SELECT pg_temp.expect_russian_refusal(
  'UPDATE public.task_statuses SET is_active = false WHERE code = ''closed''',
  'этап «Закрыта» скрыть нельзя');
SELECT pg_temp.expect_russian_refusal(
  'DELETE FROM public.task_statuses WHERE code = ''closed''',
  'этап «Закрыта» удалить нельзя');
SELECT pg_temp.expect_russian_refusal(
  'UPDATE public.task_statuses SET is_builtin = false WHERE code = ''closed''',
  'признак «встроенный» у этапа «Закрыта» снять нельзя');
SELECT pg_temp.expect_russian_refusal(
  'UPDATE public.task_statuses SET is_terminal = false WHERE code = ''closed''',
  'признак «последний этап» у «Закрыта» поменять нельзя');
SELECT pg_temp.expect_russian_refusal(
  'UPDATE public.task_statuses SET code = ''finished'' WHERE code = ''closed''',
  'код встроенного этапа поменять нельзя');
SELECT pg_temp.expect_russian_refusal(
  'UPDATE public.equipment_statuses SET is_active = false WHERE code = ''written_off''',
  'статус прибора «Списан» скрыть нельзя');
SELECT pg_temp.expect_russian_refusal(
  'UPDATE public.work_types SET is_active = false WHERE code = ''maintenance''',
  'вид работ «ТО по сервисной документации» скрыть нельзя');
SELECT pg_temp.expect_russian_refusal(
  'INSERT INTO public.task_statuses (code, name, sort_order, is_builtin) VALUES (''own_builtin'', ''Свой встроенный'', 95, true)',
  'встроенное значение со входом в CRM не завести');

-- -------------------------------------------------------------- Что по-прежнему можно
SELECT pg_temp.check(pg_temp.rows_affected(
  'UPDATE public.task_statuses SET name = ''Закрыта (принята)'' WHERE code = ''closed''') = 1,
  'название встроенного этапа администратор меняет как раньше');
SELECT pg_temp.check(pg_temp.rows_affected(
  'UPDATE public.task_statuses SET sort_order = 65 WHERE code = ''closed''') = 1,
  'порядок встроенного этапа меняется как раньше');
SELECT pg_temp.check(pg_temp.rows_affected(
  'INSERT INTO public.task_statuses (code, name, sort_order) VALUES (''waiting_parts'', ''Ждёт запчасть'', 35)') = 1,
  'свой этап справочника добавляется как раньше');
SELECT pg_temp.check(pg_temp.rows_affected(
  'UPDATE public.task_statuses SET is_active = false WHERE code = ''waiting_parts''') = 1,
  'свой этап справочника скрывается как раньше');
SELECT pg_temp.check(pg_temp.rows_affected(
  'DELETE FROM public.task_statuses WHERE code = ''waiting_parts''') = 1,
  'свой этап справочника удаляется как раньше');
SELECT pg_temp.act_as_nobody();

-- Признак встроенности из CRM не поставить: иначе своя запись становилась бы вечной.
SELECT pg_temp.act_as(pg_temp.uid('admin'));
SELECT pg_temp.check(pg_temp.rows_affected(
  'INSERT INTO public.task_statuses (code, name, sort_order) VALUES (''own_stage'', ''Свой этап'', 35)') = 1,
  'свой этап заводится');
SELECT pg_temp.expect_russian_refusal(
  'UPDATE public.task_statuses SET is_builtin = true WHERE code = ''own_stage''',
  'свой этап нельзя пометить встроенным');
SELECT pg_temp.check(NOT (SELECT is_builtin FROM task_statuses WHERE code = 'own_stage'),
  'признак так и не поставлен');
SELECT pg_temp.check(pg_temp.rows_affected(
  'DELETE FROM public.task_statuses WHERE code = ''own_stage''') = 1,
  'и запись по-прежнему удаляется');
SELECT pg_temp.act_as_nobody();

-- Служебные операции без входа (обновление базы, импорт) запрет не трогает: иначе
-- размеченную запись не починила бы и следующая миграция.
SELECT pg_temp.check(pg_temp.rows_affected(
  'UPDATE public.task_statuses SET is_active = false WHERE code = ''closed''') = 1,
  'без входа встроенный этап выключается: это делает обновление базы');
SELECT pg_temp.check(pg_temp.rows_affected(
  'UPDATE public.task_statuses SET is_active = true WHERE code = ''closed''') = 1,
  'и включается обратно');
SELECT pg_temp.act_as(pg_temp.uid('admin'));

-- Ровно случай из аудита: справочники ведёт и координатор, ему тоже отказ.
SELECT pg_temp.act_as(pg_temp.uid('coord'));
SELECT pg_temp.expect_russian_refusal(
  'UPDATE public.task_statuses SET is_active = false WHERE code = ''closed''',
  'координатор тоже не может скрыть этап «Закрыта»');
SELECT pg_temp.act_as_nobody();

-- Главное последствие находки: этап «Закрыта» остался включённым, задачи закрываются.
SELECT pg_temp.check((SELECT is_active FROM task_statuses WHERE code = 'closed'),
  'после всех попыток этап «Закрыта» по-прежнему включён');

-- Служебное: запрет работает от владельца схемы и напрямую не вызывается.
SELECT pg_temp.check((SELECT prosecdef FROM pg_proc WHERE proname = 'guard_builtin_reference_value'),
  'запрет работает от владельца схемы');
SELECT pg_temp.check(NOT has_function_privilege('authenticated', 'public.guard_builtin_reference_value()', 'EXECUTE'),
  'запрет напрямую не вызвать');

ROLLBACK;
