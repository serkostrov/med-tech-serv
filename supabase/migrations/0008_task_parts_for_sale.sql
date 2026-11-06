-- Флаг «для продажи» у позиций запчастей в задаче (без списания со склада).
ALTER TABLE task_parts
  ADD COLUMN IF NOT EXISTS for_sale boolean NOT NULL DEFAULT false;
