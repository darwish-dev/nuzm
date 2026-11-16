-- Dev/staging reversal: drop the FKs added above (named by PostgreSQL convention <table>_org_id_fkey).
ALTER TABLE platform.operations DROP CONSTRAINT IF EXISTS operations_org_id_fkey;
ALTER TABLE platform.operation_steps DROP CONSTRAINT IF EXISTS operation_steps_org_id_fkey;
ALTER TABLE platform.outbox DROP CONSTRAINT IF EXISTS outbox_org_id_fkey;
ALTER TABLE platform.idempotency_keys DROP CONSTRAINT IF EXISTS idempotency_keys_org_id_fkey;
ALTER TABLE platform.notifications DROP CONSTRAINT IF EXISTS notifications_org_id_fkey;
ALTER TABLE platform.feature_flags DROP CONSTRAINT IF EXISTS feature_flags_org_id_fkey;
