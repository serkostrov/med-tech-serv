-- Название и артикул запчасти в уведомлениях склада (миграция 0061).
BEGIN;

CREATE FUNCTION pg_temp.check(p_ok boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'ПРОВАЛ: %', p_label;
  END IF;
  RAISE NOTICE 'ok: %', p_label;
END $$;

SELECT pg_temp.check((SELECT bool_and(body_template LIKE '%{{partName}} (арт. {{partArticle}})%')
    FROM public.notification_templates WHERE code IN ('stock_reservation_created', 'stock_reservation_ready')),
  'в шаблонах склада артикул подписан: «название (арт. артикул)»');
SELECT pg_temp.check((SELECT count(*) = 0 FROM public.notification_templates
   WHERE body_template LIKE '%{{partName}} {{partArticle}}%'),
  'название и артикул подряд без подписи не осталось ни в одном шаблоне');

ROLLBACK;
