-- M10A S47: deployments of generated web applications. M09 owns `deploy.deployments` for websites (NOT on this base, assumption A-05): M10 keeps the record of a WEB-APP
-- deployment in its own tables and a later integration step may fold them into the M09 table with the extension columns the M10 prompt lists (target_type, target_id,
-- health_check, rollback_of). `project_id`/`version_id` are logical references; `target_id` is a logical reference to hosting.sites (M06) or compute.instances (M05).
--  * app_deployments: state machine queued -> building -> deploying -> verifying -> live | failed | rolled_back | superseded; the artifact is content-addressed (sha256).
--  * app_deployment_logs: append-only (no UPDATE/DELETE/TRUNCATE for anyone).
CREATE SCHEMA IF NOT EXISTS deploy;
GRANT USAGE ON SCHEMA deploy TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

CREATE TABLE deploy.app_deployments (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('production','staging')),
  target_type text NOT NULL CHECK (target_type IN ('site','instance')),
  target_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','building','deploying','verifying','live','failed','rolled_back','superseded')),
  failure_code text CHECK (failure_code IS NULL OR length(failure_code) <= 80),
  artifact_sha256 text CHECK (artifact_sha256 IS NULL OR artifact_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_ref text,
  release_ref text,
  url text CHECK (url IS NULL OR url ~ '^https?://'),
  health_check jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(health_check) = 'object'),
  migrations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(migrations) = 'array'),
  previous_deployment_id uuid,                   -- the deployment that was live on this target before (what a rollback restores)
  rollback_of uuid,                              -- set on a rollback record: the deployment it rolled back
  approval_ids uuid[] NOT NULL DEFAULT '{}',
  operation_id uuid,
  data_region text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  version int NOT NULL DEFAULT 1
);
CREATE INDEX app_deployments_project_idx ON deploy.app_deployments (org_id, project_id, created_at DESC, id);
CREATE INDEX app_deployments_target_idx ON deploy.app_deployments (org_id, target_id, environment, created_at DESC);
-- at most one live deployment per target and environment
CREATE UNIQUE INDEX app_deployments_live_idx ON deploy.app_deployments (target_id, environment) WHERE state = 'live';
CREATE FUNCTION deploy.app_deployment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'deployment records are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.project_id <> OLD.project_id OR NEW.version_id <> OLD.version_id OR NEW.environment <> OLD.environment
     OR NEW.target_type <> OLD.target_type OR NEW.target_id <> OLD.target_id OR NEW.data_region <> OLD.data_region OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'what a deployment deployed, and where, is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'queued' AND NEW.state IN ('building','failed'))
    OR (OLD.state = 'building' AND NEW.state IN ('deploying','failed'))
    OR (OLD.state = 'deploying' AND NEW.state IN ('verifying','failed'))
    OR (OLD.state = 'verifying' AND NEW.state IN ('live','failed'))
    OR (OLD.state = 'live' AND NEW.state IN ('rolled_back','superseded'))) THEN
    RAISE EXCEPTION 'illegal deployment state transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER app_deployment_guard BEFORE UPDATE OR DELETE ON deploy.app_deployments FOR EACH ROW EXECUTE FUNCTION deploy.app_deployment_guard();
CREATE TRIGGER app_deployment_no_truncate BEFORE TRUNCATE ON deploy.app_deployments FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();
ALTER TABLE deploy.app_deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE deploy.app_deployments FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON deploy.app_deployments USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON deploy.app_deployments FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON deploy.app_deployments TO nuzm_app, nuzm_worker;
GRANT UPDATE (state, failure_code, artifact_sha256, artifact_ref, release_ref, url, health_check, migrations, previous_deployment_id, approval_ids, operation_id, started_at, finished_at, duration_ms) ON deploy.app_deployments TO nuzm_app, nuzm_worker;
GRANT SELECT ON deploy.app_deployments TO nuzm_readonly_reporting;

CREATE TABLE deploy.app_deployment_logs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  deployment_id uuid NOT NULL REFERENCES deploy.app_deployments(id),
  seq int NOT NULL CHECK (seq >= 0),
  level text NOT NULL CHECK (level IN ('info','warn','error')),
  message text NOT NULL CHECK (length(message) <= 2000),
  data_region text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX app_deployment_logs_seq_idx ON deploy.app_deployment_logs (deployment_id, seq);
CREATE TRIGGER app_deployment_logs_immutable BEFORE UPDATE OR DELETE ON deploy.app_deployment_logs FOR EACH ROW EXECUTE FUNCTION audit.deny_mutation();
CREATE TRIGGER app_deployment_logs_no_truncate BEFORE TRUNCATE ON deploy.app_deployment_logs FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();
ALTER TABLE deploy.app_deployment_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE deploy.app_deployment_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON deploy.app_deployment_logs USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON deploy.app_deployment_logs FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON deploy.app_deployment_logs TO nuzm_app, nuzm_worker;
GRANT SELECT ON deploy.app_deployment_logs TO nuzm_readonly_reporting;
