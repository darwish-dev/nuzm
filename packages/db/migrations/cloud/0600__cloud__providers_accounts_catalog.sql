-- M05 S16: provider registry, provider accounts (vault references ONLY), verified regions, plans, capability matrix, evidence, catalog snapshots,
-- and platform-level provider jobs (docs/09 §8, FR-CLD-01..03).
--  * Tenant-less admin tables: RLS FORCED, one policy = platform (admin console) scope. Customers never read these tables directly; the offers
--    service reads them under the platform scope on their behalf after its own eligibility function (docs/09 §8).
--  * No secret columns anywhere: provider_accounts.vault_ref must look like vault://… (CHECK). Credentials are resolved by adapters via the VaultClient.
--  * A region is `verified` ONLY with verified_at AND evidence_ref (CHECK). A capability absent from provider_capabilities is `unknown` = unsupported.
--  * SI-M05-6: provider verification / catalog syncs are PLATFORM jobs, not tenant operations (platform.operations is org-scoped, org_id NOT NULL),
--    so they live in cloud.provider_jobs with the same state vocabulary as platform.operations.
CREATE SCHEMA IF NOT EXISTS cloud;
GRANT USAGE ON SCHEMA cloud TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('admin:provider:read','platform','Read providers, provider accounts, capability matrices, regions, plans and routing rules'),
  ('admin:provider:manage','platform','Register providers and accounts (vault references), run verification and catalog syncs, manage routing rules and reconciliations');
-- SI-M05-3: the M05 prompt names a `provider_admin` role that docs 01-09 do not define; no role is invented, platform_admin holds the permissions.
INSERT INTO tenancy.role_permissions VALUES
  ('platform_admin','admin:provider:read'),('platform_admin','admin:provider:manage'),
  ('security','admin:provider:read'),('support','admin:provider:read'),('finance','admin:provider:read');

CREATE TABLE cloud.providers (
  id uuid PRIMARY KEY,
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9-]{1,30}$'),
  kind text NOT NULL CHECK (kind IN ('compute','hosting','registrar','database','cache','object-storage','transactional-email','mailbox','psp','einvoice','model')),
  adapter_id text NOT NULL CHECK (adapter_id ~ '^[a-z][a-z0-9-]{1,40}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  -- `non_production_only`: a fixture/simulator provider that must never be offered or resolved in a production profile.
  environment_policy text NOT NULL DEFAULT 'any' CHECK (environment_policy IN ('any','non_production_only')),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO cloud.providers (id, key, kind, adapter_id, environment_policy) VALUES
  (gen_random_uuid(), 'mock', 'compute', 'mock-compute', 'non_production_only'),
  (gen_random_uuid(), 'alibaba', 'compute', 'alibaba-ecs', 'any'),
  (gen_random_uuid(), 'huawei', 'compute', 'huawei-ecs', 'any'),
  (gen_random_uuid(), 'contabo', 'compute', 'contabo-vps', 'any'),
  (gen_random_uuid(), 'cloudpanel', 'hosting', 'cloudpanel-node', 'any');

CREATE TABLE cloud.provider_accounts (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES cloud.providers(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  vault_ref text NOT NULL CHECK (vault_ref LIKE 'vault://%' AND length(vault_ref) BETWEEN 10 AND 220),
  scope_note text CHECK (scope_note IS NULL OR length(scope_note) <= 500),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  health_state text NOT NULL DEFAULT 'unknown' CHECK (health_state IN ('healthy','degraded','unhealthy','unknown')),
  last_health_at timestamptz,
  breaker_state jsonb NOT NULL DEFAULT '{"state":"closed","consecutiveFailures":0,"openedAt":null,"retryAt":null}'::jsonb,
  spend_cap_minor bigint CHECK (spend_cap_minor IS NULL OR spend_cap_minor >= 0),
  spend_cap_currency char(3) CHECK (spend_cap_currency IS NULL OR spend_cap_currency ~ '^[A-Z]{3}$'),
  verified_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  UNIQUE (provider_id, name),
  CHECK ((spend_cap_minor IS NULL) = (spend_cap_currency IS NULL))
);

-- Append-only evidence store: redacted raw evidence of probes and catalog listings. `evidence:<id>` is the evidence_ref used elsewhere.
CREATE TABLE cloud.evidence_items (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES cloud.provider_accounts(id),
  kind text NOT NULL CHECK (kind IN ('live','fixture','mock')),
  operation text NOT NULL,
  captured_at timestamptz NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  redacted jsonb NOT NULL,
  job_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_items_account_idx ON cloud.evidence_items (account_id, captured_at DESC);
CREATE FUNCTION cloud.deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are append-only (% on %.%)', TG_TABLE_NAME, TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
  USING ERRCODE = 'insufficient_privilege', HINT = 'immutable'; END $$;
CREATE TRIGGER evidence_items_immutable BEFORE UPDATE OR DELETE ON cloud.evidence_items FOR EACH ROW EXECUTE FUNCTION cloud.deny_mutation();
CREATE TRIGGER evidence_items_no_truncate BEFORE TRUNCATE ON cloud.evidence_items FOR EACH STATEMENT EXECUTE FUNCTION cloud.deny_mutation();

CREATE TABLE cloud.provider_regions (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES cloud.provider_accounts(id),
  provider_region_id text NOT NULL CHECK (length(provider_region_id) BETWEEN 1 AND 100),
  country_code char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  display_name text,
  state text NOT NULL DEFAULT 'listed' CHECK (state IN ('listed','verified','withdrawn')),
  verified_at timestamptz,
  evidence_ref text,
  evidence_kind text CHECK (evidence_kind IS NULL OR evidence_kind IN ('live','fixture','mock')),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_region_id),
  -- AC-M05-21: a verified region always carries its verification time AND evidence (a country name alone proves nothing).
  CHECK (state <> 'verified' OR (verified_at IS NOT NULL AND evidence_ref IS NOT NULL AND evidence_kind IS NOT NULL))
);

CREATE TABLE cloud.provider_plans (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES cloud.provider_accounts(id),
  region_id uuid NOT NULL REFERENCES cloud.provider_regions(id),
  plan_ref text NOT NULL CHECK (length(plan_ref) BETWEEN 1 AND 100),
  vcpu int NOT NULL CHECK (vcpu > 0),
  memory_mb int NOT NULL CHECK (memory_mb > 0),
  disk_gb int NOT NULL CHECK (disk_gb > 0),
  bandwidth text,
  -- provider COST in integer minor units; all three price columns are set together or not at all (no price = never offered)
  provider_price_minor bigint CHECK (provider_price_minor IS NULL OR provider_price_minor >= 0),
  currency char(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  period text CHECK (period IS NULL OR period IN ('hour','month')),
  availability text NOT NULL DEFAULT 'unavailable' CHECK (availability IN ('available','sold_out','unavailable')),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, region_id, plan_ref),
  CHECK ((provider_price_minor IS NULL) = (currency IS NULL) AND (currency IS NULL) = (period IS NULL))
);
CREATE INDEX provider_plans_region_idx ON cloud.provider_plans (region_id, availability);

CREATE TABLE cloud.provider_capabilities (
  account_id uuid NOT NULL REFERENCES cloud.provider_accounts(id),
  capability_id text NOT NULL CHECK (capability_id IN ('compute.provision','compute.inspect','compute.delete','compute.action.start','compute.action.stop',
    'compute.action.reboot','compute.action.resize','compute.action.snapshot','compute.metrics','compute.billing-export','compute.find-by-token','compute.quote-api')),
  state text NOT NULL CHECK (state IN ('supported','unsupported','unknown')),
  probed_at timestamptz NOT NULL,
  evidence_ref text,
  PRIMARY KEY (account_id, capability_id),
  -- a capability may be `supported` only with probe evidence (docs/09: capabilities only from probes)
  CHECK (state <> 'supported' OR evidence_ref IS NOT NULL)
);

CREATE TABLE cloud.catalog_snapshots (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES cloud.provider_accounts(id),
  taken_at timestamptz NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  payload_ref text NOT NULL,
  region_count int NOT NULL CHECK (region_count >= 0),
  plan_count int NOT NULL CHECK (plan_count >= 0),
  job_id uuid
);
CREATE INDEX catalog_snapshots_account_idx ON cloud.catalog_snapshots (account_id, taken_at DESC);
CREATE TRIGGER catalog_snapshots_immutable BEFORE UPDATE OR DELETE ON cloud.catalog_snapshots FOR EACH ROW EXECUTE FUNCTION cloud.deny_mutation();
CREATE TRIGGER catalog_snapshots_no_truncate BEFORE TRUNCATE ON cloud.catalog_snapshots FOR EACH STATEMENT EXECUTE FUNCTION cloud.deny_mutation();

-- Platform-level provider jobs (verification, catalog sync): same state vocabulary as platform.operations (SI-M05-6).
CREATE TABLE cloud.provider_jobs (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES cloud.provider_accounts(id),
  kind text NOT NULL CHECK (kind IN ('verification','catalog_sync')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','waiting_provider','succeeded','failed','cancelled','needs_reconcile')),
  result jsonb,
  error jsonb,
  attempts int NOT NULL DEFAULT 0,
  idempotency_key text,
  trace_id text,
  requested_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, kind, idempotency_key)
);
CREATE INDEX provider_jobs_account_idx ON cloud.provider_jobs (account_id, created_at DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['providers','provider_accounts','evidence_items','provider_regions','provider_plans','provider_capabilities','catalog_snapshots','provider_jobs'] LOOP
    EXECUTE format('ALTER TABLE cloud.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE cloud.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY platform_admin ON cloud.%I USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
                      WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT ON cloud.%I TO nuzm_readonly_reporting', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON cloud.providers, cloud.provider_accounts, cloud.provider_regions, cloud.provider_plans, cloud.provider_capabilities, cloud.provider_jobs TO nuzm_app;
GRANT SELECT, INSERT ON cloud.evidence_items, cloud.catalog_snapshots TO nuzm_app;
