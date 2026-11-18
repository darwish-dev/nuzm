-- M09 S38: AI sessions, messages, runs (the SINGLE run table, M10 extends it with run_steps/tool_calls), artifacts, the persisted event log (SSE resume) and approvals.
--  * A run is executed in SEGMENTS on platform.operations (kind ai.run): a segment ends when the run finishes, fails, is cancelled, or waits for a human approval;
--    the decision starts the next segment from `checkpoint`. The run state machine is enforced here (a trigger) as well as in the service.
--  * `ai.run_events` is append-only with a per-run sequence: SSE clients resume with Last-Event-ID = the last seq they saw.
--  * `ai.approvals`: kind plan|apply_changes|publish|delete|spend|auto_apply, bound to the run AND a hash of the exact action; expires (24 h proposal); the approver
--    must be a human member with a write role and is recorded; an AI cannot approve (there is no AI identity in the approval path).
--  * message content is sealed (field encryption) and classified; `content_hash` lets a duplicate be detected without opening it.
CREATE TABLE ai.sessions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','archived')),
  data_region text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);
CREATE INDEX sessions_org_idx ON ai.sessions (org_id, created_at DESC, id);

CREATE TABLE ai.messages (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES ai.sessions (id),
  run_id uuid,
  role text NOT NULL CHECK (role IN ('user','assistant','system')),
  content_enc text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  classification text NOT NULL DEFAULT 'customer-content' CHECK (classification IN ('customer-content','personal','internal')),
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  data_region text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_session_idx ON ai.messages (org_id, session_id, id);

CREATE TABLE ai.runs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES ai.sessions (id),
  project_id uuid,
  kind text NOT NULL CHECK (kind IN ('website','edit','chat','webapp','mobile','test-fix')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','waiting_approval','succeeded','failed','cancelled','budget_exceeded')),
  operation_id uuid,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  budget jsonb NOT NULL DEFAULT '{}'::jsonb,
  reserved_credits bigint NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0),
  spent_credits bigint NOT NULL DEFAULT 0 CHECK (spent_credits >= 0),
  tokens_in bigint NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out bigint NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  model_ref text,
  data_region text NOT NULL,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  step text,
  result jsonb,
  error jsonb,
  cancel_requested boolean NOT NULL DEFAULT false,
  idempotency_key text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  version int NOT NULL DEFAULT 1,
  CHECK ((state IN ('succeeded','failed','cancelled','budget_exceeded')) = (finished_at IS NOT NULL))
);
CREATE INDEX runs_org_idx ON ai.runs (org_id, created_at DESC, id);
CREATE INDEX runs_session_idx ON ai.runs (org_id, session_id, created_at DESC);
-- one active run per session and per project (409 run_active)
CREATE UNIQUE INDEX runs_one_active_session_idx ON ai.runs (session_id) WHERE state IN ('queued','running','waiting_approval');
CREATE UNIQUE INDEX runs_one_active_project_idx ON ai.runs (project_id) WHERE project_id IS NOT NULL AND state IN ('queued','running','waiting_approval');
CREATE UNIQUE INDEX runs_idem_idx ON ai.runs (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE FUNCTION ai.run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'runs are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.session_id <> OLD.session_id OR NEW.kind <> OLD.kind OR NEW.data_region <> OLD.data_region OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity, kind and region of a run are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'queued' AND NEW.state IN ('running','cancelled','failed'))
    OR (OLD.state = 'running' AND NEW.state IN ('waiting_approval','succeeded','failed','cancelled','budget_exceeded'))
    OR (OLD.state = 'waiting_approval' AND NEW.state IN ('queued','running','cancelled','failed','budget_exceeded'))) THEN
    RAISE EXCEPTION 'illegal run state transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER run_guard BEFORE UPDATE OR DELETE ON ai.runs FOR EACH ROW EXECUTE FUNCTION ai.run_guard();
CREATE TRIGGER runs_no_truncate BEFORE TRUNCATE ON ai.runs FOR EACH STATEMENT EXECUTE FUNCTION ai.deny_mutation();

CREATE TABLE ai.artifacts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  run_id uuid,
  project_id uuid,
  type text NOT NULL CHECK (type IN ('requirements','architecture','page','change_set','site_model','evaluation_report')),
  payload jsonb NOT NULL,
  schema_version int NOT NULL DEFAULT 1,
  data_region text NOT NULL,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL))
);
CREATE INDEX artifacts_run_idx ON ai.artifacts (org_id, run_id, created_at);
CREATE FUNCTION ai.artifact_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'artifacts are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.payload IS DISTINCT FROM OLD.payload OR NEW.type <> OLD.type OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.org_id <> OLD.org_id THEN
    RAISE EXCEPTION 'an artifact payload is immutable (only the approval can be recorded)' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.approved_by IS NOT NULL AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by) THEN
    RAISE EXCEPTION 'an approval cannot change' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER artifact_guard BEFORE UPDATE OR DELETE ON ai.artifacts FOR EACH ROW EXECUTE FUNCTION ai.artifact_guard();

CREATE TABLE ai.run_events (
  run_id uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq >= 1),
  org_id uuid NOT NULL,
  type text NOT NULL CHECK (length(type) BETWEEN 1 AND 60),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX run_events_org_idx ON ai.run_events (org_id, run_id);
CREATE TRIGGER run_events_immutable BEFORE UPDATE OR DELETE ON ai.run_events FOR EACH ROW EXECUTE FUNCTION ai.deny_mutation();
CREATE TRIGGER run_events_no_truncate BEFORE TRUNCATE ON ai.run_events FOR EACH STATEMENT EXECUTE FUNCTION ai.deny_mutation();

CREATE TABLE ai.approvals (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  run_id uuid,
  project_id uuid,
  kind text NOT NULL CHECK (kind IN ('plan','apply_changes','publish','delete','spend','auto_apply')),
  action_hash text NOT NULL CHECK (action_hash ~ '^[0-9a-f]{64}$'),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','denied','expired')),
  requested_by uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  note text CHECK (note IS NULL OR length(note) <= 500),
  CHECK ((state IN ('approved','denied')) = (decided_by IS NOT NULL))
);
CREATE INDEX approvals_run_idx ON ai.approvals (org_id, run_id, requested_at DESC);
CREATE INDEX approvals_pending_idx ON ai.approvals (org_id, state) WHERE state = 'pending';
CREATE FUNCTION ai.approval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'approvals are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.kind <> OLD.kind OR NEW.action_hash <> OLD.action_hash OR NEW.run_id IS DISTINCT FROM OLD.run_id THEN
    RAISE EXCEPTION 'an approval is bound to its run, kind and action' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.state <> 'pending' THEN RAISE EXCEPTION 'a decided approval cannot change' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_guard BEFORE UPDATE OR DELETE ON ai.approvals FOR EACH ROW EXECUTE FUNCTION ai.approval_guard();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['sessions','messages','runs','artifacts','run_events','approvals'] LOOP
    EXECUTE format('ALTER TABLE ai.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE ai.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON ai.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY platform_read ON ai.%I FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT ON ai.%I TO nuzm_readonly_reporting', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON ai.sessions, ai.runs, ai.approvals TO nuzm_app, nuzm_worker;
GRANT SELECT, INSERT ON ai.messages, ai.run_events TO nuzm_app, nuzm_worker;
GRANT SELECT, INSERT, UPDATE ON ai.artifacts TO nuzm_app, nuzm_worker;
