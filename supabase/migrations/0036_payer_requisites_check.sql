-- ИНН и КПП плательщика проверяются, а не принимаются любые.
--
-- Зачем. Реквизиты лежат в общем поле `payers.requisites` и не проверялись нигде:
-- ни в поле ввода, ни при сохранении, ни в базе. Сохранялось и «abc!!», и три цифры,
-- и пятьдесят. При этом метка «для счетов» ставится, как только у человека появился
-- ИНН, — то есть мусор сразу становился плательщиком и ушёл бы в счёт и в акт.
--
-- Что теперь. ИНН — ровно 10 или 12 цифр с верной контрольной цифрой (приказ МНС
-- по порядку присвоения ИНН: для 10 знаков одна контрольная цифра, для 12 — две).
-- КПП — 9 знаков: четыре цифры кода инспекции, два знака причины постановки
-- (цифры или заглавные латинские буквы — так оформляют иностранные организации),
-- три цифры номера. КПП без ИНН не бывает, поэтому один КПП не принимается.
-- Пустые реквизиты — это по-прежнему «реквизитов нет», так заводят обычного
-- человека площадки с одним телефоном.
--
-- Старые записи миграция не ломает: проверка срабатывает при создании и только
-- тогда, когда реквизиты меняют. Переименовать плательщика с мусором в ИНН по-прежнему
-- можно, но сам ИНН придётся либо исправить, либо убрать. Что именно лежит в базе
-- сейчас, миграция сообщает отдельной строкой при применении.
--
-- Миграцию можно применить повторно.

-- ---------------------------------------------------------------------------
-- 1. Что считается верным ИНН и КПП
-- ---------------------------------------------------------------------------

-- Обрезка реквизита: обычные пробелы, табуляция, переводы строк и неразрывный пробел —
-- всё, что браузер и 1С присылают незаметно. В интерфейсе то же делает trim() строки
-- JavaScript; он снимает ещё и редкие типографские пробелы, но в реквизитах их не бывает,
-- а главный виновник — неразрывный пробел из буфера обмена — учтён с обеих сторон.
CREATE OR REPLACE FUNCTION public.trim_requisite(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT btrim(coalesce(p_value, ''), E' \t\n\r\f\v\u00A0')
$$;

COMMENT ON FUNCTION public.trim_requisite(text) IS
  'Обрезка реквизита от пробелов, включая неразрывный (0036): то же правило, что в интерфейсе.';

REVOKE EXECUTE ON FUNCTION public.trim_requisite(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.trim_requisite(text) TO authenticated, medtech_api;

-- Контрольные цифры ИНН: вес каждой позиции умножается на её цифру, сумма по модулю 11
-- и ещё по модулю 10 даёт контрольную цифру. У 12-значного ИНН таких цифр две:
-- одиннадцатая считается по первым десяти, двенадцатая — по первым одиннадцати.
CREATE OR REPLACE FUNCTION public.is_valid_inn(p_value text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  digits constant text := public.trim_requisite(p_value);
  weights_10 constant int[] := ARRAY[2, 4, 10, 3, 5, 9, 4, 6, 8];
  weights_11 constant int[] := ARRAY[7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
  weights_12 constant int[] := ARRAY[3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
  position int;
  total int := 0;
BEGIN
  IF digits !~ '^[0-9]+$' OR char_length(digits) NOT IN (10, 12) THEN
    RETURN false;
  END IF;

  IF char_length(digits) = 10 THEN
    FOR position IN 1 .. 9 LOOP
      total := total + weights_10[position] * substr(digits, position, 1)::int;
    END LOOP;
    RETURN (total % 11) % 10 = substr(digits, 10, 1)::int;
  END IF;

  FOR position IN 1 .. 10 LOOP
    total := total + weights_11[position] * substr(digits, position, 1)::int;
  END LOOP;
  IF (total % 11) % 10 <> substr(digits, 11, 1)::int THEN
    RETURN false;
  END IF;

  total := 0;
  FOR position IN 1 .. 11 LOOP
    total := total + weights_12[position] * substr(digits, position, 1)::int;
  END LOOP;
  RETURN (total % 11) % 10 = substr(digits, 12, 1)::int;
END
$$;

CREATE OR REPLACE FUNCTION public.is_valid_kpp(p_value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT public.trim_requisite(p_value) ~ '^[0-9]{4}[0-9A-Z]{2}[0-9]{3}$'
$$;

COMMENT ON FUNCTION public.is_valid_inn(text) IS
  'Верный ИНН: 10 или 12 цифр с контрольной цифрой (0036). Пусто верным не считается, отсутствие реквизитов проверяет вызывающий.';
COMMENT ON FUNCTION public.is_valid_kpp(text) IS
  'Верный КПП: 9 знаков, четыре цифры инспекции, два знака причины (цифры или заглавные латинские буквы), три цифры номера (0036).';

REVOKE EXECUTE ON FUNCTION public.is_valid_inn(text), public.is_valid_kpp(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_valid_inn(text), public.is_valid_kpp(text) TO authenticated, medtech_api;

-- ---------------------------------------------------------------------------
-- 2. Проверка при записи плательщика
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.validate_payer_requisites()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- Лишние пробелы (в том числе неразрывный из буфера обмена) убираем, а не просто
  -- не замечаем: иначе «7736012343 » уехало бы в счёт и в акт вместе с пробелом.
  inn constant text := nullif(public.trim_requisite(NEW.requisites ->> 'inn'), '');
  kpp constant text := nullif(public.trim_requisite(NEW.requisites ->> 'kpp'), '');
BEGIN
  -- Старые записи не трогаем: проверяем только то, что сейчас вписали.
  IF TG_OP = 'UPDATE'
     AND (NEW.requisites -> 'inn') IS NOT DISTINCT FROM (OLD.requisites -> 'inn')
     AND (NEW.requisites -> 'kpp') IS NOT DISTINCT FROM (OLD.requisites -> 'kpp') THEN
    RETURN NEW;
  END IF;

  IF inn IS NOT NULL AND NOT public.is_valid_inn(inn) THEN
    RAISE EXCEPTION 'ИНН «%» не похож на настоящий: у организации 10 цифр, у предпринимателя 12, и последние цифры номера должны сходиться с остальными. Проверьте номер в реквизитах', inn
      USING ERRCODE = '23514', CONSTRAINT = 'payers_inn_invalid';
  END IF;
  IF kpp IS NOT NULL AND NOT public.is_valid_kpp(kpp) THEN
    RAISE EXCEPTION 'КПП «%» не похож на настоящий: нужно 9 знаков, например 773601001. Проверьте номер в реквизитах', kpp
      USING ERRCODE = '23514', CONSTRAINT = 'payers_kpp_invalid';
  END IF;
  IF kpp IS NOT NULL AND inn IS NULL THEN
    RAISE EXCEPTION 'КПП без ИНН не бывает: укажите ИНН или уберите КПП'
      USING ERRCODE = '23514', CONSTRAINT = 'payers_kpp_without_inn';
  END IF;

  -- Храним уже обрезанное: дальше реквизиты уходят в счёт и в печатный акт как есть.
  IF (NEW.requisites ->> 'inn') IS DISTINCT FROM inn THEN
    NEW.requisites := CASE WHEN inn IS NULL
      THEN NEW.requisites - 'inn'
      ELSE jsonb_set(NEW.requisites, '{inn}', to_jsonb(inn)) END;
  END IF;
  IF (NEW.requisites ->> 'kpp') IS DISTINCT FROM kpp THEN
    NEW.requisites := CASE WHEN kpp IS NULL
      THEN NEW.requisites - 'kpp'
      ELSE jsonb_set(NEW.requisites, '{kpp}', to_jsonb(kpp)) END;
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.validate_payer_requisites() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.validate_payer_requisites() IS
  'ИНН и КПП плательщика проверяются при записи (0036); старые записи не ломаются, проверка идёт только при изменении реквизитов.';

DROP TRIGGER IF EXISTS payers_validate_requisites ON payers;
CREATE TRIGGER payers_validate_requisites
  BEFORE INSERT OR UPDATE OF requisites ON payers
  FOR EACH ROW EXECUTE FUNCTION public.validate_payer_requisites();

-- ---------------------------------------------------------------------------
-- 3. Что уже лежит в базе
-- ---------------------------------------------------------------------------

-- Не чиним и не удаляем автоматически: реквизиты сверяют с договором. Просто называем,
-- чтобы координатор поправил их до первых счетов.
DO $$
DECLARE
  broken text;
BEGIN
  SELECT string_agg(format('%s (ИНН %s, КПП %s)', payer.name,
                           coalesce(nullif(public.trim_requisite(payer.requisites ->> 'inn'), ''), '—'),
                           coalesce(nullif(public.trim_requisite(payer.requisites ->> 'kpp'), ''), '—')),
                    '; ' ORDER BY payer.name)
    INTO broken
    FROM public.payers AS payer
   WHERE (nullif(public.trim_requisite(payer.requisites ->> 'inn'), '') IS NOT NULL
          AND NOT public.is_valid_inn(payer.requisites ->> 'inn'))
      OR (nullif(public.trim_requisite(payer.requisites ->> 'kpp'), '') IS NOT NULL
          AND NOT public.is_valid_kpp(payer.requisites ->> 'kpp'));
  IF broken IS NOT NULL THEN
    RAISE NOTICE 'Проверьте реквизиты плательщиков, они не проходят новую проверку: %', broken;
  END IF;
END
$$;
