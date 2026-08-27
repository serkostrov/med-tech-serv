-- Порядок отображения для справочников без sort_order.

ALTER TABLE manufacturers
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;

ALTER TABLE equipment_models
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;

ALTER TABLE guarantee_categories
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT id, (row_number() OVER (ORDER BY lower(btrim(name)), id) * 10)::integer AS next_order
  FROM manufacturers
  WHERE sort_order = 0
)
UPDATE manufacturers AS m
   SET sort_order = ranked.next_order
  FROM ranked
 WHERE m.id = ranked.id
   AND m.sort_order = 0;

WITH ranked AS (
  SELECT id, (row_number() OVER (ORDER BY lower(btrim(name)), id) * 10)::integer AS next_order
  FROM equipment_models
  WHERE sort_order = 0
)
UPDATE equipment_models AS m
   SET sort_order = ranked.next_order
  FROM ranked
 WHERE m.id = ranked.id
   AND m.sort_order = 0;

WITH ranked AS (
  SELECT id, (row_number() OVER (ORDER BY lower(btrim(name)), id) * 10)::integer AS next_order
  FROM guarantee_categories
  WHERE sort_order = 0
)
UPDATE guarantee_categories AS g
   SET sort_order = ranked.next_order
  FROM ranked
 WHERE g.id = ranked.id
   AND g.sort_order = 0;

CREATE INDEX IF NOT EXISTS manufacturers_active_sort_idx
  ON manufacturers (is_active, sort_order);

CREATE INDEX IF NOT EXISTS equipment_models_active_sort_idx
  ON equipment_models (is_active, sort_order);

CREATE INDEX IF NOT EXISTS guarantee_categories_active_sort_idx
  ON guarantee_categories (is_active, sort_order);
