-- M11 S51: workflow engine core. Workflows, immutable versions, executions, per-attempt step records, dead letters, anomaly cases.
--  * workflow_versions are IMMUTABLE (no UPDATE/DELETE grant + trigger): a change is a new version; `workflows.active_version_id` points at the live one.
--  * executions: one per (org, workflow, dedupe_key); the same dedupe key twice returns the original (unique index). `cursor` is the durable resume state, so a worker
--    that dies mid-run is resumed from the last persisted step by whoever claims the operation next.
--  * execution_steps: one row per attempt, unique (execution_id, step_key, attempt). `idempotency_key` = sha256(executionId|stepKey|attemptGroup) is the SAME for every
--    retry of a logical step, so an idempotent action produces one effect however many times it is attempted.
--  * input/output are stored REDACTED (secrets removed before they reach the database) and capped; they are `customer-content` and may include personal data (D-34 retention).
CREATE SCHEMA IF NOT EXISTS automation;
GRANT USAGE ON SCHEMA automation TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('automation:read','org','Read workflows, versions, executions and connectors'),
  ('automation:write','org','Create workflows and publish workflow versions'),
  ('automation:run','org','Start workflow executions'),
  ('connector:manage','org','Create connectors and authorize them'),
  ('webhook:manage','org','Create outbound webhook endpoints and rotate their secrets'),
  ('admin:automation','platform','Pause workflows, review anomaly cases and dead letters across organizations (kill switch)');
INSERT INTO tenancy.role_permissions VALUES
  ('owner','automation:read'),('admin','automation:read'),('developer','automation:read'),('billing_admin','automation:read'),('viewer','automation:read'),
  ('owner','automation:write'),('admin','automation:write'),('developer','automation:write'),
  ('owner','automation:run'),('admin','automation:run'),('developer','automation:run'),
  ('owner','connector:manage'),('admin','connector:manage'),
  ('owner','webhook:manage'),('admin','webhook:manage'),
  ('platform_admin','admin:automation'),('support','admin:automation'),('security','admin:automation');

CREATE TABLE automation.workflows (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','disabled')),
  active_version_id uuid,                                -- logical reference to workflow_versions (set after the first version exists)
  owner_user_id uuid,
  triggers jsonb NOT NULL DEFAULT '[]'::jsonb,           -- [{type: schedule|webhook|platform_event|manual, ...}] (no secrets)
  webhook_token_hash text,                               -- sha256 of the secret URL token of the webhook trigger (the token itself is shown once)
  webhook_secret_ref text,                               -- vault reference of the HMAC secret of the webhook trigger
  data_region text NOT NULL,
  next_run_at timestamptz,                               -- next schedule firing (UTC)
  last_run_at timestamptz,
  paused_reason text,
  paused_at timestamptz,
  paused_by_admin boolean NOT NULL DEFAULT false,        -- an admin pause cannot be lifted by the organization
  source_listing_version_id uuid,                        -- set when installed from the marketplace
  version_lock int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'active' OR active_version_id IS NOT NULL)
);
CREATE UNIQUE INDEX workflows_webhook_token_idx ON automation.workflows (webhook_token_hash) WHERE webhook_token_hash IS NOT NULL;
CREATE INDEX workflows_org_idx ON automation.workflows (org_id, created_at DESC, id);
CREATE INDEX workflows_due_idx ON automation.workflows (next_run_at) WHERE status = 'active' AND next_run_at IS NOT NULL;
CREATE FUNCTION automation.workflow_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity of a workflow is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  NEW.version_lock := OLD.version_lock + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_guard BEFORE UPDATE ON automation.workflows FOR EACH ROW EXECUTE FUNCTION automation.workflow_guard();

CREATE TABLE automation.workflow_versions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  workflow_id uuid NOT NULL REFERENCES automation.workflows(id),
  version int NOT NULL CHECK (version >= 1),
  definition jsonb NOT NULL,
  definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  validation jsonb NOT NULL DEFAULT '{}'::jsonb,         -- the validation report (warnings, connector ids)
  validated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version)
);
CREATE INDEX workflow_versions_wf_idx ON automation.workflow_versions (workflow_id, version DESC);
CREATE FUNCTION automation.immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable: change = a new row', TG_TABLE_NAME USING ERRCODE = 'check_violation', HINT = 'immutable';
END $$;
CREATE TRIGGER workflow_versions_immutable BEFORE UPDATE OR DELETE ON automation.workflow_versions FOR EACH ROW EXECUTE FUNCTION automation.immutable_row();
CREATE TRIGGER workflow_versions_no_truncate BEFORE TRUNCATE ON automation.workflow_versions FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();

CREATE TABLE automation.executions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  workflow_id uuid NOT NULL REFERENCES automation.workflows(id),
  version_id uuid NOT NULL REFERENCES automation.workflow_versions(id),
  trigger text NOT NULL CHECK (trigger IN ('manual','schedule','webhook','platform_event','replay')),
  trigger_ref text,                                      -- event id / schedule slot / webhook delivery id
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  input jsonb NOT NULL DEFAULT '{}'::jsonb,              -- customer-content, secret-redacted, capped
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','waiting','succeeded','failed','cancelled')),
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb,             -- {current, scope: {steps}, loop: {...}} durable resume state
  error jsonb,
  operation_id uuid,                                     -- platform.operations row that drives the run (logical reference)
  origin_execution_id uuid,                              -- the execution whose action caused this one (loop/recursion detection)
  key_root_id uuid,                                      -- the execution whose id seeds the step idempotency keys: a DLQ replay keeps the ORIGINAL root, so replay is idempotent
  chain_depth int NOT NULL DEFAULT 0 CHECK (chain_depth BETWEEN 0 AND 100),
  wake_at timestamptz,                                   -- durable delay
  steps_run int NOT NULL DEFAULT 0,
  data_region text NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  version_lock int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, workflow_id, dedupe_key),
  CHECK ((status IN ('succeeded','failed','cancelled')) = (finished_at IS NOT NULL))
);
CREATE INDEX executions_wf_idx ON automation.executions (workflow_id, created_at DESC, id);
CREATE INDEX executions_org_active_idx ON automation.executions (org_id) WHERE status IN ('queued','running','waiting');
CREATE INDEX executions_org_time_idx ON automation.executions (org_id, created_at DESC);
CREATE FUNCTION automation.execution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.workflow_id <> OLD.workflow_id OR NEW.version_id <> OLD.version_id OR NEW.dedupe_key <> OLD.dedupe_key
     OR NEW.trigger <> OLD.trigger OR NEW.input IS DISTINCT FROM OLD.input OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity and input of an execution are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.status IN ('succeeded','failed','cancelled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a finished execution cannot change state' USING ERRCODE = 'check_violation', HINT = 'invalid_state';
  END IF;
  NEW.version_lock := OLD.version_lock + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER execution_guard BEFORE UPDATE ON automation.executions FOR EACH ROW EXECUTE FUNCTION automation.execution_guard();

CREATE TABLE automation.execution_steps (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  execution_id uuid NOT NULL REFERENCES automation.executions(id),
  step_key text NOT NULL CHECK (length(step_key) BETWEEN 1 AND 120),      -- `fetch`, or `loop[3].body_step` inside a loop
  attempt_group text NOT NULL DEFAULT '0',
  step_type text,                                                          -- the step's type (http_request, delay, ...): anomaly rules and the UI read it
  attempt int NOT NULL CHECK (attempt >= 1),
  status text NOT NULL CHECK (status IN ('running','succeeded','failed','skipped','waiting','unknown')),
  idempotent boolean NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  input jsonb,
  output jsonb,
  error jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (execution_id, step_key, attempt)
);
CREATE INDEX execution_steps_exec_idx ON automation.execution_steps (execution_id, started_at, id);

CREATE TABLE automation.dead_letters (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  execution_id uuid NOT NULL REFERENCES automation.executions(id),
  step_key text NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  error jsonb,
  payload jsonb,                                         -- the redacted step input
  replayed_at timestamptz,
  replayed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (execution_id, step_key)
);
CREATE INDEX dead_letters_org_idx ON automation.dead_letters (org_id, created_at DESC) WHERE replayed_at IS NULL;

-- anomaly rules (spike of executions, high 4xx rate, recursion) pause a workflow and open a case for the admin console
CREATE TABLE automation.anomaly_cases (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  workflow_id uuid REFERENCES automation.workflows(id),
  kind text NOT NULL CHECK (kind IN ('execution_spike','high_4xx_rate','recursion','kill_switch','connector_failures')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX anomaly_cases_status_idx ON automation.anomaly_cases (status, created_at DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['workflows','workflow_versions','executions','execution_steps','dead_letters','anomaly_cases'] LOOP
    EXECUTE format('ALTER TABLE automation.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE automation.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON automation.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY platform_read ON automation.%I FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT, INSERT ON automation.%I TO nuzm_app, nuzm_worker', t);
    EXECUTE format('GRANT SELECT ON automation.%I TO nuzm_readonly_reporting', t);
  END LOOP;
END $$;
-- the admin console may pause a workflow and work cases (cross-organization), nothing else
CREATE POLICY platform_pause ON automation.workflows FOR UPDATE USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin') WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
CREATE POLICY platform_cases ON automation.anomaly_cases FOR UPDATE USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin') WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT UPDATE (name, status, active_version_id, triggers, webhook_token_hash, webhook_secret_ref, next_run_at, last_run_at, paused_reason, paused_at, paused_by_admin) ON automation.workflows TO nuzm_app, nuzm_worker;
GRANT UPDATE (status, cursor, error, operation_id, wake_at, steps_run, started_at, finished_at) ON automation.executions TO nuzm_app, nuzm_worker;
GRANT UPDATE (status, input, output, error, finished_at) ON automation.execution_steps TO nuzm_app, nuzm_worker;
GRANT UPDATE (replayed_at, replayed_by) ON automation.dead_letters TO nuzm_app, nuzm_worker;
GRANT UPDATE (status, resolved_by, resolved_at, details) ON automation.anomaly_cases TO nuzm_app, nuzm_worker;

-- The ONE place an execution row is created (used by the API for manual runs, by the scheduler, by inbound webhooks, and by the worker for platform events):
-- idempotent on (org, workflow, dedupe key), refuses a disabled feature, a paused/disabled workflow and a workflow with no published version. SECURITY INVOKER: the
-- caller's row-level security applies (an organization can only enqueue for itself). The operation that drives the run is attached afterwards (operation_id), so a
-- crash between the two leaves a `queued` row without an operation, which the scheduler picks up.
CREATE FUNCTION automation.enqueue_execution(
  p_id uuid, p_org uuid, p_workflow uuid, p_trigger text, p_trigger_ref text, p_dedupe text, p_input jsonb,
  p_origin uuid DEFAULT NULL, p_depth int DEFAULT 0, p_key_root uuid DEFAULT NULL, p_cursor jsonb DEFAULT '{}'::jsonb, p_version uuid DEFAULT NULL
) RETURNS TABLE (execution_id uuid, created boolean) LANGUAGE plpgsql AS $$
DECLARE wf automation.workflows%ROWTYPE; flag jsonb; vid uuid; existing uuid;
BEGIN
  SELECT value INTO flag FROM platform.feature_flags WHERE key = 'automation.enabled' AND org_id = p_org;
  IF flag IS NULL THEN SELECT value INTO flag FROM platform.feature_flags WHERE key = 'automation.enabled' AND org_id IS NULL; END IF;
  IF flag IS NULL OR NOT (flag = 'true'::jsonb OR coalesce(flag ->> 'enabled', '') = 'true') THEN
    RAISE EXCEPTION 'automation is not enabled for this organization' USING ERRCODE = 'check_violation', HINT = 'feature_disabled';
  END IF;
  SELECT * INTO wf FROM automation.workflows WHERE id = p_workflow AND org_id = p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow not found' USING ERRCODE = 'check_violation', HINT = 'not_found'; END IF;
  IF wf.status IN ('paused','disabled') OR (wf.status = 'draft' AND p_trigger NOT IN ('manual','replay')) THEN
    RAISE EXCEPTION 'the workflow is % and cannot run', wf.status USING ERRCODE = 'check_violation', HINT = 'not_runnable';
  END IF;
  vid := coalesce(p_version, wf.active_version_id);
  IF vid IS NULL THEN RAISE EXCEPTION 'the workflow has no published version' USING ERRCODE = 'check_violation', HINT = 'not_runnable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM automation.workflow_versions WHERE id = vid AND workflow_id = p_workflow) THEN
    RAISE EXCEPTION 'unknown version' USING ERRCODE = 'check_violation', HINT = 'not_found';
  END IF;
  INSERT INTO automation.executions (id, org_id, workflow_id, version_id, trigger, trigger_ref, dedupe_key, input, origin_execution_id, key_root_id, chain_depth, cursor, data_region)
    VALUES (p_id, p_org, p_workflow, vid, p_trigger, p_trigger_ref, p_dedupe, p_input, p_origin, p_key_root, p_depth, p_cursor, wf.data_region)
    ON CONFLICT (org_id, workflow_id, dedupe_key) DO NOTHING;
  IF FOUND THEN
    RETURN QUERY SELECT p_id, true;
  ELSE
    SELECT id INTO existing FROM automation.executions WHERE org_id = p_org AND workflow_id = p_workflow AND dedupe_key = p_dedupe;
    RETURN QUERY SELECT existing, false;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION automation.enqueue_execution(uuid, uuid, uuid, text, text, text, jsonb, uuid, int, uuid, jsonb, uuid) TO nuzm_app, nuzm_worker;
