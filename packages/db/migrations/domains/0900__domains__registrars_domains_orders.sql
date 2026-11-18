-- M07 S28: registrar registry, domains, domain orders, eligibility evaluations (docs/05 §3 `domains`; M07 §7).
--  * registrars / registrar_accounts are PLATFORM configuration: readable by every runtime role (search and quoting resolve the account), written only in
--    the admin-console scope. `vault_ref` is a vault:// REFERENCE (the credential itself never exists here). `capabilities`/`tld_support` hold the last PROBE result
--    (unknown = unsupported); `evidence_kind` says whether that result came from a mock, recorded fixtures or a live account (only `live` can ever be LIVE-VERIFIED, HG-07-01).
--  * domains.name is unique per registrar account (a taken name is `409 domain_unavailable` without leaking the owner); orders carry (org_id, idempotency_token) unique.
--  * eligibility_checks is append-only: the evaluation that justified (or blocked) a quote/order is evidence.
--  * No cross-schema FKs: provider_account_id (cloud.provider_accounts), quote_id/commerce_order_id (commerce), operation_id (platform), ledger_transaction_id (billing)
--    are logical references checked by the services.
CREATE SCHEMA IF NOT EXISTS domains;
GRANT USAGE ON SCHEMA domains TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('domain:search','org','Search domain availability and prices'),
  ('domain:read','org','Read domains, orders, transfers and eligibility'),
  ('domain:write','org','Register and transfer domains, edit contacts, nameservers, lock and auto-renew'),
  ('domain:renew','org','Renew domains and manage auto-renew payment'),
  ('dns:read','org','Read DNS zones and records'),
  ('dns:write','org','Create DNS zones and change records'),
  ('admin:domains:read','platform','Read registrar accounts, domain orders and domain reconciliation across organizations'),
  ('admin:domains:manage','platform','Manage registrars, verify accounts, force domain reconciliations');
INSERT INTO tenancy.role_permissions VALUES
  ('owner','domain:search'),('admin','domain:search'),('developer','domain:search'),('billing_admin','domain:search'),
  ('owner','domain:read'),('admin','domain:read'),('developer','domain:read'),('billing_admin','domain:read'),('viewer','domain:read'),
  ('owner','domain:write'),('admin','domain:write'),('developer','domain:write'),
  ('owner','domain:renew'),('admin','domain:renew'),('billing_admin','domain:renew'),
  ('owner','dns:read'),('admin','dns:read'),('developer','dns:read'),('billing_admin','dns:read'),('viewer','dns:read'),
  ('owner','dns:write'),('admin','dns:write'),('developer','dns:write'),
  ('platform_admin','admin:domains:read'),('support','admin:domains:read'),('finance','admin:domains:read'),
  ('platform_admin','admin:domains:manage');

CREATE TABLE domains.registrars (
  id uuid PRIMARY KEY,
  provider_code text NOT NULL UNIQUE CHECK (provider_code ~ '^[a-z][a-z0-9_-]{1,40}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  contract_version text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,            -- no registrar sells anything until an owner enables it AND an account is probed
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO domains.registrars (id, provider_code, title, contract_version, enabled) VALUES
  (gen_random_uuid(), 'openprovider', 'Openprovider', '1.0.0', false),
  (gen_random_uuid(), 'resellerclub', 'ResellerClub', '1.0.0', false);

CREATE TABLE domains.registrar_accounts (
  id uuid PRIMARY KEY,
  registrar_id uuid NOT NULL REFERENCES domains.registrars(id),
  provider_account_id uuid,                          -- logical ref to cloud.provider_accounts (M05); by id only
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  vault_ref text NOT NULL CHECK (vault_ref ~ '^vault://[A-Za-z0-9][A-Za-z0-9._/-]{1,200}$'),
  webhook_secret_ref text CHECK (webhook_secret_ref IS NULL OR webhook_secret_ref ~ '^vault://[A-Za-z0-9][A-Za-z0-9._/-]{1,200}$'),
  data_region text NOT NULL CHECK (length(data_region) BETWEEN 2 AND 40),   -- where the registrar processes registrant data: ISO country / region id
  provider_region_id text,
  currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  priority int NOT NULL DEFAULT 100,
  enabled boolean NOT NULL DEFAULT false,
  health text NOT NULL DEFAULT 'unknown' CHECK (health IN ('healthy','degraded','unhealthy','unknown')),
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,   -- last probe: {capability id: supported|unsupported|unknown}
  tld_support jsonb NOT NULL DEFAULT '[]'::jsonb,    -- last probe: TldSupport[]
  evidence_kind text CHECK (evidence_kind IN ('mock','fixture','live')),
  probed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX registrar_accounts_registrar_idx ON domains.registrar_accounts (registrar_id, enabled, priority);

CREATE TABLE domains.domains (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  name text NOT NULL CHECK (name = lower(name) AND length(name) BETWEEN 3 AND 253 AND name ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),  -- punycode, lower-case
  tld text NOT NULL CHECK (tld ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','active','expired','redemption','transferring','failed','renewal_at_risk')),
  registrar_account_id uuid NOT NULL REFERENCES domains.registrar_accounts(id),
  provider_ref text,
  registered_at timestamptz,
  expires_at timestamptz,
  auto_renew boolean NOT NULL DEFAULT false,
  locked boolean NOT NULL DEFAULT true,
  privacy_state text NOT NULL DEFAULT 'unknown' CHECK (privacy_state IN ('on','off','unsupported','unknown')),
  nameservers jsonb NOT NULL DEFAULT '[]'::jsonb,
  data_region text NOT NULL,
  provider_region_id text,
  last_provider_state text,
  last_synced_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state NOT IN ('active','renewal_at_risk') OR provider_ref IS NOT NULL)
);
-- a registered name belongs to exactly one organization at one registrar account; a failed attempt frees it
CREATE UNIQUE INDEX domains_account_name_uniq ON domains.domains (registrar_account_id, name) WHERE state <> 'failed';
CREATE UNIQUE INDEX domains_org_name_uniq ON domains.domains (org_id, name) WHERE state <> 'failed';
CREATE INDEX domains_org_idx ON domains.domains (org_id, created_at DESC, id);
CREATE INDEX domains_expiry_idx ON domains.domains (expires_at) WHERE state IN ('active','renewal_at_risk');
CREATE INDEX domains_provider_ref_idx ON domains.domains (registrar_account_id, provider_ref) WHERE provider_ref IS NOT NULL;

CREATE TABLE domains.domain_orders (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('register','renewal','transfer_in')),
  domain_id uuid REFERENCES domains.domains(id),
  name text NOT NULL,
  registrar_account_id uuid NOT NULL REFERENCES domains.registrar_accounts(id),
  quote_id uuid NOT NULL,                            -- logical ref to commerce.quotes
  commerce_order_id uuid,                            -- logical ref to commerce.orders
  operation_id uuid,                                 -- logical ref to platform.operations
  idempotency_token text NOT NULL CHECK (length(idempotency_token) BETWEEN 16 AND 128),
  state text NOT NULL DEFAULT 'created' CHECK (state IN ('created','authorized','provider_pending','needs_reconcile','succeeded','failed','cancelled')),
  years int NOT NULL CHECK (years BETWEEN 1 AND 10),
  price_minor bigint NOT NULL CHECK (price_minor >= 0),    -- what the customer is charged (quote total, tax included)
  tax_minor bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provider_cost_minor bigint CHECK (provider_cost_minor IS NULL OR provider_cost_minor >= 0),
  provider_cost_currency char(3),
  provider_order_ref text,
  authorization_state text NOT NULL DEFAULT 'none' CHECK (authorization_state IN ('none','held','released','captured')),
  ledger_authorize_tx uuid,
  ledger_record_tx uuid,
  ledger_release_tx uuid,
  residency jsonb NOT NULL DEFAULT '{}'::jsonb,      -- the ResidencyService decision stored with the order (M07 §9)
  consent_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  failure_code text,
  attempts int NOT NULL DEFAULT 0,
  version int NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (org_id, idempotency_token),
  CHECK ((state IN ('succeeded','failed','cancelled')) = (completed_at IS NOT NULL))
);
CREATE INDEX domain_orders_org_idx ON domains.domain_orders (org_id, created_at DESC, id);
CREATE INDEX domain_orders_state_idx ON domains.domain_orders (state, updated_at) WHERE state IN ('provider_pending','needs_reconcile');
CREATE UNIQUE INDEX domain_orders_quote_uniq ON domains.domain_orders (org_id, quote_id);   -- a quote becomes at most one order

CREATE TABLE domains.eligibility_checks (
  id uuid PRIMARY KEY,
  org_id uuid,
  quote_id uuid,
  domain_id uuid,
  name text,
  tld text NOT NULL,
  action text NOT NULL DEFAULT 'register' CHECK (action IN ('register','renew','transfer_in')),
  rule_set_version text NOT NULL,
  result text NOT NULL CHECK (result IN ('allowed','blocked','needs_info')),
  rule text NOT NULL,
  reason text NOT NULL,
  error_code text CHECK (error_code IN ('unsupported_capability','eligibility_blocked')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX eligibility_checks_domain_idx ON domains.eligibility_checks (domain_id, created_at DESC) WHERE domain_id IS NOT NULL;
CREATE INDEX eligibility_checks_org_idx ON domains.eligibility_checks (org_id, created_at DESC);

CREATE FUNCTION domains.deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'domains.% rows are append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation', HINT = 'immutable';
END $$;
CREATE TRIGGER eligibility_checks_immutable BEFORE UPDATE OR DELETE ON domains.eligibility_checks FOR EACH ROW EXECUTE FUNCTION domains.deny_mutation();
CREATE TRIGGER eligibility_checks_no_truncate BEFORE TRUNCATE ON domains.eligibility_checks FOR EACH STATEMENT EXECUTE FUNCTION domains.deny_mutation();

-- Order terms are frozen once created; only the lifecycle columns move. A finished order is final.
CREATE FUNCTION domains.order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'domain orders are never deleted' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.type <> OLD.type OR NEW.name <> OLD.name OR NEW.quote_id <> OLD.quote_id OR NEW.idempotency_token <> OLD.idempotency_token
     OR NEW.years <> OLD.years OR NEW.price_minor <> OLD.price_minor OR NEW.currency <> OLD.currency OR NEW.registrar_account_id <> OLD.registrar_account_id THEN
    RAISE EXCEPTION 'order terms are immutable (only the lifecycle moves)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state IN ('succeeded','failed','cancelled') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'a finished order is final' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.authorization_state IN ('released','captured') AND NEW.authorization_state <> OLD.authorization_state THEN
    RAISE EXCEPTION 'an authorization that was released or captured is final' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER domain_orders_guard BEFORE UPDATE OR DELETE ON domains.domain_orders FOR EACH ROW EXECUTE FUNCTION domains.order_guard();

-- RLS ---------------------------------------------------------------------------------------------------------------------
-- tenant-less configuration: everybody reads, only the admin console writes
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['registrars','registrar_accounts'] LOOP
    EXECUTE format('ALTER TABLE domains.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE domains.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY read_all ON domains.%I FOR SELECT USING (true)', t);
    EXECUTE format($p$CREATE POLICY platform_write ON domains.%I FOR ALL USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
                      WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON domains.%I TO nuzm_app', t);
    EXECUTE format('GRANT SELECT ON domains.%I TO nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass', t);
  END LOOP;
END $$;
-- tenant tables
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['domains','domain_orders','eligibility_checks'] LOOP
    EXECUTE format('ALTER TABLE domains.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE domains.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON domains.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
                      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY platform_read ON domains.%I FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT, INSERT ON domains.%I TO nuzm_app', t);
    EXECUTE format('GRANT SELECT ON domains.%I TO nuzm_worker, nuzm_readonly_reporting', t);
  END LOOP;
END $$;
GRANT UPDATE ON domains.domains, domains.domain_orders TO nuzm_app;
-- The webhook handler learns the organization from the provider's own reference (the callback carries no organization):
-- a narrow SECURITY DEFINER lookup, like payments.resolve_intent. It returns identifiers only.
DO $$ DECLARE own text := current_user; BEGIN
  EXECUTE format('CREATE POLICY definer_all ON domains.domains TO %I USING (true) WITH CHECK (true)', own);
  EXECUTE format('CREATE POLICY definer_all ON domains.domain_orders TO %I USING (true) WITH CHECK (true)', own);
END $$;
CREATE FUNCTION domains.resolve_domain(p_name text) RETURNS TABLE (id uuid, org_id uuid, registrar_account_id uuid, state text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.id, d.org_id, d.registrar_account_id, d.state FROM domains.domains d WHERE d.name = lower(p_name) AND d.state <> 'failed'
$$;
REVOKE ALL ON FUNCTION domains.resolve_domain(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domains.resolve_domain(text) TO nuzm_app, nuzm_worker;
