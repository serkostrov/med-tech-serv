-- Человек на площадке: контакт может быть связан с плательщиком (одна сущность в UI).

ALTER TABLE site_contacts
  ADD COLUMN IF NOT EXISTS payer_id uuid REFERENCES payers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS site_contacts_payer_idx
  ON site_contacts (payer_id)
  WHERE payer_id IS NOT NULL;
