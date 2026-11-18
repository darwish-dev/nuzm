-- M08 S33: restores (to a NEW instance by default; in place only with explicit confirmation and an automatic pre-restore backup) and restore
-- verification runs (scratch restore + integrity checks, recorded in `verification`), plus the one-time secret reveal marker.
--  * `mode='verification'` rows are the weekly/on-demand drills: restore the latest backup into a scratch instance, check it, destroy it.
--  * A restore never crosses organizations: source and target org_id are the same column (one org_id per row); a cross-org attempt cannot even be expressed.
--  * `reveal` on the instance records that the CURRENT credential (vault_ref) was shown once; showing it again needs a rotation (PA-15 route is not exposed).
ALTER TABLE data.database_instances ADD COLUMN reveal jsonb;
GRANT UPDATE (reveal, storage_gb) ON data.database_instances TO nuzm_app, nuzm_worker;

CREATE TABLE data.database_restores (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  source_instance_id uuid NOT NULL REFERENCES data.database_instances(id),
  source_backup_id uuid NOT NULL REFERENCES data.database_backups(id),
  target_instance_id uuid REFERENCES data.database_instances(id),
  mode text NOT NULL CHECK (mode IN ('new','inplace','verification')),
  state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','running','needs_reconcile','succeeded','failed')),
  name text CHECK (name IS NULL OR name ~ '^[a-z][a-z0-9-]{1,38}[a-z0-9]$'),
  confirm_in_place boolean NOT NULL DEFAULT false,
  pre_restore_backup_id uuid REFERENCES data.database_backups(id),
  verification jsonb,                            -- {checkedAt, passed, engineCheck, tables:[{table,rowCount,checksum,expected{rowCount,checksum},match}], alerted}
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{2,60}$'),
  data_region text NOT NULL,
  operation_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK (mode <> 'inplace' OR confirm_in_place),
  CHECK (mode <> 'inplace' OR state <> 'succeeded' OR pre_restore_backup_id IS NOT NULL),
  CHECK ((state IN ('succeeded','failed')) = (finished_at IS NOT NULL))
);
CREATE INDEX database_restores_source_idx ON data.database_restores (org_id, source_instance_id, created_at DESC, id);
CREATE FUNCTION data.database_restore_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'restores are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.source_instance_id <> OLD.source_instance_id OR NEW.source_backup_id <> OLD.source_backup_id OR NEW.mode <> OLD.mode OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity of a restore is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.state IN ('succeeded','failed') THEN RAISE EXCEPTION 'a finished restore cannot change' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'requested' AND NEW.state IN ('running','failed'))
    OR (OLD.state = 'running' AND NEW.state IN ('succeeded','failed','needs_reconcile'))
    OR (OLD.state = 'needs_reconcile' AND NEW.state IN ('running','succeeded','failed'))) THEN
    RAISE EXCEPTION 'illegal restore transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER database_restore_guard BEFORE UPDATE OR DELETE ON data.database_restores FOR EACH ROW EXECUTE FUNCTION data.database_restore_guard();
CREATE TRIGGER database_restore_no_truncate BEFORE TRUNCATE ON data.database_restores FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();
ALTER TABLE data.database_restores ENABLE ROW LEVEL SECURITY;
ALTER TABLE data.database_restores FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON data.database_restores USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON data.database_restores FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON data.database_restores TO nuzm_app, nuzm_worker;
GRANT UPDATE (target_instance_id, state, pre_restore_backup_id, verification, failure_code, operation_id, finished_at) ON data.database_restores TO nuzm_app, nuzm_worker;
GRANT SELECT ON data.database_restores TO nuzm_readonly_reporting;
