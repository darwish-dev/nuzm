-- M10A S42: agent-graph persistence and the approval engine. M09 owns `ai.runs` (NOT on this base; assumption A-01 in docs/reports/M10-m09-interface-assumptions.md):
-- every `run_id` below is therefore a LOGICAL reference (no foreign key), exactly as the data/email modules reference tables of other owners.
--  * run_steps: one row per graph node per run (unique (run_id, node)): resuming after a worker crash re-reads the rows and never creates a node twice.
--    `checkpoint_ref` names the stored output of a finished node; a node is "done" only when its checkpoint exists.
--  * tool_calls: redacted tool-call summaries (never a raw argument that may hold a secret); `action_hash` binds a call to the approval that allowed it.
--  * approval_requests: hash-bound human approvals (M10 §9). The hash is over the exact action; a decision for another hash is a 409, after `expires_at` a 410.
CREATE SCHEMA IF NOT EXISTS ai;
GRANT USAGE ON SCHEMA ai TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('ai:run','org','Start, cancel and resume AI runs'),
  ('ai:read','org','Read AI runs, steps, redacted tool calls and budgets'),
  ('ai:approve','org','Decide the human approvals an AI run or a deployment is waiting for'),
  ('ai:budget','org','Read and change AI run and organization budgets'),
  ('builder:read','org','Read builder projects, files, versions, test runs and exports'),
  ('builder:write','org','Create builder projects and apply changes'),
  ('builder:test','org','Run tests of a builder project in a sandbox'),
  ('builder:export','org','Export the source of a builder project'),
  ('builder:git','org','Read the Git history of a builder project'),
  ('sandbox:use','org','Create and use a sandbox of a builder project'),
  ('deploy:read','org','Read deployments and their logs'),
  ('deploy:create','org','Deploy a builder project to a hosting site or a compute instance'),
  ('deploy:rollback','org','Roll a deployment back'),
  ('admin:ai:read','platform','Read-only support view of AI runs (metadata only)')
ON CONFLICT (name) DO NOTHING;
INSERT INTO tenancy.role_permissions (role, permission)
  SELECT r, p FROM unnest(ARRAY['owner','admin','developer']) r,
    unnest(ARRAY['ai:run','ai:approve','builder:write','builder:test','builder:export','builder:git','sandbox:use','deploy:create','deploy:rollback']) p
ON CONFLICT DO NOTHING;
INSERT INTO tenancy.role_permissions (role, permission)
  SELECT r, p FROM unnest(ARRAY['owner','admin','developer','viewer','billing_admin']) r,
    unnest(ARRAY['ai:read','builder:read','deploy:read']) p
ON CONFLICT DO NOTHING;
INSERT INTO tenancy.role_permissions (role, permission)
  SELECT r, 'ai:budget' FROM unnest(ARRAY['owner','admin','billing_admin']) r
ON CONFLICT DO NOTHING;
INSERT INTO tenancy.role_permissions (role, permission)
  SELECT r, 'admin:ai:read' FROM unnest(ARRAY['platform_admin','support','security']) r
ON CONFLICT DO NOTHING;

CREATE TABLE ai.run_steps (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  run_id uuid NOT NULL,                          -- logical reference to ai.runs (M09)
  seq int NOT NULL CHECK (seq >= 0),
  node text NOT NULL CHECK (node ~ '^[a-z][a-z0-9_-]{0,40}$'),
  agent text NOT NULL CHECK (agent IN ('requirements','architecture','database','backend','frontend','qa','devops','test-fix')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed','waiting_approval','skipped','cancelled')),
  attempt int NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  input_ref text,
  output_ref text,
  checkpoint_ref text,
  tokens_in bigint NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out bigint NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  cost_minor bigint NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
  error_code text CHECK (error_code IS NULL OR length(error_code) <= 80),
  data_region text NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'succeeded' OR checkpoint_ref IS NOT NULL)
);
CREATE UNIQUE INDEX run_steps_run_node_idx ON ai.run_steps (run_id, node);
CREATE UNIQUE INDEX run_steps_run_seq_idx ON ai.run_steps (run_id, seq);
CREATE INDEX run_steps_org_idx ON ai.run_steps (org_id, run_id);
CREATE FUNCTION ai.run_step_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'run steps are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.run_id <> OLD.run_id OR NEW.node <> OLD.node OR NEW.seq <> OLD.seq OR NEW.agent <> OLD.agent THEN
    RAISE EXCEPTION 'the identity of a run step is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.status IN ('succeeded','skipped','cancelled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a finished run step cannot change' USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER run_step_guard BEFORE UPDATE OR DELETE ON ai.run_steps FOR EACH ROW EXECUTE FUNCTION ai.run_step_guard();
CREATE TRIGGER run_step_no_truncate BEFORE TRUNCATE ON ai.run_steps FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();
ALTER TABLE ai.run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.run_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON ai.run_steps USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON ai.run_steps FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON ai.run_steps TO nuzm_app, nuzm_worker;
GRANT UPDATE (status, attempt, input_ref, output_ref, checkpoint_ref, tokens_in, tokens_out, cost_minor, error_code, started_at, finished_at) ON ai.run_steps TO nuzm_app, nuzm_worker;
GRANT SELECT ON ai.run_steps TO nuzm_readonly_reporting;

CREATE TABLE ai.tool_calls (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  run_id uuid NOT NULL,                          -- logical reference to ai.runs (M09)
  step_id uuid NOT NULL REFERENCES ai.run_steps(id),
  tool text NOT NULL CHECK (tool ~ '^[a-z][a-z0-9_.-]{0,60}$'),
  args_redacted jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(args_redacted) = 'object'),
  result_ref text,
  status text NOT NULL DEFAULT 'succeeded' CHECK (status IN ('succeeded','failed','denied','waiting_approval')),
  duration_ms int CHECK (duration_ms IS NULL OR duration_ms >= 0),
  approved_by uuid,
  action_hash text CHECK (action_hash IS NULL OR action_hash ~ '^[0-9a-f]{64}$'),
  data_region text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tool_calls_step_idx ON ai.tool_calls (step_id, created_at);
CREATE INDEX tool_calls_org_idx ON ai.tool_calls (org_id, run_id);
ALTER TABLE ai.tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.tool_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON ai.tool_calls USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON ai.tool_calls FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON ai.tool_calls TO nuzm_app, nuzm_worker;
GRANT SELECT ON ai.tool_calls TO nuzm_readonly_reporting;

CREATE TABLE ai.approval_requests (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('run','deployment','release','project','sandbox')),
  subject_id uuid NOT NULL,
  run_id uuid,                                   -- logical reference to ai.runs (M09); null for approvals that belong to a deployment or a release
  approval_type text NOT NULL CHECK (approval_type IN (
    'production_deploy','production_rollback','data_migration_rollback','destructive_migration','paid_resource','egress_or_dependency',
    'budget_increase','export_third_party','mobile_signing','release_owner')),
  action jsonb NOT NULL CHECK (jsonb_typeof(action) = 'object'),
  action_hash text NOT NULL CHECK (action_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  requested_by uuid,                             -- null = requested by the AI agent graph (an approver must differ from the AI by construction)
  requested_by_kind text NOT NULL DEFAULT 'ai' CHECK (requested_by_kind IN ('ai','user','system')),
  required_roles text[] NOT NULL CHECK (cardinality(required_roles) >= 1),
  expires_at timestamptz NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  data_region text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('approved','rejected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status <> 'expired' OR decided_by IS NULL)
);
-- one open request per exact action; a repeated request for the same action returns the existing one
CREATE UNIQUE INDEX approval_requests_open_idx ON ai.approval_requests (org_id, subject_type, subject_id, approval_type, action_hash) WHERE status = 'pending';
CREATE INDEX approval_requests_org_idx ON ai.approval_requests (org_id, status, created_at DESC, id);
CREATE INDEX approval_requests_run_idx ON ai.approval_requests (run_id) WHERE run_id IS NOT NULL;
CREATE FUNCTION ai.approval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'approvals are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.action <> OLD.action OR NEW.action_hash <> OLD.action_hash OR NEW.approval_type <> OLD.approval_type
     OR NEW.subject_type <> OLD.subject_type OR NEW.subject_id <> OLD.subject_id OR NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the action an approval is bound to is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.status <> 'pending' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a decided or expired approval cannot change' USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_guard BEFORE UPDATE OR DELETE ON ai.approval_requests FOR EACH ROW EXECUTE FUNCTION ai.approval_guard();
CREATE TRIGGER approval_no_truncate BEFORE TRUNCATE ON ai.approval_requests FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();
ALTER TABLE ai.approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.approval_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON ai.approval_requests USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON ai.approval_requests FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON ai.approval_requests TO nuzm_app, nuzm_worker;
GRANT UPDATE (status, decided_by, decided_at, decision_note) ON ai.approval_requests TO nuzm_app, nuzm_worker;
GRANT SELECT ON ai.approval_requests TO nuzm_readonly_reporting;
