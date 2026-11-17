-- DEV ONLY. Production is forward-fix: retention policies and legal holds are compliance evidence and are never dropped.
-- Detached (archived) partitions are NOT re-attached or dropped by this script.
DROP FUNCTION IF EXISTS audit.detach_partition(text, text, uuid, uuid, text);
DROP TABLE IF EXISTS audit.archivable_tables;
DROP TABLE IF EXISTS audit.legal_holds;
DROP FUNCTION IF EXISTS audit.legal_hold_guard();
DROP TABLE IF EXISTS audit.retention_policies;
DROP FUNCTION IF EXISTS audit.retention_guard();
