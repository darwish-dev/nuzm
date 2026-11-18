-- M10A S42: versioned structured application spec (entities, roles, pages, API, non-functional). M09 owns `builder.projects` (assumption A-02): `project_id` is a logical reference.
--  * (project_id, version) is unique; a spec row is immutable except for its status (draft -> approved -> superseded).
--  * `content_hash` is the sha256 of the canonical JSON of `spec`: approvals and generated artifacts quote it.
CREATE SCHEMA IF NOT EXISTS builder;
GRANT USAGE ON SCHEMA builder TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

CREATE TABLE builder.app_specs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,                      -- logical reference to builder.projects (M09)
  version int NOT NULL CHECK (version >= 1),
  spec jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','superseded')),
  run_id uuid,                                   -- the run that produced it (logical reference to ai.runs)
  data_region text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid,
  approved_at timestamptz,
  CHECK ((status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL) OR status = 'superseded')
);
CREATE UNIQUE INDEX app_specs_project_version_idx ON builder.app_specs (project_id, version);
CREATE INDEX app_specs_org_idx ON builder.app_specs (org_id, project_id, version DESC);
CREATE FUNCTION builder.app_spec_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'app specs are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.project_id <> OLD.project_id OR NEW.version <> OLD.version OR NEW.spec <> OLD.spec OR NEW.content_hash <> OLD.content_hash THEN
    RAISE EXCEPTION 'a spec version is immutable: write a new version' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'draft' AND NEW.status IN ('approved','superseded')) OR (OLD.status = 'approved' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'illegal spec state transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER app_spec_guard BEFORE UPDATE OR DELETE ON builder.app_specs FOR EACH ROW EXECUTE FUNCTION builder.app_spec_guard();
CREATE TRIGGER app_spec_no_truncate BEFORE TRUNCATE ON builder.app_specs FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();
ALTER TABLE builder.app_specs ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder.app_specs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON builder.app_specs USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON builder.app_specs FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON builder.app_specs TO nuzm_app, nuzm_worker;
GRANT UPDATE (status, approved_by, approved_at) ON builder.app_specs TO nuzm_app, nuzm_worker;
GRANT SELECT ON builder.app_specs TO nuzm_readonly_reporting;
