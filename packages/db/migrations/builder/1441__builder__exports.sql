-- M10A S47: source exports. An export is a deterministic archive (source + lockfile + migrations + README + OpenAPI + SBOM) that builds standalone and contains no Nuzm
-- secret: every file is scanned before the archive exists and a finding BLOCKS the export (status `blocked`, rule and path recorded, never the secret).
--  * `archive_ref` points at the archive in the export store (M08 bucket in the project's region); the download URL is signed for at most 15 minutes and is never stored.
--  * `project_id` / `version_id` are logical references to M09 tables.
CREATE TABLE builder.exports (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'building' CHECK (status IN ('building','ready','blocked','expired')),
  archive_ref text,
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  sbom_ref text,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  file_count int CHECK (file_count IS NULL OR file_count >= 0),
  blocked_reasons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(blocked_reasons) = 'array'),
  flags jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(flags) = 'array'),
  expires_at timestamptz NOT NULL,
  operation_id uuid,
  data_region text NOT NULL,
  requested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  version int NOT NULL DEFAULT 1,
  CHECK ((status IN ('ready','blocked')) = (finished_at IS NOT NULL) OR status = 'expired'),
  CHECK (status <> 'ready' OR (archive_ref IS NOT NULL AND sha256 IS NOT NULL AND sbom_ref IS NOT NULL))
);
CREATE INDEX exports_project_idx ON builder.exports (org_id, project_id, created_at DESC, id);
CREATE FUNCTION builder.export_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'export records are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.project_id <> OLD.project_id OR NEW.version_id <> OLD.version_id OR NEW.data_region <> OLD.data_region THEN
    RAISE EXCEPTION 'what an export contains is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.status IN ('ready','blocked') AND NEW.status NOT IN (OLD.status, 'expired') THEN
    RAISE EXCEPTION 'a finished export cannot change' USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER export_guard BEFORE UPDATE OR DELETE ON builder.exports FOR EACH ROW EXECUTE FUNCTION builder.export_guard();
ALTER TABLE builder.exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder.exports FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON builder.exports USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON builder.exports FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON builder.exports TO nuzm_app, nuzm_worker;
GRANT UPDATE (status, archive_ref, sha256, sbom_ref, size_bytes, file_count, blocked_reasons, flags, operation_id, finished_at) ON builder.exports TO nuzm_app, nuzm_worker;
GRANT SELECT ON builder.exports TO nuzm_readonly_reporting;
