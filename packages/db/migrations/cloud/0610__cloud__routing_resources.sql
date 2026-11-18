-- M05 S17: routing rules (versioned), generic resource inventory with the canonical lifecycle (docs/05 §9), reconciliation history, and the
-- reconcile job kind. `cloud.resources` is tenant data (org_id + RLS); the reconciler reads across organizations only under the audited
-- platform scope and writes each resource under that resource's own org context.
--  * Resource states are CHECKed to the canonical nine and a trigger enforces the transition table (the domain function is the same table, a test
--    compares them). Leaving UNKNOWN needs app.resource_actor = 'reconciler' (set by the reconciler's transaction): only the reconciler resolves uncertainty.
--  * UNIQUE (provider_account_id, provider_ref): the same provider resource can never be adopted twice.
--  * SI-M05-1: docs/05 lists platform.resources_index AND cloud.resources; M05 implements cloud.resources only (platform.resources_index is not created).
CREATE TABLE cloud.routing_rules (
  id uuid PRIMARY KEY,
  rule_key text NOT NULL CHECK (rule_key ~ '^[a-z][a-z0-9_-]{1,60}$'),
  version int NOT NULL CHECK (version >= 1),
  priority int NOT NULL CHECK (priority BETWEEN 0 AND 100000),
  match jsonb NOT NULL DEFAULT '{}'::jsonb,
  action jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  note text CHECK (note IS NULL OR length(note) <= 500),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_key, version),
  CHECK (jsonb_typeof(match) = 'object' AND jsonb_typeof(action) = 'object' AND action ? 'type' AND action->>'type' IN ('prefer','exclude','pin'))
);
CREATE TRIGGER routing_rules_immutable BEFORE UPDATE OR DELETE ON cloud.routing_rules FOR EACH ROW EXECUTE FUNCTION cloud.deny_mutation();
CREATE TRIGGER routing_rules_no_truncate BEFORE TRUNCATE ON cloud.routing_rules FOR EACH STATEMENT EXECUTE FUNCTION cloud.deny_mutation();

CREATE TABLE cloud.resources (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('compute_instance')),
  provider_account_id uuid NOT NULL REFERENCES cloud.provider_accounts(id),
  provider_ref text CHECK (provider_ref IS NULL OR length(provider_ref) BETWEEN 1 AND 200),
  state text NOT NULL CHECK (state IN ('DRAFT','QUOTED','AWAITING_PAYMENT','PROVISIONING','ACTIVE','FAILED','DELETING','DELETED','UNKNOWN')),
  data_region text NOT NULL,                       -- residency region group of the verified region (M04), e.g. in_kingdom | eu | other
  country char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  provider_region_id text NOT NULL,
  created_by_operation_id uuid,                    -- logical reference to platform.operations (no cross-schema FK)
  provision_token text CHECK (provision_token IS NULL OR provision_token ~ '^[0-9a-f]{64}$'),   -- sha256(orgId|operationId|stepId): an idempotency key, not a secret
  last_seen_at timestamptz,
  drift_state text NOT NULL DEFAULT 'in_sync' CHECK (drift_state IN ('in_sync','drift','orphan_suspected','missing')),
  observed jsonb,
  case_opened_at timestamptz,
  case_detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  UNIQUE (provider_account_id, provider_ref)
);
CREATE INDEX resources_org_idx ON cloud.resources (org_id, created_at DESC, id);
CREATE INDEX resources_open_idx ON cloud.resources (state, drift_state) WHERE state IN ('PROVISIONING','UNKNOWN','ACTIVE','DELETING');

CREATE FUNCTION cloud.resource_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'cloud.resources rows are never deleted' USING ERRCODE = 'insufficient_privilege', HINT = 'immutable'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.kind <> OLD.kind OR NEW.provider_account_id <> OLD.provider_account_id OR NEW.data_region <> OLD.data_region OR NEW.provider_region_id <> OLD.provider_region_id THEN
    RAISE EXCEPTION 'resource identity and placement are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref THEN
    RAISE EXCEPTION 'provider_ref is immutable once known' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> OLD.state THEN
    IF NOT (
         (OLD.state = 'DRAFT' AND NEW.state IN ('QUOTED','FAILED'))
      OR (OLD.state = 'QUOTED' AND NEW.state IN ('AWAITING_PAYMENT','PROVISIONING','FAILED'))
      OR (OLD.state = 'AWAITING_PAYMENT' AND NEW.state IN ('PROVISIONING','FAILED'))
      OR (OLD.state = 'PROVISIONING' AND NEW.state IN ('ACTIVE','FAILED','UNKNOWN'))
      OR (OLD.state = 'ACTIVE' AND NEW.state IN ('DELETING','UNKNOWN','FAILED'))
      OR (OLD.state = 'FAILED' AND NEW.state IN ('DELETING','DELETED'))
      OR (OLD.state = 'DELETING' AND NEW.state IN ('DELETED','ACTIVE','UNKNOWN','FAILED'))
      OR (OLD.state = 'UNKNOWN' AND NEW.state IN ('ACTIVE','PROVISIONING','FAILED','DELETING','DELETED'))
    ) THEN
      RAISE EXCEPTION 'illegal resource transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation', HINT = 'state_machine';
    END IF;
    IF OLD.state = 'UNKNOWN' AND coalesce(current_setting('app.resource_actor', true), '') <> 'reconciler' THEN
      RAISE EXCEPTION 'only the reconciler may leave UNKNOWN' USING ERRCODE = 'insufficient_privilege', HINT = 'reconciler_only';
    END IF;
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER resources_guard BEFORE UPDATE OR DELETE ON cloud.resources FOR EACH ROW EXECUTE FUNCTION cloud.resource_guard();
CREATE TRIGGER resources_no_truncate BEFORE TRUNCATE ON cloud.resources FOR EACH STATEMENT EXECUTE FUNCTION cloud.deny_mutation();

ALTER TABLE cloud.resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud.resources FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON cloud.resources USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON cloud.resources FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT, UPDATE ON cloud.resources TO nuzm_app;
GRANT SELECT ON cloud.resources TO nuzm_worker, nuzm_readonly_reporting;

-- Reconciliation history: tenant-less (admin console scope); the reconciler writes it under the platform scope.
CREATE TABLE cloud.resource_reconciliations (
  id uuid PRIMARY KEY,
  resource_id uuid NOT NULL REFERENCES cloud.resources(id),
  run_at timestamptz NOT NULL DEFAULT now(),
  trigger text NOT NULL CHECK (trigger IN ('scheduled','on_demand','pre_retry','pre_delete','pre_action')),
  observed jsonb NOT NULL DEFAULT '{}'::jsonb,
  result text NOT NULL CHECK (result IN ('in_sync','drift','orphan_suspected','missing','adopted','absence_pending','absence_proven','cannot_prove_absence','compensated','error')),
  action_taken text NOT NULL DEFAULT 'none',
  actor_user_id uuid
);
CREATE INDEX resource_reconciliations_resource_idx ON cloud.resource_reconciliations (resource_id, run_at DESC);
CREATE TRIGGER resource_reconciliations_immutable BEFORE UPDATE OR DELETE ON cloud.resource_reconciliations FOR EACH ROW EXECUTE FUNCTION cloud.deny_mutation();
CREATE TRIGGER resource_reconciliations_no_truncate BEFORE TRUNCATE ON cloud.resource_reconciliations FOR EACH STATEMENT EXECUTE FUNCTION cloud.deny_mutation();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['routing_rules','resource_reconciliations'] LOOP
    EXECUTE format('ALTER TABLE cloud.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE cloud.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY platform_admin ON cloud.%I USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
                      WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT, INSERT ON cloud.%I TO nuzm_app', t);
    EXECUTE format('GRANT SELECT ON cloud.%I TO nuzm_readonly_reporting', t);
  END LOOP;
END $$;

-- Platform jobs also cover on-demand resource reconciliation (subject_id = the resource).
ALTER TABLE cloud.provider_jobs DROP CONSTRAINT provider_jobs_kind_check;
ALTER TABLE cloud.provider_jobs ADD CONSTRAINT provider_jobs_kind_check CHECK (kind IN ('verification','catalog_sync','reconcile'));
ALTER TABLE cloud.provider_jobs ADD COLUMN subject_id uuid;
