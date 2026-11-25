-- P3-S02 durable stores for the real execution runtime, part 1 (design: docs/security/sandbox/DURABLE-STORES-DESIGN.md). Expand only: a NEW schema with NEW tables.
-- The control plane is the source of truth for INTENT and STATE (jobs, workspaces); the node is the source of truth for what PHYSICALLY exists (`listWorkspaces`). The two are reconciled
-- after a restart, never assumed equal. Nothing here stores file content, output text, environment values or secrets: output lives in the run's own artifact/log store (D-34).
--  * The transition guards below mirror `transitionJob` / `transitionWorkspace` of the domain (packages/domain/src/ai/execution-gateway/lifecycle.ts) EXACTLY; a test applies every
--    (from, to) pair to the database and to the domain function and fails on any disagreement. Terminal states are final.
--  * `job_transitions` is append-only (no UPDATE/DELETE/TRUNCATE): the audit history of why a job moved.
--  * Every tenant table carries org_id + data_region (residency hook) and FORCED row level security.
-- Rollback note: 2310.down drops the schema's tables (dev/staging only; production is forward-fix because jobs and transitions are audit evidence).
CREATE SCHEMA IF NOT EXISTS execution;
GRANT USAGE ON SCHEMA execution TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

CREATE FUNCTION execution.deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation', HINT = 'immutable'; END $$;

CREATE TABLE execution.jobs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  run_id text NOT NULL CHECK (length(run_id) BETWEEN 1 AND 120),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  profile text NOT NULL CHECK (profile ~ '^[a-z][a-z0-9-]{0,40}$'),
  decision_digest text NOT NULL CHECK (decision_digest ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('requested','refused','awaiting_approval','rejected','queued','running','succeeded','failed','timed_out','terminated','cancelled','expired')),
  origin text NOT NULL CHECK (origin IN ('MOCK','REAL')),
  requires_approval boolean NOT NULL,
  approval_id uuid,                              -- logical reference to execution.approvals (same schema; no FK so a purged approval never blocks history)
  node_id text CHECK (node_id IS NULL OR length(node_id) <= 40),
  lease_token text,
  lease_expires_at timestamptz,
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 20),
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  outcome_status text CHECK (outcome_status IS NULL OR outcome_status IN ('completed','failed','timeout','terminated','refused')),
  exit_code int,
  duration_ms int CHECK (duration_ms IS NULL OR duration_ms >= 0),
  truncated boolean,
  artifact_count int NOT NULL DEFAULT 0 CHECK (artifact_count >= 0),
  data_region text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK (lease_token IS NULL OR state = 'running')
);
CREATE INDEX jobs_claim_idx ON execution.jobs (state, queued_at) WHERE state = 'queued';
CREATE INDEX jobs_org_state_idx ON execution.jobs (org_id, state);
CREATE INDEX jobs_lease_idx ON execution.jobs (lease_expires_at) WHERE state = 'running';

CREATE FUNCTION execution.job_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ok boolean;
BEGIN
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  ok := CASE OLD.state
    WHEN 'requested' THEN NEW.state IN ('refused','awaiting_approval','queued','terminated')
    WHEN 'awaiting_approval' THEN NEW.state IN ('queued','rejected','expired','cancelled','terminated')
    WHEN 'queued' THEN NEW.state IN ('running','cancelled','expired','terminated')
    WHEN 'running' THEN NEW.state IN ('succeeded','failed','timed_out','terminated','queued')
    ELSE false END;
  IF NOT ok THEN RAISE EXCEPTION 'illegal job transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_transition_guard BEFORE UPDATE OF state ON execution.jobs FOR EACH ROW EXECUTE FUNCTION execution.job_transition_guard();
-- identity never changes
CREATE FUNCTION execution.job_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.run_id <> OLD.run_id OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.decision_digest <> OLD.decision_digest OR NEW.profile <> OLD.profile OR NEW.origin <> OLD.origin
  THEN RAISE EXCEPTION 'job identity is immutable' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_identity_guard BEFORE UPDATE ON execution.jobs FOR EACH ROW EXECUTE FUNCTION execution.job_identity_guard();

CREATE TABLE execution.job_transitions (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL,
  org_id uuid NOT NULL,
  from_state text NOT NULL,
  to_state text NOT NULL,
  cause text NOT NULL CHECK (length(cause) BETWEEN 1 AND 80),
  at timestamptz NOT NULL DEFAULT now(),
  data_region text NOT NULL
);
CREATE INDEX job_transitions_job_idx ON execution.job_transitions (job_id, at);
CREATE TRIGGER job_transitions_immutable BEFORE UPDATE OR DELETE ON execution.job_transitions FOR EACH ROW EXECUTE FUNCTION execution.deny_mutation();
CREATE TRIGGER job_transitions_no_truncate BEFORE TRUNCATE ON execution.job_transitions FOR EACH STATEMENT EXECUTE FUNCTION execution.deny_mutation();

CREATE TABLE execution.workspaces (
  id text PRIMARY KEY CHECK (id ~ '^ws-[A-Za-z0-9._:-]{1,116}$'),   -- ws-<run id>: one workspace per run, never reused
  org_id uuid NOT NULL,
  run_id text NOT NULL,
  job_id uuid,
  node_id text CHECK (node_id IS NULL OR length(node_id) <= 40),
  state text NOT NULL CHECK (state IN ('creating','ready','in_use','failed','destroying','destroyed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  destroyed_at timestamptz,
  data_region text NOT NULL,
  CHECK ((state = 'destroyed') = (destroyed_at IS NOT NULL))
);
CREATE INDEX workspaces_org_state_idx ON execution.workspaces (org_id, state);
CREATE INDEX workspaces_node_idx ON execution.workspaces (node_id, state);
CREATE FUNCTION execution.workspace_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ok boolean;
BEGIN
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  ok := CASE OLD.state
    WHEN 'creating' THEN NEW.state IN ('ready','failed','destroying')
    WHEN 'ready' THEN NEW.state IN ('in_use','failed','destroying')
    WHEN 'in_use' THEN NEW.state IN ('ready','failed','destroying')
    WHEN 'failed' THEN NEW.state IN ('destroying')
    WHEN 'destroying' THEN NEW.state IN ('destroyed','failed')
    ELSE false END;
  IF NOT ok THEN RAISE EXCEPTION 'illegal workspace transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.run_id <> OLD.run_id THEN RAISE EXCEPTION 'workspace identity is immutable' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspaces_transition_guard BEFORE UPDATE ON execution.workspaces FOR EACH ROW EXECUTE FUNCTION execution.workspace_transition_guard();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['jobs','job_transitions','workspaces'] LOOP
    EXECUTE format('ALTER TABLE execution.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE execution.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON execution.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY platform_read ON execution.%I FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT ON execution.%I TO nuzm_readonly_reporting', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON execution.jobs, execution.workspaces TO nuzm_app, nuzm_worker;
GRANT SELECT, INSERT ON execution.job_transitions TO nuzm_app, nuzm_worker;
