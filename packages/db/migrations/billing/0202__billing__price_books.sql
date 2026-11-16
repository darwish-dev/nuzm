-- M02 S06: price books, versions and items (docs/12 §4, M02 §4 task 9). Platform reference data: every runtime role can
-- read it (the price list is not secret and the rater needs it); writes only from the admin console scope.
--  * A published version is immutable (triggers, owner included); items of a published version are frozen.
--  * Published versions of one book may not overlap in time (checked by billing code under a book row lock).
--  * The seeded book is DRAFT-NOT-APPROVED (HG-02-01): `placeholder = true`; the application refuses to rate with a
--    placeholder book in a production profile.
CREATE TABLE billing.price_books (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  placeholder boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, currency)
);
CREATE TABLE billing.price_book_versions (
  id uuid PRIMARY KEY,
  price_book_id uuid NOT NULL REFERENCES billing.price_books(id),
  version int NOT NULL CHECK (version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  note text,
  created_by uuid,
  published_by uuid,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (price_book_id, version),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (status = 'draft' OR (published_by IS NOT NULL AND published_at IS NOT NULL))
);
CREATE INDEX price_book_versions_effective_idx ON billing.price_book_versions (price_book_id, effective_from) WHERE status = 'published';
CREATE TABLE billing.price_items (
  id uuid PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES billing.price_book_versions(id),
  meter_id text NOT NULL,                        -- metering.meters.id (no cross-schema FK; validated by the service)
  tier_model text NOT NULL CHECK (tier_model IN ('flat','graduated','volume')),
  unit_price_minor numeric(24,8) CHECK (unit_price_minor IS NULL OR unit_price_minor >= 0),  -- flat: minor units per unit
  tiers jsonb,                                   -- graduated/volume: [{"upTo":"100"|null,"unitPriceMinor":"0.5"}] ascending
  included_allowance numeric(24,8) NOT NULL DEFAULT 0 CHECK (included_allowance >= 0),
  rounding text NOT NULL DEFAULT 'half_up' CHECK (rounding IN ('half_up','up','down')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, meter_id),
  CHECK ((tier_model = 'flat' AND unit_price_minor IS NOT NULL AND tiers IS NULL)
      OR (tier_model <> 'flat' AND tiers IS NOT NULL AND unit_price_minor IS NULL AND jsonb_typeof(tiers) = 'array' AND jsonb_array_length(tiers) >= 1))
);
CREATE INDEX price_items_meter_idx ON billing.price_items (meter_id);

CREATE FUNCTION billing.price_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION 'published price book versions are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER price_versions_immutable BEFORE UPDATE OR DELETE ON billing.price_book_versions
  FOR EACH ROW EXECUTE FUNCTION billing.price_version_immutable();
CREATE FUNCTION billing.price_item_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text; vid uuid := coalesce(NEW.version_id, OLD.version_id);
BEGIN
  SELECT status INTO st FROM billing.price_book_versions WHERE id = vid;
  IF st = 'published' THEN
    RAISE EXCEPTION 'items of a published price book version are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER price_items_frozen BEFORE INSERT OR UPDATE OR DELETE ON billing.price_items
  FOR EACH ROW EXECUTE FUNCTION billing.price_item_frozen();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['price_books','price_book_versions','price_items'] LOOP
    EXECUTE format('ALTER TABLE billing.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE billing.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY read_all ON billing.%I FOR SELECT USING (true)', t);
    EXECUTE format($p$CREATE POLICY platform_write ON billing.%I FOR ALL
      USING (coalesce(current_setting('app.platform_scope', true) = 'admin', false))
      WITH CHECK (coalesce(current_setting('app.platform_scope', true) = 'admin', false))$p$, t);
  END LOOP;
END $$;
GRANT SELECT ON billing.price_books, billing.price_book_versions, billing.price_items TO nuzm_app, nuzm_worker, nuzm_admin_breakglass;
GRANT INSERT, UPDATE, DELETE ON billing.price_books, billing.price_book_versions, billing.price_items TO nuzm_app; -- gated by platform_write RLS

-- Permission for the second-person publish step (four-eyes): platform_admin only.
INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('admin:billing:publish','platform','Publish a price book version created by someone else (four-eyes)');
INSERT INTO tenancy.role_permissions VALUES ('platform_admin','admin:billing:publish');
-- Meter catalogue writes (docs/04: platform_admin and finance).
INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('admin:meters:manage','platform','Extend the meter catalogue');
INSERT INTO tenancy.role_permissions VALUES ('platform_admin','admin:meters:manage'),('finance','admin:meters:manage');

-- Seed: DRAFT-NOT-APPROVED placeholder book (HG-02-01). Values are examples that exercise each tier model; not a price list.
WITH b AS (
  INSERT INTO billing.price_books (id, name, currency, placeholder) VALUES (gen_random_uuid(), 'default', 'SAR', true) RETURNING id
), v AS (
  INSERT INTO billing.price_book_versions (id, price_book_id, version, status, effective_from, published_by, published_at, note)
    SELECT gen_random_uuid(), b.id, 1, 'draft', '2026-01-01T00:00:00Z', NULL, NULL, 'DRAFT-NOT-APPROVED placeholder (HG-02-01)' FROM b RETURNING id
)
INSERT INTO billing.price_items (id, version_id, meter_id, tier_model, unit_price_minor, tiers, included_allowance, rounding)
  SELECT gen_random_uuid(), v.id, i.meter, i.model, i.price, i.tiers::jsonb, i.allowance, i.rounding FROM v, (VALUES
    ('compute.vcpu_hours',           'flat',      5.00000000::numeric, NULL,                                                                            0::numeric,    'half_up'),
    ('compute.memory_gb_hours',      'flat',      1.00000000::numeric, NULL,                                                                            0::numeric,    'half_up'),
    ('network.egress_gb',            'graduated', NULL::numeric,       '[{"upTo":"100","unitPriceMinor":"0"},{"upTo":"1000","unitPriceMinor":"2"},{"upTo":null,"unitPriceMinor":"1.5"}]', 0::numeric, 'half_up'),
    ('storage.object_gb_months',     'volume',    NULL::numeric,       '[{"upTo":"1000","unitPriceMinor":"20"},{"upTo":null,"unitPriceMinor":"15"}]',        0::numeric,    'half_up'),
    ('email.transactional_messages', 'flat',      0.10000000::numeric, NULL,                                                                            1000::numeric, 'up'),
    ('ai.credits_consumed',          'flat',      1.00000000::numeric, NULL,                                                                            0::numeric,    'half_up')
  ) AS i(meter, model, price, tiers, allowance, rounding);
UPDATE billing.price_book_versions SET status = 'published', published_by = '00000000-0000-0000-0000-000000000000', published_at = now();
