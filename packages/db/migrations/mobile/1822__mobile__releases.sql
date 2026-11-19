-- M10B S50: release-preparation records. A record PREPARES a store release; the platform never submits to a store in this milestone (a human gate; no submission action exists).
-- status: draft -> prepared (checklist complete) -> owner_approved (explicit account-owner approval, bound to `scope_hash` = hash of everything that was approved).
--  * `checklist` holds privacy-policy URL, permission declarations, screenshots (references + sha256), compliance items; `metadata` the store listing draft.
--  * Any change to the approved content after approval is impossible: an approved record is immutable; a change = a NEW record.
CREATE TABLE mobile.releases (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  build_id uuid NOT NULL,
  version_name text NOT NULL CHECK (version_name ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]{1,30})?$'),
  version_code int NOT NULL CHECK (version_code >= 1),
  store text NOT NULL CHECK (store IN ('google_play','app_store')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','prepared','owner_approved')),
  checklist jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checklist) = 'object'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  scope_hash text CHECK (scope_hash IS NULL OR scope_hash ~ '^[0-9a-f]{64}$'),
  owner_approved_by uuid,
  owner_approved_at timestamptz,
  data_region text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  CHECK ((status = 'owner_approved') = (owner_approved_by IS NOT NULL AND owner_approved_at IS NOT NULL)),
  CHECK (status = 'draft' OR scope_hash IS NOT NULL)
);
CREATE INDEX releases_project_idx ON mobile.releases (org_id, project_id, created_at DESC, id);
CREATE UNIQUE INDEX releases_version_idx ON mobile.releases (org_id, project_id, store, version_code);
CREATE FUNCTION mobile.release_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'release records are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.project_id <> OLD.project_id OR NEW.store <> OLD.store OR NEW.data_region <> OLD.data_region THEN
    RAISE EXCEPTION 'what a release record is for is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.status = 'owner_approved' THEN
    RAISE EXCEPTION 'an owner-approved release record is immutable (create a new record to change anything)' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.status = 'prepared' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'a prepared release cannot go back to draft' USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER release_guard BEFORE UPDATE OR DELETE ON mobile.releases FOR EACH ROW EXECUTE FUNCTION mobile.release_guard();
ALTER TABLE mobile.releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile.releases FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON mobile.releases USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON mobile.releases FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON mobile.releases TO nuzm_app, nuzm_worker;
GRANT UPDATE (build_id, version_name, version_code, status, checklist, metadata, scope_hash, owner_approved_by, owner_approved_at) ON mobile.releases TO nuzm_app, nuzm_worker;
GRANT SELECT ON mobile.releases TO nuzm_readonly_reporting;
