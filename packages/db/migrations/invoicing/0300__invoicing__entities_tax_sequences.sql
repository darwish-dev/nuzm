-- M03 S08a: invoicing foundations (docs/11 §4, §6). Billing entities (seller legal entities), tax profiles (buyers), effective-dated
-- tax rates (config, not code) and gapless per-entity invoice sequences.
--  * billing_entities and tax_rates are platform CONFIGURATION: managed by seed/config migrations only (docs/04 defines no admin
--    endpoint, M03 §6), so the runtime roles get SELECT and no write grants at all.
--  * Everything flagged `verify` is a [VERIFY] item for the tax advisor (HG-03-04); the placeholder entity is NOT registered
--    (HG-03-01): issuing in a non-sandbox mode is refused by the services until real data is loaded.
--  * invoice_sequences is written ONLY by invoicing.allocate_number() (SECURITY DEFINER): a number is taken inside the issuing
--    transaction, so a rollback gives it back (gapless by construction, no sequence objects).
CREATE SCHEMA IF NOT EXISTS invoicing;
GRANT USAGE ON SCHEMA invoicing TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

CREATE TABLE invoicing.billing_entities (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_-]{1,30}$'),
  legal_name_ar text NOT NULL,
  legal_name_en text NOT NULL,
  vat_number text,
  cr_number text,
  address jsonb NOT NULL DEFAULT '{}'::jsonb,
  invoice_series text NOT NULL CHECK (invoice_series ~ '^[A-Z]{2,6}$'),
  placeholder boolean NOT NULL DEFAULT true,     -- PLACEHOLDER-NOT-REGISTERED until HG-03-01 data is loaded
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT placeholder OR (vat_number IS NULL AND cr_number IS NULL))  -- a placeholder never carries registration numbers
);
INSERT INTO invoicing.billing_entities (id, code, legal_name_ar, legal_name_en, invoice_series, placeholder)
  VALUES (gen_random_uuid(), 'nuzm', 'نظم (بيانات تجريبية غير مسجلة)', 'Nuzm (PLACEHOLDER-NOT-REGISTERED)', 'NZM', true);

CREATE TABLE invoicing.tax_rates (
  id uuid PRIMARY KEY,
  code text NOT NULL,
  rate_bps int NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  scope text NOT NULL CHECK (scope IN ('domestic','export','exempt','zero')),
  jurisdiction text NOT NULL DEFAULT 'SA' CHECK (jurisdiction ~ '^[A-Z]{2}$'),
  valid_from date NOT NULL,
  valid_to date,
  verify boolean NOT NULL DEFAULT true,          -- [VERIFY] with the tax advisor (HG-03-04)
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  UNIQUE (code, valid_from)
);
-- Effective-dated: one rate per (jurisdiction, scope) at any date (the exclusion constraint is the arbiter).
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE invoicing.tax_rates ADD CONSTRAINT tax_rates_no_overlap
  EXCLUDE USING gist (jurisdiction WITH =, scope WITH =, daterange(valid_from, valid_to, '[)') WITH &&);
INSERT INTO invoicing.tax_rates (id, code, rate_bps, scope, valid_from, note) VALUES
  (gen_random_uuid(), 'SA-VAT-STD',    1500, 'domestic', '2020-07-01', 'Saudi standard VAT, understood to be 15 % [VERIFY]'),
  (gen_random_uuid(), 'SA-VAT-ZERO',      0, 'zero',     '2020-07-01', 'Zero-rated supplies: configuration decision for the tax advisor [VERIFY]'),
  (gen_random_uuid(), 'SA-VAT-EXEMPT',    0, 'exempt',   '2020-07-01', 'Exempt supplies: configuration decision for the tax advisor [VERIFY]'),
  (gen_random_uuid(), 'SA-VAT-EXPORT',    0, 'export',   '2020-07-01', 'Exports of services: configuration decision for the tax advisor [VERIFY]');

-- Buyer tax profile: one per organization (the invoicing party details). Classified financial + personal (company contact).
CREATE TABLE invoicing.tax_profiles (
  org_id uuid PRIMARY KEY,
  buyer_type text NOT NULL CHECK (buyer_type IN ('b2b','b2c')),
  legal_name_ar text NOT NULL CHECK (length(legal_name_ar) BETWEEN 1 AND 200),
  legal_name_en text NOT NULL CHECK (length(legal_name_en) BETWEEN 1 AND 200),
  vat_number text CHECK (vat_number IS NULL OR length(vat_number) BETWEEN 5 AND 30),
  cr_number text CHECK (cr_number IS NULL OR length(cr_number) BETWEEN 5 AND 30),
  address jsonb NOT NULL DEFAULT '{}'::jsonb,
  version int NOT NULL DEFAULT 1,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (buyer_type <> 'b2b' OR vat_number IS NOT NULL)   -- a VAT-registered buyer needs its number (format rules live in the service config)
);
ALTER TABLE invoicing.tax_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoicing.tax_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON invoicing.tax_profiles
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON invoicing.tax_profiles FOR SELECT
  USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT, UPDATE ON invoicing.tax_profiles TO nuzm_app;
GRANT SELECT ON invoicing.tax_profiles TO nuzm_worker, nuzm_readonly_reporting;

-- Platform configuration tables: readable by every runtime role (rates and the seller identity appear on every invoice),
-- writable by nobody at runtime (seed/config migrations only).
DO $$ DECLARE t text; own text := current_user; BEGIN
  FOREACH t IN ARRAY ARRAY['billing_entities','tax_rates'] LOOP
    EXECUTE format('ALTER TABLE invoicing.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE invoicing.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY read_all ON invoicing.%I FOR SELECT USING (true)', t);
    EXECUTE format('GRANT SELECT ON invoicing.%I TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass', t);
  END LOOP;
END $$;

-- Gapless invoice numbers per (entity, series). Written only by allocate_number().
CREATE TABLE invoicing.invoice_sequences (
  entity_id uuid NOT NULL REFERENCES invoicing.billing_entities(id),
  series text NOT NULL CHECK (series ~ '^[A-Z]{2,6}$'),
  next_value bigint NOT NULL CHECK (next_value >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, series)
);
ALTER TABLE invoicing.invoice_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoicing.invoice_sequences FORCE ROW LEVEL SECURITY;
DO $$ DECLARE own text := current_user; BEGIN
  EXECUTE format('CREATE POLICY definer_all ON invoicing.invoice_sequences TO %I USING (true) WITH CHECK (true)', own);
END $$;
GRANT SELECT ON invoicing.invoice_sequences TO nuzm_readonly_reporting; -- reporting policy below
CREATE POLICY reporting_read ON invoicing.invoice_sequences FOR SELECT TO nuzm_readonly_reporting USING (true);

-- Take the next number inside the CALLER'S transaction. Concurrent callers queue on the row lock until the first commits or
-- rolls back, so numbers are unique, ascending and (because a rollback undoes the increment) without gaps.
CREATE FUNCTION invoicing.allocate_number(p_entity uuid, p_series text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM invoicing.billing_entities WHERE id = p_entity AND status = 'active') THEN
    RAISE EXCEPTION 'invoicing.allocate_number: unknown or retired billing entity' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO invoicing.invoice_sequences (entity_id, series, next_value) VALUES (p_entity, p_series, 2)
  ON CONFLICT (entity_id, series) DO UPDATE SET next_value = invoicing.invoice_sequences.next_value + 1, updated_at = now()
  RETURNING next_value - 1 INTO n;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION invoicing.allocate_number(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invoicing.allocate_number(uuid, text) TO nuzm_app, nuzm_worker;
