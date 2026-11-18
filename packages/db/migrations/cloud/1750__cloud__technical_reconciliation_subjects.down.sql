-- DEV/STAGING ONLY (M12 S57).
DELETE FROM cloud.resource_reconciliations WHERE resource_id IS NULL;
DROP INDEX IF EXISTS cloud.resource_reconciliations_tr_idx;
ALTER TABLE cloud.resource_reconciliations DROP CONSTRAINT IF EXISTS resource_reconciliations_subject;
ALTER TABLE cloud.resource_reconciliations DROP COLUMN IF EXISTS evidence_mode, DROP COLUMN IF EXISTS subject_ref, DROP COLUMN IF EXISTS subject_kind, DROP COLUMN IF EXISTS tr_type;
ALTER TABLE cloud.resource_reconciliations ALTER COLUMN resource_id SET NOT NULL;
