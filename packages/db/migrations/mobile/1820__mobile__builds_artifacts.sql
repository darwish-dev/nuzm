-- M10B S49: mobile build records and artifacts (new schema `mobile`; no cross-schema FKs: project_id / version_id are logical references to builder.*).
--  * A build is one attempt to build ONE project version for ONE platform/profile. `runner_kind` + `isolation` record HOW it ran: `isolation = 'none'` (the local dev runner)
--    is never isolation evidence. `signed` is true only when the signing stage produced the artifact; this milestone has no signing stage (HG-10-01) so it stays false.
--  * `log_excerpt` is the secret-redacted tail of the build log (capped); signing material never reaches it.
--  * Artifacts are immutable. `retention_until` follows the D-34 PROPOSAL (30 days debug, 12 months release).
CREATE SCHEMA IF NOT EXISTS mobile;
GRANT USAGE ON SCHEMA mobile TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('mobile:build','org','Request and read mobile builds and their artifacts'),
  ('mobile:signing','org','Register and read signing credential references (vault references only; owner/admin)'),
  ('mobile:release','org','Prepare and read store release-preparation records'),
  ('mobile:release:approve','org','Account-owner approval of a release-preparation record (owner role only)');
INSERT INTO tenancy.role_permissions VALUES
  ('owner','mobile:build'),('admin','mobile:build'),('developer','mobile:build'),
  ('owner','mobile:signing'),('admin','mobile:signing'),
  ('owner','mobile:release'),('admin','mobile:release'),('developer','mobile:release'),
  ('owner','mobile:release:approve');

CREATE TABLE mobile.builds (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('android','ios')),
  profile text NOT NULL CHECK (profile IN ('debug','release')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','building','succeeded','failed','blocked')),
  runner_kind text,
  isolation text CHECK (isolation IS NULL OR isolation IN ('none','container','vm')),
  worker_ref text,
  signing_credential_id uuid,
  signed boolean NOT NULL DEFAULT false,
  minutes_billed numeric(12,6) NOT NULL DEFAULT 0 CHECK (minutes_billed >= 0),
  toolchain jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(toolchain) = 'object'),
  error_code text,
  log_excerpt text CHECK (log_excerpt IS NULL OR length(log_excerpt) <= 100000),
  operation_id uuid,
  data_region text NOT NULL,
  requested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  version int NOT NULL DEFAULT 1,
  CHECK (NOT signed OR signing_credential_id IS NOT NULL),
  CHECK (status NOT IN ('succeeded','failed','blocked') OR finished_at IS NOT NULL)
);
CREATE INDEX builds_project_idx ON mobile.builds (org_id, project_id, created_at DESC, id);
CREATE INDEX builds_queue_idx ON mobile.builds (created_at) WHERE status = 'queued';

CREATE TABLE mobile.artifacts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  build_id uuid NOT NULL REFERENCES mobile.builds (id),
  kind text NOT NULL CHECK (kind IN ('apk','aab','ipa','symbols')),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200 AND file_name !~ '(/|\\|\.\.)'),
  storage_ref text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  signed boolean NOT NULL DEFAULT false,
  retention_until timestamptz NOT NULL,
  data_region text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artifacts_build_idx ON mobile.artifacts (org_id, build_id, created_at);

CREATE FUNCTION mobile.build_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'build records are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.project_id <> OLD.project_id OR NEW.version_id <> OLD.version_id OR NEW.platform <> OLD.platform
     OR NEW.profile <> OLD.profile OR NEW.data_region <> OLD.data_region THEN
    RAISE EXCEPTION 'what a build is for is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.status IN ('succeeded','failed','blocked') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a finished build cannot change state' USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER build_guard BEFORE UPDATE OR DELETE ON mobile.builds FOR EACH ROW EXECUTE FUNCTION mobile.build_guard();
CREATE FUNCTION mobile.deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'check_violation', HINT = 'immutable'; END $$;
CREATE TRIGGER artifacts_immutable BEFORE UPDATE OR DELETE ON mobile.artifacts FOR EACH ROW EXECUTE FUNCTION mobile.deny_mutation();

ALTER TABLE mobile.builds ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile.builds FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON mobile.builds USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON mobile.builds FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
ALTER TABLE mobile.artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile.artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON mobile.artifacts USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON mobile.artifacts FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON mobile.builds TO nuzm_app, nuzm_worker;
GRANT UPDATE (status, runner_kind, isolation, worker_ref, signing_credential_id, signed, minutes_billed, toolchain, error_code, log_excerpt, operation_id, started_at, finished_at) ON mobile.builds TO nuzm_app, nuzm_worker;
GRANT SELECT, INSERT ON mobile.artifacts TO nuzm_app, nuzm_worker;
GRANT SELECT ON mobile.builds, mobile.artifacts TO nuzm_readonly_reporting;
