-- Плательщики площадки: связь many-to-many для справочника «Клиенты».
-- Плательщик остаётся глобальной сущностью для приборов/задач/счетов.

CREATE TABLE IF NOT EXISTS site_payers (
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  payer_id uuid NOT NULL REFERENCES payers(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, payer_id)
);

CREATE INDEX IF NOT EXISTS site_payers_payer_idx ON site_payers (payer_id);

ALTER TABLE site_payers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_user_all ON site_payers;
CREATE POLICY app_user_all ON site_payers
  FOR ALL TO authenticated
  USING (public.is_app_user())
  WITH CHECK (public.is_app_user());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE site_payers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE site_payers TO medtech_api;
