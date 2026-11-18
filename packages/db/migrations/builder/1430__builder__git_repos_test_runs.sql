-- M10A S46: per-project Git repository (bare, control-plane side) and test runs.
--  * git_repos: one row per project; `storage_ref` names the bare repository relative to the Git storage root (never an absolute path). Generated code is NEVER executed
--    by Git (plumbing only: no hooks, no filters), and no Git HTTP route exists until the owner approves SCR-M10-01.
--  * test_runs: a run of unit/typecheck/build/e2e of one project version in a sandbox, with the structured result (junit-like) and a reference to the redacted log.
CREATE TABLE builder.git_repos (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,                      -- logical reference to builder.projects (M09)
  storage_ref text NOT NULL CHECK (storage_ref ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.git$'),
  default_branch text NOT NULL DEFAULT 'main' CHECK (default_branch ~ '^[a-z][a-z0-9/_-]{0,60}$'),
  last_commit text CHECK (last_commit IS NULL OR last_commit ~ '^[0-9a-f]{40}$'),
  data_region text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX git_repos_project_idx ON builder.git_repos (project_id);
CREATE INDEX git_repos_org_idx ON builder.git_repos (org_id, created_at DESC);
CREATE FUNCTION builder.git_repo_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'git repository records are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.project_id <> OLD.project_id OR NEW.storage_ref <> OLD.storage_ref OR NEW.data_region <> OLD.data_region THEN
    RAISE EXCEPTION 'the identity, storage and region of a repository are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER git_repo_guard BEFORE UPDATE OR DELETE ON builder.git_repos FOR EACH ROW EXECUTE FUNCTION builder.git_repo_guard();
ALTER TABLE builder.git_repos ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder.git_repos FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON builder.git_repos USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON builder.git_repos FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON builder.git_repos TO nuzm_app, nuzm_worker;
GRANT UPDATE (default_branch, last_commit) ON builder.git_repos TO nuzm_app, nuzm_worker;
GRANT SELECT ON builder.git_repos TO nuzm_readonly_reporting;

CREATE TABLE builder.test_runs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,                      -- logical reference to builder.projects (M09)
  version_id uuid NOT NULL,                      -- logical reference to builder.project_versions (M09)
  suite text NOT NULL CHECK (suite IN ('unit','typecheck','build','e2e','all')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','passed','failed','errored','cancelled')),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  logs_ref text,
  sandbox_id uuid,                               -- the sandbox it ran in (same schema, no FK: sandboxes are never deleted but may be reaped)
  run_id uuid,                                   -- the test-fix run that asked for it, if any (logical reference to ai.runs)
  runtime_kind text CHECK (runtime_kind IS NULL OR runtime_kind IN ('mock','local-dev','isolated')),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  operation_id uuid,
  data_region text NOT NULL,
  requested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  version int NOT NULL DEFAULT 1,
  CHECK ((status IN ('passed','failed','errored','cancelled')) = (finished_at IS NOT NULL))
);
CREATE INDEX test_runs_project_idx ON builder.test_runs (org_id, project_id, created_at DESC, id);
CREATE FUNCTION builder.test_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'test runs are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.project_id <> OLD.project_id OR NEW.version_id <> OLD.version_id OR NEW.suite <> OLD.suite OR NEW.data_region <> OLD.data_region THEN
    RAISE EXCEPTION 'what a test run tested is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.status IN ('passed','failed','errored','cancelled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a finished test run cannot change' USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER test_run_guard BEFORE UPDATE OR DELETE ON builder.test_runs FOR EACH ROW EXECUTE FUNCTION builder.test_run_guard();
ALTER TABLE builder.test_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder.test_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON builder.test_runs USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON builder.test_runs FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON builder.test_runs TO nuzm_app, nuzm_worker;
GRANT UPDATE (status, summary, logs_ref, sandbox_id, runtime_kind, duration_ms, operation_id, started_at, finished_at) ON builder.test_runs TO nuzm_app, nuzm_worker;
GRANT SELECT ON builder.test_runs TO nuzm_readonly_reporting;
