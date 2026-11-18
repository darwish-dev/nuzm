-- M09 S41: deployments. A build renders a project version for a target (base URL, forms endpoint) into a hashed artifact; a deployment publishes that artifact to a
-- hosting site through the SiteArtifactPublisher port, runs a smoke check and either switches or rolls back automatically.
--  * deploy.deployment_logs is APPEND-ONLY (a deployment's story is never edited).
--  * `previous_deployment_id` is the deployment that served before this one: a rollback restores ITS artifact hash.
--  * `approval_id` is the ai.approvals row (kind publish) a human with owner|admin|developer decided; a deployment cannot be created without it (service) and a succeeded
--    deployment must carry it (CHECK).
INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('deploy:read','org','Read deployments, their logs and smoke results'),
  ('deploy:write','org','Create deployments and roll them back');
INSERT INTO tenancy.role_permissions VALUES
  ('owner','deploy:read'),('admin','deploy:read'),('billing_admin','deploy:read'),('developer','deploy:read'),('viewer','deploy:read'),
  ('owner','deploy:write'),('admin','deploy:write'),('developer','deploy:write');
CREATE SCHEMA IF NOT EXISTS deploy;
GRANT USAGE ON SCHEMA deploy TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

CREATE TABLE deploy.builds (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running','succeeded','failed')),
  base_url text,
  artifact_hash text CHECK (artifact_hash IS NULL OR artifact_hash ~ '^[0-9a-f]{64}$'),
  artifact bytea,
  file_count int,
  size_bytes int,
  issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  build_ms int,
  error jsonb,
  data_region text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((state = 'running') = (finished_at IS NULL)),
  CHECK (state <> 'succeeded' OR (artifact_hash IS NOT NULL AND artifact IS NOT NULL))
);
CREATE INDEX builds_project_idx ON deploy.builds (org_id, project_id, created_at DESC);

CREATE TABLE deploy.deployments (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version_id uuid NOT NULL,
  target_kind text NOT NULL DEFAULT 'hosting_site' CHECK (target_kind IN ('hosting_site')),
  target_ref uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('production','staging')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','building','deploying','smoke_checking','succeeded','failed','rolled_back')),
  operation_id uuid,
  build_id uuid,
  artifact_hash text CHECK (artifact_hash IS NULL OR artifact_hash ~ '^[0-9a-f]{64}$'),
  previous_deployment_id uuid,
  rollback_of uuid,
  url text,
  smoke jsonb,
  error jsonb,
  approval_id uuid,
  idempotency_key text,
  data_region text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  version int NOT NULL DEFAULT 1,
  CHECK ((state IN ('succeeded','failed','rolled_back')) = (finished_at IS NOT NULL)),
  CHECK (state <> 'succeeded' OR (approval_id IS NOT NULL AND artifact_hash IS NOT NULL))
);
CREATE INDEX deployments_project_idx ON deploy.deployments (org_id, project_id, created_at DESC, id);
CREATE INDEX deployments_target_idx ON deploy.deployments (org_id, target_ref, environment, created_at DESC);
CREATE UNIQUE INDEX deployments_idem_idx ON deploy.deployments (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- one deployment in flight per target and environment
CREATE UNIQUE INDEX deployments_one_active_idx ON deploy.deployments (target_ref, environment) WHERE state IN ('queued','building','deploying','smoke_checking');
CREATE FUNCTION deploy.deployment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'deployments are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.project_id <> OLD.project_id OR NEW.version_id <> OLD.version_id OR NEW.target_ref <> OLD.target_ref OR NEW.environment <> OLD.environment OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity, version and target of a deployment are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.state IN ('succeeded','failed','rolled_back') AND NEW.state <> OLD.state AND NOT (OLD.state = 'succeeded' AND NEW.state = 'rolled_back') THEN
    RAISE EXCEPTION 'illegal deployment state transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER deployment_guard BEFORE UPDATE OR DELETE ON deploy.deployments FOR EACH ROW EXECUTE FUNCTION deploy.deployment_guard();

CREATE TABLE deploy.deployment_logs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  deployment_id uuid NOT NULL REFERENCES deploy.deployments (id),
  seq int NOT NULL CHECK (seq >= 1),
  level text NOT NULL CHECK (level IN ('info','warn','error')),
  message text NOT NULL CHECK (length(message) <= 1000),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deployment_id, seq)
);
CREATE FUNCTION deploy.deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation', HINT = 'immutable'; END $$;
CREATE TRIGGER logs_immutable BEFORE UPDATE OR DELETE ON deploy.deployment_logs FOR EACH ROW EXECUTE FUNCTION deploy.deny_mutation();
CREATE TRIGGER logs_no_truncate BEFORE TRUNCATE ON deploy.deployment_logs FOR EACH STATEMENT EXECUTE FUNCTION deploy.deny_mutation();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['builds','deployments','deployment_logs'] LOOP
    EXECUTE format('ALTER TABLE deploy.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE deploy.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON deploy.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY platform_read ON deploy.%I FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT ON deploy.%I TO nuzm_readonly_reporting', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON deploy.builds, deploy.deployments TO nuzm_app, nuzm_worker;
GRANT SELECT, INSERT ON deploy.deployment_logs TO nuzm_app, nuzm_worker;
