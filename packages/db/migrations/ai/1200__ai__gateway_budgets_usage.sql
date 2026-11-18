-- M09 S37: AI model gateway. Provider registry (tenant-less, admin scope), budgets (org/project), credit balance projection, per-call reservations and the
-- append-only usage ledger of model calls.
--  * ai.model_providers is the ONLY place a model provider is turned on. A row can be enabled only when its data terms are HUMAN-ATTESTED (attested=true + an
--    attestation reference) and, outside the dev-reference providers `mock-*`/`local-*`, a second person approved (CHECKs below; the service checks first).
--    Nothing is seeded: no provider exists, so every AI call answers 422 unsupported_capability until the owner decides D-18 and HG-09-01.
--  * credits: 1 credit = `credit_unit_minor` minor units of the org's wallet (ledger account 2100, M02). ai.credit_balances is a PROJECTION of billing.wallet_balances
--    minus open reservations; the wallet is the source of truth and the projection can be rebuilt.
--  * reservations: a pre-flight hold of the worst case of one call (prompt + max_tokens at the rate card). Settled (actual cost) or released after the call. A crashed
--    call leaves a 'held' row that the sweeper releases after `expires_at`.
--  * model_usage is APPEND-ONLY: one row per call id (a duplicate call id changes nothing).
CREATE SCHEMA IF NOT EXISTS ai;
GRANT USAGE ON SCHEMA ai TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('ai:read','org','Read AI models, credits, budgets, sessions and runs'),
  ('ai:write','org','Create AI sessions and runs, answer run approvals'),
  ('ai:budgets:write','org','Change AI budgets and caps'),
  ('admin:ai:read','platform','Read model providers and AI run metadata (never prompt or output content)'),
  ('admin:ai:manage','platform','Configure model providers, rate cards and the global AI kill switch'),
  ('admin:ai:approve','platform','Approve enabling a model provider (second person) and record a data-terms attestation');
INSERT INTO tenancy.role_permissions VALUES
  ('owner','ai:read'),('admin','ai:read'),('billing_admin','ai:read'),('developer','ai:read'),('viewer','ai:read'),
  ('owner','ai:write'),('admin','ai:write'),('developer','ai:write'),
  ('owner','ai:budgets:write'),('admin','ai:budgets:write'),('billing_admin','ai:budgets:write'),
  ('platform_admin','admin:ai:read'),('support','admin:ai:read'),('security','admin:ai:read'),('compliance_officer','admin:ai:read'),
  ('platform_admin','admin:ai:manage'),
  ('platform_admin','admin:ai:approve'),('security','admin:ai:approve');

CREATE TABLE ai.model_providers (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9-]{1,40}$'),
  adapter text NOT NULL CHECK (adapter ~ '^[a-z][a-z0-9-]{1,40}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  region text NOT NULL CHECK (length(region) BETWEEN 2 AND 64),
  data_terms jsonb NOT NULL DEFAULT '{"attested":false,"retainsPrompts":"unknown","trainsOnData":"unknown"}'::jsonb,
  attestation_ref text CHECK (attestation_ref IS NULL OR length(attestation_ref) BETWEEN 3 AND 200),
  attested_by uuid,
  attested_at timestamptz,
  vault_ref text CHECK (vault_ref IS NULL OR vault_ref ~ '^vault://[A-Za-z0-9][A-Za-z0-9._/-]{1,200}$'),
  egress_allow jsonb NOT NULL DEFAULT '[]'::jsonb,
  rate_card_version text NOT NULL DEFAULT '0' CHECK (length(rate_card_version) BETWEEN 1 AND 40),
  rate_card jsonb NOT NULL DEFAULT '{"models":{}}'::jsonb,
  enabled boolean NOT NULL DEFAULT false,
  enable_requested_by uuid,
  enabled_by uuid,
  enabled_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  CHECK (NOT enabled OR enabled_at IS NOT NULL),
  CHECK (NOT enabled OR code ~ '^(mock|local)-' OR ((data_terms->>'attested')::boolean IS TRUE AND attestation_ref IS NOT NULL)),
  CHECK (NOT enabled OR code ~ '^(mock|local)-' OR (enabled_by IS NOT NULL AND enable_requested_by IS NOT NULL AND enabled_by <> enable_requested_by))
);
CREATE INDEX model_providers_enabled_idx ON ai.model_providers (code) WHERE enabled;
ALTER TABLE ai.model_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.model_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON ai.model_providers USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
CREATE POLICY worker_read ON ai.model_providers FOR SELECT USING (coalesce(current_setting('app.worker_scope', true), '') = 'claim');
CREATE POLICY runtime_read_enabled ON ai.model_providers FOR SELECT USING (enabled);
GRANT SELECT, INSERT, UPDATE ON ai.model_providers TO nuzm_app, nuzm_worker;
GRANT SELECT ON ai.model_providers TO nuzm_readonly_reporting;

CREATE TABLE ai.budgets (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('org','project')),
  project_id uuid,
  daily_credits bigint CHECK (daily_credits IS NULL OR daily_credits >= 0),
  run_max_credits bigint CHECK (run_max_credits IS NULL OR run_max_credits >= 0),
  run_max_tokens bigint CHECK (run_max_tokens IS NULL OR run_max_tokens >= 0),
  total_credits bigint CHECK (total_credits IS NULL OR total_credits >= 0),
  total_tokens bigint CHECK (total_tokens IS NULL OR total_tokens >= 0),
  alert_thresholds int[] NOT NULL DEFAULT '{50,80,100}',
  log_bodies boolean NOT NULL DEFAULT false,
  body_retention_days int CHECK (body_retention_days IS NULL OR body_retention_days BETWEEN 1 AND 365),
  auto_apply_low_risk boolean NOT NULL DEFAULT false,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  CHECK ((scope = 'org') = (project_id IS NULL)),
  CHECK (NOT log_bodies OR body_retention_days IS NOT NULL)
);
CREATE UNIQUE INDEX budgets_org_idx ON ai.budgets (org_id) WHERE scope = 'org';
CREATE UNIQUE INDEX budgets_project_idx ON ai.budgets (org_id, project_id) WHERE scope = 'project';

CREATE TABLE ai.credit_balances (
  org_id uuid NOT NULL,
  currency char(3) NOT NULL,
  wallet_minor bigint NOT NULL DEFAULT 0,
  credit_unit_minor int NOT NULL DEFAULT 1 CHECK (credit_unit_minor >= 1),
  reserved_credits bigint NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0),
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, currency)
);

CREATE TABLE ai.reservations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  run_id uuid,
  project_id uuid,
  call_id text NOT NULL CHECK (length(call_id) BETWEEN 1 AND 120),
  credits bigint NOT NULL CHECK (credits >= 0),
  tokens bigint NOT NULL CHECK (tokens >= 0),
  state text NOT NULL DEFAULT 'held' CHECK (state IN ('held','settled','released')),
  settled_credits bigint CHECK (settled_credits IS NULL OR settled_credits >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  CHECK ((state = 'held') = (closed_at IS NULL)),
  UNIQUE (org_id, call_id)
);
CREATE INDEX reservations_held_idx ON ai.reservations (expires_at) WHERE state = 'held';
CREATE INDEX reservations_run_idx ON ai.reservations (org_id, run_id);

CREATE TABLE ai.model_usage (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  run_id uuid,
  project_id uuid,
  call_id text NOT NULL CHECK (length(call_id) BETWEEN 1 AND 120),
  provider_code text NOT NULL,
  model_ref text NOT NULL,
  task text,
  run_kind text,
  tokens_in bigint NOT NULL CHECK (tokens_in >= 0),
  tokens_out bigint NOT NULL CHECK (tokens_out >= 0),
  estimated boolean NOT NULL DEFAULT false,
  cost_minor bigint NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
  cost_currency char(3),
  credits bigint NOT NULL CHECK (credits >= 0),
  outcome text NOT NULL CHECK (outcome IN ('ok','error','blocked')),
  error_code text CHECK (error_code IS NULL OR length(error_code) <= 60),
  latency_ms int CHECK (latency_ms IS NULL OR latency_ms >= 0),
  data_region text NOT NULL,
  residency_evidence text,
  body_enc text,
  body_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, call_id)
);
CREATE INDEX model_usage_org_idx ON ai.model_usage (org_id, created_at DESC);
CREATE INDEX model_usage_run_idx ON ai.model_usage (org_id, run_id);
CREATE FUNCTION ai.deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation', HINT = 'immutable'; END $$;
CREATE TRIGGER model_usage_immutable BEFORE UPDATE OR DELETE ON ai.model_usage FOR EACH ROW EXECUTE FUNCTION ai.deny_mutation();
CREATE TRIGGER model_usage_no_truncate BEFORE TRUNCATE ON ai.model_usage FOR EACH STATEMENT EXECUTE FUNCTION ai.deny_mutation();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['budgets','credit_balances','reservations','model_usage'] LOOP
    EXECUTE format('ALTER TABLE ai.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE ai.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON ai.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY platform_read ON ai.%I FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT ON ai.%I TO nuzm_readonly_reporting', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON ai.budgets, ai.credit_balances, ai.reservations TO nuzm_app, nuzm_worker;
GRANT SELECT, INSERT ON ai.model_usage TO nuzm_app, nuzm_worker;
