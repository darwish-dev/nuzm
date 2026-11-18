-- M12 S57: technical reconciliations TR-01..TR-04 are stored ONLY in cloud.resource_reconciliations (docs/05 §7). M05 created that table for compute resources
-- (resource_id NOT NULL -> cloud.resources). TR-02 (hosting), TR-03 (domains) and TR-04 (data/email) have no cloud.resources row, so the table is EXTENDED:
-- resource_id becomes optional when the row names its subject (tr_type + subject_ref). Existing rows and the M05 reconciler are unchanged.
-- CONFLICT RECORDED for the owner (docs/reports/M12-report.md): docs/05 says "only in cloud.resource_reconciliations" and M05's FK says "compute only".
ALTER TABLE cloud.resource_reconciliations ALTER COLUMN resource_id DROP NOT NULL;
ALTER TABLE cloud.resource_reconciliations
  ADD COLUMN tr_type text CHECK (tr_type IS NULL OR tr_type IN ('TR-01','TR-02','TR-03','TR-04')),
  ADD COLUMN subject_kind text CHECK (subject_kind IS NULL OR subject_kind ~ '^[a-z][a-z_.]{2,60}$'),
  ADD COLUMN subject_ref text CHECK (subject_ref IS NULL OR length(subject_ref) BETWEEN 1 AND 300),
  ADD COLUMN evidence_mode text CHECK (evidence_mode IS NULL OR evidence_mode IN ('fixture','sandbox','live','database_only')),
  ADD CONSTRAINT resource_reconciliations_subject CHECK (resource_id IS NOT NULL OR (tr_type IS NOT NULL AND subject_kind IS NOT NULL AND subject_ref IS NOT NULL));
ALTER TABLE cloud.resource_reconciliations DROP CONSTRAINT IF EXISTS resource_reconciliations_trigger_check;
ALTER TABLE cloud.resource_reconciliations ADD CONSTRAINT resource_reconciliations_trigger_check
  CHECK (trigger IN ('scheduled','on_demand','pre_retry','pre_delete','pre_action'));
CREATE INDEX resource_reconciliations_tr_idx ON cloud.resource_reconciliations (tr_type, run_at DESC) WHERE tr_type IS NOT NULL;
