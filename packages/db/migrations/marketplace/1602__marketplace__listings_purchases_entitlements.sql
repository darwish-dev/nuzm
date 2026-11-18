-- M11 S53: marketplace. Publisher accounts (verification is a HUMAN/ops step), listings and immutable versions, moderation cases, purchases (through M03 invoicing),
-- entitlements (exposed to the billing entitlement resolver through the view marketplace.v_entitlements), installations (COPIES owned by the buyer) and the publisher
-- revenue ACCRUAL log. There is NO payout table and no payout path anywhere (D-26 / HG-11-01 open): publisher revenue is accounted (ledger 2600), never paid.
--  * org_id is the BUYER on purchases/entitlements/installations ("buyer_org_id" in the prompt) and the PUBLISHER on publisher_accounts/listings/listing_versions/moderation_cases/publisher_accruals.
--  * A version is purchasable/installable only when moderation_status = 'approved'. listing_versions are immutable except the moderation status, which only the admin console can change.
--  * installations is guarded by a trigger: no installation row exists without an ACTIVE entitlement of the same organization for the same listing (defence in depth under the service check).
CREATE SCHEMA IF NOT EXISTS marketplace;
GRANT USAGE ON SCHEMA marketplace TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('marketplace:read','org','Browse marketplace listings'),
  ('marketplace:buy','org','Purchase marketplace listings'),
  ('marketplace:install','org','Install purchased marketplace listings'),
  ('marketplace:publish','org','Publish listings and versions (publisher role; the organization must also be a verified publisher)'),
  ('admin:marketplace','platform','Moderate marketplace listings and verify publishers');
INSERT INTO tenancy.role_permissions VALUES
  ('owner','marketplace:read'),('admin','marketplace:read'),('billing_admin','marketplace:read'),('developer','marketplace:read'),('viewer','marketplace:read'),
  ('owner','marketplace:buy'),('admin','marketplace:buy'),('billing_admin','marketplace:buy'),
  ('owner','marketplace:install'),('admin','marketplace:install'),('developer','marketplace:install'),
  ('owner','marketplace:publish'),('admin','marketplace:publish'),
  ('platform_admin','admin:marketplace'),('support','admin:marketplace');

CREATE TABLE marketplace.publisher_accounts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL UNIQUE,
  display_name_ar text,
  display_name_en text,
  status text NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified','verified','suspended')),
  verified_by uuid,
  verified_at timestamptz,
  version_lock int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'verified') = (verified_at IS NOT NULL AND verified_by IS NOT NULL) OR status = 'suspended')
);
CREATE FUNCTION marketplace.touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity of a marketplace row is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  NEW.version_lock := OLD.version_lock + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER publisher_touch BEFORE UPDATE ON marketplace.publisher_accounts FOR EACH ROW EXECUTE FUNCTION marketplace.touch();

CREATE TABLE marketplace.listings (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,                                  -- the publisher organization
  publisher_id uuid NOT NULL REFERENCES marketplace.publisher_accounts(id),
  type text NOT NULL CHECK (type IN ('website-template','app-template','workflow-template')),
  title_ar text NOT NULL CHECK (length(title_ar) BETWEEN 1 AND 160),
  title_en text NOT NULL CHECK (length(title_en) BETWEEN 1 AND 160),
  description_ar text CHECK (description_ar IS NULL OR length(description_ar) <= 4000),
  description_en text CHECK (description_en IS NULL OR length(description_en) <= 4000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','suspended','archived')),
  licence text NOT NULL CHECK (licence IN ('single_org','multi_seat')),
  seats int NOT NULL DEFAULT 1 CHECK (seats BETWEEN 1 AND 1000),
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  data_region text NOT NULL,
  version_lock int NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX listings_pub_idx ON marketplace.listings (org_id, created_at DESC, id);
CREATE INDEX listings_browse_idx ON marketplace.listings (type, created_at DESC) WHERE status = 'published';
CREATE TRIGGER listing_touch BEFORE UPDATE ON marketplace.listings FOR EACH ROW EXECUTE FUNCTION marketplace.touch();

CREATE TABLE marketplace.listing_versions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  listing_id uuid NOT NULL REFERENCES marketplace.listings(id),
  version text NOT NULL CHECK (version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'),
  artifact_ref text NOT NULL CHECK (length(artifact_ref) BETWEEN 1 AND 500),
  sbom_ref text CHECK (sbom_ref IS NULL OR length(sbom_ref) <= 500),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  changelog text CHECK (changelog IS NULL OR length(changelog) <= 4000),
  moderation_status text NOT NULL DEFAULT 'pending' CHECK (moderation_status IN ('pending','approved','rejected','suspended')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, version)
);
CREATE INDEX listing_versions_listing_idx ON marketplace.listing_versions (listing_id, created_at DESC);
CREATE FUNCTION marketplace.version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'listing versions are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.listing_id <> OLD.listing_id OR NEW.version <> OLD.version OR NEW.artifact_ref <> OLD.artifact_ref
     OR NEW.sbom_ref IS DISTINCT FROM OLD.sbom_ref OR NEW.content_hash <> OLD.content_hash OR NEW.changelog IS DISTINCT FROM OLD.changelog OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a listing version is immutable; publish a new version' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER version_guard BEFORE UPDATE OR DELETE ON marketplace.listing_versions FOR EACH ROW EXECUTE FUNCTION marketplace.version_guard();

CREATE TABLE marketplace.moderation_cases (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,                                  -- the publisher organization
  listing_id uuid NOT NULL REFERENCES marketplace.listings(id),
  listing_version_id uuid NOT NULL REFERENCES marketplace.listing_versions(id),
  scan_results jsonb NOT NULL DEFAULT '{}'::jsonb,       -- automated scans: malware, secrets, dependencies, PII, licence
  scan_verdict text NOT NULL DEFAULT 'pending' CHECK (scan_verdict IN ('pending','clean','flagged')),
  decision text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','approve','reject','suspend')),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  notes text CHECK (notes IS NULL OR length(notes) <= 4000),
  decided_by uuid,
  decided_at timestamptz,
  version_lock int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_version_id)
);
CREATE INDEX moderation_cases_queue_idx ON marketplace.moderation_cases (created_at) WHERE decision = 'pending';

CREATE TABLE marketplace.purchases (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,                                  -- the BUYER organization
  listing_id uuid NOT NULL REFERENCES marketplace.listings(id),
  listing_version_id uuid NOT NULL REFERENCES marketplace.listing_versions(id),
  publisher_id uuid NOT NULL,                            -- the publisher account and its organization, frozen at purchase time (the accrual needs them even if the listing is later withdrawn)
  publisher_org_id uuid NOT NULL,
  quote_id uuid NOT NULL,                                -- logical reference to commerce.quotes
  order_id uuid,
  invoice_id uuid,                                       -- logical reference to invoicing.invoices
  status text NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment','paid','failed','refunded')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  publisher_share_minor bigint NOT NULL CHECK (publisher_share_minor >= 0),
  paid_at timestamptz,
  refunded_at timestamptz,
  created_by uuid,
  version_lock int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, quote_id),
  CHECK (publisher_share_minor <= amount_minor)
);
CREATE INDEX purchases_org_idx ON marketplace.purchases (org_id, created_at DESC, id);
CREATE INDEX purchases_invoice_idx ON marketplace.purchases (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE FUNCTION marketplace.purchase_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.listing_id <> OLD.listing_id OR NEW.listing_version_id <> OLD.listing_version_id OR NEW.quote_id <> OLD.quote_id OR NEW.publisher_id <> OLD.publisher_id OR NEW.publisher_org_id <> OLD.publisher_org_id
     OR NEW.amount_minor <> OLD.amount_minor OR NEW.currency <> OLD.currency OR NEW.publisher_share_minor <> OLD.publisher_share_minor OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the commercial terms of a purchase are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  NEW.version_lock := OLD.version_lock + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_guard BEFORE UPDATE ON marketplace.purchases FOR EACH ROW EXECUTE FUNCTION marketplace.purchase_guard();

CREATE TABLE marketplace.entitlements_mkt (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,                                  -- the BUYER organization
  listing_id uuid NOT NULL REFERENCES marketplace.listings(id),
  purchase_id uuid NOT NULL UNIQUE REFERENCES marketplace.purchases(id),
  version_range text NOT NULL DEFAULT '*' CHECK (length(version_range) <= 100),
  licence text NOT NULL CHECK (licence IN ('single_org','multi_seat')),
  seats int NOT NULL DEFAULT 1 CHECK (seats >= 1),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','revoked')),
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 200),
  version_lock int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
-- 409 already entitled: one live (pending or active) entitlement per (buyer, listing)
CREATE UNIQUE INDEX entitlements_live_idx ON marketplace.entitlements_mkt (org_id, listing_id) WHERE status IN ('pending','active');
CREATE TRIGGER entitlement_touch BEFORE UPDATE ON marketplace.entitlements_mkt FOR EACH ROW EXECUTE FUNCTION marketplace.touch();

CREATE TABLE marketplace.installations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,                                  -- the BUYER organization (the copy is owned by it)
  entitlement_id uuid NOT NULL REFERENCES marketplace.entitlements_mkt(id),
  listing_id uuid NOT NULL REFERENCES marketplace.listings(id),
  listing_version_id uuid NOT NULL REFERENCES marketplace.listing_versions(id),
  target_type text NOT NULL CHECK (target_type IN ('workflow','project')),
  target_id uuid,                                        -- the new workflow / builder project (a COPY with a new id)
  workspace_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  error jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX installations_once_idx ON marketplace.installations (entitlement_id, coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status <> 'failed';
CREATE INDEX installations_org_idx ON marketplace.installations (org_id, created_at DESC, id);
CREATE FUNCTION marketplace.installation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM marketplace.entitlements_mkt e
                    WHERE e.id = NEW.entitlement_id AND e.org_id = NEW.org_id AND e.listing_id = NEW.listing_id AND e.status = 'active') THEN
      RAISE EXCEPTION 'no active entitlement for this installation' USING ERRCODE = 'check_violation', HINT = 'not_entitled';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.entitlement_id <> OLD.entitlement_id OR NEW.listing_version_id <> OLD.listing_version_id THEN
    RAISE EXCEPTION 'the identity of an installation is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER installation_guard BEFORE INSERT OR UPDATE ON marketplace.installations FOR EACH ROW EXECUTE FUNCTION marketplace.installation_guard();

CREATE TABLE marketplace.publisher_accruals (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,                                  -- the PUBLISHER organization (it never sees the buyer)
  publisher_id uuid NOT NULL REFERENCES marketplace.publisher_accounts(id),
  listing_id uuid NOT NULL REFERENCES marketplace.listings(id),
  purchase_id uuid NOT NULL,                             -- logical reference (the buyer's purchase row is not readable by the publisher)
  invoice_id uuid,
  kind text NOT NULL CHECK (kind IN ('accrual','reversal')),
  gross_minor bigint NOT NULL CHECK (gross_minor >= 0),
  share_minor bigint NOT NULL CHECK (share_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  ledger_transaction_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purchase_id, kind)
);
CREATE INDEX publisher_accruals_idx ON marketplace.publisher_accruals (org_id, created_at DESC, id);
CREATE TRIGGER publisher_accruals_append_only BEFORE UPDATE OR DELETE ON marketplace.publisher_accruals FOR EACH ROW EXECUTE FUNCTION automation.immutable_row();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['publisher_accounts','listings','listing_versions','moderation_cases','purchases','entitlements_mkt','installations','publisher_accruals'] LOOP
    EXECUTE format('ALTER TABLE marketplace.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE marketplace.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON marketplace.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY platform_read ON marketplace.%I FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT, INSERT ON marketplace.%I TO nuzm_app, nuzm_worker', t);
    EXECUTE format('GRANT SELECT ON marketplace.%I TO nuzm_readonly_reporting', t);
  END LOOP;
END $$;
-- browsing: every organization reads PUBLISHED listings and APPROVED versions of other publishers (read only)
CREATE POLICY public_read ON marketplace.listings FOR SELECT USING (status = 'published');
CREATE POLICY public_read ON marketplace.listing_versions FOR SELECT USING (moderation_status = 'approved');
-- the admin console decides moderation and verifies publishers; nothing else
CREATE POLICY platform_moderate ON marketplace.listings FOR UPDATE USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin') WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
CREATE POLICY platform_moderate ON marketplace.listing_versions FOR UPDATE USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin') WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
CREATE POLICY platform_moderate ON marketplace.moderation_cases FOR UPDATE USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin') WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
CREATE POLICY platform_verify ON marketplace.publisher_accounts FOR UPDATE USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin') WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT UPDATE (display_name_ar, display_name_en, status, verified_by, verified_at) ON marketplace.publisher_accounts TO nuzm_app, nuzm_worker;
GRANT UPDATE (title_ar, title_en, description_ar, description_en, status, licence, seats, price_minor) ON marketplace.listings TO nuzm_app, nuzm_worker;
GRANT UPDATE (moderation_status) ON marketplace.listing_versions TO nuzm_app, nuzm_worker;
GRANT UPDATE (scan_results, scan_verdict, decision, reason_code, notes, decided_by, decided_at, version_lock) ON marketplace.moderation_cases TO nuzm_app, nuzm_worker;
GRANT UPDATE (order_id, invoice_id, status, paid_at, refunded_at) ON marketplace.purchases TO nuzm_app, nuzm_worker;
GRANT UPDATE (status, revoked_at, revoke_reason, version_range) ON marketplace.entitlements_mkt TO nuzm_app, nuzm_worker;
GRANT UPDATE (target_id, status, error) ON marketplace.installations TO nuzm_app, nuzm_worker;

-- The published read-only view the billing entitlement resolver consumes (docs/05 §4). security_invoker: the caller's row-level security applies.
CREATE VIEW marketplace.v_entitlements WITH (security_invoker = true) AS
  SELECT e.org_id, e.id AS entitlement_id, e.listing_id, e.purchase_id, e.version_range, e.licence, e.seats, e.status, e.revoked_at, e.created_at,
         l.type AS listing_type, l.title_ar AS listing_title_ar, l.title_en AS listing_title_en
    FROM marketplace.entitlements_mkt e LEFT JOIN marketplace.listings l ON l.id = e.listing_id;
GRANT SELECT ON marketplace.v_entitlements TO nuzm_app, nuzm_worker, nuzm_readonly_reporting;
