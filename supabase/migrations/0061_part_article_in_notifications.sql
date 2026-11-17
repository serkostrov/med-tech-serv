-- Запчасть в уведомлениях: «Лампа (арт. AU-LAMP)», а не «Лампа AU-LAMP».
--
-- Что было не так. Шаблоны склада (0029) ставили название и артикул подряд через пробел.
-- На встрече 16.11 заказчик получил «Запчасть можно забрать на складе: 10 123, 10 шт.» —
-- название «10» и артикул «123» слились в одно число, и было непонятно, что это.
--
-- Что делаем. Меняем только шаблоны, которые никто не правил руками: если администратор
-- уже переписал текст по-своему, его вариант не трогаем.

UPDATE public.notification_templates
   SET body_template = replace(body_template, '{{partName}} {{partArticle}}', '{{partName}} (арт. {{partArticle}})')
 WHERE code IN ('stock_reservation_created', 'stock_reservation_ready')
   AND body_template LIKE '%{{partName}} {{partArticle}}%';
