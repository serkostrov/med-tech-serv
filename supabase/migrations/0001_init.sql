-- Единая схема МедТехСервиса: Auth/PostgREST/Storage, доменные ограничения и RLS.


-- ---------------------------------------------------------------------------
-- 0001_foundation.sql
-- ---------------------------------------------------------------------------

-- Базовые расширения, типы и общие функции схемы МедТехСервиса.
-- Файл выполняется миграционным раннером в отдельной транзакции.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF to_regtype('user_role') IS NULL THEN
    CREATE TYPE user_role AS ENUM (
      'coordinator',
      'engineer',
      'warehouse',
      'initiator',
      'manager',
      'supervisor',
      'admin'
    );
  END IF;
  IF to_regtype('site_type') IS NULL THEN
    CREATE TYPE site_type AS ENUM ('medical_facility', 'group_company', 'other');
  END IF;
  IF to_regtype('task_priority') IS NULL THEN
    CREATE TYPE task_priority AS ENUM ('urgent', 'planned');
  END IF;
  IF to_regtype('work_modifier') IS NULL THEN
    CREATE TYPE work_modifier AS ENUM ('G', 'N');
  END IF;
  IF to_regtype('part_condition') IS NULL THEN
    CREATE TYPE part_condition AS ENUM ('G', 'N', 'B');
  END IF;
  IF to_regtype('reservation_status') IS NULL THEN
    CREATE TYPE reservation_status AS ENUM (
      'created',
      'warehouse_notified',
      'issued',
      'installed',
      'returned',
      'cancelled'
    );
  END IF;
  IF to_regtype('stock_movement_type') IS NULL THEN
    CREATE TYPE stock_movement_type AS ENUM (
      'receipt',
      'reserve',
      'issue',
      'install',
      'writeoff',
      'return',
      'adjustment'
    );
  END IF;
  IF to_regtype('invoice_status') IS NULL THEN
    CREATE TYPE invoice_status AS ENUM ('draft', 'issued', 'transferred_to_1c', 'cancelled');
  END IF;
  IF to_regtype('contract_status') IS NULL THEN
    CREATE TYPE contract_status AS ENUM ('draft', 'active', 'suspended', 'completed', 'cancelled');
  END IF;
  IF to_regtype('quote_status') IS NULL THEN
    CREATE TYPE quote_status AS ENUM ('draft', 'sent', 'accepted', 'rejected', 'expired');
  END IF;
  IF to_regtype('notification_channel') IS NULL THEN
    CREATE TYPE notification_channel AS ENUM ('email', 'telegram', 'max', 'sms');
  END IF;
  IF to_regtype('notification_status') IS NULL THEN
    CREATE TYPE notification_status AS ENUM ('queued', 'sent', 'delivered', 'failed', 'cancelled');
  END IF;
  IF to_regtype('file_kind') IS NULL THEN
    CREATE TYPE file_kind AS ENUM ('act', 'photo', 'video', 'document', 'mail_attachment');
  END IF;
  IF to_regtype('integration_direction') IS NULL THEN
    CREATE TYPE integration_direction AS ENUM ('inbound', 'outbound');
  END IF;
  IF to_regtype('integration_status') IS NULL THEN
    CREATE TYPE integration_status AS ENUM ('received', 'queued', 'processed', 'failed', 'ignored');
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION current_app_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN current_setting('app.user_id', true) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN current_setting('app.user_id', true)::uuid
    ELSE NULL
  END
$$;

-- ---------------------------------------------------------------------------
-- 0002_organizations_and_equipment.sql
-- ---------------------------------------------------------------------------

-- Площадки, плательщики, пользователи, справочники приборов и паспорт прибора.

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (btrim(name) <> ''),
  legal_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS organizations_name_ci_uq
  ON organizations (lower(btrim(name)));

CREATE TABLE IF NOT EXISTS sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  name text NOT NULL CHECK (btrim(name) <> ''),
  address text NOT NULL DEFAULT '',
  type site_type NOT NULL DEFAULT 'medical_facility',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sites_organization_idx ON sites (organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS sites_organization_name_ci_uq
  ON sites (organization_id, lower(btrim(name)));

CREATE TABLE IF NOT EXISTS site_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  full_name text NOT NULL CHECK (btrim(full_name) <> ''),
  phone text,
  email text,
  position text,
  is_primary boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS site_contacts_site_idx ON site_contacts (site_id);
CREATE UNIQUE INDEX IF NOT EXISTS site_contacts_primary_uq
  ON site_contacts (site_id) WHERE is_primary;

CREATE TABLE IF NOT EXISTS payers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (btrim(name) <> ''),
  requisites jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payers_name_ci_uq ON payers (lower(btrim(name)));

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL CHECK (btrim(full_name) <> ''),
  role user_role NOT NULL,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  site_id uuid REFERENCES sites(id) ON DELETE SET NULL,
  email text,
  telegram_chat_id text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_ci_uq
  ON users (lower(btrim(email))) WHERE email IS NOT NULL AND btrim(email) <> '';
CREATE INDEX IF NOT EXISTS users_role_active_idx ON users (role, is_active);
CREATE INDEX IF NOT EXISTS users_site_idx ON users (site_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS manufacturers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (btrim(name) <> ''),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS manufacturers_name_ci_uq
  ON manufacturers (lower(btrim(name)));

CREATE TABLE IF NOT EXISTS equipment_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manufacturer_id uuid NOT NULL REFERENCES manufacturers(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (btrim(name) <> ''),
  category text,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, manufacturer_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS equipment_models_manufacturer_name_ci_uq
  ON equipment_models (manufacturer_id, lower(btrim(name)));

CREATE TABLE IF NOT EXISTS guarantee_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL CHECK (btrim(code) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  supplier_warranty_months integer CHECK (supplier_warranty_months IS NULL OR supplier_warranty_months >= 0),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code)
);

INSERT INTO guarantee_categories (code, name, supplier_warranty_months, sort_order)
VALUES
  ('standard', 'Стандартная гарантия', NULL, 10),
  ('supplier_annual', 'Гарантия поставщика 100% · 1 год', 12, 20)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS equipment_statuses (
  code text PRIMARY KEY CHECK (btrim(code) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true
);

INSERT INTO equipment_statuses (code, name, sort_order)
VALUES
  ('in_use', 'В эксплуатации', 10),
  ('needs_repair', 'Требует ремонта', 20),
  ('in_repair', 'В ремонте', 30),
  ('conserved', 'Консервация', 40),
  ('written_off', 'Списан', 50)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS equipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  serial_number text NOT NULL CHECK (btrim(serial_number) <> ''),
  serial_number_normalized text GENERATED ALWAYS AS (
    upper(regexp_replace(btrim(serial_number), E'\\s+', '', 'g'))
  ) STORED,
  manufacturer_id uuid NOT NULL REFERENCES manufacturers(id) ON DELETE RESTRICT,
  model_id uuid NOT NULL,
  guarantee_category_id uuid REFERENCES guarantee_categories(id) ON DELETE SET NULL,
  status_code text NOT NULL DEFAULT 'in_use' REFERENCES equipment_statuses(code) ON DELETE RESTRICT,
  current_site_id uuid REFERENCES sites(id) ON DELETE SET NULL,
  current_payer_id uuid REFERENCES payers(id) ON DELETE SET NULL,
  last_meter_reading numeric(14, 2) CHECK (last_meter_reading IS NULL OR last_meter_reading >= 0),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT equipment_model_manufacturer_fk
    FOREIGN KEY (model_id, manufacturer_id)
    REFERENCES equipment_models(id, manufacturer_id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS equipment_serial_number_normalized_uq
  ON equipment (serial_number_normalized);
CREATE INDEX IF NOT EXISTS equipment_model_idx ON equipment (model_id);
CREATE INDEX IF NOT EXISTS equipment_manufacturer_idx ON equipment (manufacturer_id);
CREATE INDEX IF NOT EXISTS equipment_status_idx ON equipment (status_code);
CREATE INDEX IF NOT EXISTS equipment_site_idx ON equipment (current_site_id);
CREATE INDEX IF NOT EXISTS equipment_payer_idx ON equipment (current_payer_id);
CREATE INDEX IF NOT EXISTS equipment_model_search_idx ON equipment (lower(serial_number), lower(model_id::text));

CREATE TABLE IF NOT EXISTS equipment_site_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id uuid NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  changed_from_site_id uuid REFERENCES sites(id) ON DELETE RESTRICT,
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (
    equipment_id WITH =,
    (tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)')) WITH &&
  )
);

CREATE INDEX IF NOT EXISTS equipment_site_history_timeline_idx
  ON equipment_site_history (equipment_id, valid_from DESC);

CREATE TABLE IF NOT EXISTS equipment_payer_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id uuid NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  payer_id uuid NOT NULL REFERENCES payers(id) ON DELETE RESTRICT,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  changed_from_payer_id uuid REFERENCES payers(id) ON DELETE RESTRICT,
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (
    equipment_id WITH =,
    (tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)')) WITH &&
  )
);

CREATE INDEX IF NOT EXISTS equipment_payer_history_timeline_idx
  ON equipment_payer_history (equipment_id, valid_from DESC);

CREATE TABLE IF NOT EXISTS equipment_meter_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id uuid NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  reading numeric(14, 2) NOT NULL CHECK (reading >= 0),
  measured_at timestamptz NOT NULL,
  source text NOT NULL DEFAULT 'task_closure',
  task_id uuid,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS equipment_meter_readings_timeline_idx
  ON equipment_meter_readings (equipment_id, measured_at DESC);

CREATE TRIGGER organizations_updated_at
  BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER sites_updated_at
  BEFORE UPDATE ON sites FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER site_contacts_updated_at
  BEFORE UPDATE ON site_contacts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER payers_updated_at
  BEFORE UPDATE ON payers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER manufacturers_updated_at
  BEFORE UPDATE ON manufacturers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER equipment_models_updated_at
  BEFORE UPDATE ON equipment_models FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER guarantee_categories_updated_at
  BEFORE UPDATE ON guarantee_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER equipment_updated_at
  BEFORE UPDATE ON equipment FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 0003_tasks_contracts_and_maintenance.sql
-- ---------------------------------------------------------------------------

-- Агрегаты задачи, договора и годового плана ТО.

CREATE SEQUENCE IF NOT EXISTS task_number_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS contract_number_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS work_types (
  code text PRIMARY KEY CHECK (btrim(code) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  requires_hours boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO work_types (code, name, requires_hours, sort_order)
VALUES
  ('diagnostics', 'Диагностика', false, 10),
  ('installation', 'Инсталляция (в т. ч. повторная)', false, 20),
  ('repair', 'Ремонт', false, 30),
  ('deinstallation', 'Деинсталляция', false, 40),
  ('application_methods', 'Аппликация: постановка методик исследований', false, 50),
  ('application_training', 'Аппликация: инструктаж персонала', false, 60),
  ('conservation', 'Консервация', false, 70),
  ('packaging', 'Упаковка', false, 80),
  ('pre_sale_preparation', 'Предпродажная подготовка', false, 90),
  ('relocation', 'Перемещение прибора', false, 100),
  ('modernization', 'Модификация (модернизация)', false, 110),
  ('other', 'Прочие работы', true, 120),
  ('maintenance', 'ТО по сервисной документации', false, 130)
ON CONFLICT (code) DO NOTHING;

CREATE TRIGGER work_types_updated_at
  BEFORE UPDATE ON work_types FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS task_statuses (
  code text PRIMARY KEY CHECK (btrim(code) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  sort_order integer NOT NULL DEFAULT 0,
  is_terminal boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true
);

INSERT INTO task_statuses (code, name, sort_order, is_terminal)
VALUES
  ('planned', 'Запланировано', 10, false),
  ('new', 'Новая', 20, false),
  ('assigned', 'Назначена', 30, false),
  ('in_progress', 'В работе', 40, false),
  ('under_review', 'На проверке', 50, false),
  ('closed', 'Закрыта', 60, true),
  ('cancelled', 'Отменена', 70, true),
  ('rework', 'На доработке', 80, false)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS task_status_transitions (
  from_status text NOT NULL REFERENCES task_statuses(code) ON DELETE CASCADE,
  to_status text NOT NULL REFERENCES task_statuses(code) ON DELETE CASCADE,
  PRIMARY KEY (from_status, to_status),
  CHECK (from_status <> to_status)
);

INSERT INTO task_status_transitions (from_status, to_status)
VALUES
  ('planned', 'new'),
  ('planned', 'cancelled'),
  ('new', 'assigned'),
  ('new', 'cancelled'),
  ('assigned', 'in_progress'),
  ('assigned', 'cancelled'),
  ('in_progress', 'under_review'),
  ('in_progress', 'cancelled'),
  ('under_review', 'closed'),
  ('under_review', 'in_progress')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS task_reasons (
  code text PRIMARY KEY CHECK (btrim(code) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true
);

INSERT INTO task_reasons (code, name, sort_order)
VALUES
  ('wear', 'Износ / естественная эксплуатация', 10),
  ('user_fault', 'Вина пользователя', 20),
  ('warranty', 'Гарантийный случай', 30),
  ('other', 'Другая причина', 40)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL DEFAULT ('Д-' || lpad(nextval('contract_number_seq')::text, 6, '0')) CHECK (btrim(number) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  status contract_status NOT NULL DEFAULT 'draft',
  site_id uuid REFERENCES sites(id) ON DELETE SET NULL,
  payer_id uuid REFERENCES payers(id) ON DELETE SET NULL,
  valid_from date,
  valid_to date,
  total_amount numeric(14, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  notes text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (number),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE TABLE IF NOT EXISTS maintenance_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id uuid NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  plan_year integer NOT NULL CHECK (plan_year BETWEEN 2000 AND 2200),
  period_no smallint NOT NULL CHECK (period_no BETWEEN 1 AND 5),
  period_from date NOT NULL,
  period_to date NOT NULL,
  work_type_code text NOT NULL REFERENCES work_types(code) ON DELETE RESTRICT,
  assigned_engineer_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'generated', 'completed', 'cancelled')),
  comment text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (equipment_id, plan_year, period_no),
  UNIQUE (id, equipment_id),
  CHECK (period_to >= period_from),
  CHECK (extract(year FROM period_from) = plan_year OR extract(year FROM period_to) = plan_year)
);

CREATE INDEX IF NOT EXISTS maintenance_plans_period_idx
  ON maintenance_plans (plan_year, period_from, period_to, status);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL DEFAULT ('З-' || lpad(nextval('task_number_seq')::text, 6, '0')) CHECK (btrim(number) <> ''),
  title text NOT NULL CHECK (btrim(title) <> ''),
  work_type_code text NOT NULL REFERENCES work_types(code) ON DELETE RESTRICT,
  status_code text NOT NULL DEFAULT 'new' REFERENCES task_statuses(code) ON DELETE RESTRICT,
  priority task_priority NOT NULL DEFAULT 'planned',
  is_maintenance_plan boolean NOT NULL DEFAULT false,
  maintenance_plan_id uuid,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,
  site_id uuid REFERENCES sites(id) ON DELETE SET NULL,
  payer_id uuid REFERENCES payers(id) ON DELETE SET NULL,
  engineer_id uuid REFERENCES users(id) ON DELETE SET NULL,
  contract_id uuid REFERENCES contracts(id) ON DELETE SET NULL,
  primary_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  deadline_from date,
  deadline_to date,
  call_date date NOT NULL DEFAULT CURRENT_DATE,
  visit_date date,
  completed_at timestamptz,
  work_started_at timestamptz,
  work_finished_at timestamptz,
  reason_code text REFERENCES task_reasons(code) ON DELETE SET NULL,
  work_modifier work_modifier,
  hours numeric(8, 2) CHECK (hours IS NULL OR hours > 0),
  meter_reading numeric(14, 2) CHECK (meter_reading IS NULL OR meter_reading >= 0),
  contact_name text,
  contact_phone text,
  call_reason text,
  work_description text,
  recommendations text,
  user_remarks text,
  work_completed boolean NOT NULL DEFAULT false,
  apparatus_approved boolean NOT NULL DEFAULT false,
  customer_has_no_claims boolean NOT NULL DEFAULT false,
  continued_in_primary boolean NOT NULL DEFAULT false,
  cancellation_reason text,
  rework_comment text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (number),
  CONSTRAINT task_period_valid
    CHECK (deadline_from IS NULL AND deadline_to IS NULL OR deadline_from IS NOT NULL AND deadline_to IS NOT NULL AND deadline_to >= deadline_from),
  CONSTRAINT task_dates_valid
    CHECK (visit_date IS NULL OR visit_date >= call_date),
  CONSTRAINT task_work_time_valid
    CHECK (work_finished_at IS NULL OR work_started_at IS NULL OR work_finished_at >= work_started_at),
  CONSTRAINT task_continuation_valid
    CHECK (NOT continued_in_primary OR primary_task_id IS NOT NULL),
  CONSTRAINT task_not_self_continuation
    CHECK (primary_task_id IS NULL OR primary_task_id <> id),
  CONSTRAINT task_plan_link_valid
    CHECK (maintenance_plan_id IS NULL AND NOT is_maintenance_plan OR maintenance_plan_id IS NOT NULL AND is_maintenance_plan AND equipment_id IS NOT NULL),
  CONSTRAINT task_planned_status_valid
    CHECK (status_code <> 'planned' OR is_maintenance_plan),
  CONSTRAINT task_maintenance_plan_equipment_fk
    FOREIGN KEY (maintenance_plan_id, equipment_id)
    REFERENCES maintenance_plans(id, equipment_id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS task_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_status text REFERENCES task_statuses(code) ON DELETE RESTRICT,
  to_status text NOT NULL REFERENCES task_statuses(code) ON DELETE RESTRICT,
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  comment text,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  engineer_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_from timestamptz NOT NULL DEFAULT now(),
  assigned_to timestamptz,
  assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  comment text,
  CHECK (assigned_to IS NULL OR assigned_to > assigned_from)
);

CREATE INDEX IF NOT EXISTS task_status_history_timeline_idx
  ON task_status_history (task_id, changed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS task_assignments_current_uq
  ON task_assignments (task_id) WHERE assigned_to IS NULL;
CREATE INDEX IF NOT EXISTS task_assignments_engineer_period_idx
  ON task_assignments (engineer_id, assigned_from, assigned_to);

CREATE OR REPLACE FUNCTION enforce_task_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status_code <> OLD.status_code THEN
    IF NOT EXISTS (
      SELECT 1
      FROM task_status_transitions
      WHERE from_status = OLD.status_code AND to_status = NEW.status_code
    ) THEN
      RAISE EXCEPTION 'Недопустимый переход задачи: % -> %', OLD.status_code, NEW.status_code
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION record_task_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO task_status_history (task_id, from_status, to_status, changed_by, comment)
    VALUES (NEW.id, NULL, NEW.status_code, NEW.created_by, NULL);
  ELSIF NEW.status_code <> OLD.status_code THEN
    INSERT INTO task_status_history (task_id, from_status, to_status, changed_by, comment)
    VALUES (NEW.id, OLD.status_code, NEW.status_code, NEW.updated_by, coalesce(NEW.rework_comment, NEW.cancellation_reason));
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION validate_task_business_rules()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.work_type_code = 'other' AND (NEW.hours IS NULL OR NEW.hours <= 0) THEN
    RAISE EXCEPTION 'Для вида работ «Прочие работы» часы обязательны'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status_code = 'cancelled' AND nullif(btrim(coalesce(NEW.cancellation_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Для отменённой задачи нужна причина'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tasks_updated_at
  BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tasks_status_transition
  BEFORE INSERT OR UPDATE OF status_code ON tasks FOR EACH ROW EXECUTE FUNCTION enforce_task_status_transition();
CREATE TRIGGER tasks_status_history
  AFTER INSERT OR UPDATE OF status_code ON tasks FOR EACH ROW EXECUTE FUNCTION record_task_status_transition();
CREATE TRIGGER tasks_business_rules
  BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION validate_task_business_rules();
CREATE TRIGGER contracts_updated_at
  BEFORE UPDATE ON contracts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER maintenance_plans_updated_at
  BEFORE UPDATE ON maintenance_plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE equipment_meter_readings
  ADD CONSTRAINT equipment_meter_readings_task_fk
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 0004_inventory_and_finance.sql
-- ---------------------------------------------------------------------------

-- Номенклатура, складской журнал, резервы, прайс, счета и коммерческие предложения.

CREATE SEQUENCE IF NOT EXISTS reservation_number_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS quote_number_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_number text NOT NULL CHECK (btrim(article_number) <> ''),
  article_number_normalized text GENERATED ALWAYS AS (upper(btrim(article_number))) STORED,
  name text NOT NULL CHECK (btrim(name) <> ''),
  minimum_stock numeric(14, 3) NOT NULL DEFAULT 0 CHECK (minimum_stock >= 0),
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS parts_article_number_uq
  ON parts (article_number_normalized);

CREATE TABLE IF NOT EXISTS part_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id uuid NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  alias text NOT NULL CHECK (btrim(alias) <> ''),
  alias_normalized text GENERATED ALWAYS AS (upper(btrim(alias))) STORED,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS part_aliases_alias_uq ON part_aliases (alias_normalized);
CREATE INDEX IF NOT EXISTS part_aliases_part_idx ON part_aliases (part_id);

CREATE TABLE IF NOT EXISTS stock_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id uuid NOT NULL REFERENCES parts(id) ON DELETE RESTRICT,
  part_condition part_condition NOT NULL,
  lot_code text NOT NULL DEFAULT 'default' CHECK (btrim(lot_code) <> ''),
  source_document text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (part_id, part_condition, lot_code),
  UNIQUE (id, part_id, part_condition)
);

CREATE TABLE IF NOT EXISTS stock_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL DEFAULT ('Р-' || lpad(nextval('reservation_number_seq')::text, 6, '0')) CHECK (btrim(number) <> ''),
  part_id uuid NOT NULL REFERENCES parts(id) ON DELETE RESTRICT,
  part_condition part_condition NOT NULL,
  quantity numeric(14, 3) NOT NULL CHECK (quantity > 0),
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  contract_id uuid REFERENCES contracts(id) ON DELETE CASCADE,
  status reservation_status NOT NULL DEFAULT 'created',
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  issued_to uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (number),
  CHECK (
    (CASE WHEN task_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN contract_id IS NOT NULL THEN 1 ELSE 0 END) = 1
  )
);

CREATE TABLE IF NOT EXISTS stock_reservation_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES stock_reservations(id) ON DELETE CASCADE,
  from_status reservation_status,
  to_status reservation_status NOT NULL,
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  comment text
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  movement_type stock_movement_type NOT NULL,
  lot_id uuid NOT NULL,
  part_id uuid NOT NULL,
  part_condition part_condition NOT NULL,
  quantity numeric(14, 3) NOT NULL CHECK (quantity > 0),
  on_hand_delta numeric(14, 3) NOT NULL,
  reservation_id uuid REFERENCES stock_reservations(id) ON DELETE RESTRICT,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,
  performed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  comment text,
  UNIQUE (idempotency_key),
  CONSTRAINT stock_movement_lot_fk
    FOREIGN KEY (lot_id, part_id, part_condition)
    REFERENCES stock_lots(id, part_id, part_condition)
    ON DELETE RESTRICT,
  CONSTRAINT stock_movement_delta_valid
    CHECK (
      (movement_type IN ('receipt', 'return') AND on_hand_delta = quantity) OR
      (movement_type IN ('issue', 'writeoff') AND on_hand_delta = -quantity) OR
      (movement_type IN ('reserve', 'install') AND on_hand_delta = 0) OR
      (movement_type = 'adjustment' AND on_hand_delta <> 0)
    ),
  CONSTRAINT stock_movement_reservation_valid
    CHECK (
      (movement_type IN ('reserve', 'issue', 'install', 'return') AND reservation_id IS NOT NULL) OR
      (movement_type IN ('receipt', 'writeoff', 'adjustment') AND reservation_id IS NULL)
    )
);

CREATE TABLE IF NOT EXISTS task_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  part_id uuid NOT NULL REFERENCES parts(id) ON DELETE RESTRICT,
  reservation_id uuid REFERENCES stock_reservations(id) ON DELETE SET NULL,
  part_condition part_condition NOT NULL,
  article_number_snapshot text NOT NULL CHECK (btrim(article_number_snapshot) <> ''),
  name_snapshot text NOT NULL CHECK (btrim(name_snapshot) <> ''),
  quantity numeric(14, 3) NOT NULL CHECK (quantity > 0),
  installed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, part_id, part_condition)
);

CREATE INDEX IF NOT EXISTS stock_reservations_status_idx
  ON stock_reservations (status, created_at);
CREATE INDEX IF NOT EXISTS stock_reservations_task_idx ON stock_reservations (task_id);
CREATE INDEX IF NOT EXISTS stock_reservations_contract_idx ON stock_reservations (contract_id);
CREATE INDEX IF NOT EXISTS stock_movements_part_timeline_idx
  ON stock_movements (part_id, part_condition, occurred_at DESC);
CREATE INDEX IF NOT EXISTS stock_movements_task_idx ON stock_movements (task_id);
CREATE INDEX IF NOT EXISTS stock_movements_equipment_idx ON stock_movements (equipment_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS task_parts_task_idx ON task_parts (task_id);
CREATE INDEX IF NOT EXISTS task_parts_reservation_idx ON task_parts (reservation_id);

CREATE OR REPLACE VIEW stock_balances AS
WITH physical AS (
  SELECT
    sl.part_id,
    sl.part_condition,
    coalesce(sum(sm.on_hand_delta), 0)::numeric(14, 3) AS on_hand_quantity
  FROM stock_lots sl
  LEFT JOIN stock_movements sm ON sm.lot_id = sl.id
  GROUP BY sl.part_id, sl.part_condition
), reserved AS (
  SELECT part_id, part_condition, sum(quantity)::numeric(14, 3) AS reserved_quantity
  FROM stock_reservations
  WHERE status IN ('created', 'warehouse_notified')
  GROUP BY part_id, part_condition
)
SELECT
  p.id AS part_id,
  p.article_number,
  p.name,
  physical.part_condition,
  physical.on_hand_quantity,
  coalesce(reserved.reserved_quantity, 0)::numeric(14, 3) AS reserved_quantity,
  (physical.on_hand_quantity - coalesce(reserved.reserved_quantity, 0))::numeric(14, 3) AS available_quantity,
  p.minimum_stock,
  (physical.on_hand_quantity - coalesce(reserved.reserved_quantity, 0) < p.minimum_stock) AS below_minimum
FROM physical
JOIN parts p ON p.id = physical.part_id
LEFT JOIN reserved
  ON reserved.part_id = physical.part_id AND reserved.part_condition = physical.part_condition;

CREATE OR REPLACE FUNCTION enforce_stock_reservation_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  ELSIF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'created' AND NEW.status IN ('warehouse_notified', 'cancelled')) OR
      (OLD.status = 'warehouse_notified' AND NEW.status IN ('issued', 'cancelled')) OR
      (OLD.status = 'issued' AND NEW.status IN ('installed', 'returned'))
    ) THEN
      RAISE EXCEPTION 'Недопустимый переход резерва: % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION record_stock_reservation_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO stock_reservation_history (reservation_id, from_status, to_status, changed_by)
    VALUES (NEW.id, NULL, NEW.status, NEW.requested_by);
  ELSIF NEW.status <> OLD.status THEN
    INSERT INTO stock_reservation_history (reservation_id, from_status, to_status, changed_by)
    VALUES (NEW.id, OLD.status, NEW.status, coalesce(NEW.issued_to, NEW.requested_by));
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION assert_stock_capacity(p_part_id uuid, p_condition part_condition)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  physical_quantity numeric(14, 3);
  reserved_quantity numeric(14, 3);
BEGIN
  -- Сериализуем проверку одного артикула/состояния, чтобы два параллельных
  -- резерва не прошли проверку доступного остатка одновременно.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_part_id::text || ':' || p_condition::text, 0));

  SELECT coalesce(sum(on_hand_delta), 0)
  INTO physical_quantity
  FROM stock_movements
  WHERE part_id = p_part_id AND part_condition = p_condition;

  SELECT coalesce(sum(quantity), 0)
  INTO reserved_quantity
  FROM stock_reservations
  WHERE part_id = p_part_id
    AND part_condition = p_condition
    AND status IN ('created', 'warehouse_notified');

  IF physical_quantity - reserved_quantity < 0 THEN
    RAISE EXCEPTION 'Недостаточный остаток запчасти % (%): доступно %', p_part_id, p_condition, physical_quantity - reserved_quantity
      USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION assert_stock_capacity_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'stock_movements' THEN
    IF TG_OP = 'DELETE' THEN
      PERFORM assert_stock_capacity(OLD.part_id, OLD.part_condition);
    ELSE
      PERFORM assert_stock_capacity(NEW.part_id, NEW.part_condition);
      IF TG_OP = 'UPDATE' AND (OLD.part_id, OLD.part_condition) IS DISTINCT FROM (NEW.part_id, NEW.part_condition) THEN
        PERFORM assert_stock_capacity(OLD.part_id, OLD.part_condition);
      END IF;
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      PERFORM assert_stock_capacity(OLD.part_id, OLD.part_condition);
    ELSE
      PERFORM assert_stock_capacity(NEW.part_id, NEW.part_condition);
      IF TG_OP = 'UPDATE' AND (OLD.part_id, OLD.part_condition) IS DISTINCT FROM (NEW.part_id, NEW.part_condition) THEN
        PERFORM assert_stock_capacity(OLD.part_id, OLD.part_condition);
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER stock_reservations_updated_at
  BEFORE UPDATE ON stock_reservations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER stock_reservation_status_transition
  BEFORE INSERT OR UPDATE OF status ON stock_reservations FOR EACH ROW EXECUTE FUNCTION enforce_stock_reservation_transition();
CREATE TRIGGER stock_reservation_status_history
  AFTER INSERT OR UPDATE OF status ON stock_reservations FOR EACH ROW EXECUTE FUNCTION record_stock_reservation_transition();
CREATE CONSTRAINT TRIGGER stock_reservation_capacity
  AFTER INSERT OR UPDATE OR DELETE ON stock_reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_stock_capacity_trigger();
CREATE CONSTRAINT TRIGGER stock_movement_capacity
  AFTER INSERT OR UPDATE OR DELETE ON stock_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_stock_capacity_trigger();
CREATE TRIGGER parts_updated_at
  BEFORE UPDATE ON parts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS contract_equipment (
  contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES equipment(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, equipment_id)
);

CREATE TABLE IF NOT EXISTS contract_parts (
  contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  part_id uuid NOT NULL REFERENCES parts(id) ON DELETE RESTRICT,
  planned_quantity numeric(14, 3) NOT NULL CHECK (planned_quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, part_id)
);

CREATE TABLE IF NOT EXISTS price_list (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_type_code text NOT NULL REFERENCES work_types(code) ON DELETE RESTRICT,
  guarantee_category_id uuid REFERENCES guarantee_categories(id) ON DELETE CASCADE,
  scope_key text GENERATED ALWAYS AS (coalesce(guarantee_category_id::text, '*')) STORED,
  valid_from date NOT NULL,
  valid_to date,
  amount numeric(14, 2) NOT NULL CHECK (amount >= 0),
  currency text NOT NULL DEFAULT 'RUB' CHECK (currency ~ '^[A-Z]{3}$'),
  include_guarantee_work boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (
    work_type_code WITH =,
    scope_key WITH =,
    (daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[)')) WITH &&
  )
);

CREATE INDEX IF NOT EXISTS price_list_lookup_idx
  ON price_list (work_type_code, guarantee_category_id, valid_from DESC);

CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL DEFAULT ('СЧ-' || lpad(nextval('invoice_number_seq')::text, 6, '0')) CHECK (btrim(number) <> ''),
  payer_id uuid NOT NULL REFERENCES payers(id) ON DELETE RESTRICT,
  status invoice_status NOT NULL DEFAULT 'draft',
  subtotal numeric(14, 2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  adjustment_amount numeric(14, 2) NOT NULL DEFAULT 0,
  total_amount numeric(14, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  correction_reason text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  issued_at timestamptz,
  transferred_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (number)
);

CREATE TABLE IF NOT EXISTS invoice_tasks (
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invoice_id, task_id)
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  item_type text NOT NULL CHECK (item_type IN ('work', 'part')),
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  work_type_code text REFERENCES work_types(code) ON DELETE RESTRICT,
  part_id uuid REFERENCES parts(id) ON DELETE RESTRICT,
  description text NOT NULL CHECK (btrim(description) <> ''),
  quantity numeric(14, 3) NOT NULL CHECK (quantity > 0),
  unit_price numeric(14, 2) NOT NULL CHECK (unit_price >= 0),
  modifier work_modifier,
  excluded_from_total boolean NOT NULL DEFAULT false,
  line_total numeric(14, 2) GENERATED ALWAYS AS (
    CASE WHEN excluded_from_total THEN 0 ELSE round(quantity * unit_price, 2) END
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (item_type = 'work' AND work_type_code IS NOT NULL) OR
    (item_type = 'part' AND part_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS invoice_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  before_value jsonb NOT NULL,
  after_value jsonb NOT NULL,
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoice_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  from_status invoice_status,
  to_status invoice_status NOT NULL,
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invoices_payer_status_idx ON invoices (payer_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS invoice_items_invoice_idx ON invoice_items (invoice_id);
CREATE INDEX IF NOT EXISTS invoice_tasks_task_idx ON invoice_tasks (task_id);

CREATE TABLE IF NOT EXISTS quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL DEFAULT ('КП-' || lpad(nextval('quote_number_seq')::text, 6, '0')) CHECK (btrim(number) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  status quote_status NOT NULL DEFAULT 'draft',
  site_id uuid REFERENCES sites(id) ON DELETE SET NULL,
  payer_id uuid REFERENCES payers(id) ON DELETE SET NULL,
  total_amount numeric(14, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  valid_until date,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (number)
);

CREATE TABLE IF NOT EXISTS quote_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  part_id uuid REFERENCES parts(id) ON DELETE RESTRICT,
  work_type_code text REFERENCES work_types(code) ON DELETE RESTRICT,
  description text NOT NULL CHECK (btrim(description) <> ''),
  quantity numeric(14, 3) NOT NULL CHECK (quantity > 0),
  unit_price numeric(14, 2) NOT NULL CHECK (unit_price >= 0),
  line_total numeric(14, 2) GENERATED ALWAYS AS (round(quantity * unit_price, 2)) STORED,
  CHECK (part_id IS NOT NULL OR work_type_code IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS quotes_payer_status_idx ON quotes (payer_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS quote_items_quote_idx ON quote_items (quote_id);

CREATE OR REPLACE FUNCTION enforce_invoice_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'draft' AND NEW.status IN ('issued', 'cancelled')) OR
      (OLD.status = 'issued' AND NEW.status IN ('transferred_to_1c', 'cancelled'))
    ) THEN
      RAISE EXCEPTION 'Недопустимый переход счёта: % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION record_invoice_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO invoice_status_history (invoice_id, from_status, to_status, changed_by)
    VALUES (NEW.id, NULL, NEW.status, NEW.created_by);
  ELSIF NEW.status <> OLD.status THEN
    INSERT INTO invoice_status_history (invoice_id, from_status, to_status, changed_by)
    VALUES (NEW.id, OLD.status, NEW.status, NEW.created_by);
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION recalculate_invoice_total()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_invoice uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_invoice := OLD.invoice_id;
  ELSE
    target_invoice := NEW.invoice_id;
  END IF;
  UPDATE invoices
  SET subtotal = coalesce((SELECT sum(line_total) FROM invoice_items WHERE invoice_id = target_invoice), 0),
      total_amount = greatest(0, coalesce((SELECT sum(line_total) FROM invoice_items WHERE invoice_id = target_invoice), 0) + adjustment_amount),
      updated_at = now()
  WHERE id = target_invoice;
  RETURN NULL;
END
$$;

CREATE TRIGGER invoices_updated_at
  BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER invoice_status_transition
  BEFORE INSERT OR UPDATE OF status ON invoices FOR EACH ROW EXECUTE FUNCTION enforce_invoice_status_transition();
CREATE TRIGGER invoice_status_history
  AFTER INSERT OR UPDATE OF status ON invoices FOR EACH ROW EXECUTE FUNCTION record_invoice_status_transition();
CREATE TRIGGER invoice_items_total
  AFTER INSERT OR UPDATE OR DELETE ON invoice_items FOR EACH ROW EXECUTE FUNCTION recalculate_invoice_total();
CREATE TRIGGER quotes_updated_at
  BEFORE UPDATE ON quotes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 0005_files_notifications_integrations_audit.sql
-- ---------------------------------------------------------------------------

-- Файлы, закрытие задачи, уведомления, почтовый inbox, интеграционный outbox и аудит.

CREATE TABLE IF NOT EXISTS permissions (
  code text PRIMARY KEY CHECK (btrim(code) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  is_sensitive boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role user_role NOT NULL,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role, permission_code)
);

INSERT INTO permissions (code, name, is_sensitive)
VALUES
  ('tasks.read', 'Просмотр задач', false),
  ('tasks.write', 'Изменение задач', false),
  ('equipment.read', 'Просмотр приборов', false),
  ('warehouse.write', 'Складские операции', false),
  ('notifications.read', 'Просмотр уведомлений', false),
  ('finance.read', 'Просмотр цен и финансов', true),
  ('finance.write', 'Изменение счетов и прайса', true),
  ('contracts.write', 'Изменение договоров', true),
  ('references.write', 'Изменение справочников', true),
  ('audit.read', 'Просмотр аудита', true),
  ('users.write', 'Изменение пользователей', true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code)
VALUES
  ('coordinator', 'tasks.read'), ('coordinator', 'tasks.write'),
  ('coordinator', 'equipment.read'), ('coordinator', 'warehouse.write'),
  ('coordinator', 'notifications.read'), ('coordinator', 'finance.read'),
  ('coordinator', 'finance.write'), ('coordinator', 'contracts.write'),
  ('engineer', 'tasks.read'), ('engineer', 'tasks.write'), ('engineer', 'equipment.read'),
  ('warehouse', 'warehouse.write'), ('warehouse', 'notifications.read'),
  ('initiator', 'tasks.read'), ('initiator', 'tasks.write'),
  ('manager', 'tasks.read'), ('manager', 'tasks.write'), ('manager', 'equipment.read'),
  ('manager', 'finance.read'), ('manager', 'finance.write'), ('manager', 'contracts.write'),
  ('supervisor', 'tasks.read'), ('supervisor', 'tasks.write'), ('supervisor', 'equipment.read'),
  ('supervisor', 'warehouse.write'), ('supervisor', 'notifications.read'),
  ('supervisor', 'finance.read'), ('supervisor', 'finance.write'), ('supervisor', 'contracts.write'),
  ('supervisor', 'references.write'), ('supervisor', 'audit.read'),
  ('admin', 'tasks.read'), ('admin', 'tasks.write'), ('admin', 'equipment.read'),
  ('admin', 'warehouse.write'), ('admin', 'notifications.read'), ('admin', 'finance.read'),
  ('admin', 'finance.write'), ('admin', 'contracts.write'), ('admin', 'references.write'),
  ('admin', 'audit.read'), ('admin', 'users.write')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind file_kind NOT NULL,
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  equipment_id uuid REFERENCES equipment(id) ON DELETE CASCADE,
  storage_key text NOT NULL CHECK (btrim(storage_key) <> ''),
  original_name text NOT NULL CHECK (btrim(original_name) <> ''),
  content_type text NOT NULL CHECK (btrim(content_type) <> ''),
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  checksum_sha256 text CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-fA-F]{64}$'),
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (task_id IS NOT NULL OR equipment_id IS NOT NULL),
  UNIQUE (storage_key)
);

CREATE INDEX IF NOT EXISTS files_task_kind_idx ON files (task_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS files_equipment_timeline_idx ON files (equipment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_closures (
  task_id uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  act_file_id uuid NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  submitted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  verified_by uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_at timestamptz,
  verification_comment text,
  CHECK ((verified_by IS NULL) = (verified_at IS NULL))
);

CREATE TABLE IF NOT EXISTS equipment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id uuid NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('task', 'part_movement', 'site_change', 'payer_change', 'meter', 'attachment', 'manual')),
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  stock_movement_id uuid REFERENCES stock_movements(id) ON DELETE SET NULL,
  file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  happened_at timestamptz NOT NULL,
  summary text NOT NULL CHECK (btrim(summary) <> ''),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS equipment_history_timeline_idx
  ON equipment_history (equipment_id, happened_at DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_templates (
  code text PRIMARY KEY CHECK (btrim(code) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  subject_template text NOT NULL DEFAULT '',
  body_template text NOT NULL CHECK (btrim(body_template) <> ''),
  is_active boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_code text NOT NULL,
  channel notification_channel NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, event_code, channel)
);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  event_code text NOT NULL,
  recipient_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  channel notification_channel NOT NULL,
  recipient_address text NOT NULL CHECK (btrim(recipient_address) <> ''),
  subject text NOT NULL DEFAULT '',
  body text NOT NULL CHECK (btrim(body) <> ''),
  status notification_status NOT NULL DEFAULT 'queued',
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,
  reservation_id uuid REFERENCES stock_reservations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS notifications_recipient_status_idx
  ON notifications (recipient_user_id, status, scheduled_at);
CREATE INDEX IF NOT EXISTS notifications_delivery_queue_idx
  ON notifications (status, scheduled_at) WHERE status IN ('queued', 'failed');
CREATE INDEX IF NOT EXISTS notifications_task_idx ON notifications (task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mail_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_message_id text NOT NULL,
  thread_id text,
  sender text NOT NULL CHECK (btrim(sender) <> ''),
  subject text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  received_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'parsed', 'converted', 'ignored', 'failed')),
  parsed_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_confidence numeric(5, 4) CHECK (ai_confidence IS NULL OR ai_confidence BETWEEN 0 AND 1),
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (external_message_id)
);

CREATE INDEX IF NOT EXISTS mail_messages_status_received_idx
  ON mail_messages (status, received_at DESC);
CREATE INDEX IF NOT EXISTS mail_messages_thread_idx ON mail_messages (thread_id, received_at);

CREATE TABLE IF NOT EXISTS integration_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  system_name text NOT NULL CHECK (btrim(system_name) <> ''),
  direction integration_direction NOT NULL,
  message_type text NOT NULL CHECK (btrim(message_type) <> ''),
  external_id text,
  payload jsonb NOT NULL,
  status integration_status NOT NULL DEFAULT 'received',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  occurred_at timestamptz NOT NULL,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key)
);

CREATE TABLE IF NOT EXISTS integration_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status integration_status NOT NULL DEFAULT 'queued',
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS integration_messages_processing_idx
  ON integration_messages (system_name, status, occurred_at);
CREATE INDEX IF NOT EXISTS integration_outbox_queue_idx
  ON integration_outbox (status, available_at) WHERE status IN ('queued', 'failed');

CREATE TABLE IF NOT EXISTS audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (btrim(action) <> ''),
  entity_type text NOT NULL CHECK (btrim(entity_type) <> ''),
  entity_id text NOT NULL CHECK (btrim(entity_id) <> ''),
  before_data jsonb,
  after_data jsonb,
  request_id text,
  ip_address inet,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_entity_timeline_idx
  ON audit_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_timeline_idx
  ON audit_log (actor_user_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS login_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  success boolean NOT NULL,
  ip_address inet,
  user_agent text,
  failure_reason text
);

CREATE INDEX IF NOT EXISTS login_events_user_timeline_idx
  ON login_events (user_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION validate_task_closure_file()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM files
    WHERE id = NEW.act_file_id AND task_id = NEW.task_id AND kind = 'act'
  ) THEN
    RAISE EXCEPTION 'Фото акта должно быть привязано к этой задаче и иметь тип act'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION assert_task_closure_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_task tasks%ROWTYPE;
  closure task_closures%ROWTYPE;
  photo_count integer;
  video_count integer;
BEGIN
  IF TG_TABLE_NAME = 'task_closures' THEN
    SELECT * INTO current_task FROM tasks WHERE id = NEW.task_id;
  ELSE
    SELECT * INTO current_task FROM tasks WHERE id = NEW.id;
  END IF;

  IF current_task.id IS NULL OR current_task.status_code NOT IN ('under_review', 'closed') THEN
    RETURN NULL;
  END IF;

  SELECT * INTO closure FROM task_closures WHERE task_id = current_task.id;
  IF closure.task_id IS NULL THEN
    RAISE EXCEPTION 'Для закрытия задачи нужен акт'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO photo_count FROM files WHERE task_id = current_task.id AND kind = 'photo';
  SELECT count(*) INTO video_count FROM files WHERE task_id = current_task.id AND kind = 'video';
  IF photo_count > 10 OR video_count > 2 THEN
    RAISE EXCEPTION 'Превышен лимит фото/видео задачи'
      USING ERRCODE = '23514';
  END IF;

  IF current_task.status_code = 'closed' THEN
    IF closure.verified_by IS NULL OR closure.verified_at IS NULL THEN
      RAISE EXCEPTION 'Закрытую задачу должен проверить координатор'
        USING ERRCODE = '23514';
    END IF;
    IF NOT current_task.work_completed OR NOT current_task.apparatus_approved OR NOT current_task.customer_has_no_claims THEN
      RAISE EXCEPTION 'Для закрытия нужны отметки акта: работа выполнена, аппарат исправен, претензий нет'
        USING ERRCODE = '23514';
    END IF;
    IF photo_count < 3 THEN
      RAISE EXCEPTION 'Для закрытия нужны минимум три фото фотофиксации'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION write_audit_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  before_data jsonb;
  after_data jsonb;
  entity_id_value text;
BEGIN
  before_data := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  after_data := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  entity_id_value := coalesce(after_data ->> 'id', before_data ->> 'id', 'unknown');

  INSERT INTO audit_log (
    actor_user_id, action, entity_type, entity_id, before_data, after_data, request_id
  )
  VALUES (
    current_app_user_id(), lower(TG_OP), TG_TABLE_NAME, entity_id_value,
    before_data, after_data, nullif(current_setting('app.request_id', true), '')
  );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER task_closure_file_valid
  BEFORE INSERT OR UPDATE ON task_closures FOR EACH ROW EXECUTE FUNCTION validate_task_closure_file();
CREATE CONSTRAINT TRIGGER tasks_closure_integrity
  AFTER INSERT OR UPDATE ON tasks
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_task_closure_integrity();
CREATE CONSTRAINT TRIGGER task_closures_integrity
  AFTER INSERT OR UPDATE ON task_closures
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_task_closure_integrity();

CREATE TRIGGER audit_tasks
  AFTER INSERT OR UPDATE OR DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION write_audit_row();
CREATE TRIGGER audit_equipment
  AFTER INSERT OR UPDATE OR DELETE ON equipment FOR EACH ROW EXECUTE FUNCTION write_audit_row();
CREATE TRIGGER audit_stock_reservations
  AFTER INSERT OR UPDATE OR DELETE ON stock_reservations FOR EACH ROW EXECUTE FUNCTION write_audit_row();
CREATE TRIGGER audit_invoices
  AFTER INSERT OR UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION write_audit_row();
CREATE TRIGGER audit_contracts
  AFTER INSERT OR UPDATE OR DELETE ON contracts FOR EACH ROW EXECUTE FUNCTION write_audit_row();
CREATE TRIGGER audit_quotes
  AFTER INSERT OR UPDATE OR DELETE ON quotes FOR EACH ROW EXECUTE FUNCTION write_audit_row();

-- ---------------------------------------------------------------------------
-- 0006_registry_indexes_and_views.sql
-- ---------------------------------------------------------------------------

-- Индексы реестров и read-модели для ключевых списков без финансовых полей инженера.

CREATE INDEX IF NOT EXISTS tasks_status_period_idx
  ON tasks (status_code, deadline_from, deadline_to, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_engineer_period_idx
  ON tasks (engineer_id, deadline_from, deadline_to, status_code);
CREATE INDEX IF NOT EXISTS tasks_site_period_idx
  ON tasks (site_id, deadline_from, deadline_to, status_code);
CREATE INDEX IF NOT EXISTS tasks_work_type_period_idx
  ON tasks (work_type_code, deadline_from, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_equipment_timeline_idx
  ON tasks (equipment_id, (coalesce(completed_at, created_at)) DESC);
CREATE INDEX IF NOT EXISTS tasks_attention_idx
  ON tasks (status_code, deadline_to, created_at DESC)
  WHERE status_code IN ('new', 'under_review');
CREATE INDEX IF NOT EXISTS tasks_open_engineer_idx
  ON tasks (engineer_id, status_code, deadline_to)
  WHERE status_code NOT IN ('closed', 'cancelled');

CREATE INDEX IF NOT EXISTS equipment_status_site_idx
  ON equipment (status_code, current_site_id, current_payer_id);
CREATE INDEX IF NOT EXISTS equipment_updated_idx ON equipment (updated_at DESC);
CREATE INDEX IF NOT EXISTS task_reasons_active_idx ON task_reasons (is_active, sort_order);
CREATE INDEX IF NOT EXISTS work_types_active_idx ON work_types (is_active, sort_order);
CREATE INDEX IF NOT EXISTS task_statuses_active_idx ON task_statuses (is_active, sort_order);
CREATE INDEX IF NOT EXISTS contracts_payer_status_idx ON contracts (payer_id, status, valid_to);
CREATE INDEX IF NOT EXISTS contract_equipment_equipment_idx ON contract_equipment (equipment_id, contract_id);
CREATE INDEX IF NOT EXISTS contract_parts_part_idx ON contract_parts (part_id, contract_id);

CREATE INDEX IF NOT EXISTS parts_name_search_idx ON parts (lower(name));
CREATE INDEX IF NOT EXISTS part_aliases_lookup_idx ON part_aliases (alias_normalized);
CREATE INDEX IF NOT EXISTS stock_lots_part_condition_idx ON stock_lots (part_id, part_condition);

CREATE INDEX IF NOT EXISTS price_list_current_lookup_idx
  ON price_list (work_type_code, scope_key, valid_from DESC, valid_to);
CREATE INDEX IF NOT EXISTS invoices_status_created_idx ON invoices (status, created_at DESC);
CREATE INDEX IF NOT EXISTS invoice_status_history_timeline_idx
  ON invoice_status_history (invoice_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS files_checksum_idx ON files (checksum_sha256) WHERE checksum_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_closures_verified_idx ON task_closures (verified_at DESC);
CREATE INDEX IF NOT EXISTS equipment_meter_readings_task_idx ON equipment_meter_readings (task_id);

CREATE OR REPLACE VIEW equipment_registry AS
SELECT
  e.id,
  e.serial_number,
  e.serial_number_normalized,
  e.manufacturer_id,
  manufacturer.name AS manufacturer_name,
  e.model_id,
  model.name AS model_name,
  e.guarantee_category_id,
  e.status_code,
  equipment_status.name AS status_name,
  e.current_site_id,
  site.name AS site_name,
  e.current_payer_id,
  payer.name AS payer_name,
  e.last_meter_reading,
  e.notes,
  e.created_at,
  e.updated_at
FROM equipment e
JOIN manufacturers manufacturer ON manufacturer.id = e.manufacturer_id
JOIN equipment_models model ON model.id = e.model_id
JOIN equipment_statuses equipment_status ON equipment_status.code = e.status_code
LEFT JOIN sites site ON site.id = e.current_site_id
LEFT JOIN payers payer ON payer.id = e.current_payer_id;

CREATE OR REPLACE VIEW task_registry AS
SELECT
  t.id,
  t.number,
  t.title,
  t.work_type_code,
  work_type.name AS work_type_name,
  t.status_code,
  task_status.name AS status_name,
  t.priority,
  t.is_maintenance_plan,
  t.equipment_id,
  e.serial_number,
  model.name AS model_name,
  t.site_id,
  site.name AS site_name,
  t.payer_id,
  payer.name AS payer_name,
  t.engineer_id,
  engineer.full_name AS engineer_name,
  t.deadline_from,
  t.deadline_to,
  (t.deadline_to IS NOT NULL AND t.deadline_to < CURRENT_DATE AND t.status_code NOT IN ('closed', 'cancelled')) AS is_overdue,
  t.call_date,
  t.visit_date,
  t.completed_at,
  t.created_at,
  t.updated_at
FROM tasks t
JOIN work_types work_type ON work_type.code = t.work_type_code
JOIN task_statuses task_status ON task_status.code = t.status_code
LEFT JOIN equipment e ON e.id = t.equipment_id
LEFT JOIN equipment_models model ON model.id = e.model_id
LEFT JOIN sites site ON site.id = t.site_id
LEFT JOIN payers payer ON payer.id = t.payer_id
LEFT JOIN users engineer ON engineer.id = t.engineer_id;

CREATE OR REPLACE VIEW equipment_history_feed AS
SELECT
  h.equipment_id,
  h.happened_at,
  h.event_type,
  h.summary,
  h.details,
  h.task_id,
  h.stock_movement_id,
  h.file_id,
  h.created_at
FROM equipment_history h
UNION ALL
SELECT
  t.equipment_id,
  coalesce(t.completed_at, t.created_at) AS happened_at,
  'task' AS event_type,
  t.number || ' · ' || t.title AS summary,
  jsonb_build_object('status', t.status_code, 'work_type', t.work_type_code) AS details,
  t.id AS task_id,
  NULL::uuid AS stock_movement_id,
  NULL::uuid AS file_id,
  t.created_at
FROM tasks t
WHERE t.equipment_id IS NOT NULL
UNION ALL
SELECT
  m.equipment_id,
  m.occurred_at AS happened_at,
  'part_movement' AS event_type,
  p.article_number || ' · ' || m.movement_type::text AS summary,
  jsonb_build_object('quantity', m.quantity, 'condition', m.part_condition::text) AS details,
  m.task_id,
  m.id AS stock_movement_id,
  NULL::uuid AS file_id,
  m.occurred_at AS created_at
FROM stock_movements m
JOIN parts p ON p.id = m.part_id
WHERE m.equipment_id IS NOT NULL;

CREATE OR REPLACE VIEW document_numbers AS
SELECT 'task'::text AS document_type, id, number, created_at FROM tasks
UNION ALL
SELECT 'contract'::text, id, number, created_at FROM contracts
UNION ALL
SELECT 'reservation'::text, id, number, created_at FROM stock_reservations
UNION ALL
SELECT 'invoice'::text, id, number, created_at FROM invoices
UNION ALL
SELECT 'quote'::text, id, number, created_at FROM quotes;

-- ---------------------------------------------------------------------------
-- 0007_authentication_and_sessions.sql
-- ---------------------------------------------------------------------------

-- Аутентификация, серверные сессии и активность пользователей.
-- Пароли хранятся только как scrypt-хэши; открытые пароли в БД и журнале отсутствуют.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz,
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;

CREATE TABLE IF NOT EXISTS user_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL CHECK (btrim(password_hash) <> ''),
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until timestamptz
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  ip_address inet,
  user_agent text,
  CONSTRAINT user_sessions_expiry_valid CHECK (expires_at > created_at),
  CONSTRAINT user_sessions_revocation_valid CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS user_sessions_active_user_idx
  ON user_sessions (user_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS user_sessions_expiry_idx
  ON user_sessions (expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE login_events
  ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES user_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS login_events_timeline_idx
  ON login_events (occurred_at DESC, success);
CREATE INDEX IF NOT EXISTS login_events_ip_idx
  ON login_events (ip_address, occurred_at DESC);

-- Это единственная серверная матрица ролей в БД. manager — совместимый alias
-- старых записей, который API нормализует в роль менеджера-инициатора.
INSERT INTO permissions (code, name, is_sensitive)
VALUES
  ('tasks.read_own', 'Просмотр своих задач', false),
  ('tasks.read_all', 'Просмотр всех задач', false),
  ('tasks.write_own', 'Изменение своих задач', false),
  ('tasks.create', 'Создание задач', false),
  ('tasks.assign', 'Назначение инженеров', false),
  ('tasks.accept', 'Принятие задачи инженером', false),
  ('tasks.close', 'Закрытие задачи инженером', false),
  ('tasks.review', 'Проверка закрытия задачи', false),
  ('warehouse.read', 'Просмотр складского окна', false),
  ('reports.read', 'Просмотр отчётов', true),
  ('users.read', 'Просмотр пользователей', true),
  ('roles.write', 'Управление ролями', true),
  ('notification_settings.write', 'Настройка уведомлений', true),
  ('price.read', 'Просмотр прайса', true),
  ('price.write', 'Изменение прайса', true)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  is_sensitive = EXCLUDED.is_sensitive;

DELETE FROM role_permissions
WHERE role IN ('coordinator', 'engineer', 'warehouse', 'initiator', 'manager', 'supervisor', 'admin');

INSERT INTO role_permissions (role, permission_code)
VALUES
  -- Координатор ведёт полный операционный цикл и счета.
  ('coordinator', 'tasks.read'), ('coordinator', 'tasks.read_all'), ('coordinator', 'tasks.write'),
  ('coordinator', 'tasks.create'), ('coordinator', 'tasks.assign'), ('coordinator', 'tasks.review'),
  ('coordinator', 'equipment.read'), ('coordinator', 'warehouse.read'), ('coordinator', 'warehouse.write'),
  ('coordinator', 'notifications.read'), ('coordinator', 'finance.read'), ('coordinator', 'finance.write'),
  ('coordinator', 'contracts.write'), ('coordinator', 'references.write'), ('coordinator', 'audit.read'),
  -- Инженер получает только свои задачи и мобильные операции. Финансовых прав нет.
  ('engineer', 'tasks.read'), ('engineer', 'tasks.read_own'), ('engineer', 'tasks.write_own'),
  ('engineer', 'tasks.accept'), ('engineer', 'tasks.close'), ('engineer', 'equipment.read'),
  ('engineer', 'warehouse.read'), ('engineer', 'notifications.read'),
  -- Кладовщик работает только со складским окном. Финансовых прав нет.
  ('warehouse', 'tasks.read'), ('warehouse', 'warehouse.read'), ('warehouse', 'warehouse.write'),
  ('warehouse', 'notifications.read'),
  -- Менеджер-инициатор и старый alias manager видят только свои заявки.
  ('initiator', 'tasks.read'), ('initiator', 'tasks.read_own'), ('initiator', 'tasks.write_own'),
  ('initiator', 'tasks.create'), ('initiator', 'notifications.read'),
  ('manager', 'tasks.read'), ('manager', 'tasks.read_own'), ('manager', 'tasks.write_own'),
  ('manager', 'tasks.create'), ('manager', 'notifications.read'),
  -- Руководитель видит операционные, складские, финансовые и отчётные данные.
  ('supervisor', 'tasks.read'), ('supervisor', 'tasks.read_all'), ('supervisor', 'tasks.write'),
  ('supervisor', 'tasks.create'), ('supervisor', 'tasks.assign'), ('supervisor', 'tasks.accept'),
  ('supervisor', 'tasks.close'), ('supervisor', 'tasks.review'), ('supervisor', 'equipment.read'),
  ('supervisor', 'warehouse.read'), ('supervisor', 'warehouse.write'), ('supervisor', 'notifications.read'),
  ('supervisor', 'finance.read'), ('supervisor', 'finance.write'), ('supervisor', 'contracts.write'),
  ('supervisor', 'references.write'), ('supervisor', 'reports.read'), ('supervisor', 'audit.read'),
  -- Администратор управляет учётными записями и настройками, но не получает финансы задач.
  ('admin', 'users.read'), ('admin', 'users.write'), ('admin', 'roles.write'),
  ('admin', 'references.write'), ('admin', 'notification_settings.write'), ('admin', 'price.read'),
  ('admin', 'price.write'), ('admin', 'audit.read')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 0008_user_profiles_and_competencies.sql
-- ---------------------------------------------------------------------------

-- Профили пользователей, принадлежность менеджера и компетенции инженеров.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS manager_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS users_manager_idx ON users (manager_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS engineer_competencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engineer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  manufacturer_id uuid NOT NULL REFERENCES manufacturers(id) ON DELETE RESTRICT,
  model_line text NOT NULL CHECK (btrim(model_line) <> ''),
  model_line_normalized text GENERATED ALWAYS AS (lower(btrim(model_line))) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, engineer_id),
  UNIQUE (engineer_id, manufacturer_id, model_line_normalized)
);

CREATE INDEX IF NOT EXISTS engineer_competencies_manufacturer_line_idx
  ON engineer_competencies (manufacturer_id, model_line_normalized);
CREATE INDEX IF NOT EXISTS engineer_competencies_engineer_idx
  ON engineer_competencies (engineer_id);

CREATE OR REPLACE FUNCTION validate_engineer_competency_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM users
    WHERE id = NEW.engineer_id AND role = 'engineer' AND is_active
  ) THEN
    RAISE EXCEPTION 'Компетенция может принадлежать только активному инженеру'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER engineer_competencies_owner_valid
  BEFORE INSERT OR UPDATE ON engineer_competencies
  FOR EACH ROW EXECUTE FUNCTION validate_engineer_competency_owner();

CREATE OR REPLACE FUNCTION validate_user_competency_role_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.role <> 'engineer' AND EXISTS (
    SELECT 1 FROM engineer_competencies WHERE engineer_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'Пользователь с компетенциями должен иметь роль engineer'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER users_competency_role_valid
  BEFORE UPDATE OF role, is_active ON users
  FOR EACH ROW EXECUTE FUNCTION validate_user_competency_role_change();

CREATE OR REPLACE VIEW active_engineer_competencies AS
SELECT
  c.engineer_id,
  u.full_name AS engineer_name,
  c.manufacturer_id,
  c.model_line,
  c.model_line_normalized
FROM engineer_competencies c
JOIN users u ON u.id = c.engineer_id
WHERE u.role = 'engineer' AND u.is_active;

-- ---------------------------------------------------------------------------
-- 0009_file_security_metadata.sql
-- ---------------------------------------------------------------------------

-- Дополнительные признаки безопасности файлов.

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS is_financial boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS files_financial_access_idx
  ON files (is_financial, task_id, created_at DESC);

CREATE TRIGGER audit_files
  AFTER INSERT OR UPDATE OR DELETE ON files FOR EACH ROW EXECUTE FUNCTION write_audit_row();

INSERT INTO permissions (code, name, is_sensitive)
VALUES
  ('files.read', 'Просмотр вложений', false),
  ('files.write', 'Загрузка вложений', false)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code)
VALUES
  ('coordinator', 'files.read'), ('coordinator', 'files.write'),
  ('engineer', 'files.read'), ('engineer', 'files.write'),
  ('initiator', 'files.read'), ('initiator', 'files.write'),
  ('manager', 'files.read'), ('manager', 'files.write'),
  ('supervisor', 'files.read'), ('supervisor', 'files.write')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 0010_immutable_domain_audit.sql
-- ---------------------------------------------------------------------------

-- Единый append-only журнал доменных действий и изменений.

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS event_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS actor_type text NOT NULL DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'success',
  ADD COLUMN IF NOT EXISTS changed_fields text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Автор хранится как исторический идентификатор: FK с ON DELETE SET NULL
-- изменял бы уже записанное событие при деактивации/удалении пользователя.
ALTER TABLE audit_log
  DROP CONSTRAINT IF EXISTS audit_log_actor_user_id_fkey;

ALTER TABLE audit_log
  DROP CONSTRAINT IF EXISTS audit_log_event_version_check,
  DROP CONSTRAINT IF EXISTS audit_log_actor_type_check,
  DROP CONSTRAINT IF EXISTS audit_log_outcome_check,
  ADD CONSTRAINT audit_log_event_version_check CHECK (event_version = 1),
  ADD CONSTRAINT audit_log_actor_type_check CHECK (actor_type IN ('user', 'system', 'anonymous')),
  ADD CONSTRAINT audit_log_outcome_check CHECK (outcome IN ('success', 'denied'));

CREATE INDEX IF NOT EXISTS audit_log_filter_timeline_idx
  ON audit_log (entity_type, action, outcome, occurred_at DESC);

CREATE OR REPLACE FUNCTION audit_changed_fields(p_before jsonb, p_after jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  WITH keys AS (
    SELECT key
    FROM jsonb_object_keys(coalesce(p_before, '{}'::jsonb) || coalesce(p_after, '{}'::jsonb)) AS value(key)
  )
  SELECT coalesce(array_agg(key ORDER BY key), ARRAY[]::text[])
  FROM keys
  WHERE (p_before -> key) IS DISTINCT FROM (p_after -> key)
$$;

CREATE OR REPLACE FUNCTION audit_snapshot(p_row jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_row - ARRAY[
    'created_at',
    'updated_at',
    'last_seen_at',
    'password_hash',
    'token_hash'
  ]::text[]
$$;

CREATE OR REPLACE FUNCTION audit_actor_from_row(p_row jsonb)
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  candidate text;
  current_actor uuid;
BEGIN
  current_actor := current_app_user_id();
  IF current_actor IS NOT NULL THEN
    RETURN current_actor;
  END IF;

  candidate := coalesce(
    p_row ->> 'updated_by',
    p_row ->> 'changed_by',
    p_row ->> 'performed_by',
    p_row ->> 'requested_by',
    p_row ->> 'created_by',
    p_row ->> 'author_id',
    p_row ->> 'uploaded_by',
    p_row ->> 'verified_by',
    p_row ->> 'submitted_by'
  );
  IF candidate ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN candidate::uuid;
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION audit_entity_type_for_table(p_table_name text, p_row jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_table_name IN (
      'tasks', 'task_status_history', 'task_assignments', 'task_closures', 'task_parts',
      'maintenance_plans'
    ) THEN 'task'
    WHEN p_table_name IN (
      'equipment', 'equipment_site_history', 'equipment_payer_history',
      'equipment_meter_readings', 'equipment_history'
    ) THEN 'equipment'
    WHEN p_table_name IN (
      'invoices', 'invoice_items', 'invoice_tasks', 'invoice_adjustments', 'invoice_status_history'
    ) THEN 'invoice'
    WHEN p_table_name IN (
      'parts', 'part_aliases', 'stock_lots', 'stock_reservations',
      'stock_reservation_history', 'stock_movements', 'contract_parts'
    ) THEN 'warehouse'
    WHEN p_table_name IN (
      'mail_messages', 'integration_messages', 'integration_outbox',
      'notifications', 'notification_templates', 'notification_preferences'
    ) THEN 'integration'
    WHEN p_table_name = 'files' AND p_row ->> 'task_id' IS NOT NULL THEN 'task'
    WHEN p_table_name = 'files' AND p_row ->> 'equipment_id' IS NOT NULL THEN 'equipment'
    WHEN p_table_name IN ('users') THEN 'user'
    WHEN p_table_name IN ('audit_log') THEN 'audit'
    WHEN p_table_name IN (
      'work_types', 'manufacturers', 'equipment_models', 'guarantee_categories',
      'equipment_statuses', 'task_statuses', 'task_status_transitions', 'task_reasons',
      'organizations', 'sites', 'site_contacts', 'payers', 'price_list',
      'contracts', 'contract_equipment', 'quotes', 'quote_items', 'permissions',
      'role_permissions'
    ) THEN 'reference'
    ELSE p_table_name
  END
$$;

CREATE OR REPLACE FUNCTION audit_entity_id_for_row(p_table_name text, p_row jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_table_name
    WHEN 'task_status_history' THEN coalesce(p_row ->> 'task_id', 'unknown')
    WHEN 'task_assignments' THEN coalesce(p_row ->> 'task_id', 'unknown')
    WHEN 'task_closures' THEN coalesce(p_row ->> 'task_id', 'unknown')
    WHEN 'task_parts' THEN coalesce(p_row ->> 'task_id', 'unknown')
    WHEN 'maintenance_plans' THEN coalesce(p_row ->> 'equipment_id', p_row ->> 'id', 'unknown')
    WHEN 'equipment_site_history' THEN coalesce(p_row ->> 'equipment_id', 'unknown')
    WHEN 'equipment_payer_history' THEN coalesce(p_row ->> 'equipment_id', 'unknown')
    WHEN 'equipment_meter_readings' THEN coalesce(p_row ->> 'equipment_id', 'unknown')
    WHEN 'equipment_history' THEN coalesce(p_row ->> 'equipment_id', 'unknown')
    WHEN 'invoice_items' THEN coalesce(p_row ->> 'invoice_id', 'unknown')
    WHEN 'invoice_tasks' THEN coalesce(p_row ->> 'invoice_id', 'unknown')
    WHEN 'invoice_adjustments' THEN coalesce(p_row ->> 'invoice_id', 'unknown')
    WHEN 'invoice_status_history' THEN coalesce(p_row ->> 'invoice_id', 'unknown')
    WHEN 'stock_reservation_history' THEN coalesce(p_row ->> 'reservation_id', 'unknown')
    WHEN 'contract_equipment' THEN coalesce(p_row ->> 'contract_id', 'unknown')
    WHEN 'contract_parts' THEN coalesce(p_row ->> 'contract_id', 'unknown')
    WHEN 'quote_items' THEN coalesce(p_row ->> 'quote_id', 'unknown')
    WHEN 'role_permissions' THEN concat_ws(':', p_row ->> 'role', p_row ->> 'permission_code')
    WHEN 'task_status_transitions' THEN concat_ws('->', p_row ->> 'from_status', p_row ->> 'to_status')
    ELSE coalesce(
      p_row ->> 'id',
      p_row ->> 'code',
      p_row ->> 'number',
      p_row ->> 'external_message_id',
      p_row ->> 'idempotency_key',
      'unknown'
    )
  END
$$;

CREATE OR REPLACE FUNCTION audit_action_for_row(
  p_table_name text,
  p_operation text,
  p_before jsonb,
  p_after jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_operation = 'DELETE' THEN 'deleted'
    WHEN p_table_name IN ('task_status_history', 'invoice_status_history', 'stock_reservation_history')
      THEN 'status_transition'
    WHEN p_operation = 'INSERT' THEN 'created'
    WHEN p_table_name = 'tasks'
      AND (p_before ->> 'status_code') IS DISTINCT FROM (p_after ->> 'status_code')
      THEN 'status_changed'
    WHEN p_table_name IN ('invoices', 'contracts', 'quotes', 'stock_reservations')
      AND (p_before ->> 'status') IS DISTINCT FROM (p_after ->> 'status')
      THEN 'status_changed'
    WHEN p_table_name IN ('equipment', 'integration_messages', 'integration_outbox', 'notifications')
      AND (p_before ->> 'status_code') IS DISTINCT FROM (p_after ->> 'status_code')
      AND (p_before ->> 'status') IS NOT DISTINCT FROM (p_after ->> 'status')
      THEN 'status_changed'
    WHEN p_table_name IN ('equipment', 'integration_messages', 'integration_outbox', 'notifications')
      AND (p_before ->> 'status') IS DISTINCT FROM (p_after ->> 'status')
      THEN 'status_changed'
    ELSE 'updated'
  END
$$;

CREATE OR REPLACE FUNCTION append_audit_event(
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_before_data jsonb DEFAULT NULL,
  p_after_data jsonb DEFAULT NULL,
  p_outcome text DEFAULT 'success',
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_actor_user_id uuid DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
-- Авторизованный слой использует action = 'operation_denied' и outcome = 'denied'
-- для отказов до изменения агрегата.
DECLARE
  event_id bigint;
  actor_id uuid;
  actor_kind text;
BEGIN
  IF nullif(btrim(p_action), '') IS NULL
    OR nullif(btrim(p_entity_type), '') IS NULL
    OR nullif(btrim(p_entity_id), '') IS NULL THEN
    RAISE EXCEPTION 'Событие аудита должно содержать действие и сущность'
      USING ERRCODE = '23514';
  END IF;

  actor_id := coalesce(p_actor_user_id, current_app_user_id());
  actor_kind := coalesce(
    nullif(current_setting('app.actor_type', true), ''),
    CASE WHEN actor_id IS NULL THEN 'system' ELSE 'user' END
  );
  IF actor_kind NOT IN ('user', 'system', 'anonymous') THEN
    RAISE EXCEPTION 'Недопустимый тип автора аудита: %', actor_kind
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO audit_log (
    event_version,
    actor_type,
    actor_user_id,
    action,
    outcome,
    entity_type,
    entity_id,
    before_data,
    after_data,
    changed_fields,
    metadata,
    request_id,
    ip_address,
    occurred_at
  )
  VALUES (
    1,
    actor_kind,
    actor_id,
    btrim(p_action),
    p_outcome,
    btrim(p_entity_type),
    btrim(p_entity_id),
    p_before_data,
    p_after_data,
    audit_changed_fields(p_before_data, p_after_data),
    coalesce(p_metadata, '{}'::jsonb),
    nullif(current_setting('app.request_id', true), ''),
    nullif(current_setting('app.ip_address', true), '')::inet,
    now()
  )
  RETURNING id INTO event_id;
  RETURN event_id;
END
$$;

CREATE OR REPLACE FUNCTION write_audit_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  before_row jsonb;
  after_row jsonb;
  before_data jsonb;
  after_data jsonb;
  entity_type_value text;
  entity_id_value text;
  action_value text;
BEGIN
  before_row := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  after_row := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  before_data := CASE WHEN before_row IS NULL THEN NULL ELSE audit_snapshot(before_row) END;
  after_data := CASE WHEN after_row IS NULL THEN NULL ELSE audit_snapshot(after_row) END;
  entity_type_value := audit_entity_type_for_table(TG_TABLE_NAME, coalesce(after_row, before_row));
  entity_id_value := audit_entity_id_for_row(TG_TABLE_NAME, coalesce(after_row, before_row));
  action_value := audit_action_for_row(TG_TABLE_NAME, TG_OP, before_row, after_row);

  PERFORM append_audit_event(
    action_value,
    entity_type_value,
    entity_id_value,
    before_data,
    after_data,
    'success',
    jsonb_strip_nulls(jsonb_build_object(
      'table_name', TG_TABLE_NAME,
      'operation', lower(TG_OP),
      'from_status', coalesce(before_row ->> 'status_code', before_row ->> 'status'),
      'to_status', coalesce(after_row ->> 'status_code', after_row ->> 'status')
    )),
    audit_actor_from_row(coalesce(after_row, before_row))
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION reject_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Журнал аудита неизменяем: операция % запрещена', TG_OP
    USING ERRCODE = '42501';
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_log_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM PUBLIC;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'organizations', 'sites', 'site_contacts', 'payers', 'users',
    'manufacturers', 'equipment_models', 'guarantee_categories', 'equipment',
    'equipment_site_history', 'equipment_payer_history', 'equipment_meter_readings',
    'equipment_statuses', 'work_types', 'task_statuses', 'task_status_transitions',
    'task_reasons', 'tasks', 'task_status_history', 'task_assignments',
    'maintenance_plans', 'task_parts', 'files', 'task_closures', 'equipment_history',
    'parts', 'part_aliases', 'stock_lots', 'stock_reservations',
    'stock_reservation_history', 'stock_movements', 'contracts', 'contract_equipment',
    'contract_parts', 'price_list', 'invoices', 'invoice_tasks', 'invoice_items',
    'invoice_adjustments', 'invoice_status_history', 'quotes', 'quote_items',
    'notification_templates', 'notification_preferences', 'notifications',
    'mail_messages', 'integration_messages', 'integration_outbox', 'permissions',
    'role_permissions'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'audit_' || table_name, table_name);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION write_audit_row()',
      'audit_' || table_name,
      table_name
    );
  END LOOP;
END
$$;

CREATE OR REPLACE VIEW audit_log_timeline AS
SELECT
  id,
  event_version,
  actor_type,
  actor_user_id,
  occurred_at,
  action,
  outcome,
  entity_type,
  entity_id,
  before_data,
  after_data,
  changed_fields,
  metadata,
  request_id,
  ip_address
FROM audit_log;

-- ---------------------------------------------------------------------------
-- 0011_performance_and_privacy_guardrails.sql
-- ---------------------------------------------------------------------------

-- Индексы и фильтр снимков аудита для базового профиля производительности.
-- Все объёмы и значения в нагрузочных сценариях синтетические.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS equipment_serial_number_trgm_idx
  ON equipment USING gin (serial_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS equipment_models_name_trgm_idx
  ON equipment_models USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS sites_name_trgm_idx
  ON sites USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS payers_name_trgm_idx
  ON payers USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS tasks_title_trgm_idx
  ON tasks USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS tasks_number_trgm_idx
  ON tasks USING gin (number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS equipment_history_feed_timeline_idx
  ON equipment_history (equipment_id, happened_at DESC, created_at DESC);

-- Снимки аудита не должны превращаться в копию секрета, файла или финансового
-- документа. В аудит попадают только безопасные метаданные и поля доменной
-- операции; значение чувствительного поля удаляется рекурсивно.
CREATE OR REPLACE FUNCTION audit_sanitize_jsonb(p_value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  item record;
  normalized_key text;
  result jsonb;
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(p_value) = 'object' THEN
    result := '{}'::jsonb;
    FOR item IN
      SELECT pair.key AS item_key, pair.value AS item_value
      FROM jsonb_each(p_value) AS pair
    LOOP
      normalized_key := lower(regexp_replace(item.item_key, '[^a-zA-Z0-9]', '', 'g'));
      IF normalized_key ~ '(password|passphrase|token|secret|authorization|cookie|credential|apikey)'
        OR normalized_key IN ('body', 'rawbody', 'content', 'filecontent', 'filebody', 'payload', 'parsedpayload', 'storagekey', 'binary', 'binarybody', 'attachment', 'attachmentbody')
        OR normalized_key ~ '(financial|amount|price|cost|currency|invoice|subtotal|totalamount|unitprice|laborprice|partscost|payment|requisite|budget)' THEN
        CONTINUE;
      END IF;
      result := result || jsonb_build_object(item.item_key, audit_sanitize_jsonb(item.item_value));
    END LOOP;
    RETURN result;
  END IF;

  IF jsonb_typeof(p_value) = 'array' THEN
    SELECT coalesce(jsonb_agg(audit_sanitize_jsonb(value)), '[]'::jsonb)
      INTO result
      FROM jsonb_array_elements(p_value) AS element(value);
    RETURN result;
  END IF;

  RETURN p_value;
END
$$;

-- Защищаем и прямые вызовы append_audit_event(), а не только row-триггеры:
-- внешние адаптеры не должны иметь способ записать сырой payload в аудит.
CREATE OR REPLACE FUNCTION append_audit_event(
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_before_data jsonb DEFAULT NULL,
  p_after_data jsonb DEFAULT NULL,
  p_outcome text DEFAULT 'success',
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_actor_user_id uuid DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  event_id bigint;
  actor_id uuid;
  actor_kind text;
  safe_before jsonb;
  safe_after jsonb;
  safe_metadata jsonb;
BEGIN
  IF nullif(btrim(p_action), '') IS NULL
    OR nullif(btrim(p_entity_type), '') IS NULL
    OR nullif(btrim(p_entity_id), '') IS NULL THEN
    RAISE EXCEPTION 'Событие аудита должно содержать действие и сущность'
      USING ERRCODE = '23514';
  END IF;

  safe_before := audit_sanitize_jsonb(p_before_data);
  safe_after := audit_sanitize_jsonb(p_after_data);
  safe_metadata := audit_sanitize_jsonb(coalesce(p_metadata, '{}'::jsonb));

  actor_id := coalesce(p_actor_user_id, current_app_user_id());
  actor_kind := coalesce(
    nullif(current_setting('app.actor_type', true), ''),
    CASE WHEN actor_id IS NULL THEN 'system' ELSE 'user' END
  );
  IF actor_kind NOT IN ('user', 'system', 'anonymous') THEN
    RAISE EXCEPTION 'Недопустимый тип автора аудита: %', actor_kind
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO audit_log (
    event_version,
    actor_type,
    actor_user_id,
    action,
    outcome,
    entity_type,
    entity_id,
    before_data,
    after_data,
    changed_fields,
    metadata,
    request_id,
    ip_address,
    occurred_at
  )
  VALUES (
    1,
    actor_kind,
    actor_id,
    btrim(p_action),
    p_outcome,
    btrim(p_entity_type),
    btrim(p_entity_id),
    safe_before,
    safe_after,
    audit_changed_fields(safe_before, safe_after),
    coalesce(safe_metadata, '{}'::jsonb),
    nullif(current_setting('app.request_id', true), ''),
    nullif(current_setting('app.ip_address', true), '')::inet,
    now()
  )
  RETURNING id INTO event_id;
  RETURN event_id;
END
$$;

CREATE OR REPLACE FUNCTION audit_snapshot(p_row jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT audit_sanitize_jsonb(p_row - ARRAY[
    'created_at',
    'updated_at',
    'last_seen_at',
    'password_hash',
    'token_hash'
  ]::text[])
$$;

-- ---------------------------------------------------------------------------
-- 0012_customer_role.sql
-- ---------------------------------------------------------------------------

-- Роль постоянного заказчика добавляется отдельной миграцией: PostgreSQL не
-- разрешает надёжно использовать новое enum-значение в той же транзакции.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'customer';

-- Область и permissions добавляются в следующей миграции после commit enum.

-- ---------------------------------------------------------------------------
-- 0013_customer_read_only_scope.sql
-- ---------------------------------------------------------------------------

-- Серверный задел доступа постоянных заказчиков.
-- В этапах 1–3 это только область организаций и API-политика; клиентский
-- интерфейс заказчика не входит в поставку этих этапов.

CREATE TABLE IF NOT EXISTS customer_organization_access (
  customer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_user_id, organization_id)
);

CREATE INDEX IF NOT EXISTS customer_organization_access_organization_idx
  ON customer_organization_access (organization_id, customer_user_id);

-- Совместимость с уже заведённой одиночной принадлежностью пользователя.
INSERT INTO customer_organization_access (customer_user_id, organization_id)
SELECT id, organization_id
FROM users
WHERE role = 'customer' AND organization_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO permissions (code, name, is_sensitive)
VALUES
  ('tasks.read_organization', 'Просмотр работ разрешённых организаций', false),
  ('files.read', 'Просмотр файлов разрешённых работ', false)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  is_sensitive = EXCLUDED.is_sensitive;

INSERT INTO role_permissions (role, permission_code)
VALUES
  ('customer', 'tasks.read'),
  ('customer', 'tasks.read_organization'),
  ('customer', 'files.read')
ON CONFLICT DO NOTHING;

-- В БД область задачи определяется через площадку: customer видит только
-- задачи, чья site.organization_id присутствует в его явной области.
CREATE OR REPLACE VIEW customer_task_scope AS
SELECT
  customer_access.customer_user_id,
  task.id AS task_id,
  site.organization_id
FROM customer_organization_access customer_access
JOIN tasks task ON true
JOIN sites site ON site.id = task.site_id
WHERE site.organization_id = customer_access.organization_id;

-- ---------------------------------------------------------------------------
-- 0014_m1_runtime_integrity.sql
-- ---------------------------------------------------------------------------

-- M1 production boundary: persistent ownership, exact file parents and
-- cross-table warehouse invariants. Existing migrations are immutable; all
-- corrections are additive and run only once by db/migrate.mjs.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS initiator_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS tasks_organization_period_idx
  ON tasks (organization_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS tasks_initiator_period_idx
  ON tasks (initiator_id, updated_at DESC);

-- The API/domain model has no rework pseudo-status. Rework is represented by
-- under_review -> in_progress and the legacy catalog entry is not selectable.
UPDATE task_statuses SET is_active = false WHERE code = 'rework';

CREATE OR REPLACE FUNCTION validate_active_task_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM task_statuses
    WHERE code = NEW.status_code AND is_active
  ) THEN
    RAISE EXCEPTION 'Статус задачи не активен: %', NEW.status_code
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS tasks_status_active ON tasks;
CREATE TRIGGER tasks_status_active
  BEFORE INSERT OR UPDATE OF status_code ON tasks
  FOR EACH ROW EXECUTE FUNCTION validate_active_task_status();

ALTER TABLE files
  ADD CONSTRAINT files_exactly_one_parent
  CHECK (
    (CASE WHEN task_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN equipment_id IS NOT NULL THEN 1 ELSE 0 END) = 1
  );

CREATE OR REPLACE FUNCTION reject_closed_task_file_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_task_status text;
  new_task_status text;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.task_id IS NOT NULL THEN
    SELECT status_code INTO old_task_status FROM tasks WHERE id = OLD.task_id;
    IF old_task_status = 'closed' THEN
      RAISE EXCEPTION 'Файл закрытой задачи нельзя изменить или удалить'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.task_id IS NOT NULL THEN
    SELECT status_code INTO new_task_status FROM tasks WHERE id = NEW.task_id;
    IF new_task_status = 'closed' THEN
      RAISE EXCEPTION 'В закрытую задачу нельзя добавить или привязать файл'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

DROP TRIGGER IF EXISTS files_closed_task_mutation ON files;
CREATE TRIGGER files_closed_task_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON files
  FOR EACH ROW EXECUTE FUNCTION reject_closed_task_file_mutation();

CREATE OR REPLACE FUNCTION reject_closed_task_closure_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'DELETE' AND EXISTS (
    SELECT 1 FROM tasks WHERE id = NEW.task_id AND status_code = 'closed'
  ) THEN
    RAISE EXCEPTION 'В закрытую задачу нельзя добавить или привязать акт'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP <> 'INSERT' AND EXISTS (
    SELECT 1 FROM tasks WHERE id = OLD.task_id AND status_code = 'closed'
  ) THEN
    RAISE EXCEPTION 'Акт закрытой задачи нельзя изменить или удалить'
      USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

DROP TRIGGER IF EXISTS task_closures_closed_mutation ON task_closures;
CREATE TRIGGER task_closures_closed_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON task_closures
  FOR EACH ROW EXECUTE FUNCTION reject_closed_task_closure_mutation();

CREATE OR REPLACE FUNCTION validate_stock_movement_links()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  reservation stock_reservations%ROWTYPE;
  task_row tasks%ROWTYPE;
BEGIN
  IF NEW.reservation_id IS NOT NULL THEN
    SELECT * INTO reservation FROM stock_reservations WHERE id = NEW.reservation_id FOR KEY SHARE;
    IF reservation.id IS NULL THEN
      RAISE EXCEPTION 'Резерв складского движения не найден' USING ERRCODE = '23503';
    END IF;
    IF reservation.part_id <> NEW.part_id OR reservation.part_condition <> NEW.part_condition THEN
      RAISE EXCEPTION 'Резерв, деталь и состояние складского движения не совпадают'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.task_id IS DISTINCT FROM reservation.task_id THEN
      RAISE EXCEPTION 'Задача складского движения не совпадает с задачей резерва'
        USING ERRCODE = '23514';
    END IF;
    IF reservation.status IN ('cancelled', 'returned') THEN
      RAISE EXCEPTION 'Нельзя провести движение по отменённому или возвращённому резерву'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.movement_type = 'reserve' AND reservation.status NOT IN ('created', 'warehouse_notified') THEN
      RAISE EXCEPTION 'Резервирование возможно только до выдачи детали' USING ERRCODE = '23514';
    END IF;
    IF NEW.movement_type = 'issue' AND reservation.status NOT IN ('created', 'warehouse_notified', 'issued') THEN
      RAISE EXCEPTION 'Выдача детали не соответствует состоянию резерва' USING ERRCODE = '23514';
    END IF;
    IF NEW.movement_type = 'install' AND reservation.status NOT IN ('issued', 'installed') THEN
      RAISE EXCEPTION 'Установка детали требует выданного резерва' USING ERRCODE = '23514';
    END IF;
    IF NEW.movement_type = 'return' AND reservation.status NOT IN ('issued', 'installed') THEN
      RAISE EXCEPTION 'Возврат детали требует выданного или установленного резерва' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.task_id IS NOT NULL THEN
    SELECT * INTO task_row FROM tasks WHERE id = NEW.task_id FOR KEY SHARE;
    IF task_row.id IS NULL THEN
      RAISE EXCEPTION 'Задача складского движения не найдена' USING ERRCODE = '23503';
    END IF;
    IF NEW.equipment_id IS NOT NULL AND task_row.equipment_id IS DISTINCT FROM NEW.equipment_id THEN
      RAISE EXCEPTION 'Прибор складского движения не совпадает с прибором задачи'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.movement_type = 'install' AND NEW.equipment_id IS NULL THEN
      RAISE EXCEPTION 'Для установки детали нужен прибор задачи' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.movement_type = 'install' AND (NEW.reservation_id IS NULL OR NEW.task_id IS NULL OR NEW.equipment_id IS NULL) THEN
    RAISE EXCEPTION 'Установка детали требует резерв, задачу и прибор' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS stock_movements_links_valid ON stock_movements;
CREATE TRIGGER stock_movements_links_valid
  BEFORE INSERT OR UPDATE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION validate_stock_movement_links();

-- Проверяем и обратное направление: после изменения резерва уже созданные
-- движения и строки деталей не должны остаться привязанными к другой задаче,
-- детали, состоянию или отменённому резерву. Constraint-триггер позволяет
-- одной транзакции сначала изменить резерв, а затем записать движение.
CREATE OR REPLACE FUNCTION validate_reservation_reference_updates()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM stock_movements movement
     WHERE movement.reservation_id = NEW.id
       AND (
         movement.task_id IS DISTINCT FROM NEW.task_id
         OR movement.part_id IS DISTINCT FROM NEW.part_id
         OR movement.part_condition IS DISTINCT FROM NEW.part_condition
         OR NEW.status = 'cancelled'
       )
  ) THEN
    RAISE EXCEPTION 'Изменение резерва нарушает связь со складским движением'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM task_parts detail
     WHERE detail.reservation_id = NEW.id
       AND (
         detail.task_id IS DISTINCT FROM NEW.task_id
         OR detail.part_id IS DISTINCT FROM NEW.part_id
         OR detail.part_condition IS DISTINCT FROM NEW.part_condition
       )
  ) THEN
    RAISE EXCEPTION 'Изменение резерва нарушает связь с деталями задачи'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS stock_reservation_references_valid ON stock_reservations;
CREATE CONSTRAINT TRIGGER stock_reservation_references_valid
  AFTER UPDATE OF task_id, part_id, part_condition, status ON stock_reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_reservation_reference_updates();

CREATE OR REPLACE FUNCTION validate_task_part_reservation_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  reservation stock_reservations%ROWTYPE;
BEGIN
  IF NEW.reservation_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO reservation FROM stock_reservations WHERE id = NEW.reservation_id FOR KEY SHARE;
  IF reservation.id IS NULL OR reservation.task_id IS DISTINCT FROM NEW.task_id
    OR reservation.part_id IS DISTINCT FROM NEW.part_id
    OR reservation.part_condition IS DISTINCT FROM NEW.part_condition
    OR reservation.status IN ('cancelled', 'returned') THEN
    RAISE EXCEPTION 'Строка деталей задачи не совпадает с активным резервом'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS task_parts_reservation_link_valid ON task_parts;
CREATE TRIGGER task_parts_reservation_link_valid
  BEFORE INSERT OR UPDATE ON task_parts
  FOR EACH ROW EXECUTE FUNCTION validate_task_part_reservation_link();

CREATE OR REPLACE VIEW customer_task_scope AS
SELECT
  customer_access.customer_user_id,
  task.id AS task_id,
  coalesce(task.organization_id, site.organization_id) AS organization_id
FROM customer_organization_access customer_access
JOIN tasks task ON true
LEFT JOIN sites site ON site.id = task.site_id
WHERE coalesce(task.organization_id, site.organization_id) = customer_access.organization_id;

-- ---------------------------------------------------------------------------
-- 0015_m1_model_integrity.sql
-- ---------------------------------------------------------------------------

-- M1 model integrity: current equipment ownership always has a matching open
-- history row, and document totals are derived from their line items.

CREATE OR REPLACE FUNCTION sync_equipment_site_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event_at timestamptz;
BEGIN
  event_at := clock_timestamp();

  IF TG_OP = 'UPDATE' AND NEW.current_site_id IS NOT DISTINCT FROM OLD.current_site_id THEN
    RETURN NEW;
  END IF;

  UPDATE equipment_site_history
     SET valid_to = event_at
   WHERE equipment_id = NEW.id
     AND valid_to IS NULL;

  IF NEW.current_site_id IS NOT NULL THEN
    INSERT INTO equipment_site_history (
      equipment_id, site_id, valid_from, changed_from_site_id, changed_by, comment
    )
    VALUES (
      NEW.id,
      NEW.current_site_id,
      event_at,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.current_site_id ELSE NULL END,
      current_app_user_id(),
      CASE WHEN TG_OP = 'INSERT' THEN 'Начальная запись места установки' ELSE 'Автоматическая запись изменения места установки' END
    );
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION sync_equipment_payer_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event_at timestamptz;
BEGIN
  event_at := clock_timestamp();

  IF TG_OP = 'UPDATE' AND NEW.current_payer_id IS NOT DISTINCT FROM OLD.current_payer_id THEN
    RETURN NEW;
  END IF;

  UPDATE equipment_payer_history
     SET valid_to = event_at
   WHERE equipment_id = NEW.id
     AND valid_to IS NULL;

  IF NEW.current_payer_id IS NOT NULL THEN
    INSERT INTO equipment_payer_history (
      equipment_id, payer_id, valid_from, changed_from_payer_id, changed_by, comment
    )
    VALUES (
      NEW.id,
      NEW.current_payer_id,
      event_at,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.current_payer_id ELSE NULL END,
      current_app_user_id(),
      CASE WHEN TG_OP = 'INSERT' THEN 'Начальная запись плательщика' ELSE 'Автоматическая запись изменения плательщика' END
    );
  END IF;
  RETURN NEW;
END
$$;

-- Backfill the open interval for databases created before this migration.
-- Existing closed imported intervals may extend past equipment.created_at, so
-- the new interval must continue the timeline instead of overlapping it.
LOCK TABLE equipment, equipment_site_history, equipment_payer_history
  IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO equipment_site_history (
  equipment_id, site_id, valid_from, changed_from_site_id, changed_by, comment
)
SELECT equipment.id,
       equipment.current_site_id,
       coalesce(last_history.valid_to, equipment.created_at),
       last_history.site_id,
       current_app_user_id(),
       'Восстановленная текущая запись места установки'
  FROM equipment
  LEFT JOIN LATERAL (
    SELECT history.site_id, history.valid_to
      FROM equipment_site_history history
     WHERE history.equipment_id = equipment.id
     ORDER BY history.valid_to DESC NULLS FIRST, history.valid_from DESC
     LIMIT 1
  ) last_history ON true
 WHERE equipment.current_site_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM equipment_site_history history
      WHERE history.equipment_id = equipment.id
        AND history.valid_to IS NULL
   );

INSERT INTO equipment_payer_history (
  equipment_id, payer_id, valid_from, changed_from_payer_id, changed_by, comment
)
SELECT equipment.id,
       equipment.current_payer_id,
       coalesce(last_history.valid_to, equipment.created_at),
       last_history.payer_id,
       current_app_user_id(),
       'Восстановленная текущая запись плательщика'
  FROM equipment
  LEFT JOIN LATERAL (
    SELECT history.payer_id, history.valid_to
      FROM equipment_payer_history history
     WHERE history.equipment_id = equipment.id
     ORDER BY history.valid_to DESC NULLS FIRST, history.valid_from DESC
     LIMIT 1
  ) last_history ON true
 WHERE equipment.current_payer_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM equipment_payer_history history
      WHERE history.equipment_id = equipment.id
        AND history.valid_to IS NULL
   );

DROP TRIGGER IF EXISTS equipment_site_history_sync ON equipment;
CREATE TRIGGER equipment_site_history_sync
  AFTER INSERT OR UPDATE OF current_site_id ON equipment
  FOR EACH ROW EXECUTE FUNCTION sync_equipment_site_history();

DROP TRIGGER IF EXISTS equipment_payer_history_sync ON equipment;
CREATE TRIGGER equipment_payer_history_sync
  AFTER INSERT OR UPDATE OF current_payer_id ON equipment
  FOR EACH ROW EXECUTE FUNCTION sync_equipment_payer_history();

CREATE OR REPLACE FUNCTION refresh_invoice_total(p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE invoices
     SET subtotal = coalesce((SELECT sum(line_total) FROM invoice_items WHERE invoice_id = p_invoice_id), 0),
         total_amount = greatest(0::numeric,
           coalesce((SELECT sum(line_total) FROM invoice_items WHERE invoice_id = p_invoice_id), 0)
           + adjustment_amount),
         updated_at = now()
   WHERE id = p_invoice_id;
END
$$;

CREATE OR REPLACE FUNCTION enforce_invoice_amounts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  line_total numeric;
BEGIN
  SELECT coalesce(sum(line_total), 0) INTO line_total
    FROM invoice_items
   WHERE invoice_id = NEW.id;
  NEW.subtotal := line_total;
  NEW.total_amount := greatest(0::numeric, line_total + coalesce(NEW.adjustment_amount, 0));
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION recalculate_invoice_total()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.invoice_id IS DISTINCT FROM NEW.invoice_id THEN
    PERFORM refresh_invoice_total(OLD.invoice_id);
  END IF;
  PERFORM refresh_invoice_total(CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END);
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS invoices_amounts ON invoices;
CREATE TRIGGER invoices_amounts
  BEFORE INSERT OR UPDATE OF subtotal, adjustment_amount, total_amount ON invoices
  FOR EACH ROW EXECUTE FUNCTION enforce_invoice_amounts();

DROP TRIGGER IF EXISTS invoice_items_total ON invoice_items;
CREATE TRIGGER invoice_items_total
  AFTER INSERT OR UPDATE OR DELETE ON invoice_items
  FOR EACH ROW EXECUTE FUNCTION recalculate_invoice_total();

CREATE OR REPLACE FUNCTION refresh_quote_total(p_quote_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE quotes
     SET total_amount = coalesce((SELECT sum(line_total) FROM quote_items WHERE quote_id = p_quote_id), 0),
         updated_at = now()
   WHERE id = p_quote_id;
END
$$;

CREATE OR REPLACE FUNCTION enforce_quote_total()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.total_amount := coalesce((SELECT sum(line_total) FROM quote_items WHERE quote_id = NEW.id), 0);
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION recalculate_quote_total()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.quote_id IS DISTINCT FROM NEW.quote_id THEN
    PERFORM refresh_quote_total(OLD.quote_id);
  END IF;
  PERFORM refresh_quote_total(CASE WHEN TG_OP = 'DELETE' THEN OLD.quote_id ELSE NEW.quote_id END);
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS quotes_amounts ON quotes;
CREATE TRIGGER quotes_amounts
  BEFORE INSERT OR UPDATE OF total_amount ON quotes
  FOR EACH ROW EXECUTE FUNCTION enforce_quote_total();

DROP TRIGGER IF EXISTS quote_items_total ON quote_items;
CREATE TRIGGER quote_items_total
  AFTER INSERT OR UPDATE OR DELETE ON quote_items
  FOR EACH ROW EXECUTE FUNCTION recalculate_quote_total();

-- ---------------------------------------------------------------------------
-- 0016_m1_review_blockers.sql
-- ---------------------------------------------------------------------------

-- Идемпотентность повторного импорта истории приборов из XLSX.
-- Ручные и доменные события остаются без source_key и не затрагиваются.

ALTER TABLE equipment_history
  ADD COLUMN IF NOT EXISTS source_key text;

ALTER TABLE equipment_history
  ADD CONSTRAINT equipment_history_source_key_format
  CHECK (source_key IS NULL OR source_key ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX IF NOT EXISTS equipment_history_import_source_uq
  ON equipment_history (equipment_id, source_key)
  WHERE source_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 0017_role_scope_review_blockers.sql
-- ---------------------------------------------------------------------------

-- Сужение ролей по блокирующим замечаниям M1.
-- Кладовщик работает через складское окно, администратор не читает
-- глобальный операционный аудит.

DELETE FROM role_permissions
WHERE (role = 'warehouse' AND permission_code = 'tasks.read')
   OR (role = 'admin' AND permission_code = 'audit.read');

-- ---------------------------------------------------------------------------
-- 0018_atomic_task_file_quotas.sql
-- ---------------------------------------------------------------------------

-- Атомарные лимиты фото/видео задачи. Счётчики обновляются в той же
-- транзакции, что и files, поэтому конкурентные INSERT не проходят лимит.

CREATE TABLE IF NOT EXISTS task_file_quotas (
  task_id uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  photo_count smallint NOT NULL DEFAULT 0 CHECK (photo_count BETWEEN 0 AND 10),
  video_count smallint NOT NULL DEFAULT 0 CHECK (video_count BETWEEN 0 AND 2)
);

INSERT INTO task_file_quotas (task_id, photo_count, video_count)
SELECT task.id,
       count(file.id) FILTER (WHERE file.kind = 'photo')::smallint,
       count(file.id) FILTER (WHERE file.kind = 'video')::smallint
  FROM tasks task
  LEFT JOIN files file ON file.task_id = task.id
 GROUP BY task.id
HAVING count(file.id) FILTER (WHERE file.kind IN ('photo', 'video')) > 0;

CREATE OR REPLACE FUNCTION adjust_task_file_quota(
  p_task_id uuid,
  p_kind file_kind,
  p_delta integer
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  next_count smallint;
BEGIN
  IF p_task_id IS NULL OR p_kind NOT IN ('photo', 'video') THEN
    RETURN;
  END IF;

  IF p_delta > 0 THEN
    INSERT INTO task_file_quotas (task_id)
    VALUES (p_task_id)
    ON CONFLICT (task_id) DO NOTHING;
  END IF;

  IF p_kind = 'photo' THEN
    UPDATE task_file_quotas
       SET photo_count = photo_count + p_delta
     WHERE task_id = p_task_id
       AND photo_count + p_delta BETWEEN 0 AND 10
     RETURNING photo_count INTO next_count;
  ELSE
    UPDATE task_file_quotas
       SET video_count = video_count + p_delta
     WHERE task_id = p_task_id
       AND video_count + p_delta BETWEEN 0 AND 2
     RETURNING video_count INTO next_count;
  END IF;

  IF NOT FOUND AND p_delta < 0 THEN
    -- При каскадном удалении задачи строка счётчика могла быть уже удалена.
    RETURN;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Для задачи достигнут лимит вложений типа %', p_kind
      USING ERRCODE = '23514', CONSTRAINT = 'task_file_quota_limit';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION sync_task_file_quota()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM adjust_task_file_quota(NEW.task_id, NEW.kind, 1);
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM adjust_task_file_quota(OLD.task_id, OLD.kind, -1);
    RETURN OLD;
  END IF;

  IF (NEW.task_id, NEW.kind) IS DISTINCT FROM (OLD.task_id, OLD.kind) THEN
    PERFORM adjust_task_file_quota(OLD.task_id, OLD.kind, -1);
    PERFORM adjust_task_file_quota(NEW.task_id, NEW.kind, 1);
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS files_task_quota ON files;
CREATE TRIGGER files_task_quota
  BEFORE INSERT OR DELETE OR UPDATE OF task_id, kind ON files
  FOR EACH ROW EXECUTE FUNCTION sync_task_file_quota();

-- ---------------------------------------------------------------------------
-- 0019_protected_invoice_financial_audit.sql
-- ---------------------------------------------------------------------------

-- Финансовые значения счёта являются доменным аудитом, а не эксплуатационным
-- логом. Они сохраняются только для entity_type=invoice и выдаются API лишь
-- ролям, одновременно имеющим audit.read и finance.read.

CREATE OR REPLACE FUNCTION audit_sanitize_domain_jsonb(p_value jsonb, p_entity_type text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  item record;
  normalized_key text;
  result jsonb;
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(p_value) = 'object' THEN
    result := '{}'::jsonb;
    FOR item IN
      SELECT pair.key AS item_key, pair.value AS item_value
      FROM jsonb_each(p_value) AS pair
    LOOP
      normalized_key := lower(regexp_replace(item.item_key, '[^a-zA-Z0-9]', '', 'g'));
      IF normalized_key ~ '(password|passphrase|token|secret|authorization|cookie|credential|apikey)'
        OR normalized_key IN ('body', 'rawbody', 'content', 'filecontent', 'filebody', 'payload', 'parsedpayload', 'storagekey', 'binary', 'binarybody', 'attachment', 'attachmentbody')
        OR (p_entity_type <> 'invoice'
          AND normalized_key ~ '(financial|amount|price|cost|currency|invoice|subtotal|totalamount|unitprice|laborprice|partscost|payment|requisite|budget)') THEN
        CONTINUE;
      END IF;
      result := result || jsonb_build_object(
        item.item_key,
        audit_sanitize_domain_jsonb(item.item_value, p_entity_type)
      );
    END LOOP;
    RETURN result;
  END IF;

  IF jsonb_typeof(p_value) = 'array' THEN
    SELECT coalesce(jsonb_agg(audit_sanitize_domain_jsonb(value, p_entity_type)), '[]'::jsonb)
      INTO result
      FROM jsonb_array_elements(p_value) AS element(value);
    RETURN result;
  END IF;

  RETURN p_value;
END
$$;

-- Подготавливаем полный доменный снимок. Окончательное решение о финансовых
-- полях принимает append_audit_event после определения контура сущности.
CREATE OR REPLACE FUNCTION audit_snapshot(p_row jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT audit_sanitize_domain_jsonb(p_row - ARRAY[
    'created_at',
    'updated_at',
    'last_seen_at',
    'password_hash',
    'token_hash'
  ]::text[], 'invoice')
$$;

CREATE OR REPLACE FUNCTION append_audit_event(
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_before_data jsonb DEFAULT NULL,
  p_after_data jsonb DEFAULT NULL,
  p_outcome text DEFAULT 'success',
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_actor_user_id uuid DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  event_id bigint;
  actor_id uuid;
  actor_kind text;
  safe_before jsonb;
  safe_after jsonb;
  safe_metadata jsonb;
BEGIN
  IF nullif(btrim(p_action), '') IS NULL
    OR nullif(btrim(p_entity_type), '') IS NULL
    OR nullif(btrim(p_entity_id), '') IS NULL THEN
    RAISE EXCEPTION 'Событие аудита должно содержать действие и сущность'
      USING ERRCODE = '23514';
  END IF;

  safe_before := audit_sanitize_domain_jsonb(p_before_data, btrim(p_entity_type));
  safe_after := audit_sanitize_domain_jsonb(p_after_data, btrim(p_entity_type));
  safe_metadata := audit_sanitize_domain_jsonb(coalesce(p_metadata, '{}'::jsonb), btrim(p_entity_type));

  actor_id := coalesce(p_actor_user_id, current_app_user_id());
  actor_kind := coalesce(
    nullif(current_setting('app.actor_type', true), ''),
    CASE WHEN actor_id IS NULL THEN 'system' ELSE 'user' END
  );
  IF actor_kind NOT IN ('user', 'system', 'anonymous') THEN
    RAISE EXCEPTION 'Недопустимый тип автора аудита: %', actor_kind
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO audit_log (
    event_version, actor_type, actor_user_id, action, outcome, entity_type,
    entity_id, before_data, after_data, changed_fields, metadata, request_id,
    ip_address, occurred_at
  ) VALUES (
    1, actor_kind, actor_id, btrim(p_action), p_outcome, btrim(p_entity_type),
    btrim(p_entity_id), safe_before, safe_after,
    audit_changed_fields(safe_before, safe_after), coalesce(safe_metadata, '{}'::jsonb),
    nullif(current_setting('app.request_id', true), ''),
    nullif(current_setting('app.ip_address', true), '')::inet, now()
  )
  RETURNING id INTO event_id;
  RETURN event_id;
END
$$;

CREATE OR REPLACE FUNCTION validate_invoice_financial_correction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.adjustment_amount IS DISTINCT FROM OLD.adjustment_amount THEN
    IF current_app_user_id() IS NULL THEN
      RAISE EXCEPTION 'Для корректировки счёта обязателен автор'
        USING ERRCODE = '23514';
    END IF;
    IF nullif(btrim(coalesce(NEW.correction_reason, '')), '') IS NULL
      OR NEW.correction_reason IS NOT DISTINCT FROM OLD.correction_reason THEN
      RAISE EXCEPTION 'Для каждой корректировки счёта обязательна новая причина'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION record_invoice_financial_correction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.adjustment_amount IS DISTINCT FROM OLD.adjustment_amount THEN
    INSERT INTO invoice_adjustments (invoice_id, author_id, before_value, after_value, reason)
    VALUES (
      NEW.id,
      current_app_user_id(),
      jsonb_build_object(
        'subtotal', OLD.subtotal,
        'adjustmentAmount', OLD.adjustment_amount,
        'totalAmount', OLD.total_amount
      ),
      jsonb_build_object(
        'subtotal', NEW.subtotal,
        'adjustmentAmount', NEW.adjustment_amount,
        'totalAmount', NEW.total_amount
      ),
      btrim(NEW.correction_reason)
    );
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS invoices_financial_correction_guard ON invoices;
CREATE TRIGGER invoices_financial_correction_guard
  BEFORE UPDATE OF adjustment_amount ON invoices
  FOR EACH ROW EXECUTE FUNCTION validate_invoice_financial_correction();

DROP TRIGGER IF EXISTS invoices_financial_correction_audit ON invoices;
CREATE TRIGGER invoices_financial_correction_audit
  AFTER UPDATE OF adjustment_amount ON invoices
  FOR EACH ROW EXECUTE FUNCTION record_invoice_financial_correction();

-- ---------------------------------------------------------------------------
-- 0020_runtime_roles_and_last_admin.sql
-- ---------------------------------------------------------------------------

-- Runtime-процессы не владеют схемой и не могут отключать защитные триггеры.
-- Login-роли создаёт локальный provisioner; миграция выдаёт права NOLOGIN-группам.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'medtech_schema_owner') THEN
    CREATE ROLE medtech_schema_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'medtech_api') THEN
    CREATE ROLE medtech_api NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'medtech_worker') THEN
    CREATE ROLE medtech_worker NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'medtech_backup') THEN
    CREATE ROLE medtech_backup NOLOGIN;
  END IF;
END
$$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO medtech_api, medtech_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO medtech_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO medtech_api;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO medtech_api;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO medtech_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO medtech_backup;

-- Даже широкий DML-доступ приложения не включает изменение журнала или
-- миграций. Владелец схемы остаётся только у одноразового migrator.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM medtech_api;
REVOKE ALL ON schema_migrations FROM medtech_api, medtech_backup;

-- В managed/self-hosted Supabase роль postgres обычно не superuser.
-- ALTER DEFAULT PRIVILEGES FOR ROLE требует членства в этой роли (PG 16+).
DO $$
BEGIN
  BEGIN
    EXECUTE format('GRANT medtech_schema_owner TO %I', current_user);
  EXCEPTION
    WHEN insufficient_privilege OR invalid_grant_operation THEN
      NULL;
  END;

  ALTER DEFAULT PRIVILEGES FOR ROLE medtech_schema_owner IN SCHEMA public
    REVOKE ALL ON TABLES FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES FOR ROLE medtech_schema_owner IN SCHEMA public
    REVOKE ALL ON SEQUENCES FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES FOR ROLE medtech_schema_owner IN SCHEMA public
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES FOR ROLE medtech_schema_owner IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO medtech_api;
  ALTER DEFAULT PRIVILEGES FOR ROLE medtech_schema_owner IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO medtech_api;
  ALTER DEFAULT PRIVILEGES FOR ROLE medtech_schema_owner IN SCHEMA public
    GRANT EXECUTE ON FUNCTIONS TO medtech_api;
  ALTER DEFAULT PRIVILEGES FOR ROLE medtech_schema_owner IN SCHEMA public
    GRANT SELECT ON TABLES TO medtech_backup;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Пропуск ALTER DEFAULT PRIVILEGES: %', SQLERRM;
END
$$;

CREATE OR REPLACE FUNCTION preserve_last_active_administrator()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.role = 'admin' AND OLD.is_active
    AND (TG_OP = 'DELETE' OR NOT NEW.is_active OR NEW.role <> 'admin') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('medtechservice:last-active-admin', 0));
    IF NOT EXISTS (
      SELECT 1 FROM users
       WHERE role = 'admin' AND is_active AND id <> OLD.id
    ) THEN
      RAISE EXCEPTION 'Нельзя удалить последнего активного администратора'
        USING ERRCODE = '23514', CONSTRAINT = 'users_last_active_admin';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS users_preserve_last_active_admin ON users;
CREATE TRIGGER users_preserve_last_active_admin
  BEFORE UPDATE OF role, is_active OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION preserve_last_active_administrator();

REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM medtech_api;
REVOKE ALL ON schema_migrations FROM medtech_api, medtech_backup;

-- ---------------------------------------------------------------------------
-- 0021_reference_catalogs.sql
-- ---------------------------------------------------------------------------

-- M2: стартовые справочники приборов и сервисных случаев.
-- Существующие записи не перезаписываются: миграция только дополняет каталог
-- и усиливает ссылочную целостность заполненной базы.

ALTER TABLE guarantee_categories
  ADD COLUMN IF NOT EXISTS supplier_coverage_percent numeric(5, 2);

ALTER TABLE guarantee_categories
  ADD COLUMN IF NOT EXISTS is_full_annual_supplier_warranty boolean
    GENERATED ALWAYS AS (
      coalesce(supplier_coverage_percent = 100 AND supplier_warranty_months = 12, false)
    ) STORED;

UPDATE guarantee_categories
   SET supplier_coverage_percent = 100
 WHERE code = 'supplier_annual'
   AND supplier_coverage_percent IS NULL;

ALTER TABLE guarantee_categories
  ADD CONSTRAINT guarantee_categories_supplier_coverage_percent_check
    CHECK (supplier_coverage_percent IS NULL OR supplier_coverage_percent BETWEEN 0 AND 100),
  ADD CONSTRAINT guarantee_categories_supplier_warranty_definition_check
    CHECK (
      supplier_coverage_percent IS NULL OR supplier_warranty_months > 0
    );

INSERT INTO manufacturers (name)
SELECT seed.name
  FROM (VALUES
    ('Beckman Coulter'),
    ('Mindray')
  ) AS seed(name)
 WHERE NOT EXISTS (
   SELECT 1 FROM manufacturers existing
    WHERE lower(btrim(existing.name)) = lower(btrim(seed.name))
 );

INSERT INTO equipment_models (manufacturer_id, name)
SELECT manufacturer.id, seed.model_name
  FROM (VALUES
    ('Beckman Coulter', 'DxH-800'),
    ('Beckman Coulter', 'AU 480'),
    ('Beckman Coulter', 'DxH 690T'),
    ('Mindray', 'BS-620'),
    ('Mindray', 'BS-240'),
    ('Mindray', 'CL-1200i')
  ) AS seed(manufacturer_name, model_name)
  JOIN manufacturers manufacturer
    ON lower(btrim(manufacturer.name)) = lower(btrim(seed.manufacturer_name))
 WHERE NOT EXISTS (
   SELECT 1
     FROM equipment_models existing
    WHERE existing.manufacturer_id = manufacturer.id
      AND lower(btrim(existing.name)) = lower(btrim(seed.model_name))
 );

INSERT INTO task_reasons (code, name, sort_order)
VALUES ('factory_defect', 'Заводской дефект', 40)
ON CONFLICT (code) DO NOTHING;

-- Используемое значение справочника нельзя удалить. Для скрытия устаревших
-- значений предназначен is_active, поэтому исторические ссылки сохраняются.
ALTER TABLE equipment
  DROP CONSTRAINT IF EXISTS equipment_guarantee_category_id_fkey,
  ADD CONSTRAINT equipment_guarantee_category_id_fkey
    FOREIGN KEY (guarantee_category_id)
    REFERENCES guarantee_categories(id)
    ON DELETE RESTRICT;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_reason_code_fkey,
  ADD CONSTRAINT tasks_reason_code_fkey
    FOREIGN KEY (reason_code)
    REFERENCES task_reasons(code)
    ON DELETE RESTRICT;

ALTER TABLE price_list
  DROP CONSTRAINT IF EXISTS price_list_guarantee_category_id_fkey,
  ADD CONSTRAINT price_list_guarantee_category_id_fkey
    FOREIGN KEY (guarantee_category_id)
    REFERENCES guarantee_categories(id)
    ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION validate_active_equipment_references()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  manufacturer_changed boolean;
  model_changed boolean;
  guarantee_changed boolean;
  status_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    manufacturer_changed := true;
    model_changed := true;
    guarantee_changed := true;
    status_changed := true;
  ELSE
    manufacturer_changed := NEW.manufacturer_id IS DISTINCT FROM OLD.manufacturer_id;
    model_changed := NEW.model_id IS DISTINCT FROM OLD.model_id;
    guarantee_changed := NEW.guarantee_category_id IS DISTINCT FROM OLD.guarantee_category_id;
    status_changed := NEW.status_code IS DISTINCT FROM OLD.status_code;
  END IF;

  IF manufacturer_changed AND NOT EXISTS (
    SELECT 1 FROM manufacturers
     WHERE id = NEW.manufacturer_id AND is_active
  ) THEN
    RAISE EXCEPTION 'Производитель прибора не активен: %', NEW.manufacturer_id
      USING ERRCODE = '23514';
  END IF;

  IF model_changed AND NOT EXISTS (
    SELECT 1 FROM equipment_models
     WHERE id = NEW.model_id AND is_active
  ) THEN
    RAISE EXCEPTION 'Модель прибора не активна: %', NEW.model_id
      USING ERRCODE = '23514';
  END IF;

  IF guarantee_changed AND NEW.guarantee_category_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM guarantee_categories
     WHERE id = NEW.guarantee_category_id AND is_active
  ) THEN
    RAISE EXCEPTION 'Категория гарантии прибора не активна: %', NEW.guarantee_category_id
      USING ERRCODE = '23514';
  END IF;

  IF status_changed AND NOT EXISTS (
    SELECT 1 FROM equipment_statuses
     WHERE code = NEW.status_code AND is_active
  ) THEN
    RAISE EXCEPTION 'Статус прибора не активен: %', NEW.status_code
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS equipment_references_active ON equipment;
CREATE TRIGGER equipment_references_active
  BEFORE INSERT OR UPDATE OF manufacturer_id, model_id, guarantee_category_id, status_code
  ON equipment
  FOR EACH ROW EXECUTE FUNCTION validate_active_equipment_references();

CREATE OR REPLACE FUNCTION validate_active_task_reason()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.reason_code IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM task_reasons
     WHERE code = NEW.reason_code AND is_active
  ) THEN
    RAISE EXCEPTION 'Причина сервисного случая не активна: %', NEW.reason_code
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS tasks_reason_active ON tasks;
CREATE TRIGGER tasks_reason_active
  BEFORE INSERT OR UPDATE OF reason_code ON tasks
  FOR EACH ROW EXECUTE FUNCTION validate_active_task_reason();

CREATE INDEX IF NOT EXISTS manufacturers_active_name_idx
  ON manufacturers (is_active, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS equipment_models_active_manufacturer_name_idx
  ON equipment_models (manufacturer_id, is_active, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS guarantee_categories_active_name_idx
  ON guarantee_categories (is_active, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS equipment_statuses_active_order_idx
  ON equipment_statuses (is_active, sort_order);

-- ---------------------------------------------------------------------------
-- 0022_customer_directories.sql
-- ---------------------------------------------------------------------------

-- M2: рабочие справочники площадок, контактов и самостоятельных плательщиков.
-- Снимок данных заказчика хранится в задаче, чтобы карточка и акт не менялись
-- задним числом после редактирования справочника.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS site_contact_id uuid,
  ADD COLUMN IF NOT EXISTS customer_name text,
  ADD COLUMN IF NOT EXISTS customer_address text,
  ADD COLUMN IF NOT EXISTS contact_email text,
  ADD COLUMN IF NOT EXISTS payer_name text;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_site_contact_id_fkey,
  ADD CONSTRAINT tasks_site_contact_id_fkey
    FOREIGN KEY (site_contact_id) REFERENCES site_contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS tasks_site_contact_idx
  ON tasks (site_contact_id) WHERE site_contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS site_contacts_name_ci_idx
  ON site_contacts (site_id, lower(btrim(full_name)));

INSERT INTO permissions (code, name, is_sensitive)
VALUES ('references.read', 'Просмотр справочников площадок, контактов и плательщиков', false)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  is_sensitive = EXCLUDED.is_sensitive;

INSERT INTO role_permissions (role, permission_code)
VALUES
  ('coordinator', 'references.read'),
  ('supervisor', 'references.read'),
  ('admin', 'references.read')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION fill_task_customer_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  selected_site sites%ROWTYPE;
  selected_contact site_contacts%ROWTYPE;
  selected_payer payers%ROWTYPE;
  site_changed boolean;
  contact_changed boolean;
  payer_changed boolean;
BEGIN
  site_changed := TG_OP = 'INSERT'
    OR NEW.site_id IS DISTINCT FROM OLD.site_id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id;
  contact_changed := TG_OP = 'INSERT' OR NEW.site_contact_id IS DISTINCT FROM OLD.site_contact_id;
  payer_changed := TG_OP = 'INSERT' OR NEW.payer_id IS DISTINCT FROM OLD.payer_id;

  IF NEW.site_id IS NULL AND NEW.site_contact_id IS NOT NULL THEN
    RAISE EXCEPTION 'Контакт задачи нельзя выбрать без площадки'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.site_id IS NOT NULL AND site_changed THEN
    SELECT * INTO selected_site FROM sites WHERE id = NEW.site_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Площадка задачи не найдена: %', NEW.site_id
        USING ERRCODE = '23503';
    END IF;
    IF NEW.organization_id IS NOT NULL AND selected_site.organization_id IS NOT NULL
       AND NEW.organization_id <> selected_site.organization_id THEN
      RAISE EXCEPTION 'Организация задачи не соответствует выбранной площадке'
        USING ERRCODE = '23514';
    END IF;
    NEW.organization_id := coalesce(NEW.organization_id, selected_site.organization_id);
    NEW.customer_name := selected_site.name;
    NEW.customer_address := selected_site.address;
  ELSIF NEW.site_id IS NULL AND site_changed THEN
    NEW.customer_name := NULL;
    NEW.customer_address := NULL;
  END IF;

  IF NEW.site_contact_id IS NOT NULL AND (site_changed OR contact_changed) THEN
    SELECT * INTO selected_contact FROM site_contacts WHERE id = NEW.site_contact_id;
    IF NOT FOUND OR selected_contact.site_id <> NEW.site_id THEN
      RAISE EXCEPTION 'Контакт задачи не относится к выбранной площадке'
        USING ERRCODE = '23514';
    END IF;
    NEW.contact_name := selected_contact.full_name;
    NEW.contact_phone := selected_contact.phone;
    NEW.contact_email := selected_contact.email;
  ELSIF NEW.site_contact_id IS NULL AND (site_changed OR contact_changed) THEN
    NEW.contact_name := NULL;
    NEW.contact_phone := NULL;
    NEW.contact_email := NULL;
  END IF;

  IF NEW.payer_id IS NOT NULL AND payer_changed THEN
    SELECT * INTO selected_payer FROM payers WHERE id = NEW.payer_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Плательщик задачи не найден: %', NEW.payer_id
        USING ERRCODE = '23503';
    END IF;
    NEW.payer_name := selected_payer.name;
  ELSIF NEW.payer_id IS NULL AND payer_changed THEN
    NEW.payer_name := NULL;
  END IF;

  RETURN NEW;
END
$$;

UPDATE tasks task
   SET customer_name = site.name,
       customer_address = site.address,
       payer_name = (SELECT payer.name FROM payers payer WHERE payer.id = task.payer_id)
  FROM sites site
 WHERE task.site_id = site.id
   AND (task.customer_name IS NULL OR task.customer_address IS NULL OR task.payer_name IS NULL);

UPDATE tasks task
   SET payer_name = payer.name
  FROM payers payer
 WHERE task.payer_id = payer.id
   AND task.payer_name IS NULL;

DROP TRIGGER IF EXISTS tasks_customer_snapshot ON tasks;
CREATE TRIGGER tasks_customer_snapshot
  BEFORE INSERT OR UPDATE OF organization_id, site_id, site_contact_id, payer_id
  ON tasks
  FOR EACH ROW EXECUTE FUNCTION fill_task_customer_snapshot();

-- ---------------------------------------------------------------------------
-- 0023_equipment_passports.sql
-- ---------------------------------------------------------------------------

-- TASK3FC9-15: запись паспорта прибора доступна только операционным ролям.
-- Уникальность S/N уже обеспечивается generated key + unique index в 0002;
-- этот инвариант остаётся атомарным и для конкурентных INSERT/UPDATE.

INSERT INTO permissions (code, name, is_sensitive)
VALUES ('equipment.write', 'Создание и изменение паспортов приборов', false)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  is_sensitive = EXCLUDED.is_sensitive;

INSERT INTO role_permissions (role, permission_code)
VALUES
  ('coordinator', 'equipment.write'),
  ('supervisor', 'equipment.write')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 0024_equipment_assignment_changes.sql
-- ---------------------------------------------------------------------------

-- M2: отдельные датированные операции смены места установки и плательщика.
-- Текущее значение и новая строка истории меняются одним SQL-вызовом.

ALTER TABLE equipment_site_history
  ADD COLUMN IF NOT EXISTS changed_by_name text;

ALTER TABLE equipment_payer_history
  ADD COLUMN IF NOT EXISTS changed_by_name text;

UPDATE equipment_site_history history
   SET changed_by_name = actor.full_name
  FROM users actor
 WHERE actor.id = history.changed_by
   AND history.changed_by_name IS NULL;

UPDATE equipment_payer_history history
   SET changed_by_name = actor.full_name
  FROM users actor
 WHERE actor.id = history.changed_by
   AND history.changed_by_name IS NULL;

CREATE OR REPLACE FUNCTION sync_equipment_site_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event_at timestamptz;
  event_comment text;
  event_actor uuid;
  event_actor_name text;
  configured_at text;
  configured_actor text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.current_site_id IS NOT DISTINCT FROM OLD.current_site_id THEN
    RETURN NEW;
  END IF;

  configured_at := nullif(current_setting('app.equipment_change_at', true), '');
  configured_actor := nullif(current_setting('app.equipment_change_by', true), '');
  event_at := coalesce(configured_at::timestamptz, clock_timestamp());
  event_comment := nullif(btrim(current_setting('app.equipment_change_comment', true)), '');
  event_actor := CASE
    WHEN configured_actor ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN configured_actor::uuid
    ELSE current_app_user_id()
  END;
  SELECT full_name INTO event_actor_name FROM users WHERE id = event_actor;

  UPDATE equipment_site_history
     SET valid_to = event_at
   WHERE equipment_id = NEW.id
     AND valid_to IS NULL;

  IF NEW.current_site_id IS NOT NULL THEN
    INSERT INTO equipment_site_history (
      equipment_id, site_id, valid_from, changed_from_site_id,
      changed_by, changed_by_name, comment
    )
    VALUES (
      NEW.id,
      NEW.current_site_id,
      event_at,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.current_site_id ELSE NULL END,
      event_actor,
      event_actor_name,
      coalesce(
        event_comment,
        CASE WHEN TG_OP = 'INSERT'
          THEN 'Начальная запись места установки'
          ELSE 'Автоматическая запись изменения места установки'
        END
      )
    );
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION sync_equipment_payer_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event_at timestamptz;
  event_comment text;
  event_actor uuid;
  event_actor_name text;
  configured_at text;
  configured_actor text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.current_payer_id IS NOT DISTINCT FROM OLD.current_payer_id THEN
    RETURN NEW;
  END IF;

  configured_at := nullif(current_setting('app.equipment_change_at', true), '');
  configured_actor := nullif(current_setting('app.equipment_change_by', true), '');
  event_at := coalesce(configured_at::timestamptz, clock_timestamp());
  event_comment := nullif(btrim(current_setting('app.equipment_change_comment', true)), '');
  event_actor := CASE
    WHEN configured_actor ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN configured_actor::uuid
    ELSE current_app_user_id()
  END;
  SELECT full_name INTO event_actor_name FROM users WHERE id = event_actor;

  UPDATE equipment_payer_history
     SET valid_to = event_at
   WHERE equipment_id = NEW.id
     AND valid_to IS NULL;

  IF NEW.current_payer_id IS NOT NULL THEN
    INSERT INTO equipment_payer_history (
      equipment_id, payer_id, valid_from, changed_from_payer_id,
      changed_by, changed_by_name, comment
    )
    VALUES (
      NEW.id,
      NEW.current_payer_id,
      event_at,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.current_payer_id ELSE NULL END,
      event_actor,
      event_actor_name,
      coalesce(
        event_comment,
        CASE WHEN TG_OP = 'INSERT'
          THEN 'Начальная запись плательщика'
          ELSE 'Автоматическая запись изменения плательщика'
        END
      )
    );
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION change_equipment_site(
  p_equipment_id uuid,
  p_new_site_id uuid,
  p_happened_at timestamptz,
  p_comment text,
  p_changed_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  previous_site_id uuid;
  open_since timestamptz;
  history_id uuid;
BEGIN
  IF p_happened_at IS NULL THEN
    RAISE EXCEPTION 'Дата смены места установки обязательна'
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_site_change_date_required';
  END IF;
  IF nullif(btrim(p_comment), '') IS NULL OR char_length(btrim(p_comment)) > 2000 THEN
    RAISE EXCEPTION 'Комментарий смены места установки обязателен и не должен превышать 2000 символов'
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_site_change_comment_invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_changed_by) THEN
    RAISE EXCEPTION 'Автор смены места установки не найден'
      USING ERRCODE = '23503', CONSTRAINT = 'equipment_site_change_actor_missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sites WHERE id = p_new_site_id) THEN
    RAISE EXCEPTION 'Новое место установки не найдено'
      USING ERRCODE = '23503', CONSTRAINT = 'equipment_site_change_target_missing';
  END IF;

  SELECT current_site_id
    INTO previous_site_id
    FROM equipment
   WHERE id = p_equipment_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Прибор не найден'
      USING ERRCODE = '23503', CONSTRAINT = 'equipment_site_change_equipment_missing';
  END IF;
  IF previous_site_id IS NOT DISTINCT FROM p_new_site_id THEN
    RAISE EXCEPTION 'Новое место установки совпадает с текущим'
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_site_change_same_value';
  END IF;

  SELECT valid_from
    INTO open_since
    FROM equipment_site_history
   WHERE equipment_id = p_equipment_id AND valid_to IS NULL
   FOR UPDATE;
  IF open_since IS NOT NULL AND p_happened_at <= open_since THEN
    RAISE EXCEPTION 'Дата смены места установки должна быть позже текущей записи истории'
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_site_change_chronology';
  END IF;

  PERFORM set_config('app.equipment_change_at', p_happened_at::text, true);
  PERFORM set_config('app.equipment_change_by', p_changed_by::text, true);
  PERFORM set_config('app.equipment_change_comment', btrim(p_comment), true);
  UPDATE equipment SET current_site_id = p_new_site_id WHERE id = p_equipment_id;
  PERFORM set_config('app.equipment_change_at', '', true);
  PERFORM set_config('app.equipment_change_by', '', true);
  PERFORM set_config('app.equipment_change_comment', '', true);

  SELECT id INTO history_id
    FROM equipment_site_history
   WHERE equipment_id = p_equipment_id AND valid_to IS NULL;
  RETURN history_id;
END
$$;

CREATE OR REPLACE FUNCTION change_equipment_payer(
  p_equipment_id uuid,
  p_new_payer_id uuid,
  p_happened_at timestamptz,
  p_comment text,
  p_changed_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  previous_payer_id uuid;
  open_since timestamptz;
  history_id uuid;
BEGIN
  IF p_happened_at IS NULL THEN
    RAISE EXCEPTION 'Дата смены плательщика обязательна'
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_payer_change_date_required';
  END IF;
  IF nullif(btrim(p_comment), '') IS NULL OR char_length(btrim(p_comment)) > 2000 THEN
    RAISE EXCEPTION 'Комментарий смены плательщика обязателен и не должен превышать 2000 символов'
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_payer_change_comment_invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_changed_by) THEN
    RAISE EXCEPTION 'Автор смены плательщика не найден'
      USING ERRCODE = '23503', CONSTRAINT = 'equipment_payer_change_actor_missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM payers WHERE id = p_new_payer_id) THEN
    RAISE EXCEPTION 'Новый плательщик не найден'
      USING ERRCODE = '23503', CONSTRAINT = 'equipment_payer_change_target_missing';
  END IF;

  SELECT current_payer_id
    INTO previous_payer_id
    FROM equipment
   WHERE id = p_equipment_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Прибор не найден'
      USING ERRCODE = '23503', CONSTRAINT = 'equipment_payer_change_equipment_missing';
  END IF;
  IF previous_payer_id IS NOT DISTINCT FROM p_new_payer_id THEN
    RAISE EXCEPTION 'Новый плательщик совпадает с текущим'
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_payer_change_same_value';
  END IF;

  SELECT valid_from
    INTO open_since
    FROM equipment_payer_history
   WHERE equipment_id = p_equipment_id AND valid_to IS NULL
   FOR UPDATE;
  IF open_since IS NOT NULL AND p_happened_at <= open_since THEN
    RAISE EXCEPTION 'Дата смены плательщика должна быть позже текущей записи истории'
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_payer_change_chronology';
  END IF;

  PERFORM set_config('app.equipment_change_at', p_happened_at::text, true);
  PERFORM set_config('app.equipment_change_by', p_changed_by::text, true);
  PERFORM set_config('app.equipment_change_comment', btrim(p_comment), true);
  UPDATE equipment SET current_payer_id = p_new_payer_id WHERE id = p_equipment_id;
  PERFORM set_config('app.equipment_change_at', '', true);
  PERFORM set_config('app.equipment_change_by', '', true);
  PERFORM set_config('app.equipment_change_comment', '', true);

  SELECT id INTO history_id
    FROM equipment_payer_history
   WHERE equipment_id = p_equipment_id AND valid_to IS NULL;
  RETURN history_id;
END
$$;

CREATE OR REPLACE VIEW equipment_history_feed AS
SELECT
  h.equipment_id,
  h.happened_at,
  h.event_type,
  h.summary,
  h.details,
  h.task_id,
  h.stock_movement_id,
  h.file_id,
  h.created_at,
  h.id AS event_id,
  h.created_by,
  actor.full_name AS created_by_name
FROM equipment_history h
LEFT JOIN users actor ON actor.id = h.created_by
UNION ALL
SELECT
  t.equipment_id,
  coalesce(t.completed_at, t.created_at) AS happened_at,
  'task' AS event_type,
  t.number || ' · ' || t.title AS summary,
  jsonb_build_object('status', t.status_code, 'work_type', t.work_type_code) AS details,
  t.id AS task_id,
  NULL::uuid AS stock_movement_id,
  NULL::uuid AS file_id,
  t.created_at,
  t.id AS event_id,
  t.created_by,
  task_actor.full_name AS created_by_name
FROM tasks t
LEFT JOIN users task_actor ON task_actor.id = t.created_by
WHERE t.equipment_id IS NOT NULL
UNION ALL
SELECT
  m.equipment_id,
  m.occurred_at AS happened_at,
  'part_movement' AS event_type,
  p.article_number || ' · ' || m.movement_type::text AS summary,
  jsonb_build_object('quantity', m.quantity, 'condition', m.part_condition::text) AS details,
  m.task_id,
  m.id AS stock_movement_id,
  NULL::uuid AS file_id,
  m.occurred_at AS created_at,
  m.id AS event_id,
  m.performed_by AS created_by,
  movement_actor.full_name AS created_by_name
FROM stock_movements m
JOIN parts p ON p.id = m.part_id
LEFT JOIN users movement_actor ON movement_actor.id = m.performed_by
WHERE m.equipment_id IS NOT NULL
UNION ALL
SELECT
  history.equipment_id,
  history.valid_from AS happened_at,
  'site_change' AS event_type,
  'Место установки: «' || coalesce(previous_site.name, 'Не указано') || '» → «' || new_site.name || '»' AS summary,
  jsonb_strip_nulls(jsonb_build_object(
    'previousValueId', history.changed_from_site_id,
    'previousValue', coalesce(previous_site.name, 'Не указано'),
    'newValueId', history.site_id,
    'newValue', new_site.name,
    'comment', history.comment,
    'authorId', history.changed_by,
    'author', coalesce(history.changed_by_name, site_actor.full_name)
  )) AS details,
  NULL::uuid AS task_id,
  NULL::uuid AS stock_movement_id,
  NULL::uuid AS file_id,
  history.created_at,
  history.id AS event_id,
  history.changed_by AS created_by,
  coalesce(history.changed_by_name, site_actor.full_name) AS created_by_name
FROM equipment_site_history history
JOIN sites new_site ON new_site.id = history.site_id
LEFT JOIN sites previous_site ON previous_site.id = history.changed_from_site_id
LEFT JOIN users site_actor ON site_actor.id = history.changed_by
UNION ALL
SELECT
  history.equipment_id,
  history.valid_from AS happened_at,
  'payer_change' AS event_type,
  'Плательщик: «' || coalesce(previous_payer.name, 'Не указан') || '» → «' || new_payer.name || '»' AS summary,
  jsonb_strip_nulls(jsonb_build_object(
    'previousValueId', history.changed_from_payer_id,
    'previousValue', coalesce(previous_payer.name, 'Не указан'),
    'newValueId', history.payer_id,
    'newValue', new_payer.name,
    'comment', history.comment,
    'authorId', history.changed_by,
    'author', coalesce(history.changed_by_name, payer_actor.full_name)
  )) AS details,
  NULL::uuid AS task_id,
  NULL::uuid AS stock_movement_id,
  NULL::uuid AS file_id,
  history.created_at,
  history.id AS event_id,
  history.changed_by AS created_by,
  coalesce(history.changed_by_name, payer_actor.full_name) AS created_by_name
FROM equipment_payer_history history
JOIN payers new_payer ON new_payer.id = history.payer_id
LEFT JOIN payers previous_payer ON previous_payer.id = history.changed_from_payer_id
LEFT JOIN users payer_actor ON payer_actor.id = history.changed_by;

-- ---------------------------------------------------------------------------
-- 0025_document_payer_snapshots.sql
-- ---------------------------------------------------------------------------

-- TASK3FC9-17: плательщик задачи и счёта является снимком на момент создания.
-- Последующая смена плательщика прибора не переписывает документы.

INSERT INTO permissions (code, name, is_sensitive)
VALUES ('payer.override', 'Переопределение плательщика документа', true)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  is_sensitive = EXCLUDED.is_sensitive;

INSERT INTO role_permissions (role, permission_code)
VALUES
  ('coordinator', 'payer.override'),
  ('supervisor', 'payer.override')
ON CONFLICT DO NOTHING;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS payer_requisites jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS inherited_payer_id uuid REFERENCES payers(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS payer_snapshot_source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS payer_override_reason text,
  ADD COLUMN IF NOT EXISTS payer_overridden_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS payer_overridden_at timestamptz;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS payer_name text,
  ADD COLUMN IF NOT EXISTS payer_requisites jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS source_equipment_id uuid REFERENCES equipment(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS inherited_payer_id uuid REFERENCES payers(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS payer_snapshot_source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS payer_override_reason text,
  ADD COLUMN IF NOT EXISTS payer_overridden_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS payer_overridden_at timestamptz;

UPDATE tasks task
   SET payer_requisites = coalesce(payer.requisites, '{}'::jsonb),
       inherited_payer_id = CASE WHEN task.equipment_id IS NOT NULL THEN task.payer_id ELSE NULL END,
       payer_snapshot_source = CASE WHEN task.equipment_id IS NOT NULL THEN 'equipment' ELSE 'manual' END
  FROM payers payer
 WHERE payer.id = task.payer_id;

UPDATE invoices invoice
   SET payer_name = payer.name,
       payer_requisites = coalesce(payer.requisites, '{}'::jsonb),
       inherited_payer_id = invoice.payer_id
  FROM payers payer
 WHERE payer.id = invoice.payer_id;

UPDATE invoices invoice
   SET source_equipment_id = source.equipment_id,
       payer_snapshot_source = 'equipment'
  FROM (
    SELECT invoice_task.invoice_id, min(task.equipment_id::text)::uuid AS equipment_id
      FROM invoice_tasks invoice_task
      JOIN tasks task ON task.id = invoice_task.task_id
     WHERE task.equipment_id IS NOT NULL
     GROUP BY invoice_task.invoice_id
    HAVING count(DISTINCT task.equipment_id) = 1
  ) source
 WHERE source.invoice_id = invoice.id;

-- Справочник нельзя удалить, если его снимок используется документом: иначе
-- ON DELETE SET NULL запустил бы пересчёт и стёр исторический payerId задачи.
ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_payer_id_fkey,
  ADD CONSTRAINT tasks_payer_id_fkey
    FOREIGN KEY (payer_id) REFERENCES payers(id) ON DELETE RESTRICT;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_payer_snapshot_source_valid,
  DROP CONSTRAINT IF EXISTS tasks_payer_override_complete,
  ADD CONSTRAINT tasks_payer_snapshot_source_valid
    CHECK (payer_snapshot_source IN ('equipment', 'manual', 'override')),
  ADD CONSTRAINT tasks_payer_override_complete CHECK (
    (payer_snapshot_source = 'override'
      AND payer_override_reason IS NOT NULL
      AND payer_overridden_by IS NOT NULL
      AND payer_overridden_at IS NOT NULL)
    OR
    (payer_snapshot_source <> 'override'
      AND payer_override_reason IS NULL
      AND payer_overridden_by IS NULL
      AND payer_overridden_at IS NULL)
  );

ALTER TABLE invoices
  ALTER COLUMN payer_name SET NOT NULL,
  DROP CONSTRAINT IF EXISTS invoices_payer_snapshot_source_valid,
  DROP CONSTRAINT IF EXISTS invoices_payer_override_complete,
  ADD CONSTRAINT invoices_payer_snapshot_source_valid
    CHECK (payer_snapshot_source IN ('equipment', 'manual', 'override')),
  ADD CONSTRAINT invoices_payer_override_complete CHECK (
    (payer_snapshot_source = 'override'
      AND payer_override_reason IS NOT NULL
      AND payer_overridden_by IS NOT NULL
      AND payer_overridden_at IS NOT NULL)
    OR
    (payer_snapshot_source <> 'override'
      AND payer_override_reason IS NULL
      AND payer_overridden_by IS NULL
      AND payer_overridden_at IS NULL)
  );

CREATE INDEX IF NOT EXISTS tasks_inherited_payer_idx
  ON tasks (inherited_payer_id) WHERE inherited_payer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS invoices_source_equipment_idx
  ON invoices (source_equipment_id) WHERE source_equipment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION actor_can_override_payer(p_actor_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM users actor
      JOIN role_permissions permission
        ON permission.role = actor.role
       AND permission.permission_code = 'payer.override'
     WHERE actor.id = p_actor_id
       AND actor.is_active
  )
$$;

CREATE OR REPLACE FUNCTION fill_task_customer_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  selected_site sites%ROWTYPE;
  selected_contact site_contacts%ROWTYPE;
  selected_payer payers%ROWTYPE;
  equipment_payer_id uuid;
  site_changed boolean;
  contact_changed boolean;
  payer_changed boolean;
  equipment_changed boolean;
  snapshot_changed boolean;
BEGIN
  site_changed := TG_OP = 'INSERT'
    OR NEW.site_id IS DISTINCT FROM OLD.site_id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id;
  contact_changed := TG_OP = 'INSERT' OR NEW.site_contact_id IS DISTINCT FROM OLD.site_contact_id;
  payer_changed := TG_OP = 'INSERT' OR NEW.payer_id IS DISTINCT FROM OLD.payer_id;
  equipment_changed := TG_OP = 'INSERT' OR NEW.equipment_id IS DISTINCT FROM OLD.equipment_id;
  snapshot_changed := TG_OP = 'UPDATE' AND (
    NEW.payer_name IS DISTINCT FROM OLD.payer_name
    OR NEW.payer_requisites IS DISTINCT FROM OLD.payer_requisites
    OR NEW.inherited_payer_id IS DISTINCT FROM OLD.inherited_payer_id
    OR NEW.payer_snapshot_source IS DISTINCT FROM OLD.payer_snapshot_source
    OR NEW.payer_override_reason IS DISTINCT FROM OLD.payer_override_reason
    OR NEW.payer_overridden_by IS DISTINCT FROM OLD.payer_overridden_by
    OR NEW.payer_overridden_at IS DISTINCT FROM OLD.payer_overridden_at
  );

  IF NEW.site_id IS NULL AND NEW.site_contact_id IS NOT NULL THEN
    RAISE EXCEPTION 'Контакт задачи нельзя выбрать без площадки'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.site_id IS NOT NULL AND site_changed THEN
    SELECT * INTO selected_site FROM sites WHERE id = NEW.site_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Площадка задачи не найдена: %', NEW.site_id
        USING ERRCODE = '23503';
    END IF;
    IF NEW.organization_id IS NOT NULL AND selected_site.organization_id IS NOT NULL
       AND NEW.organization_id <> selected_site.organization_id THEN
      RAISE EXCEPTION 'Организация задачи не соответствует выбранной площадке'
        USING ERRCODE = '23514';
    END IF;
    NEW.organization_id := coalesce(NEW.organization_id, selected_site.organization_id);
    NEW.customer_name := selected_site.name;
    NEW.customer_address := selected_site.address;
  ELSIF NEW.site_id IS NULL AND site_changed THEN
    NEW.customer_name := NULL;
    NEW.customer_address := NULL;
  END IF;

  IF NEW.site_contact_id IS NOT NULL AND (site_changed OR contact_changed) THEN
    SELECT * INTO selected_contact FROM site_contacts WHERE id = NEW.site_contact_id;
    IF NOT FOUND OR selected_contact.site_id <> NEW.site_id THEN
      RAISE EXCEPTION 'Контакт задачи не относится к выбранной площадке'
        USING ERRCODE = '23514';
    END IF;
    NEW.contact_name := selected_contact.full_name;
    NEW.contact_phone := selected_contact.phone;
    NEW.contact_email := selected_contact.email;
  ELSIF NEW.site_contact_id IS NULL AND (site_changed OR contact_changed) THEN
    NEW.contact_name := NULL;
    NEW.contact_phone := NULL;
    NEW.contact_email := NULL;
  END IF;

  IF TG_OP = 'UPDATE' AND snapshot_changed AND NOT payer_changed AND NOT equipment_changed THEN
    RAISE EXCEPTION 'Снимок плательщика задачи нельзя изменить без выбора нового плательщика'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_payer_snapshot_immutable';
  END IF;

  IF payer_changed OR equipment_changed THEN
    equipment_payer_id := NULL;
    IF NEW.equipment_id IS NOT NULL THEN
      SELECT equipment.current_payer_id INTO equipment_payer_id
        FROM equipment
       WHERE equipment.id = NEW.equipment_id
       FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Прибор задачи не найден: %', NEW.equipment_id
          USING ERRCODE = '23503';
      END IF;
    END IF;

    IF NEW.equipment_id IS NOT NULL AND NEW.payer_id IS NULL THEN
      NEW.payer_id := equipment_payer_id;
    END IF;
    NEW.inherited_payer_id := equipment_payer_id;

    IF NEW.equipment_id IS NOT NULL
       AND equipment_payer_id IS NOT NULL
       AND NEW.payer_id IS DISTINCT FROM equipment_payer_id THEN
      IF nullif(btrim(coalesce(NEW.payer_override_reason, '')), '') IS NULL
        OR NEW.payer_overridden_by IS NULL THEN
        RAISE EXCEPTION 'Для замены плательщика задачи обязательны автор и причина'
          USING ERRCODE = '23514', CONSTRAINT = 'tasks_payer_override_audit_required';
      END IF;
      IF NOT actor_can_override_payer(NEW.payer_overridden_by) THEN
        RAISE EXCEPTION 'Недостаточно прав для замены плательщика задачи'
          USING ERRCODE = '42501', CONSTRAINT = 'tasks_payer_override_forbidden';
      END IF;
      NEW.payer_snapshot_source := 'override';
      NEW.payer_override_reason := btrim(NEW.payer_override_reason);
      NEW.payer_overridden_at := coalesce(NEW.payer_overridden_at, clock_timestamp());
    ELSIF NEW.equipment_id IS NOT NULL AND NEW.payer_id IS NOT DISTINCT FROM equipment_payer_id THEN
      NEW.payer_snapshot_source := 'equipment';
      NEW.payer_override_reason := NULL;
      NEW.payer_overridden_by := NULL;
      NEW.payer_overridden_at := NULL;
    ELSE
      -- Нет прибора, либо у прибора плательщик не задан — выбранный плательщик это ручной выбор, не замена.
      NEW.payer_snapshot_source := 'manual';
      NEW.payer_override_reason := NULL;
      NEW.payer_overridden_by := NULL;
      NEW.payer_overridden_at := NULL;
    END IF;

    IF NEW.payer_id IS NOT NULL THEN
      SELECT * INTO selected_payer FROM payers WHERE id = NEW.payer_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Плательщик задачи не найден: %', NEW.payer_id
          USING ERRCODE = '23503';
      END IF;
      NEW.payer_name := selected_payer.name;
      NEW.payer_requisites := coalesce(selected_payer.requisites, '{}'::jsonb);
    ELSE
      NEW.payer_name := NULL;
      NEW.payer_requisites := '{}'::jsonb;
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS tasks_customer_snapshot ON tasks;
CREATE TRIGGER tasks_customer_snapshot
  BEFORE INSERT OR UPDATE OF organization_id, site_id, site_contact_id, equipment_id, payer_id,
    payer_name, payer_requisites, inherited_payer_id, payer_snapshot_source,
    payer_override_reason, payer_overridden_by, payer_overridden_at
  ON tasks
  FOR EACH ROW EXECUTE FUNCTION fill_task_customer_snapshot();

CREATE OR REPLACE FUNCTION fill_invoice_payer_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  selected_payer payers%ROWTYPE;
  equipment_payer_id uuid;
  selection_changed boolean;
  snapshot_changed boolean;
BEGIN
  selection_changed := TG_OP = 'INSERT'
    OR NEW.payer_id IS DISTINCT FROM OLD.payer_id
    OR NEW.source_equipment_id IS DISTINCT FROM OLD.source_equipment_id;
  snapshot_changed := TG_OP = 'UPDATE' AND (
    NEW.payer_name IS DISTINCT FROM OLD.payer_name
    OR NEW.payer_requisites IS DISTINCT FROM OLD.payer_requisites
    OR NEW.inherited_payer_id IS DISTINCT FROM OLD.inherited_payer_id
    OR NEW.payer_snapshot_source IS DISTINCT FROM OLD.payer_snapshot_source
    OR NEW.payer_override_reason IS DISTINCT FROM OLD.payer_override_reason
    OR NEW.payer_overridden_by IS DISTINCT FROM OLD.payer_overridden_by
    OR NEW.payer_overridden_at IS DISTINCT FROM OLD.payer_overridden_at
  );

  IF snapshot_changed AND NOT selection_changed THEN
    RAISE EXCEPTION 'Снимок плательщика счёта нельзя изменить без выбора нового плательщика'
      USING ERRCODE = '23514', CONSTRAINT = 'invoices_payer_snapshot_immutable';
  END IF;

  IF selection_changed THEN
    equipment_payer_id := NULL;
    IF NEW.source_equipment_id IS NOT NULL THEN
      SELECT equipment.current_payer_id INTO equipment_payer_id
        FROM equipment
       WHERE equipment.id = NEW.source_equipment_id
       FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Прибор счёта не найден: %', NEW.source_equipment_id
          USING ERRCODE = '23503';
      END IF;
    END IF;

    IF NEW.source_equipment_id IS NOT NULL AND NEW.payer_id IS NULL THEN
      NEW.payer_id := equipment_payer_id;
    END IF;
    NEW.inherited_payer_id := equipment_payer_id;

    IF NEW.source_equipment_id IS NOT NULL AND NEW.payer_id IS DISTINCT FROM equipment_payer_id THEN
      IF nullif(btrim(coalesce(NEW.payer_override_reason, '')), '') IS NULL
        OR NEW.payer_overridden_by IS NULL THEN
        RAISE EXCEPTION 'Для замены плательщика счёта обязательны автор и причина'
          USING ERRCODE = '23514', CONSTRAINT = 'invoices_payer_override_audit_required';
      END IF;
      IF NOT actor_can_override_payer(NEW.payer_overridden_by) THEN
        RAISE EXCEPTION 'Недостаточно прав для замены плательщика счёта'
          USING ERRCODE = '42501', CONSTRAINT = 'invoices_payer_override_forbidden';
      END IF;
      NEW.payer_snapshot_source := 'override';
      NEW.payer_override_reason := btrim(NEW.payer_override_reason);
      NEW.payer_overridden_at := coalesce(NEW.payer_overridden_at, clock_timestamp());
    ELSE
      NEW.payer_snapshot_source := CASE WHEN NEW.source_equipment_id IS NULL THEN 'manual' ELSE 'equipment' END;
      NEW.payer_override_reason := NULL;
      NEW.payer_overridden_by := NULL;
      NEW.payer_overridden_at := NULL;
    END IF;

    SELECT * INTO selected_payer FROM payers WHERE id = NEW.payer_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Плательщик счёта не найден: %', NEW.payer_id
        USING ERRCODE = '23503';
    END IF;
    NEW.payer_name := selected_payer.name;
    NEW.payer_requisites := coalesce(selected_payer.requisites, '{}'::jsonb);
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS invoices_payer_snapshot ON invoices;
CREATE TRIGGER invoices_payer_snapshot
  BEFORE INSERT OR UPDATE OF payer_id, source_equipment_id, payer_name, payer_requisites,
    inherited_payer_id, payer_snapshot_source, payer_override_reason,
    payer_overridden_by, payer_overridden_at
  ON invoices
  FOR EACH ROW EXECUTE FUNCTION fill_invoice_payer_snapshot();

CREATE OR REPLACE FUNCTION validate_invoice_task_payer_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  invoice_row invoices%ROWTYPE;
  task_status text;
  task_equipment_id uuid;
  equipment_payer_id uuid;
BEGIN
  SELECT * INTO invoice_row FROM invoices WHERE id = NEW.invoice_id;
  SELECT task.status_code, task.equipment_id, equipment.current_payer_id
    INTO task_status, task_equipment_id, equipment_payer_id
    FROM tasks task
    JOIN equipment ON equipment.id = task.equipment_id
   WHERE task.id = NEW.task_id
   FOR SHARE OF task, equipment;

  IF invoice_row.id IS NULL OR task_status IS NULL THEN
    RAISE EXCEPTION 'Счёт или задача связи не найдены'
      USING ERRCODE = '23503', CONSTRAINT = 'invoice_tasks_payer_snapshot_reference';
  END IF;
  IF task_status <> 'closed' THEN
    RAISE EXCEPTION 'Счёт можно связать только с закрытой задачей'
      USING ERRCODE = '23514', CONSTRAINT = 'invoice_tasks_closed_task_required';
  END IF;
  IF task_equipment_id IS NULL OR equipment_payer_id IS NULL THEN
    RAISE EXCEPTION 'Для счёта у прибора задачи должен быть текущий плательщик'
      USING ERRCODE = '23514', CONSTRAINT = 'invoice_tasks_equipment_payer_required';
  END IF;
  IF invoice_row.source_equipment_id IS NULL
    OR invoice_row.inherited_payer_id IS DISTINCT FROM equipment_payer_id THEN
    RAISE EXCEPTION 'Снимок счёта не соответствует текущему плательщику прибора задачи'
      USING ERRCODE = '23514', CONSTRAINT = 'invoice_tasks_payer_snapshot_mismatch';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS invoice_tasks_payer_snapshot_valid ON invoice_tasks;
CREATE CONSTRAINT TRIGGER invoice_tasks_payer_snapshot_valid
  AFTER INSERT OR UPDATE ON invoice_tasks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_invoice_task_payer_snapshot();

-- ---------------------------------------------------------------------------
-- 0026_equipment_history_feed.sql
-- ---------------------------------------------------------------------------

-- TASK3FC9-18: единый формат хронологической истории прибора.
-- Исходное описание и клиент передаются в details снимком, включая пустую
-- строку описания. Вложения задачи и прибора также входят в общую ленту.

ALTER TABLE equipment_history
  DROP CONSTRAINT IF EXISTS equipment_history_event_type_check,
  ADD CONSTRAINT equipment_history_event_type_check CHECK (
    event_type IN (
      'task', 'part_movement', 'site_change', 'payer_change', 'meter',
      'attachment', 'imported', 'manual'
    )
  );

CREATE OR REPLACE VIEW equipment_history_feed AS
SELECT
  h.equipment_id,
  h.happened_at,
  CASE
    WHEN h.event_type = 'manual' AND h.details ->> 'import_source' IS NOT NULL THEN 'imported'
    ELSE h.event_type
  END AS event_type,
  h.summary,
  jsonb_strip_nulls(
    h.details
    || jsonb_build_object(
      'sourceKind', CASE
        WHEN h.event_type = 'manual' AND h.details ->> 'import_source' IS NOT NULL THEN 'imported'
        ELSE h.event_type
      END,
      'sourceId', coalesce(h.source_key, h.id::text),
      'client', coalesce(h.details ->> 'client', ''),
      'description', coalesce(h.details ->> 'description', '')
    )
  ) AS details,
  h.task_id,
  h.stock_movement_id,
  h.file_id,
  h.created_at,
  h.id AS event_id,
  h.created_by,
  actor.full_name AS created_by_name,
  h.source_key
FROM equipment_history h
LEFT JOIN users actor ON actor.id = h.created_by

UNION ALL

SELECT
  task.equipment_id,
  coalesce(task.completed_at, task.created_at) AS happened_at,
  'task' AS event_type,
  task.number || ' · ' || task.title AS summary,
  jsonb_build_object(
    'sourceKind', 'task',
    'sourceId', task.id,
    'client', coalesce(task.customer_name, task_site.name, ''),
    'description', coalesce(task.work_description, ''),
    'callReason', coalesce(task.call_reason, ''),
    'status', task.status_code,
    'workType', task.work_type_code
  ) AS details,
  task.id AS task_id,
  NULL::uuid AS stock_movement_id,
  NULL::uuid AS file_id,
  task.created_at,
  task.id AS event_id,
  task.created_by,
  task_actor.full_name AS created_by_name,
  NULL::text AS source_key
FROM tasks task
LEFT JOIN sites task_site ON task_site.id = task.site_id
LEFT JOIN users task_actor ON task_actor.id = task.created_by
WHERE task.equipment_id IS NOT NULL

UNION ALL

SELECT
  movement.equipment_id,
  movement.occurred_at AS happened_at,
  'part_replacement' AS event_type,
  part.article_number || ' · ' || part.name AS summary,
  jsonb_build_object(
    'sourceKind', 'part_replacement',
    'sourceId', movement.id,
    'client', coalesce(task.customer_name, task_site.name, client_at_movement.name, ''),
    'description', coalesce(movement.comment, ''),
    'quantity', movement.quantity,
    'condition', movement.part_condition::text,
    'articleNumber', part.article_number,
    'partName', part.name
  ) AS details,
  movement.task_id,
  movement.id AS stock_movement_id,
  NULL::uuid AS file_id,
  movement.occurred_at AS created_at,
  movement.id AS event_id,
  movement.performed_by AS created_by,
  movement_actor.full_name AS created_by_name,
  NULL::text AS source_key
FROM stock_movements movement
JOIN parts part ON part.id = movement.part_id
LEFT JOIN tasks task ON task.id = movement.task_id
LEFT JOIN sites task_site ON task_site.id = task.site_id
LEFT JOIN users movement_actor ON movement_actor.id = movement.performed_by
LEFT JOIN LATERAL (
  SELECT site.name
    FROM equipment_site_history site_history
    JOIN sites site ON site.id = site_history.site_id
   WHERE site_history.equipment_id = movement.equipment_id
     AND site_history.valid_from <= movement.occurred_at
     AND (site_history.valid_to IS NULL OR site_history.valid_to > movement.occurred_at)
   ORDER BY site_history.valid_from DESC
   LIMIT 1
) client_at_movement ON true
WHERE movement.equipment_id IS NOT NULL
  AND movement.movement_type = 'install'

UNION ALL

SELECT
  history.equipment_id,
  history.valid_from AS happened_at,
  'site_change' AS event_type,
  'Место установки: «' || coalesce(previous_site.name, 'Не указано') || '» → «' || new_site.name || '»' AS summary,
  jsonb_strip_nulls(jsonb_build_object(
    'sourceKind', 'site_change',
    'sourceId', history.id,
    'client', new_site.name,
    'description', coalesce(history.comment, ''),
    'previousValueId', history.changed_from_site_id,
    'previousValue', coalesce(previous_site.name, 'Не указано'),
    'newValueId', history.site_id,
    'newValue', new_site.name,
    'comment', history.comment,
    'authorId', history.changed_by,
    'author', coalesce(history.changed_by_name, site_actor.full_name)
  )) AS details,
  NULL::uuid AS task_id,
  NULL::uuid AS stock_movement_id,
  NULL::uuid AS file_id,
  history.created_at,
  history.id AS event_id,
  history.changed_by AS created_by,
  coalesce(history.changed_by_name, site_actor.full_name) AS created_by_name,
  NULL::text AS source_key
FROM equipment_site_history history
JOIN sites new_site ON new_site.id = history.site_id
LEFT JOIN sites previous_site ON previous_site.id = history.changed_from_site_id
LEFT JOIN users site_actor ON site_actor.id = history.changed_by

UNION ALL

SELECT
  history.equipment_id,
  history.valid_from AS happened_at,
  'payer_change' AS event_type,
  'Плательщик: «' || coalesce(previous_payer.name, 'Не указан') || '» → «' || new_payer.name || '»' AS summary,
  jsonb_strip_nulls(jsonb_build_object(
    'sourceKind', 'payer_change',
    'sourceId', history.id,
    'client', coalesce(client_at_event.name, ''),
    'description', coalesce(history.comment, ''),
    'previousValueId', history.changed_from_payer_id,
    'previousValue', coalesce(previous_payer.name, 'Не указан'),
    'newValueId', history.payer_id,
    'newValue', new_payer.name,
    'comment', history.comment,
    'authorId', history.changed_by,
    'author', coalesce(history.changed_by_name, payer_actor.full_name)
  )) AS details,
  NULL::uuid AS task_id,
  NULL::uuid AS stock_movement_id,
  NULL::uuid AS file_id,
  history.created_at,
  history.id AS event_id,
  history.changed_by AS created_by,
  coalesce(history.changed_by_name, payer_actor.full_name) AS created_by_name,
  NULL::text AS source_key
FROM equipment_payer_history history
JOIN payers new_payer ON new_payer.id = history.payer_id
LEFT JOIN payers previous_payer ON previous_payer.id = history.changed_from_payer_id
LEFT JOIN users payer_actor ON payer_actor.id = history.changed_by
LEFT JOIN LATERAL (
  SELECT site.name
    FROM equipment_site_history site_history
    JOIN sites site ON site.id = site_history.site_id
   WHERE site_history.equipment_id = history.equipment_id
     AND site_history.valid_from <= history.valid_from
     AND (site_history.valid_to IS NULL OR site_history.valid_to > history.valid_from)
   ORDER BY site_history.valid_from DESC
   LIMIT 1
) client_at_event ON true

UNION ALL

SELECT
  coalesce(file.equipment_id, task.equipment_id) AS equipment_id,
  file.created_at AS happened_at,
  'attachment' AS event_type,
  'Вложение · ' || file.original_name AS summary,
  jsonb_build_object(
    'sourceKind', 'attachment',
    'sourceId', file.id,
    'client', coalesce(task.customer_name, task_site.name, client_at_upload.name, ''),
    'description', file.original_name,
    'fileName', file.original_name,
    'fileKind', file.kind::text,
    'contentType', file.content_type
  ) AS details,
  file.task_id,
  NULL::uuid AS stock_movement_id,
  file.id AS file_id,
  file.created_at,
  file.id AS event_id,
  file.uploaded_by AS created_by,
  file_actor.full_name AS created_by_name,
  NULL::text AS source_key
FROM files file
LEFT JOIN tasks task ON task.id = file.task_id
LEFT JOIN sites task_site ON task_site.id = task.site_id
LEFT JOIN users file_actor ON file_actor.id = file.uploaded_by
LEFT JOIN LATERAL (
  SELECT site.name
    FROM equipment_site_history site_history
    JOIN sites site ON site.id = site_history.site_id
   WHERE site_history.equipment_id = file.equipment_id
     AND site_history.valid_from <= file.created_at
     AND (site_history.valid_to IS NULL OR site_history.valid_to > file.created_at)
   ORDER BY site_history.valid_from DESC
   LIMIT 1
) client_at_upload ON true
WHERE coalesce(file.equipment_id, task.equipment_id) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM equipment_history history WHERE history.file_id = file.id
  );

-- ---------------------------------------------------------------------------
-- 0027_equipment_meter_readings.sql
-- ---------------------------------------------------------------------------

-- TASK3FC9-19: показания счётчика становятся неизменяемыми записями принятого
-- закрытия. Одна задача создаёт не более одного показания; паспорт хранит
-- производное последнее значение, а полная хронология остаётся в журнале.

ALTER TABLE equipment_meter_readings
  ADD COLUMN IF NOT EXISTS created_by_name text;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_meter_requires_equipment,
  ADD CONSTRAINT tasks_meter_requires_equipment
    CHECK (meter_reading IS NULL OR equipment_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS equipment_meter_readings_task_closure_uq
  ON equipment_meter_readings (task_id)
  WHERE task_id IS NOT NULL AND source = 'task_closure';

CREATE OR REPLACE FUNCTION record_accepted_task_meter_reading(
  p_equipment_id uuid,
  p_task_id uuid,
  p_reading numeric,
  p_measured_at timestamptz,
  p_created_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  stored equipment_meter_readings%ROWTYPE;
  task_row tasks%ROWTYPE;
  author_name text;
  client_name text;
BEGIN
  IF p_reading IS NULL OR p_reading < 0 OR p_measured_at IS NULL OR p_created_by IS NULL THEN
    RAISE EXCEPTION 'Для показания нужны числовое значение, дата и автор'
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_meter_reading_required';
  END IF;

  SELECT * INTO task_row FROM tasks WHERE id = p_task_id FOR KEY SHARE;
  IF task_row.id IS NULL OR task_row.status_code <> 'closed' THEN
    RAISE EXCEPTION 'Показание счётчика можно записать только из принятого закрытия'
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_meter_reading_task_not_closed';
  END IF;
  IF task_row.equipment_id IS DISTINCT FROM p_equipment_id
    OR task_row.meter_reading IS DISTINCT FROM p_reading THEN
    RAISE EXCEPTION 'Прибор или значение показания не совпадает с задачей'
      USING ERRCODE = '23514', CONSTRAINT = 'equipment_meter_reading_task_mismatch';
  END IF;

  PERFORM 1 FROM equipment WHERE id = p_equipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Прибор для показания не найден'
      USING ERRCODE = '23503', CONSTRAINT = 'equipment_meter_readings_equipment_id_fkey';
  END IF;

  SELECT * INTO stored
    FROM equipment_meter_readings
   WHERE task_id = p_task_id AND source = 'task_closure';
  IF stored.id IS NOT NULL THEN
    IF stored.equipment_id IS DISTINCT FROM p_equipment_id
      OR stored.reading IS DISTINCT FROM p_reading
      OR stored.created_by IS DISTINCT FROM p_created_by THEN
      RAISE EXCEPTION 'Для задачи уже сохранено другое показание счётчика'
        USING ERRCODE = '23505', CONSTRAINT = 'equipment_meter_readings_task_closure_uq';
    END IF;
    RETURN stored.id;
  END IF;

  SELECT full_name INTO author_name FROM users WHERE id = p_created_by;
  IF author_name IS NULL THEN
    RAISE EXCEPTION 'Автор показания не найден'
      USING ERRCODE = '23503', CONSTRAINT = 'equipment_meter_readings_created_by_fkey';
  END IF;

  INSERT INTO equipment_meter_readings (
    equipment_id, reading, measured_at, source, task_id,
    created_by, created_by_name
  ) VALUES (
    p_equipment_id, p_reading, p_measured_at, 'task_closure', p_task_id,
    p_created_by, author_name
  )
  ON CONFLICT (task_id) WHERE task_id IS NOT NULL AND source = 'task_closure'
  DO NOTHING
  RETURNING * INTO stored;

  IF stored.id IS NULL THEN
    SELECT * INTO stored
      FROM equipment_meter_readings
     WHERE task_id = p_task_id AND source = 'task_closure';
    IF stored.equipment_id IS DISTINCT FROM p_equipment_id
      OR stored.reading IS DISTINCT FROM p_reading
      OR stored.created_by IS DISTINCT FROM p_created_by THEN
      RAISE EXCEPTION 'Для задачи уже сохранено другое показание счётчика'
        USING ERRCODE = '23505', CONSTRAINT = 'equipment_meter_readings_task_closure_uq';
    END IF;
    RETURN stored.id;
  END IF;

  SELECT coalesce(
    task_row.customer_name,
    (SELECT site.name FROM sites site WHERE site.id = task_row.site_id),
    ''
  ) INTO client_name;

  INSERT INTO equipment_history (
    equipment_id, event_type, task_id, happened_at, summary, details, created_by
  ) VALUES (
    p_equipment_id,
    'meter',
    p_task_id,
    p_measured_at,
    'Показание счётчика · ' || p_reading::text,
    jsonb_build_object(
      'sourceKind', 'meter',
      'sourceId', stored.id,
      'client', coalesce(client_name, ''),
      'description', 'Принято при закрытии задачи ' || task_row.number,
      'reading', p_reading,
      'authorId', p_created_by,
      'author', author_name
    ),
    p_created_by
  );

  UPDATE equipment
     SET last_meter_reading = latest.reading
    FROM (
      SELECT reading
        FROM equipment_meter_readings
       WHERE equipment_id = p_equipment_id
       ORDER BY measured_at DESC, created_at DESC, id DESC
       LIMIT 1
    ) latest
   WHERE equipment.id = p_equipment_id;

  RETURN stored.id;
END
$$;

CREATE OR REPLACE FUNCTION record_task_meter_reading_after_acceptance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  closure task_closures%ROWTYPE;
BEGIN
  IF OLD.status_code IS DISTINCT FROM 'closed'
    AND NEW.status_code = 'closed'
    AND NEW.meter_reading IS NOT NULL THEN
    SELECT * INTO closure FROM task_closures WHERE task_id = NEW.id;
    IF closure.task_id IS NULL OR closure.submitted_by IS NULL THEN
      RAISE EXCEPTION 'У принятого закрытия отсутствует автор показания счётчика'
        USING ERRCODE = '23514', CONSTRAINT = 'equipment_meter_reading_closure_author';
    END IF;
    PERFORM record_accepted_task_meter_reading(
      NEW.equipment_id,
      NEW.id,
      NEW.meter_reading,
      closure.submitted_at,
      closure.submitted_by
    );
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS tasks_record_meter_reading ON tasks;
CREATE TRIGGER tasks_record_meter_reading
  AFTER UPDATE OF status_code ON tasks
  FOR EACH ROW EXECUTE FUNCTION record_task_meter_reading_after_acceptance();

DO $$
DECLARE
  accepted record;
BEGIN
  FOR accepted IN
    SELECT task.id AS task_id, task.equipment_id, task.meter_reading,
           closure.submitted_at, closure.submitted_by
      FROM tasks task
      JOIN task_closures closure ON closure.task_id = task.id
     WHERE task.status_code = 'closed'
       AND task.equipment_id IS NOT NULL
       AND task.meter_reading IS NOT NULL
       AND closure.submitted_by IS NOT NULL
  LOOP
    PERFORM record_accepted_task_meter_reading(
      accepted.equipment_id,
      accepted.task_id,
      accepted.meter_reading,
      accepted.submitted_at,
      accepted.submitted_by
    );
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION reject_task_meter_reading_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'История показаний счётчика неизменяема'
    USING ERRCODE = '42501';
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS equipment_meter_readings_append_only ON equipment_meter_readings;
CREATE TRIGGER equipment_meter_readings_append_only
  BEFORE UPDATE OR DELETE ON equipment_meter_readings
  FOR EACH ROW EXECUTE FUNCTION reject_task_meter_reading_mutation();

-- ---------------------------------------------------------------------------
-- 0028_isolated_test_import.sql
-- ---------------------------------------------------------------------------

-- TASK3FC9-23: постоянный изолированный контур тестового импорта.
-- Таблицы не имеют внешних ключей к боевым сущностям: повторная сверка файла
-- изменяет только набор с тем же dataset_key.

CREATE TABLE IF NOT EXISTS import_test_datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_key text NOT NULL UNIQUE
    CHECK (dataset_key ~ '^[[:alnum:]][[:alnum:]._:-]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS import_test_equipment (
  dataset_id uuid NOT NULL REFERENCES import_test_datasets(id) ON DELETE CASCADE,
  serial_number text NOT NULL CHECK (btrim(serial_number) <> ''),
  serial_number_normalized text GENERATED ALWAYS AS (
    upper(regexp_replace(btrim(serial_number), E'\\s+', '', 'g'))
  ) STORED,
  manufacturer text NOT NULL CHECK (btrim(manufacturer) <> ''),
  model text NOT NULL CHECK (btrim(model) <> ''),
  site text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_id, serial_number_normalized)
);

CREATE TABLE IF NOT EXISTS import_test_equipment_history (
  dataset_id uuid NOT NULL,
  source_key text NOT NULL CHECK (source_key ~ '^[0-9a-f]{64}$'),
  serial_number_normalized text NOT NULL,
  happened_at timestamptz NOT NULL,
  client text NOT NULL DEFAULT '',
  work_type text NOT NULL CHECK (btrim(work_type) <> ''),
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_id, source_key),
  CONSTRAINT import_test_history_equipment_fk
    FOREIGN KEY (dataset_id, serial_number_normalized)
    REFERENCES import_test_equipment(dataset_id, serial_number_normalized)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS import_test_equipment_history_timeline_idx
  ON import_test_equipment_history (dataset_id, happened_at DESC, source_key);

COMMENT ON TABLE import_test_datasets IS
  'Изолированные наборы тестового импорта; не являются боевым реестром';
COMMENT ON TABLE import_test_equipment IS
  'Приборы тестового импорта с идемпотентным S/N внутри dataset_key';
COMMENT ON TABLE import_test_equipment_history IS
  'События тестового импорта с идемпотентным source_key внутри dataset_key';

-- ---------------------------------------------------------------------------
-- 0029_configured_import_test_records.sql
-- ---------------------------------------------------------------------------

-- TASK3FC9-22: изолированный контур сверки для всех настраиваемых схем.
-- JSON хранит только в тестовом dataset и не имеет связей с боевыми таблицами.

CREATE TABLE IF NOT EXISTS import_test_records (
  dataset_id uuid NOT NULL REFERENCES import_test_datasets(id) ON DELETE CASCADE,
  schema_id text NOT NULL CHECK (schema_id IN (
    'equipment', 'sites', 'payers', 'nomenclature', 'stock', 'history'
  )),
  source_key text NOT NULL CHECK (source_key ~ '^[0-9a-f]{64}$'),
  normalized_data jsonb NOT NULL,
  source_sheet text NOT NULL CHECK (btrim(source_sheet) <> ''),
  source_row integer NOT NULL CHECK (source_row > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_id, schema_id, source_key)
);

CREATE INDEX IF NOT EXISTS import_test_records_schema_idx
  ON import_test_records (dataset_id, schema_id, source_row);

COMMENT ON TABLE import_test_records IS
  'Изолированный предпросмотр и тестовый импорт всех схем M2; не является боевыми данными';

-- ---------------------------------------------------------------------------
-- 0030_customer_directory_lifecycle.sql
-- ---------------------------------------------------------------------------

-- M2 review: редактирование и безопасная деактивация справочников заказчиков.
-- Исторические внешние ключи сохраняются; неактивные значения исключаются из
-- новых выборов, но остаются доступны администратору и аудиту.

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

ALTER TABLE site_contacts
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

ALTER TABLE payers
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

UPDATE site_contacts
   SET is_primary = false
 WHERE NOT is_active AND is_primary;

ALTER TABLE site_contacts
  DROP CONSTRAINT IF EXISTS site_contacts_inactive_not_primary,
  ADD CONSTRAINT site_contacts_inactive_not_primary
    CHECK (is_active OR NOT is_primary);

DROP INDEX IF EXISTS site_contacts_primary_uq;
CREATE UNIQUE INDEX site_contacts_primary_uq
  ON site_contacts (site_id) WHERE is_active AND is_primary;

CREATE INDEX IF NOT EXISTS sites_active_name_idx
  ON sites (name, id) WHERE is_active;

CREATE INDEX IF NOT EXISTS site_contacts_active_site_idx
  ON site_contacts (site_id, is_primary DESC, full_name) WHERE is_active;

CREATE INDEX IF NOT EXISTS payers_active_name_idx
  ON payers (name, id) WHERE is_active;

-- ---------------------------------------------------------------------------
-- 0031_service_task_aggregate.sql
-- ---------------------------------------------------------------------------

-- TASK3FC9-26: целостный агрегат сервисной задачи, атомарный номер и просрочка.

ALTER TABLE tasks
  ALTER COLUMN number SET DEFAULT ('З-' || lpad(nextval('task_number_seq')::text, 6, '0'));

-- Ранее API мог записывать собственные номера, не двигая sequence. Перед
-- включением единственного генератора поднимаем sequence до старшего номера.
DO $$
DECLARE
  current_sequence bigint;
  current_is_called boolean;
  greatest_stored_number bigint;
BEGIN
  SELECT last_value, is_called
    INTO current_sequence, current_is_called
    FROM task_number_seq;

  SELECT coalesce(max((regexp_match(number, '^З-([0-9]+)$'))[1]::bigint), 0)
    INTO greatest_stored_number
    FROM tasks;

  IF greatest_stored_number > current_sequence
     OR (greatest_stored_number = current_sequence AND greatest_stored_number > 0 AND NOT current_is_called) THEN
    PERFORM setval('task_number_seq', greatest_stored_number, true);
  END IF;
END
$$;

-- NOT VALID сохраняет upgrade исторических неполных строк, но PostgreSQL
-- немедленно проверяет ограничения для каждой новой или изменяемой задачи.
ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_core_relations_required,
  DROP CONSTRAINT IF EXISTS tasks_execution_period_required,
  DROP CONSTRAINT IF EXISTS tasks_engineer_required_after_assignment,
  ADD CONSTRAINT tasks_core_relations_required CHECK (
    equipment_id IS NOT NULL AND site_id IS NOT NULL AND payer_id IS NOT NULL
  ) NOT VALID,
  ADD CONSTRAINT tasks_execution_period_required CHECK (
    deadline_from IS NOT NULL AND deadline_to IS NOT NULL
  ) NOT VALID,
  ADD CONSTRAINT tasks_engineer_required_after_assignment CHECK (
    status_code NOT IN ('assigned', 'in_progress', 'under_review', 'closed')
    OR engineer_id IS NOT NULL
  ) NOT VALID;

CREATE OR REPLACE FUNCTION service_task_is_overdue(
  p_deadline_to date,
  p_status_code text,
  p_as_of date
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT p_deadline_to IS NOT NULL
     AND p_deadline_to < p_as_of
     AND p_status_code NOT IN ('closed', 'cancelled')
$$;

CREATE OR REPLACE VIEW task_registry AS
SELECT
  t.id,
  t.number,
  t.title,
  t.work_type_code,
  work_type.name AS work_type_name,
  t.status_code,
  task_status.name AS status_name,
  t.priority,
  t.is_maintenance_plan,
  t.equipment_id,
  equipment.serial_number,
  model.name AS model_name,
  t.site_id,
  site.name AS site_name,
  t.payer_id,
  payer.name AS payer_name,
  t.engineer_id,
  engineer.full_name AS engineer_name,
  t.deadline_from,
  t.deadline_to,
  service_task_is_overdue(t.deadline_to, t.status_code, CURRENT_DATE) AS is_overdue,
  t.call_date,
  t.visit_date,
  t.completed_at,
  t.created_at,
  t.updated_at,
  t.maintenance_plan_id,
  t.contract_id,
  contract.number AS contract_number,
  t.primary_task_id,
  t.work_started_at,
  t.work_finished_at
FROM tasks t
JOIN work_types work_type ON work_type.code = t.work_type_code
JOIN task_statuses task_status ON task_status.code = t.status_code
LEFT JOIN equipment ON equipment.id = t.equipment_id
LEFT JOIN equipment_models model ON model.id = equipment.model_id
LEFT JOIN sites site ON site.id = t.site_id
LEFT JOIN payers payer ON payer.id = t.payer_id
LEFT JOIN users engineer ON engineer.id = t.engineer_id
LEFT JOIN contracts contract ON contract.id = t.contract_id;

-- ---------------------------------------------------------------------------
-- 0032_work_types_modifiers_and_hours.sql
-- ---------------------------------------------------------------------------

-- TASK3FC9-27: 13 видов работ из бланка акта, модификаторы Г/Н и условные часы.

-- Upgrade заполненной базы только дополняет отсутствующие стартовые значения:
-- изменения администратора не перезаписываются повторной миграцией.
INSERT INTO work_types (code, name, requires_hours, sort_order)
VALUES
  ('diagnostics', 'Диагностика', false, 10),
  ('installation', 'Инсталляция (в т. ч. повторная)', false, 20),
  ('repair', 'Ремонт', false, 30),
  ('deinstallation', 'Деинсталляция', false, 40),
  ('application_methods', 'Аппликация: постановка методик исследований', false, 50),
  ('application_training', 'Аппликация: инструктаж персонала', false, 60),
  ('conservation', 'Консервация', false, 70),
  ('packaging', 'Упаковка', false, 80),
  ('pre_sale_preparation', 'Предпродажная подготовка', false, 90),
  ('relocation', 'Перемещение прибора', false, 100),
  ('modernization', 'Модификация (модернизация)', false, 110),
  ('other', 'Прочие работы', true, 120),
  ('maintenance', 'ТО по сервисной документации', false, 130)
ON CONFLICT (code) DO NOTHING;

-- Часы являются полем закрытия: задача вида «Прочие работы» может быть
-- создана без них, но не может быть передана на проверку или закрыта.
-- requires_hours берётся из редактируемого справочника, поэтому правило
-- одинаково работает после разрешённых администратору изменений.
CREATE OR REPLACE FUNCTION validate_task_business_rules()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  work_type_requires_hours boolean;
BEGIN
  SELECT requires_hours
    INTO work_type_requires_hours
    FROM work_types
   WHERE code = NEW.work_type_code;

  IF coalesce(work_type_requires_hours, false)
     AND NEW.status_code IN ('under_review', 'closed')
     AND (NEW.hours IS NULL OR NEW.hours <= 0) THEN
    RAISE EXCEPTION 'Для вида работ «Прочие работы» часы обязательны'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_required_work_hours';
  END IF;

  IF NOT coalesce(work_type_requires_hours, false) AND NEW.hours IS NOT NULL THEN
    RAISE EXCEPTION 'Часы можно указать только для вида работ «Прочие работы»'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_work_hours_not_applicable';
  END IF;

  IF NEW.status_code = 'cancelled'
     AND nullif(btrim(coalesce(NEW.cancellation_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Для отменённой задачи нужна причина'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE VIEW task_registry AS
SELECT
  t.id,
  t.number,
  t.title,
  t.work_type_code,
  work_type.name AS work_type_name,
  t.status_code,
  task_status.name AS status_name,
  t.priority,
  t.is_maintenance_plan,
  t.equipment_id,
  equipment.serial_number,
  model.name AS model_name,
  t.site_id,
  site.name AS site_name,
  t.payer_id,
  payer.name AS payer_name,
  t.engineer_id,
  engineer.full_name AS engineer_name,
  t.deadline_from,
  t.deadline_to,
  service_task_is_overdue(t.deadline_to, t.status_code, CURRENT_DATE) AS is_overdue,
  t.call_date,
  t.visit_date,
  t.completed_at,
  t.created_at,
  t.updated_at,
  t.maintenance_plan_id,
  t.contract_id,
  contract.number AS contract_number,
  t.primary_task_id,
  t.work_started_at,
  t.work_finished_at,
  t.work_modifier,
  t.hours
FROM tasks t
JOIN work_types work_type ON work_type.code = t.work_type_code
JOIN task_statuses task_status ON task_status.code = t.status_code
LEFT JOIN equipment ON equipment.id = t.equipment_id
LEFT JOIN equipment_models model ON model.id = equipment.model_id
LEFT JOIN sites site ON site.id = t.site_id
LEFT JOIN payers payer ON payer.id = t.payer_id
LEFT JOIN users engineer ON engineer.id = t.engineer_id
LEFT JOIN contracts contract ON contract.id = t.contract_id;

-- ---------------------------------------------------------------------------
-- 0033_task_status_role_model.sql
-- ---------------------------------------------------------------------------

-- TASK3FC9-28: автомат статусов, отмена, возврат и независимая просрочка.

-- «На доработке» является действием возврата в «В работе», а не отдельным
-- состоянием задачи. Историческое значение сохраняется, но новые задачи его
-- использовать не могут.
UPDATE task_statuses
   SET is_active = false
 WHERE code = 'rework';

-- База допускает только канонический граф. Ролевая часть команды проверяется
-- доменом/API, а этот слой защищает данные от обхода графа прямым UPDATE.
DELETE FROM task_status_transitions
 WHERE (from_status, to_status) NOT IN (
   ('planned', 'new'),
   ('planned', 'cancelled'),
   ('new', 'assigned'),
   ('new', 'cancelled'),
   ('assigned', 'in_progress'),
   ('assigned', 'cancelled'),
   ('in_progress', 'under_review'),
   ('in_progress', 'cancelled'),
   ('under_review', 'closed'),
   ('under_review', 'in_progress'),
   ('under_review', 'cancelled')
 );

INSERT INTO task_status_transitions (from_status, to_status)
VALUES
  ('planned', 'new'),
  ('planned', 'cancelled'),
  ('new', 'assigned'),
  ('new', 'cancelled'),
  ('assigned', 'in_progress'),
  ('assigned', 'cancelled'),
  ('in_progress', 'under_review'),
  ('in_progress', 'cancelled'),
  ('under_review', 'closed'),
  ('under_review', 'in_progress'),
  ('under_review', 'cancelled')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION validate_task_business_rules()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  work_type_requires_hours boolean;
BEGIN
  SELECT requires_hours
    INTO work_type_requires_hours
    FROM work_types
   WHERE code = NEW.work_type_code;

  IF coalesce(work_type_requires_hours, false)
     AND NEW.status_code IN ('under_review', 'closed')
     AND (NEW.hours IS NULL OR NEW.hours <= 0) THEN
    RAISE EXCEPTION 'Для вида работ «Прочие работы» часы обязательны'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_required_work_hours';
  END IF;

  IF NOT coalesce(work_type_requires_hours, false) AND NEW.hours IS NOT NULL THEN
    RAISE EXCEPTION 'Часы можно указать только для вида работ «Прочие работы»'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_work_hours_not_applicable';
  END IF;

  IF NEW.status_code = 'cancelled'
     AND nullif(btrim(coalesce(NEW.cancellation_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Для отменённой задачи нужна причина'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_cancellation_reason_required';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status_code = 'under_review'
     AND NEW.status_code = 'in_progress'
     AND nullif(btrim(coalesce(NEW.rework_comment, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Для возврата задачи на доработку нужен комментарий'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_rework_comment_required';
  END IF;

  -- После повторной отправки старый комментарий остаётся в истории, но не
  -- может неявно удовлетворить следующую команду возврата.
  IF TG_OP = 'UPDATE'
     AND OLD.status_code = 'in_progress'
     AND NEW.status_code = 'under_review' THEN
    NEW.rework_comment := NULL;
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION record_task_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  transition_comment text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO task_status_history (task_id, from_status, to_status, changed_by, comment)
    VALUES (NEW.id, NULL, NEW.status_code, NEW.created_by, NULL);
  ELSIF NEW.status_code <> OLD.status_code THEN
    transition_comment := CASE
      WHEN NEW.status_code = 'cancelled' THEN NEW.cancellation_reason
      WHEN OLD.status_code = 'under_review' AND NEW.status_code = 'in_progress' THEN NEW.rework_comment
      ELSE NULL
    END;
    INSERT INTO task_status_history (task_id, from_status, to_status, changed_by, comment)
    VALUES (NEW.id, OLD.status_code, NEW.status_code, NEW.updated_by, transition_comment);
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- 0034_task_closure_continuations.sql
-- ---------------------------------------------------------------------------

-- TASK3FC9-31: полный акт сервисного закрытия и одно связанное продолжение.

-- Признак ставится на закрываемой первичной задаче, а ссылка primary_task_id —
-- на новой задаче-продолжении. Старое ограничение ошибочно требовало обе связи
-- на одной строке и не позволяло сохранить связь в обеих карточках.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS task_continuation_valid;

DO $$
BEGIN
  IF EXISTS (
    SELECT primary_task_id
      FROM tasks
     WHERE primary_task_id IS NOT NULL
     GROUP BY primary_task_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Нельзя включить идемпотентные продолжения: у первичной задачи уже есть несколько продолжений';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_continuation_per_primary_uq
  ON tasks (primary_task_id)
  WHERE primary_task_id IS NOT NULL;

-- Дополняет правила 0032: причина и результат обязательны при передаче акта
-- на проверку. Рекомендации и замечания сохраняются как поля акта, но могут
-- быть пустыми, как и на бумажном бланке заказчика.
CREATE OR REPLACE FUNCTION validate_task_business_rules()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  work_type_requires_hours boolean;
BEGIN
  SELECT requires_hours
    INTO work_type_requires_hours
    FROM work_types
   WHERE code = NEW.work_type_code;

  IF coalesce(work_type_requires_hours, false)
     AND NEW.status_code IN ('under_review', 'closed')
     AND (NEW.hours IS NULL OR NEW.hours <= 0) THEN
    RAISE EXCEPTION 'Для вида работ «Прочие работы» часы обязательны'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_required_work_hours';
  END IF;

  IF NOT coalesce(work_type_requires_hours, false) AND NEW.hours IS NOT NULL THEN
    RAISE EXCEPTION 'Часы можно указать только для вида работ «Прочие работы»'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_work_hours_not_applicable';
  END IF;

  IF NEW.status_code IN ('under_review', 'closed')
     AND nullif(btrim(coalesce(NEW.call_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Для закрытия задачи нужна причина вызова'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_closure_call_reason_required';
  END IF;

  IF NEW.status_code IN ('under_review', 'closed')
     AND nullif(btrim(coalesce(NEW.work_description, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Для закрытия задачи нужно описание работ'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_closure_work_description_required';
  END IF;

  IF NEW.status_code = 'cancelled'
     AND nullif(btrim(coalesce(NEW.cancellation_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Для отменённой задачи нужна причина'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_cancellation_reason_required';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status_code = 'under_review'
     AND NEW.status_code = 'in_progress'
     AND nullif(btrim(coalesce(NEW.rework_comment, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Для возврата задачи на доработку нужен комментарий'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_rework_comment_required';
  END IF;

  -- Повторная отправка на проверку начинает новый цикл: прежний комментарий
  -- остаётся в task_status_history, но не может подтвердить следующий возврат.
  IF TG_OP = 'UPDATE'
     AND OLD.status_code = 'in_progress'
     AND NEW.status_code = 'under_review' THEN
    NEW.rework_comment := NULL;
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- 0035_task_part_positions.sql
-- ---------------------------------------------------------------------------

-- Позиции использованных запчастей в задаче (R-016), пока без обязательной
-- связи с номенклатурой, резервом и складским движением.

ALTER TABLE task_parts
  ALTER COLUMN part_id DROP NOT NULL;

ALTER TABLE task_parts
  ADD COLUMN IF NOT EXISTS position integer;

WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY task_id ORDER BY created_at, id) - 1 AS position
    FROM task_parts
)
UPDATE task_parts target
   SET position = ranked.position
  FROM ranked
 WHERE target.id = ranked.id
   AND target.position IS NULL;

ALTER TABLE task_parts
  ALTER COLUMN position SET DEFAULT 0,
  ALTER COLUMN position SET NOT NULL;

ALTER TABLE task_parts
  DROP CONSTRAINT IF EXISTS task_parts_position_valid;

ALTER TABLE task_parts
  ADD CONSTRAINT task_parts_position_valid CHECK (position >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS task_parts_task_position_uq
  ON task_parts (task_id, position);

-- ---------------------------------------------------------------------------
-- 0036_task_attachment_rules.sql
-- ---------------------------------------------------------------------------

-- Серверные правила вложений задачи: act хранит только фотографию акта.
-- NOT VALID не блокирует upgrade при наличии старых PDF-актов, но защищает
-- все новые и изменяемые строки. Исторические записи проверяются отдельно.

ALTER TABLE files
  ADD CONSTRAINT files_act_requires_photo
  CHECK (
    kind <> 'act'
    OR lower(btrim(split_part(content_type, ';', 1))) IN (
      'image/heic',
      'image/heif',
      'image/jpeg',
      'image/png',
      'image/webp'
    )
  ) NOT VALID;

CREATE OR REPLACE FUNCTION validate_task_closure_file()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM files
     WHERE id = NEW.act_file_id
       AND task_id = NEW.task_id
       AND kind = 'act'
       AND lower(btrim(split_part(content_type, ';', 1))) IN (
         'image/heic',
         'image/heif',
         'image/jpeg',
         'image/png',
         'image/webp'
       )
  ) THEN
    RAISE EXCEPTION 'Фото акта должно быть привязано к этой задаче и иметь тип act'
      USING ERRCODE = '23514', CONSTRAINT = 'task_closure_act_photo';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- 0037_task_closure_review.sql
-- ---------------------------------------------------------------------------

-- TASK3FC9-35: возврат координатором ставит e-mail инженеру в очередь
-- в той же транзакции, что и переход under_review -> in_progress.

CREATE OR REPLACE FUNCTION queue_task_rework_notification()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  engineer_email text;
  notification_key text;
BEGIN
  IF OLD.status_code = 'under_review' AND NEW.status_code = 'in_progress' THEN
    SELECT email
      INTO engineer_email
      FROM users
     WHERE id = NEW.engineer_id
       AND is_active;

    IF nullif(btrim(coalesce(engineer_email, '')), '') IS NULL THEN
      RAISE EXCEPTION 'У инженера не указан e-mail для уведомления о доработке'
        USING ERRCODE = '23514', CONSTRAINT = 'tasks_rework_engineer_email_required';
    END IF;

    notification_key := 'task-rework:' || NEW.id::text || ':'
      || floor(extract(epoch FROM NEW.updated_at) * 1000)::bigint::text;

    INSERT INTO notifications (
      idempotency_key,
      event_code,
      recipient_user_id,
      channel,
      recipient_address,
      subject,
      body,
      status,
      task_id
    )
    VALUES (
      notification_key,
      'task_rework_requested',
      NEW.engineer_id,
      'email',
      engineer_email,
      'Задача ' || NEW.number || ' возвращена на доработку',
      'Координатор вернул задачу «' || NEW.title || '» на доработку. Комментарий: ' || NEW.rework_comment,
      'queued',
      NEW.id
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS tasks_queue_rework_notification ON tasks;
CREATE TRIGGER tasks_queue_rework_notification
AFTER UPDATE OF status_code ON tasks
FOR EACH ROW
WHEN (OLD.status_code IS DISTINCT FROM NEW.status_code)
EXECUTE FUNCTION queue_task_rework_notification();

-- ---------------------------------------------------------------------------
-- 0038_annual_maintenance_planning.sql
-- ---------------------------------------------------------------------------

-- R-034: годовой план ТО, идемпотентная генерация и защита периодов.

ALTER TABLE maintenance_plans
  ADD COLUMN IF NOT EXISTS generated_at timestamptz,
  ADD COLUMN IF NOT EXISTS generated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT maintenance_plans_period_intersects_year
    CHECK (
      period_from <= make_date(plan_year, 12, 31)
      AND period_to >= make_date(plan_year, 1, 1)
    );

CREATE UNIQUE INDEX IF NOT EXISTS tasks_maintenance_plan_once_uq
  ON tasks (maintenance_plan_id)
  WHERE maintenance_plan_id IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_maintenance_plan_period()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM maintenance_plans existing
     WHERE existing.equipment_id = NEW.equipment_id
       AND existing.plan_year = NEW.plan_year
       AND existing.id <> NEW.id
       AND existing.status <> 'cancelled'
       AND daterange(existing.period_from, existing.period_to, '[]')
           && daterange(NEW.period_from, NEW.period_to, '[]')
  ) THEN
    RAISE EXCEPTION 'Периоды ТО одного годового плана не должны пересекаться'
      USING ERRCODE = '23514', CONSTRAINT = 'maintenance_plans_period_overlap';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS maintenance_plans_period_valid ON maintenance_plans;
CREATE TRIGGER maintenance_plans_period_valid
  BEFORE INSERT OR UPDATE OF equipment_id, plan_year, period_from, period_to, status
  ON maintenance_plans
  FOR EACH ROW EXECUTE FUNCTION validate_maintenance_plan_period();

CREATE INDEX IF NOT EXISTS maintenance_plans_engineer_year_idx
  ON maintenance_plans (assigned_engineer_id, plan_year, period_from)
  WHERE status <> 'cancelled';

-- ---------------------------------------------------------------------------
-- 0039_automatic_maintenance_task_activation.sql
-- ---------------------------------------------------------------------------

-- TASK3FC9-37 / R-012 / R-034: системный идемпотентный переход задач ТО
-- «Запланировано» -> «Новая» при наступлении настроенного порога периода.

CREATE INDEX IF NOT EXISTS tasks_planned_maintenance_activation_idx
  ON tasks (deadline_from, id)
  WHERE status_code = 'planned' AND is_maintenance_plan;

CREATE OR REPLACE FUNCTION activate_due_maintenance_tasks(
  p_cutoff_date date,
  p_activated_at timestamptz
)
RETURNS TABLE(task_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_cutoff_date IS NULL OR p_activated_at IS NULL THEN
    RAISE EXCEPTION 'Для запуска задач ТО нужны дата порога и время запуска'
      USING ERRCODE = '22004';
  END IF;

  RETURN QUERY
  UPDATE public.tasks task
     SET status_code = 'new',
         updated_at = p_activated_at,
         updated_by = NULL
   WHERE task.status_code = 'planned'
     AND task.is_maintenance_plan
     AND task.maintenance_plan_id IS NOT NULL
     AND task.deadline_from <= p_cutoff_date
  RETURNING task.id;
END
$$;

REVOKE ALL ON FUNCTION activate_due_maintenance_tasks(date, timestamptz) FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO medtech_worker;
GRANT EXECUTE ON FUNCTION activate_due_maintenance_tasks(date, timestamptz) TO medtech_worker;

-- ---------------------------------------------------------------------------
-- 0040_business_event_outbox.sql
-- ---------------------------------------------------------------------------

-- TASK3FC9-38 / R-026 / R-027: каталог бизнес-событий и transactional outbox.
-- Триггеры пишут событие в той же транзакции, что и изменение агрегата.
-- Конкретный канал выбирается позже worker-ом и не входит в payload события.

CREATE TABLE IF NOT EXISTS business_event_catalog (
  code text PRIMARY KEY CHECK (btrim(code) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  aggregate_type text NOT NULL CHECK (btrim(aggregate_type) <> ''),
  current_version smallint NOT NULL CHECK (current_version > 0),
  is_active boolean NOT NULL DEFAULT true
);

INSERT INTO business_event_catalog (code, name, aggregate_type, current_version)
VALUES
  ('task_application_accepted', 'Заявка принята', 'task', 1),
  ('task_engineer_assigned', 'Инженер назначен', 'task', 1),
  ('task_engineer_accepted', 'Инженер принял задачу', 'task', 1),
  ('task_work_completed', 'Работы завершены', 'task', 1),
  ('task_rework_requested', 'Задача возвращена на доработку', 'task', 1),
  ('task_overdue', 'Задача просрочена', 'task', 1),
  ('stock_reservation_created', 'Создан резерв запчастей', 'stock_reservation', 1),
  ('stock_reservation_ready', 'Запчасти можно забрать', 'stock_reservation', 1)
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    aggregate_type = EXCLUDED.aggregate_type,
    current_version = EXCLUDED.current_version;

ALTER TABLE integration_outbox
  ADD COLUMN IF NOT EXISTS event_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS occurred_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE integration_outbox
  DROP CONSTRAINT IF EXISTS integration_outbox_event_version_positive;
ALTER TABLE integration_outbox
  ADD CONSTRAINT integration_outbox_event_version_positive CHECK (event_version > 0);

-- Старые интеграционные записи не препятствуют upgrade. Новые записи обязаны
-- сначала зарегистрировать стабильный код в каталоге.
ALTER TABLE integration_outbox
  DROP CONSTRAINT IF EXISTS integration_outbox_event_catalog_fk;
ALTER TABLE integration_outbox
  ADD CONSTRAINT integration_outbox_event_catalog_fk
  FOREIGN KEY (event_type) REFERENCES business_event_catalog(code) ON DELETE RESTRICT
  NOT VALID;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS outbox_event_id uuid REFERENCES integration_outbox(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS provider_message_id text;

CREATE INDEX IF NOT EXISTS integration_outbox_due_idx
  ON integration_outbox (available_at, created_at, id)
  WHERE status IN ('queued', 'failed');
CREATE INDEX IF NOT EXISTS notifications_outbox_event_idx
  ON notifications (outbox_event_id, status, scheduled_at)
  WHERE outbox_event_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enqueue_business_event(
  p_idempotency_key text,
  p_aggregate_type text,
  p_aggregate_id uuid,
  p_event_type text,
  p_payload jsonb,
  p_occurred_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  catalog_entry business_event_catalog%ROWTYPE;
  event_id uuid;
BEGIN
  IF nullif(btrim(coalesce(p_idempotency_key, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Для бизнес-события нужен idempotency key'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO catalog_entry
    FROM business_event_catalog
   WHERE code = p_event_type AND is_active;
  IF catalog_entry.code IS NULL OR catalog_entry.aggregate_type <> p_aggregate_type THEN
    RAISE EXCEPTION 'Событие % не зарегистрировано для агрегата %', p_event_type, p_aggregate_type
      USING ERRCODE = '23514', CONSTRAINT = 'integration_outbox_event_catalog';
  END IF;

  INSERT INTO integration_outbox (
    idempotency_key, aggregate_type, aggregate_id, event_type, event_version,
    payload, status, available_at, occurred_at
  )
  VALUES (
    p_idempotency_key, p_aggregate_type, p_aggregate_id, p_event_type,
    catalog_entry.current_version, coalesce(p_payload, '{}'::jsonb), 'queued',
    p_occurred_at, p_occurred_at
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO event_id;

  IF event_id IS NULL THEN
    SELECT id INTO event_id
      FROM integration_outbox
     WHERE idempotency_key = p_idempotency_key;
  END IF;
  RETURN event_id;
END
$$;

CREATE OR REPLACE FUNCTION enqueue_task_business_events()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event_code text;
  event_time timestamptz;
  event_payload jsonb;
BEGIN
  event_payload := jsonb_strip_nulls(jsonb_build_object(
    'taskId', NEW.id,
    'taskNumber', NEW.number,
    'engineerId', NEW.engineer_id,
    'initiatorId', NEW.initiator_id,
    'siteId', NEW.site_id,
    'periodFrom', NEW.deadline_from,
    'periodTo', NEW.deadline_to
  ));

  -- API может создать задачу уже назначенной. Оба события пишутся этим
  -- AFTER-trigger в той же транзакции, поэтому ни одно уведомление не теряется.
  IF TG_OP = 'INSERT' AND NEW.status_code IN ('new', 'assigned') THEN
    event_time := NEW.created_at;
    PERFORM enqueue_business_event(
      'task_application_accepted:' || NEW.id::text || ':'
        || floor(extract(epoch FROM event_time) * 1000000)::bigint::text,
      'task', NEW.id, 'task_application_accepted', event_payload, event_time
    );
    IF NEW.status_code = 'assigned' THEN
      PERFORM enqueue_business_event(
        'task_engineer_assigned:' || NEW.id::text || ':'
          || floor(extract(epoch FROM event_time) * 1000000)::bigint::text,
        'task', NEW.id, 'task_engineer_assigned', event_payload, event_time
      );
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' AND OLD.status_code = 'planned' AND NEW.status_code = 'new' THEN
    event_code := 'task_application_accepted';
    event_time := NEW.updated_at;
  ELSIF TG_OP = 'UPDATE' AND OLD.status_code = 'new' AND NEW.status_code = 'assigned' THEN
    event_code := 'task_engineer_assigned';
    event_time := NEW.updated_at;
  ELSIF TG_OP = 'UPDATE' AND OLD.status_code = 'assigned' AND NEW.status_code = 'in_progress' THEN
    event_code := 'task_engineer_accepted';
    event_time := NEW.updated_at;
  ELSIF TG_OP = 'UPDATE' AND OLD.status_code = 'in_progress' AND NEW.status_code = 'under_review' THEN
    event_code := 'task_work_completed';
    event_time := NEW.updated_at;
  ELSIF TG_OP = 'UPDATE' AND OLD.status_code = 'under_review' AND NEW.status_code = 'in_progress' THEN
    event_code := 'task_rework_requested';
    event_time := NEW.updated_at;
  ELSE
    RETURN NEW;
  END IF;

  IF event_code = 'task_rework_requested' THEN
    event_payload := event_payload || jsonb_build_object('reworkComment', NEW.rework_comment);
  END IF;

  PERFORM enqueue_business_event(
    event_code || ':' || NEW.id::text || ':'
      || floor(extract(epoch FROM event_time) * 1000000)::bigint::text,
    'task', NEW.id, event_code, event_payload, event_time
  );
  RETURN NEW;
END
$$;

-- TASK3FC9-35 создавал e-mail непосредственно из task trigger. С этого
-- milestone trigger публикует нейтральное событие, а канал выбирает dispatcher.
DROP TRIGGER IF EXISTS tasks_queue_rework_notification ON tasks;
DROP FUNCTION IF EXISTS queue_task_rework_notification();

DROP TRIGGER IF EXISTS tasks_enqueue_business_events ON tasks;
CREATE TRIGGER tasks_enqueue_business_events
AFTER INSERT OR UPDATE OF status_code ON tasks
FOR EACH ROW EXECUTE FUNCTION enqueue_task_business_events();

CREATE OR REPLACE FUNCTION enqueue_stock_reservation_business_events()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event_code text;
  event_time timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    event_code := 'stock_reservation_created';
    event_time := NEW.created_at;
  ELSIF OLD.status = 'created' AND NEW.status = 'warehouse_notified' THEN
    event_code := 'stock_reservation_ready';
    event_time := NEW.updated_at;
  ELSE
    RETURN NEW;
  END IF;

  PERFORM enqueue_business_event(
    event_code || ':' || NEW.id::text || ':'
      || floor(extract(epoch FROM event_time) * 1000000)::bigint::text,
    'stock_reservation', NEW.id, event_code,
    jsonb_strip_nulls(jsonb_build_object(
      'reservationId', NEW.id,
      'reservationNumber', NEW.number,
      'taskId', NEW.task_id,
      'contractId', NEW.contract_id,
      'issuedTo', NEW.issued_to
    )),
    event_time
  );
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS stock_reservations_enqueue_business_events ON stock_reservations;
CREATE TRIGGER stock_reservations_enqueue_business_events
AFTER INSERT OR UPDATE OF status ON stock_reservations
FOR EACH ROW EXECUTE FUNCTION enqueue_stock_reservation_business_events();

CREATE OR REPLACE FUNCTION claim_business_events(
  p_limit integer,
  p_now timestamptz,
  p_lease_until timestamptz
)
RETURNS TABLE(
  id uuid,
  idempotency_key text,
  aggregate_type text,
  aggregate_id uuid,
  event_type text,
  event_version smallint,
  payload jsonb,
  occurred_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH due AS (
    SELECT queued.id
      FROM public.integration_outbox queued
     WHERE queued.status IN ('queued', 'failed')
       AND queued.available_at <= p_now
     ORDER BY queued.available_at, queued.created_at, queued.id
     FOR UPDATE SKIP LOCKED
     LIMIT least(greatest(coalesce(p_limit, 1), 1), 1000)
  ), claimed AS (
    UPDATE public.integration_outbox event
       SET status = 'queued', attempts = event.attempts + 1,
           available_at = p_lease_until
      FROM due
     WHERE event.id = due.id
   RETURNING event.id, event.idempotency_key, event.aggregate_type,
             event.aggregate_id, event.event_type, event.event_version,
             event.payload, event.occurred_at
  )
  SELECT * FROM claimed
$$;

CREATE OR REPLACE FUNCTION stage_event_notifications(
  p_event_id uuid,
  p_commands jsonb
)
RETURNS TABLE(
  id uuid,
  outbox_event_id uuid,
  idempotency_key text,
  event_code text,
  recipient_user_id uuid,
  channel notification_channel,
  recipient_address text,
  subject text,
  body text,
  task_id uuid,
  equipment_id uuid,
  reservation_id uuid,
  attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  stored_event_type text;
BEGIN
  IF p_commands IS NULL OR jsonb_typeof(p_commands) <> 'array' THEN
    RAISE EXCEPTION 'Команды доставки должны быть JSON-массивом'
      USING ERRCODE = '22023';
  END IF;
  SELECT event.event_type INTO stored_event_type
    FROM public.integration_outbox event
   WHERE event.id = p_event_id;
  IF stored_event_type IS NULL THEN
    RAISE EXCEPTION 'Событие outbox не найдено'
      USING ERRCODE = '23503';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_commands) item(value)
     WHERE item.value ->> 'eventCode' <> stored_event_type
        OR nullif(btrim(item.value ->> 'idempotencyKey'), '') IS NULL
        OR nullif(btrim(item.value ->> 'recipientAddress'), '') IS NULL
        OR nullif(btrim(item.value ->> 'body'), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'Команда доставки не соответствует событию outbox'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.notifications (
    idempotency_key, event_code, recipient_user_id, channel,
    recipient_address, subject, body, task_id, equipment_id,
    reservation_id, outbox_event_id, status
  )
  SELECT value ->> 'idempotencyKey', value ->> 'eventCode',
         nullif(value ->> 'recipientUserId', '')::uuid,
         (value ->> 'channel')::public.notification_channel,
         value ->> 'recipientAddress', coalesce(value ->> 'subject', ''),
         value ->> 'body', nullif(value ->> 'taskId', '')::uuid,
         nullif(value ->> 'equipmentId', '')::uuid,
         nullif(value ->> 'reservationId', '')::uuid, p_event_id, 'queued'
    FROM jsonb_array_elements(p_commands) item(value)
  ON CONFLICT (idempotency_key) DO NOTHING;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_commands) item(value)
      LEFT JOIN public.notifications notification
        ON notification.idempotency_key = item.value ->> 'idempotencyKey'
       AND notification.outbox_event_id = p_event_id
     WHERE notification.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Idempotency key доставки уже занят другим событием'
      USING ERRCODE = '23505';
  END IF;

  RETURN QUERY
  SELECT notification.id, notification.outbox_event_id,
         notification.idempotency_key, notification.event_code,
         notification.recipient_user_id, notification.channel,
         notification.recipient_address, notification.subject, notification.body,
         notification.task_id, notification.equipment_id,
         notification.reservation_id, notification.attempts
    FROM public.notifications notification
   WHERE notification.outbox_event_id = p_event_id
     AND notification.status IN ('queued', 'failed')
   ORDER BY notification.created_at, notification.id;
END
$$;

CREATE OR REPLACE FUNCTION record_notification_delivery_attempt(p_delivery_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.notifications
     SET attempts = attempts + 1, last_error = NULL
   WHERE id = p_delivery_id AND status IN ('queued', 'failed')
$$;

CREATE OR REPLACE FUNCTION complete_notification_delivery(
  p_delivery_id uuid,
  p_delivered_at timestamptz,
  p_provider_message_id text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.notifications
     SET status = 'delivered', sent_at = coalesce(sent_at, p_delivered_at),
         delivered_at = p_delivered_at, last_error = NULL,
         provider_message_id = coalesce(p_provider_message_id, provider_message_id)
   WHERE id = p_delivery_id AND status <> 'delivered'
$$;

CREATE OR REPLACE FUNCTION fail_notification_delivery(
  p_delivery_id uuid,
  p_error_code text,
  p_retry_at timestamptz
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.notifications
     SET status = 'failed', last_error = left(p_error_code, 200), scheduled_at = p_retry_at
   WHERE id = p_delivery_id AND status <> 'delivered'
$$;

CREATE OR REPLACE FUNCTION complete_business_event(p_event_id uuid, p_processed_at timestamptz)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.integration_outbox
     SET status = 'processed', published_at = p_processed_at,
         last_error = NULL, available_at = p_processed_at
   WHERE id = p_event_id
$$;

CREATE OR REPLACE FUNCTION retry_business_event(
  p_event_id uuid,
  p_error_code text,
  p_retry_at timestamptz
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.integration_outbox
     SET status = 'failed', last_error = left(p_error_code, 200), available_at = p_retry_at
   WHERE id = p_event_id
$$;

GRANT SELECT ON business_event_catalog TO medtech_api, medtech_worker, medtech_backup;
GRANT EXECUTE ON FUNCTION enqueue_business_event(text, text, uuid, text, jsonb, timestamptz) TO medtech_api;
REVOKE ALL ON integration_outbox, notifications FROM medtech_worker;
REVOKE ALL ON FUNCTION claim_business_events(integer, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION stage_event_notifications(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_notification_delivery_attempt(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_notification_delivery(uuid, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fail_notification_delivery(uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_business_event(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION retry_business_event(uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_business_events(integer, timestamptz, timestamptz) FROM medtech_api, medtech_backup;
REVOKE ALL ON FUNCTION stage_event_notifications(uuid, jsonb) FROM medtech_api, medtech_backup;
REVOKE ALL ON FUNCTION record_notification_delivery_attempt(uuid) FROM medtech_api, medtech_backup;
REVOKE ALL ON FUNCTION complete_notification_delivery(uuid, timestamptz, text) FROM medtech_api, medtech_backup;
REVOKE ALL ON FUNCTION fail_notification_delivery(uuid, text, timestamptz) FROM medtech_api, medtech_backup;
REVOKE ALL ON FUNCTION complete_business_event(uuid, timestamptz) FROM medtech_api, medtech_backup;
REVOKE ALL ON FUNCTION retry_business_event(uuid, text, timestamptz) FROM medtech_api, medtech_backup;
GRANT EXECUTE ON FUNCTION claim_business_events(integer, timestamptz, timestamptz) TO medtech_worker;
GRANT EXECUTE ON FUNCTION stage_event_notifications(uuid, jsonb) TO medtech_worker;
GRANT EXECUTE ON FUNCTION record_notification_delivery_attempt(uuid) TO medtech_worker;
GRANT EXECUTE ON FUNCTION complete_notification_delivery(uuid, timestamptz, text) TO medtech_worker;
GRANT EXECUTE ON FUNCTION fail_notification_delivery(uuid, text, timestamptz) TO medtech_worker;
GRANT EXECUTE ON FUNCTION complete_business_event(uuid, timestamptz) TO medtech_worker;
GRANT EXECUTE ON FUNCTION retry_business_event(uuid, text, timestamptz) TO medtech_worker;

-- ---------------------------------------------------------------------------
-- 0041_email_notification_delivery.sql
-- ---------------------------------------------------------------------------

-- TASK3FC9-39 / R-026 / R-027 / R-041: e-mail шаблоны, адресаты,
-- регистрация просрочек и безопасный журнал доставки.

ALTER TABLE notification_templates
  ADD COLUMN IF NOT EXISTS allowed_variables text[] NOT NULL DEFAULT '{}'::text[];

INSERT INTO notification_templates (
  code, name, subject_template, body_template, allowed_variables
)
VALUES
  (
    'task_application_accepted', 'Заявка принята',
    'Заявка {{taskNumber}} принята',
    E'Здравствуйте, {{recipientName}}!

Заявка {{taskNumber}} «{{taskTitle}}» принята в работу. Площадка: {{siteName}}.

Карточка задачи: {{taskUrl}}',
    ARRAY['recipientName', 'taskNumber', 'taskTitle', 'siteName', 'taskUrl']
  ),
  (
    'task_engineer_assigned', 'Инженер назначен',
    'По задаче {{taskNumber}} назначен инженер',
    E'Здравствуйте, {{recipientName}}!

По задаче {{taskNumber}} «{{taskTitle}}» назначен инженер {{engineerName}}. Период выполнения: {{periodFrom}} — {{periodTo}}.

Карточка задачи: {{taskUrl}}',
    ARRAY['recipientName', 'taskNumber', 'taskTitle', 'engineerName', 'periodFrom', 'periodTo', 'taskUrl']
  ),
  (
    'task_engineer_accepted', 'Инженер принял задачу',
    'Инженер принял задачу {{taskNumber}}',
    E'Здравствуйте, {{recipientName}}!

Инженер {{engineerName}} принял задачу {{taskNumber}} «{{taskTitle}}» в работу.

Карточка задачи: {{taskUrl}}',
    ARRAY['recipientName', 'taskNumber', 'taskTitle', 'engineerName', 'taskUrl']
  ),
  (
    'task_work_completed', 'Работы завершены',
    'Работы по задаче {{taskNumber}} завершены',
    E'Здравствуйте, {{recipientName}}!

Работы по задаче {{taskNumber}} «{{taskTitle}}» завершены. Акт и отчёт доступны в карточке задачи: {{taskUrl}}',
    ARRAY['recipientName', 'taskNumber', 'taskTitle', 'taskUrl']
  ),
  (
    'task_rework_requested', 'Задача возвращена на доработку',
    'Задача {{taskNumber}} возвращена на доработку',
    E'Здравствуйте, {{recipientName}}!

Задача {{taskNumber}} «{{taskTitle}}» возвращена на доработку. Комментарий координатора: {{reworkComment}}.

Карточка задачи: {{taskUrl}}',
    ARRAY['recipientName', 'taskNumber', 'taskTitle', 'reworkComment', 'taskUrl']
  ),
  (
    'task_overdue', 'Задача просрочена',
    'Просрочена задача {{taskNumber}}',
    E'Здравствуйте, {{recipientName}}!

Задача {{taskNumber}} «{{taskTitle}}» просрочена. Плановый срок: до {{periodTo}}. Ответственный инженер: {{engineerName}}.

Карточка задачи: {{taskUrl}}',
    ARRAY['recipientName', 'taskNumber', 'taskTitle', 'periodTo', 'engineerName', 'taskUrl']
  )
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    allowed_variables = EXCLUDED.allowed_variables;

DROP TRIGGER IF EXISTS notification_templates_updated_at ON notification_templates;
CREATE TRIGGER notification_templates_updated_at
  BEFORE UPDATE ON notification_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Просрочка является вычисляемым признаком, поэтому событие регистрируется
-- идемпотентно отдельной командой worker-а. Один срок задачи даёт одно событие.
CREATE OR REPLACE FUNCTION enqueue_overdue_task_events(p_now timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  inserted_count integer;
BEGIN
  WITH overdue AS (
    SELECT task.id, task.deadline_to
      FROM public.tasks task
     WHERE public.service_task_is_overdue(task.deadline_to, task.status_code, p_now::date)
  ), inserted AS (
    INSERT INTO public.integration_outbox (
      idempotency_key, aggregate_type, aggregate_id, event_type, event_version,
      payload, status, available_at, occurred_at
    )
    SELECT 'task_overdue:' || overdue.id::text || ':' || overdue.deadline_to::text,
           'task', overdue.id, 'task_overdue', catalog.current_version,
           jsonb_build_object('taskId', overdue.id, 'periodTo', overdue.deadline_to),
           'queued', p_now, p_now
      FROM overdue
      JOIN public.business_event_catalog catalog ON catalog.code = 'task_overdue' AND catalog.is_active
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer INTO inserted_count FROM inserted;
  RETURN inserted_count;
END
$$;

-- Единственная read-модель планировщика: выбор адресатов и снимок шаблона
-- остаются локальны БД, worker получает только готовые к рендерингу данные.
CREATE OR REPLACE FUNCTION load_email_event_plan(p_event_id uuid)
RETURNS TABLE(
  recipient_user_id uuid,
  recipient_address text,
  recipient_name text,
  subject_template text,
  body_template text,
  allowed_variables text[],
  task_id uuid,
  variables jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH event AS (
    SELECT queued.id, queued.event_type, queued.aggregate_id, queued.payload
      FROM public.integration_outbox queued
     WHERE queued.id = p_event_id AND queued.aggregate_type = 'task'
  ), task_context AS (
    SELECT event.event_type, event.payload, task.id, task.number, task.title,
           task.deadline_from, task.deadline_to, task.rework_comment,
           task.engineer_id, task.initiator_id, task.contact_name,
           task.contact_email, task.site_id, engineer.full_name AS engineer_name,
           site.name AS site_name
      FROM event
      JOIN public.tasks task ON task.id = event.aggregate_id
      LEFT JOIN public.users engineer ON engineer.id = task.engineer_id
      LEFT JOIN public.sites site ON site.id = task.site_id
  ), candidates AS (
    -- Инициатор получает подтверждение, назначение, принятие и результат.
    SELECT context.event_type, context.id AS task_id, user_account.id AS user_id,
           user_account.email AS address, user_account.full_name AS display_name,
           context.payload, context.number, context.title, context.deadline_from,
           context.deadline_to, context.rework_comment, context.engineer_name,
           context.site_name
      FROM task_context context
      JOIN public.users user_account ON user_account.id = context.initiator_id
       AND user_account.is_active AND nullif(btrim(user_account.email), '') IS NOT NULL
     WHERE context.event_type IN (
       'task_application_accepted', 'task_engineer_assigned',
       'task_engineer_accepted', 'task_work_completed'
     )
    UNION ALL
    -- Инженер получает назначение и комментарий возврата.
    SELECT context.event_type, context.id, user_account.id, user_account.email,
           user_account.full_name, context.payload, context.number, context.title,
           context.deadline_from, context.deadline_to, context.rework_comment,
           context.engineer_name, context.site_name
      FROM task_context context
      JOIN public.users user_account ON user_account.id = context.engineer_id
       AND user_account.is_active AND nullif(btrim(user_account.email), '') IS NOT NULL
     WHERE context.event_type IN ('task_engineer_assigned', 'task_rework_requested')
    UNION ALL
    -- Контакт площадки получает подтверждение заявки и завершение работ.
    SELECT context.event_type, context.id, NULL::uuid, context.contact_email,
           coalesce(nullif(btrim(context.contact_name), ''), 'коллеги'),
           context.payload, context.number, context.title, context.deadline_from,
           context.deadline_to, context.rework_comment, context.engineer_name,
           context.site_name
      FROM task_context context
     WHERE context.event_type IN ('task_application_accepted', 'task_work_completed')
       AND nullif(btrim(context.contact_email), '') IS NOT NULL
    UNION ALL
    -- Просрочка эскалируется всем активным руководителям.
    SELECT context.event_type, context.id, user_account.id, user_account.email,
           user_account.full_name, context.payload, context.number, context.title,
           context.deadline_from, context.deadline_to, context.rework_comment,
           context.engineer_name, context.site_name
      FROM task_context context
      JOIN public.users user_account ON user_account.role = 'supervisor'
       AND user_account.is_active AND nullif(btrim(user_account.email), '') IS NOT NULL
     WHERE context.event_type = 'task_overdue'
  ), enabled AS (
    SELECT candidate.*
      FROM candidates candidate
      LEFT JOIN public.notification_preferences preference
        ON preference.user_id = candidate.user_id
       AND preference.event_code = candidate.event_type
       AND preference.channel = 'email'
     WHERE candidate.user_id IS NULL OR coalesce(preference.is_enabled, true)
  ), deduplicated AS (
    SELECT DISTINCT ON (lower(btrim(address))) *
      FROM enabled
     ORDER BY lower(btrim(address)), user_id NULLS LAST
  )
  SELECT deduplicated.user_id, btrim(deduplicated.address), deduplicated.display_name,
         template.subject_template, template.body_template, template.allowed_variables,
         deduplicated.task_id,
         jsonb_strip_nulls(jsonb_build_object(
           'recipientName', deduplicated.display_name,
           'taskNumber', deduplicated.number,
           'taskTitle', deduplicated.title,
           'siteName', deduplicated.site_name,
           'engineerName', coalesce(deduplicated.engineer_name, 'не назначен'),
           'periodFrom', deduplicated.deadline_from,
           'periodTo', deduplicated.deadline_to,
           'reworkComment', coalesce(deduplicated.payload ->> 'reworkComment', deduplicated.rework_comment),
           'taskId', deduplicated.task_id
         ))
    FROM deduplicated
    JOIN public.notification_templates template
      ON template.code = deduplicated.event_type AND template.is_active
   ORDER BY lower(btrim(deduplicated.address))
$$;

-- SMTP подтверждает приём сервером, но не факт чтения/финальной доставки.
-- Поэтому успешная команда получает честный статус sent, а delivered_at
-- остаётся для каналов с отдельным delivery receipt в следующих этапах.
CREATE OR REPLACE FUNCTION complete_notification_delivery(
  p_delivery_id uuid,
  p_delivered_at timestamptz,
  p_provider_message_id text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.notifications
     SET status = 'sent', sent_at = coalesce(sent_at, p_delivered_at),
         last_error = NULL,
         provider_message_id = coalesce(p_provider_message_id, provider_message_id)
   WHERE id = p_delivery_id AND status NOT IN ('sent', 'delivered')
$$;

REVOKE ALL ON FUNCTION enqueue_overdue_task_events(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION load_email_event_plan(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_overdue_task_events(timestamptz) FROM medtech_api, medtech_backup;
REVOKE ALL ON FUNCTION load_email_event_plan(uuid) FROM medtech_api, medtech_backup;
GRANT EXECUTE ON FUNCTION enqueue_overdue_task_events(timestamptz) TO medtech_worker;
GRANT EXECUTE ON FUNCTION load_email_event_plan(uuid) TO medtech_worker;
GRANT EXECUTE ON FUNCTION complete_notification_delivery(uuid, timestamptz, text) TO medtech_worker;

GRANT SELECT ON notification_templates, notifications TO medtech_api;
GRANT UPDATE ON notification_templates TO medtech_api;

-- ---------------------------------------------------------------------------
-- 0042_m3_blocking_invariants.sql
-- ---------------------------------------------------------------------------

-- Блокирующие замечания M3: неизменяемое правило часов, корректное назначение
-- инженера и отдельное состояние начатой внешней доставки.

-- Требование часов определяется кодом вида работ, а не редактируемым флагом.
UPDATE work_types
   SET requires_hours = (code = 'other')
 WHERE requires_hours IS DISTINCT FROM (code = 'other');

CREATE OR REPLACE FUNCTION validate_work_type_hours_invariant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.requires_hours IS DISTINCT FROM (NEW.code = 'other') THEN
    RAISE EXCEPTION 'Часы обязательны только для вида работ «Прочие работы»'
      USING ERRCODE = '23514', CONSTRAINT = 'work_types_hours_only_for_other';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS work_types_hours_invariant ON work_types;
CREATE TRIGGER work_types_hours_invariant
  BEFORE INSERT OR UPDATE OF code, requires_hours ON work_types
  FOR EACH ROW EXECUTE FUNCTION validate_work_type_hours_invariant();

CREATE OR REPLACE FUNCTION validate_task_business_rules()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.work_type_code = 'other'
     AND NEW.status_code IN ('under_review', 'closed')
     AND (NEW.hours IS NULL OR NEW.hours <= 0) THEN
    RAISE EXCEPTION 'Для вида работ «Прочие работы» часы обязательны'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_required_work_hours';
  END IF;

  IF NEW.work_type_code <> 'other' AND NEW.hours IS NOT NULL THEN
    RAISE EXCEPTION 'Часы можно указать только для вида работ «Прочие работы»'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_work_hours_not_applicable';
  END IF;

  IF NEW.status_code IN ('under_review', 'closed')
     AND nullif(btrim(coalesce(NEW.call_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Для закрытия задачи нужна причина вызова'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_closure_call_reason_required';
  END IF;

  IF NEW.status_code IN ('under_review', 'closed')
     AND nullif(btrim(coalesce(NEW.work_description, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Для закрытия задачи нужно описание работ'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_closure_work_description_required';
  END IF;

  IF NEW.status_code = 'cancelled'
     AND nullif(btrim(coalesce(NEW.cancellation_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Для отменённой задачи нужна причина'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_cancellation_reason_required';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status_code = 'under_review'
     AND NEW.status_code = 'in_progress'
     AND nullif(btrim(coalesce(NEW.rework_comment, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Для возврата задачи на доработку нужен комментарий'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_rework_comment_required';
  END IF;

  -- Повторная отправка начинает новый цикл проверки. Предыдущий комментарий
  -- остаётся в task_status_history и не может подтвердить следующий возврат.
  IF TG_OP = 'UPDATE'
     AND OLD.status_code = 'in_progress'
     AND NEW.status_code = 'under_review' THEN
    NEW.rework_comment := NULL;
  END IF;
  RETURN NEW;
END
$$;

-- FK гарантирует существование пользователя; этот trigger гарантирует его
-- рабочую роль и активность в момент создания или назначения задачи.
CREATE OR REPLACE FUNCTION validate_task_engineer_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.engineer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM users
     WHERE id = NEW.engineer_id
       AND role = 'engineer'
       AND is_active
  ) THEN
    RAISE EXCEPTION 'Задачу можно назначить только активному инженеру'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_active_engineer_required';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS tasks_active_engineer_required ON tasks;
CREATE TRIGGER tasks_active_engineer_required
  BEFORE INSERT OR UPDATE OF engineer_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION validate_task_engineer_assignment();

-- Обычный SMTP не поддерживает idempotency key. Состояние sending отделяет
-- постоянную бронь попытки от подтверждённого SMTP-сервером sent.
ALTER TYPE notification_status ADD VALUE IF NOT EXISTS 'sending' BEFORE 'sent';

-- ---------------------------------------------------------------------------
-- 0043_persistent_smtp_delivery_claim.sql
-- ---------------------------------------------------------------------------

-- R-027: постоянная at-most-once бронь закрывает crash-окно между SMTP DATA 250
-- и фиксацией результата worker-ом. После перезапуска sending не выдаётся
-- повторно; неопределённый исход остаётся видимым в журнале.

DROP FUNCTION IF EXISTS record_notification_delivery_attempt(uuid);
CREATE FUNCTION record_notification_delivery_attempt(p_delivery_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  claimed boolean := false;
BEGIN
  UPDATE public.notifications
     SET status = 'sending', attempts = attempts + 1, last_error = NULL
   WHERE id = p_delivery_id
     AND status IN ('queued', 'failed');
  GET DIAGNOSTICS claimed = ROW_COUNT;
  RETURN claimed;
END
$$;

REVOKE ALL ON FUNCTION record_notification_delivery_attempt(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_notification_delivery_attempt(uuid) FROM medtech_api, medtech_backup;
GRANT EXECUTE ON FUNCTION record_notification_delivery_attempt(uuid) TO medtech_worker;

-- ---------------------------------------------------------------------------
-- 0044_atomic_task_closure_acceptance.sql
-- ---------------------------------------------------------------------------

-- TASK3FC9-35 / TASK3FC9-39: решение координатора является одной командой,
-- а результат работ публикуется только после окончательного закрытия задачи.

CREATE OR REPLACE FUNCTION accept_task_closure(
  p_task_id uuid,
  p_verified_by uuid,
  p_verification_comment text,
  p_updated_at timestamptz
)
RETURNS task_closures
LANGUAGE plpgsql
AS $$
DECLARE
  task_before tasks%ROWTYPE;
  accepted_closure task_closures%ROWTYPE;
  photo_count integer;
BEGIN
  SELECT * INTO task_before
    FROM tasks
   WHERE id = p_task_id
   FOR UPDATE;

  IF task_before.id IS NULL OR task_before.status_code <> 'under_review' THEN
    RAISE EXCEPTION 'Проверить и закрыть можно только задачу на проверке'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_accept_closure_under_review_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM task_closures closure
      JOIN files act_file
        ON act_file.id = closure.act_file_id
       AND act_file.task_id = closure.task_id
       AND act_file.kind = 'act'
       AND lower(btrim(split_part(act_file.content_type, ';', 1))) IN (
         'image/heic', 'image/heif', 'image/jpeg', 'image/png', 'image/webp'
       )
     WHERE closure.task_id = p_task_id
  ) THEN
    RAISE EXCEPTION 'Для закрытия задачи нужно фото акта'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_accept_closure_act_photo_required';
  END IF;

  SELECT count(*) INTO photo_count
    FROM files
   WHERE task_id = p_task_id AND kind = 'photo';
  IF photo_count < 3 THEN
    RAISE EXCEPTION 'Для закрытия нужны минимум три фото фотофиксации'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_accept_closure_photos_required';
  END IF;

  UPDATE task_closures
     SET verified_by = p_verified_by,
         verified_at = p_updated_at,
         verification_comment = nullif(btrim(p_verification_comment), '')
   WHERE task_id = p_task_id
  RETURNING * INTO accepted_closure;

  IF accepted_closure.task_id IS NULL THEN
    RAISE EXCEPTION 'Акт задачи не найден'
      USING ERRCODE = '23514', CONSTRAINT = 'tasks_accept_closure_required';
  END IF;

  UPDATE tasks
     SET status_code = 'closed',
         updated_at = p_updated_at,
         updated_by = p_verified_by
   WHERE id = p_task_id AND status_code = 'under_review';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Задача была изменена параллельно'
      USING ERRCODE = '40001';
  END IF;

  PERFORM append_audit_event(
    'task_closure_accepted',
    'task',
    p_task_id::text,
    jsonb_build_object('status', task_before.status_code, 'closureVerified', false),
    jsonb_build_object('status', 'closed', 'closureVerified', true),
    'success',
    jsonb_strip_nulls(jsonb_build_object(
      'verificationComment', nullif(btrim(p_verification_comment), '')
    )),
    p_verified_by
  );

  RETURN accepted_closure;
END
$$;

CREATE OR REPLACE FUNCTION enqueue_task_business_events()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event_code text;
  event_time timestamptz;
  event_payload jsonb;
BEGIN
  event_payload := jsonb_strip_nulls(jsonb_build_object(
    'taskId', NEW.id,
    'taskNumber', NEW.number,
    'engineerId', NEW.engineer_id,
    'initiatorId', NEW.initiator_id,
    'siteId', NEW.site_id,
    'periodFrom', NEW.deadline_from,
    'periodTo', NEW.deadline_to
  ));

  IF TG_OP = 'INSERT' AND NEW.status_code IN ('new', 'assigned') THEN
    event_time := NEW.created_at;
    PERFORM enqueue_business_event(
      'task_application_accepted:' || NEW.id::text || ':'
        || floor(extract(epoch FROM event_time) * 1000000)::bigint::text,
      'task', NEW.id, 'task_application_accepted', event_payload, event_time
    );
    IF NEW.status_code = 'assigned' THEN
      PERFORM enqueue_business_event(
        'task_engineer_assigned:' || NEW.id::text || ':'
          || floor(extract(epoch FROM event_time) * 1000000)::bigint::text,
        'task', NEW.id, 'task_engineer_assigned', event_payload, event_time
      );
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' AND OLD.status_code = 'planned' AND NEW.status_code = 'new' THEN
    event_code := 'task_application_accepted';
    event_time := NEW.updated_at;
  ELSIF TG_OP = 'UPDATE' AND OLD.status_code = 'new' AND NEW.status_code = 'assigned' THEN
    event_code := 'task_engineer_assigned';
    event_time := NEW.updated_at;
  ELSIF TG_OP = 'UPDATE' AND OLD.status_code = 'assigned' AND NEW.status_code = 'in_progress' THEN
    event_code := 'task_engineer_accepted';
    event_time := NEW.updated_at;
  ELSIF TG_OP = 'UPDATE' AND OLD.status_code = 'under_review' AND NEW.status_code = 'closed' THEN
    event_code := 'task_work_completed';
    event_time := NEW.updated_at;
  ELSIF TG_OP = 'UPDATE' AND OLD.status_code = 'under_review' AND NEW.status_code = 'in_progress' THEN
    event_code := 'task_rework_requested';
    event_time := NEW.updated_at;
  ELSE
    RETURN NEW;
  END IF;

  IF event_code = 'task_rework_requested' THEN
    event_payload := event_payload || jsonb_build_object('reworkComment', NEW.rework_comment);
  END IF;

  PERFORM enqueue_business_event(
    event_code || ':' || NEW.id::text || ':'
      || floor(extract(epoch FROM event_time) * 1000000)::bigint::text,
    'task', NEW.id, event_code, event_payload, event_time
  );
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- 0045_optional_task_closure_outcomes.sql
-- ---------------------------------------------------------------------------

-- TASK3FC9-31 / TASK3FC9-35: итоговые отметки акта фиксируют фактический
-- результат выезда, но false не запрещает координатору принять закрытие.

CREATE OR REPLACE FUNCTION assert_task_closure_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_task tasks%ROWTYPE;
  closure task_closures%ROWTYPE;
  photo_count integer;
  video_count integer;
BEGIN
  IF TG_TABLE_NAME = 'task_closures' THEN
    SELECT * INTO current_task FROM tasks WHERE id = NEW.task_id;
  ELSE
    SELECT * INTO current_task FROM tasks WHERE id = NEW.id;
  END IF;

  IF current_task.id IS NULL OR current_task.status_code NOT IN ('under_review', 'closed') THEN
    RETURN NULL;
  END IF;

  SELECT * INTO closure FROM task_closures WHERE task_id = current_task.id;
  IF closure.task_id IS NULL THEN
    RAISE EXCEPTION 'Для закрытия задачи нужен акт'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO photo_count FROM files WHERE task_id = current_task.id AND kind = 'photo';
  SELECT count(*) INTO video_count FROM files WHERE task_id = current_task.id AND kind = 'video';
  IF photo_count > 10 OR video_count > 2 THEN
    RAISE EXCEPTION 'Превышен лимит фото/видео задачи'
      USING ERRCODE = '23514';
  END IF;

  IF current_task.status_code = 'closed' THEN
    IF closure.verified_by IS NULL OR closure.verified_at IS NULL THEN
      RAISE EXCEPTION 'Закрытую задачу должен проверить координатор'
        USING ERRCODE = '23514';
    END IF;
    IF photo_count < 3 THEN
      RAISE EXCEPTION 'Для закрытия нужны минимум три фото фотофиксации'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- ---------------------------------------------------------------------------
-- 0046_smtp_delivery_lease_and_mailbox_guard.sql
-- ---------------------------------------------------------------------------

-- R-026/R-027: конечная аренда незавершённой SMTP-попытки и защита адреса
-- контакта на границе хранения. Старые некорректные значения не мешают
-- upgrade; SMTP-адаптер всё равно отклоняет их до открытия соединения.

ALTER TABLE site_contacts
  DROP CONSTRAINT IF EXISTS site_contacts_email_mailbox;
ALTER TABLE site_contacts
  ADD CONSTRAINT site_contacts_email_mailbox CHECK (
    email IS NULL OR (
      email = btrim(email)
      AND char_length(email) <= 254
      AND email !~ E'[\r
]'
      AND email ~ '^[^[:space:]<>@]+@[^[:space:]<>@]+[.][^[:space:]<>@]+$'
    )
  ) NOT VALID;

CREATE OR REPLACE FUNCTION stage_event_notifications(
  p_event_id uuid,
  p_commands jsonb,
  p_now timestamptz
)
RETURNS TABLE(
  id uuid,
  outbox_event_id uuid,
  idempotency_key text,
  event_code text,
  recipient_user_id uuid,
  channel notification_channel,
  recipient_address text,
  subject text,
  body text,
  task_id uuid,
  equipment_id uuid,
  reservation_id uuid,
  attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'Время восстановления доставки обязательно'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.notifications notification
     SET status = 'failed',
         last_error = 'notification_delivery_lease_expired',
         scheduled_at = p_now
   WHERE notification.outbox_event_id = p_event_id
     AND notification.status = 'sending'
     AND notification.scheduled_at <= p_now;

  RETURN QUERY
  SELECT staged.id, staged.outbox_event_id, staged.idempotency_key,
         staged.event_code, staged.recipient_user_id, staged.channel,
         staged.recipient_address, staged.subject, staged.body,
         staged.task_id, staged.equipment_id, staged.reservation_id,
         staged.attempts
    FROM public.stage_event_notifications(p_event_id, p_commands) staged
    JOIN public.notifications notification ON notification.id = staged.id
   WHERE notification.scheduled_at <= p_now;
END
$$;

DROP FUNCTION IF EXISTS record_notification_delivery_attempt(uuid);
CREATE FUNCTION record_notification_delivery_attempt(
  p_delivery_id uuid,
  p_now timestamptz,
  p_lease_until timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  claimed boolean := false;
BEGIN
  IF p_now IS NULL OR p_lease_until IS NULL OR p_lease_until <= p_now THEN
    RAISE EXCEPTION 'Срок аренды доставки должен быть позже времени начала'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.notifications
     SET status = 'sending',
         attempts = attempts + 1,
         scheduled_at = p_lease_until,
         last_error = coalesce(last_error, 'notification_delivery_attempt_in_progress')
   WHERE id = p_delivery_id
     AND status IN ('queued', 'failed')
     AND scheduled_at <= p_now;
  GET DIAGNOSTICS claimed = ROW_COUNT;
  RETURN claimed;
END
$$;

-- Если подтверждение SQL потерялось уже после фиксации sent, последующая
-- диагностическая запись не должна вернуть успешную доставку в retry.
CREATE OR REPLACE FUNCTION fail_notification_delivery(
  p_delivery_id uuid,
  p_error_code text,
  p_retry_at timestamptz
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.notifications
     SET status = 'failed',
         last_error = left(p_error_code, 200),
         scheduled_at = p_retry_at
   WHERE id = p_delivery_id
     AND status NOT IN ('sent', 'delivered')
$$;

REVOKE ALL ON FUNCTION stage_event_notifications(uuid, jsonb) FROM medtech_worker;
REVOKE ALL ON FUNCTION stage_event_notifications(uuid, jsonb, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION stage_event_notifications(uuid, jsonb, timestamptz) FROM medtech_api, medtech_backup;
GRANT EXECUTE ON FUNCTION stage_event_notifications(uuid, jsonb, timestamptz) TO medtech_worker;

REVOKE ALL ON FUNCTION record_notification_delivery_attempt(uuid, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_notification_delivery_attempt(uuid, timestamptz, timestamptz) FROM medtech_api, medtech_backup;
GRANT EXECUTE ON FUNCTION record_notification_delivery_attempt(uuid, timestamptz, timestamptz) TO medtech_worker;

-- ---------------------------------------------------------------------------
-- 0047_email_at_most_once_and_coordinator_routing.sql
-- ---------------------------------------------------------------------------

-- TASK3FC9-38/39: обычный SMTP не предоставляет idempotency key. Поэтому
-- после начала неоднозначной попытки выбираем at-most-once: возможная потеря
-- видна в журнале, но повторное письмо автоматически не отправляется.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS retry_allowed boolean NOT NULL DEFAULT true;

UPDATE notifications
   SET retry_allowed = false
 WHERE channel = 'email'
   AND (
     status = 'sending'
     OR last_error IN (
       'smtp_delivery_outcome_unknown',
       'notification_delivery_result_recording_failed',
       'notification_delivery_lease_expired'
     )
   );

CREATE OR REPLACE FUNCTION stage_event_notifications(
  p_event_id uuid,
  p_commands jsonb,
  p_now timestamptz
)
RETURNS TABLE(
  id uuid,
  outbox_event_id uuid,
  idempotency_key text,
  event_code text,
  recipient_user_id uuid,
  channel notification_channel,
  recipient_address text,
  subject text,
  body text,
  task_id uuid,
  equipment_id uuid,
  reservation_id uuid,
  attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'Время восстановления доставки обязательно'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.notifications notification
     SET status = 'failed',
         last_error = 'notification_delivery_lease_expired',
         scheduled_at = p_now,
         retry_allowed = false
   WHERE notification.outbox_event_id = p_event_id
     AND notification.status = 'sending'
     AND notification.scheduled_at <= p_now;

  RETURN QUERY
  SELECT staged.id, staged.outbox_event_id, staged.idempotency_key,
         staged.event_code, staged.recipient_user_id, staged.channel,
         staged.recipient_address, staged.subject, staged.body,
         staged.task_id, staged.equipment_id, staged.reservation_id,
         staged.attempts
    FROM public.stage_event_notifications(p_event_id, p_commands) staged
    JOIN public.notifications notification ON notification.id = staged.id
   WHERE notification.scheduled_at <= p_now
     AND notification.retry_allowed;
END
$$;

CREATE OR REPLACE FUNCTION record_notification_delivery_attempt(
  p_delivery_id uuid,
  p_now timestamptz,
  p_lease_until timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  claimed boolean := false;
BEGIN
  IF p_now IS NULL OR p_lease_until IS NULL OR p_lease_until <= p_now THEN
    RAISE EXCEPTION 'Срок аренды доставки должен быть позже времени начала'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.notifications
     SET status = 'sending',
         attempts = attempts + 1,
         scheduled_at = p_lease_until,
         last_error = coalesce(last_error, 'notification_delivery_attempt_in_progress')
   WHERE id = p_delivery_id
     AND status IN ('queued', 'failed')
     AND scheduled_at <= p_now
     AND retry_allowed;
  GET DIAGNOSTICS claimed = ROW_COUNT;
  RETURN claimed;
END
$$;

CREATE OR REPLACE FUNCTION fail_notification_delivery(
  p_delivery_id uuid,
  p_error_code text,
  p_retry_at timestamptz,
  p_retry_allowed boolean
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.notifications
     SET status = 'failed',
         last_error = left(p_error_code, 200),
         scheduled_at = p_retry_at,
         retry_allowed = p_retry_allowed
   WHERE id = p_delivery_id
     AND status NOT IN ('sent', 'delivered')
$$;

-- Принятие задачи инженером в эталонном пути уведомляет координатора.
-- Выбор по роли также покрывает задачи ТО без initiator_id.
CREATE OR REPLACE FUNCTION load_email_event_plan(p_event_id uuid)
RETURNS TABLE(
  recipient_user_id uuid,
  recipient_address text,
  recipient_name text,
  subject_template text,
  body_template text,
  allowed_variables text[],
  task_id uuid,
  variables jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH event AS (
    SELECT queued.id, queued.event_type, queued.aggregate_id, queued.payload
      FROM public.integration_outbox queued
     WHERE queued.id = p_event_id AND queued.aggregate_type = 'task'
  ), task_context AS (
    SELECT event.event_type, event.payload, task.id, task.number, task.title,
           task.deadline_from, task.deadline_to, task.rework_comment,
           task.engineer_id, task.initiator_id, task.contact_name,
           task.contact_email, task.site_id, engineer.full_name AS engineer_name,
           site.name AS site_name
      FROM event
      JOIN public.tasks task ON task.id = event.aggregate_id
      LEFT JOIN public.users engineer ON engineer.id = task.engineer_id
      LEFT JOIN public.sites site ON site.id = task.site_id
  ), candidates AS (
    -- Инициатор получает подтверждение, назначение, принятие и результат.
    SELECT context.event_type, context.id AS task_id, user_account.id AS user_id,
           user_account.email AS address, user_account.full_name AS display_name,
           context.payload, context.number, context.title, context.deadline_from,
           context.deadline_to, context.rework_comment, context.engineer_name,
           context.site_name
      FROM task_context context
      JOIN public.users user_account ON user_account.id = context.initiator_id
       AND user_account.is_active AND nullif(btrim(user_account.email), '') IS NOT NULL
     WHERE context.event_type IN (
       'task_application_accepted', 'task_engineer_assigned',
       'task_engineer_accepted', 'task_work_completed'
     )
    UNION ALL
    -- Координаторы получают подтверждение принятия, в том числе для задач ТО.
    SELECT context.event_type, context.id, user_account.id, user_account.email,
           user_account.full_name, context.payload, context.number, context.title,
           context.deadline_from, context.deadline_to, context.rework_comment,
           context.engineer_name, context.site_name
      FROM task_context context
      JOIN public.users user_account ON user_account.role = 'coordinator'
       AND user_account.is_active AND nullif(btrim(user_account.email), '') IS NOT NULL
     WHERE context.event_type = 'task_engineer_accepted'
    UNION ALL
    -- Инженер получает назначение и комментарий возврата.
    SELECT context.event_type, context.id, user_account.id, user_account.email,
           user_account.full_name, context.payload, context.number, context.title,
           context.deadline_from, context.deadline_to, context.rework_comment,
           context.engineer_name, context.site_name
      FROM task_context context
      JOIN public.users user_account ON user_account.id = context.engineer_id
       AND user_account.is_active AND nullif(btrim(user_account.email), '') IS NOT NULL
     WHERE context.event_type IN ('task_engineer_assigned', 'task_rework_requested')
    UNION ALL
    -- Контакт площадки получает подтверждение заявки и завершение работ.
    SELECT context.event_type, context.id, NULL::uuid, context.contact_email,
           coalesce(nullif(btrim(context.contact_name), ''), 'коллеги'),
           context.payload, context.number, context.title, context.deadline_from,
           context.deadline_to, context.rework_comment, context.engineer_name,
           context.site_name
      FROM task_context context
     WHERE context.event_type IN ('task_application_accepted', 'task_work_completed')
       AND nullif(btrim(context.contact_email), '') IS NOT NULL
    UNION ALL
    -- Просрочка эскалируется всем активным руководителям.
    SELECT context.event_type, context.id, user_account.id, user_account.email,
           user_account.full_name, context.payload, context.number, context.title,
           context.deadline_from, context.deadline_to, context.rework_comment,
           context.engineer_name, context.site_name
      FROM task_context context
      JOIN public.users user_account ON user_account.role = 'supervisor'
       AND user_account.is_active AND nullif(btrim(user_account.email), '') IS NOT NULL
     WHERE context.event_type = 'task_overdue'
  ), enabled AS (
    SELECT candidate.*
      FROM candidates candidate
      LEFT JOIN public.notification_preferences preference
        ON preference.user_id = candidate.user_id
       AND preference.event_code = candidate.event_type
       AND preference.channel = 'email'
     WHERE candidate.user_id IS NULL OR coalesce(preference.is_enabled, true)
  ), deduplicated AS (
    SELECT DISTINCT ON (lower(btrim(address))) *
      FROM enabled
     ORDER BY lower(btrim(address)), user_id NULLS LAST
  )
  SELECT deduplicated.user_id, btrim(deduplicated.address), deduplicated.display_name,
         template.subject_template, template.body_template, template.allowed_variables,
         deduplicated.task_id,
         jsonb_strip_nulls(jsonb_build_object(
           'recipientName', deduplicated.display_name,
           'taskNumber', deduplicated.number,
           'taskTitle', deduplicated.title,
           'siteName', deduplicated.site_name,
           'engineerName', coalesce(deduplicated.engineer_name, 'не назначен'),
           'periodFrom', deduplicated.deadline_from,
           'periodTo', deduplicated.deadline_to,
           'reworkComment', coalesce(deduplicated.payload ->> 'reworkComment', deduplicated.rework_comment),
           'taskId', deduplicated.task_id
         ))
    FROM deduplicated
    JOIN public.notification_templates template
      ON template.code = deduplicated.event_type AND template.is_active
   ORDER BY lower(btrim(deduplicated.address))
$$;

REVOKE ALL ON FUNCTION fail_notification_delivery(uuid, text, timestamptz) FROM medtech_worker;
REVOKE ALL ON FUNCTION fail_notification_delivery(uuid, text, timestamptz, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION fail_notification_delivery(uuid, text, timestamptz, boolean) FROM medtech_api, medtech_backup;
GRANT EXECUTE ON FUNCTION fail_notification_delivery(uuid, text, timestamptz, boolean) TO medtech_worker;

-- ---------------------------------------------------------------------------
-- 0048_configurable_task_workflow.sql
-- ---------------------------------------------------------------------------

-- Настраиваемые статусы задач: справочник определяет доступные колонки,
-- координатор не ограничен зашитым в БД графом переходов.

CREATE OR REPLACE FUNCTION enforce_task_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Активность и существование значения проверяет отдельный триггер
  -- validate_active_task_status. История перехода и специальные проверки
  -- закрытия/отмены продолжают работать независимо от графа.
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION enforce_task_status_transition() IS
  'Переходы задач свободны между активными значениями настраиваемого справочника; специализированные команды проверяются приложением.';

-- ---------------------------------------------------------------------------
-- 0049_configurable_access_roles.sql
-- ---------------------------------------------------------------------------

-- Настраиваемые роли доступа. Базовый профиль сохраняет доменный scope,
-- а конкретная матрица permissions применяется API к каждой сессии.

CREATE TABLE IF NOT EXISTS access_roles (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_-]{1,63}$'),
  name text NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 120),
  base_role user_role NOT NULL,
  is_builtin boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS access_role_permissions (
  role_key text NOT NULL REFERENCES access_roles(key) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_key, permission_code)
);

INSERT INTO access_roles (key, name, base_role, is_builtin)
VALUES
  ('admin', 'Главный администратор', 'admin', true),
  ('coordinator', 'Координатор', 'coordinator', true),
  ('engineer', 'Инженер', 'engineer', true),
  ('warehouse', 'Кладовщик', 'warehouse', true),
  ('initiator', 'Инициатор', 'initiator', true),
  ('customer', 'Заказчик', 'customer', true),
  ('supervisor', 'Руководитель', 'supervisor', true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO access_role_permissions (role_key, permission_code)
SELECT CASE WHEN source.role::text = 'manager' THEN 'initiator' ELSE source.role::text END, source.permission_code
FROM role_permissions source
WHERE source.role::text IN ('admin', 'coordinator', 'engineer', 'warehouse', 'initiator', 'manager', 'customer', 'supervisor')
ON CONFLICT DO NOTHING;

ALTER TABLE users ADD COLUMN IF NOT EXISTS access_role_key text REFERENCES access_roles(key) ON DELETE RESTRICT;

UPDATE users
SET access_role_key = CASE WHEN role::text = 'manager' THEN 'initiator' ELSE role::text END
WHERE access_role_key IS NULL;

CREATE INDEX IF NOT EXISTS users_access_role_active_idx ON users (access_role_key, is_active);

-- ---------------------------------------------------------------------------
-- 0050_supabase_auth_link.sql
-- ---------------------------------------------------------------------------

-- Связь профилей МедТехСервиса с self-hosted GoTrue.
-- Миграция безопасна, пока схема auth ещё не создана или профили уже совпадают по id.

DO $$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.users AS profile
      LEFT JOIN auth.users AS auth_user ON auth_user.id = profile.id
     WHERE auth_user.id IS NULL
  ) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'users_auth_user_fk'
       AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_auth_user_fk
      FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE RESTRICT;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 0051_row_level_security.sql
-- ---------------------------------------------------------------------------

-- RLS: браузер ходит в PostgREST только как authenticated/anon.
-- Политики требуют активный профиль public.users с тем же id, что auth.uid().

CREATE OR REPLACE FUNCTION public.is_app_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.users
     WHERE id = auth.uid()
       AND is_active
  );
$$;

REVOKE ALL ON FUNCTION public.is_app_user() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_app_user() TO authenticated;

DO $$
DECLARE
  table_name text;
BEGIN
  FOR table_name IN
    SELECT tablename
      FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename <> 'schema_migrations'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS app_user_all ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY app_user_all ON public.%I FOR ALL TO authenticated USING (public.is_app_user()) WITH CHECK (public.is_app_user())',
      table_name
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', table_name);
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT EXECUTE ON FUNCTION public.change_equipment_site TO authenticated;
GRANT EXECUTE ON FUNCTION public.change_equipment_payer TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_task_closure TO authenticated;

DO $$
DECLARE
  view_name text;
BEGIN
  FOR view_name IN
    SELECT viewname
      FROM pg_views
     WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER VIEW public.%I SET (security_invoker = true)', view_name);
  END LOOP;
END
$$;

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    INSERT INTO storage.buckets (id, name, public)
    VALUES ('medtech-files', 'medtech-files', false)
    ON CONFLICT (id) DO NOTHING;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'Пропуск storage.buckets: %', SQLERRM;
  END;

  -- Владелец storage.objects — supabase_storage_admin, не postgres.
  BEGIN
    EXECUTE 'ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS medtech_files_all ON storage.objects';
    EXECUTE $policy$
      CREATE POLICY medtech_files_all ON storage.objects
        FOR ALL TO authenticated
        USING (bucket_id = 'medtech-files' AND public.is_app_user())
        WITH CHECK (bucket_id = 'medtech-files' AND public.is_app_user())
    $policy$;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'Пропуск RLS storage.objects: %', SQLERRM;
  END;
END
$$;

-- ---------------------------------------------------------------------------
-- 0052_create_access_user.sql
-- ---------------------------------------------------------------------------

-- Администратор создаёт сотрудника без публичной регистрации GoTrue
-- (enable_signup = false). Функция пишет auth.users и профиль public.users.

CREATE OR REPLACE FUNCTION public.create_access_user(
  p_email text,
  p_password text,
  p_full_name text,
  p_access_role_key text,
  p_organization_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, auth
AS $$
DECLARE
  actor_id uuid := auth.uid();
  new_user_id uuid := gen_random_uuid();
  normalized_email text;
  normalized_name text;
  role_base public.user_role;
  role_active boolean;
  instance_uuid uuid := '00000000-0000-0000-0000-000000000000';
  identity_payload jsonb;
  hashed_password text;
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'Нужна сессия'
      USING ERRCODE = '28000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.users AS actor
      JOIN public.access_role_permissions AS perm
        ON perm.role_key = coalesce(actor.access_role_key, actor.role::text)
     WHERE actor.id = actor_id
       AND actor.is_active
       AND perm.permission_code = 'users.write'
  ) THEN
    RAISE EXCEPTION 'Недостаточно прав для этого действия.'
      USING ERRCODE = '42501';
  END IF;

  normalized_email := lower(btrim(coalesce(p_email, '')));
  normalized_name := btrim(coalesce(p_full_name, ''));

  IF normalized_name = '' OR char_length(normalized_name) > 200 THEN
    RAISE EXCEPTION 'Укажите ФИО сотрудника.'
      USING ERRCODE = '23514';
  END IF;

  IF normalized_email = ''
     OR char_length(normalized_email) > 254
     OR normalized_email !~ '^[^[:space:]<>@]+@[^[:space:]<>@]+[.][^[:space:]<>@]+$' THEN
    RAISE EXCEPTION 'Укажите корректный e-mail.'
      USING ERRCODE = '23514';
  END IF;

  IF p_password IS NULL OR char_length(p_password) < 8 THEN
    RAISE EXCEPTION 'Пароль должен быть не короче 8 символов.'
      USING ERRCODE = '23514';
  END IF;

  IF char_length(p_password) > 72 THEN
    RAISE EXCEPTION 'Пароль слишком длинный.'
      USING ERRCODE = '23514';
  END IF;

  SELECT access_roles.base_role, access_roles.is_active
    INTO role_base, role_active
    FROM public.access_roles
   WHERE access_roles.key = btrim(coalesce(p_access_role_key, ''));

  IF role_base IS NULL THEN
    RAISE EXCEPTION 'Роль не найдена.'
      USING ERRCODE = 'P0002';
  END IF;

  IF role_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Нельзя назначить неактивную роль.'
      USING ERRCODE = '23514';
  END IF;

  IF role_base = 'customer' AND coalesce(cardinality(p_organization_ids), 0) = 0 THEN
    RAISE EXCEPTION 'Для роли заказчика укажите хотя бы одну организацию.'
      USING ERRCODE = '23514';
  END IF;

  IF coalesce(cardinality(p_organization_ids), 0) > 0
     AND EXISTS (
       SELECT 1
         FROM unnest(p_organization_ids) AS org_id
        WHERE NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = org_id)
     ) THEN
    RAISE EXCEPTION 'Организация не найдена.'
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.users WHERE lower(btrim(email)) = normalized_email
     )
     OR (
       to_regclass('auth.users') IS NOT NULL
       AND EXISTS (SELECT 1 FROM auth.users WHERE lower(email) = normalized_email)
     ) THEN
    RAISE EXCEPTION 'Пользователь с таким e-mail уже есть.'
      USING ERRCODE = '23505';
  END IF;

  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'Схема Auth недоступна. Нельзя создать учётную запись.'
      USING ERRCODE = '42501';
  END IF;

  hashed_password := crypt(p_password, gen_salt('bf', 10));

  IF to_regclass('auth.instances') IS NOT NULL THEN
    SELECT id INTO instance_uuid FROM auth.instances LIMIT 1;
    instance_uuid := coalesce(instance_uuid, '00000000-0000-0000-0000-000000000000');
  END IF;

  BEGIN
    INSERT INTO auth.users (
      instance_id,
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at,
      confirmation_token,
      email_change,
      email_change_token_new,
      recovery_token
    ) VALUES (
      instance_uuid,
      new_user_id,
      'authenticated',
      'authenticated',
      normalized_email,
      hashed_password,
      clock_timestamp(),
      jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
      jsonb_build_object('full_name', normalized_name, 'email_verified', true),
      clock_timestamp(),
      clock_timestamp(),
      '',
      '',
      '',
      ''
    );

    identity_payload := jsonb_build_object(
      'sub', new_user_id::text,
      'email', normalized_email,
      'email_verified', true,
      'phone_verified', false
    );

    IF to_regclass('auth.identities') IS NOT NULL THEN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'auth' AND table_name = 'identities' AND column_name = 'provider_id'
      ) THEN
        INSERT INTO auth.identities (
          user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
        ) VALUES (
          new_user_id, identity_payload, 'email', new_user_id::text,
          clock_timestamp(), clock_timestamp(), clock_timestamp()
        );
      ELSE
        INSERT INTO auth.identities (
          id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
        ) VALUES (
          new_user_id::text, new_user_id, identity_payload, 'email',
          clock_timestamp(), clock_timestamp(), clock_timestamp()
        );
      END IF;
    END IF;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'Сервер Auth не позволяет создать пользователя из базы.'
        USING ERRCODE = '42501';
    WHEN unique_violation THEN
      RAISE EXCEPTION 'Пользователь с таким e-mail уже есть.'
        USING ERRCODE = '23505';
  END;

  INSERT INTO public.users (
    id, full_name, role, email, is_active, access_role_key, organization_id
  ) VALUES (
    new_user_id,
    normalized_name,
    role_base,
    normalized_email,
    true,
    btrim(p_access_role_key),
    CASE WHEN role_base = 'customer' THEN p_organization_ids[1] ELSE NULL END
  );

  IF role_base = 'customer' THEN
    INSERT INTO public.customer_organization_access (customer_user_id, organization_id)
    SELECT new_user_id, org_id
      FROM unnest(p_organization_ids) AS org_id
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'id', new_user_id,
    'full_name', normalized_name,
    'role', role_base,
    'email', normalized_email,
    'is_active', true,
    'access_role_key', btrim(p_access_role_key)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_access_user(text, text, text, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_access_user(text, text, text, text, uuid[]) TO authenticated;

COMMENT ON FUNCTION public.create_access_user(text, text, text, text, uuid[]) IS
  'Создаёт учётную запись GoTrue и профиль сотрудника. Доступно только с правом users.write.';

NOTIFY pgrst, 'reload schema';
