-- DEV ONLY. Production is forward-fix: restore records are evidence and are never dropped.
DROP TABLE IF EXISTS data.database_restores;
DROP FUNCTION IF EXISTS data.database_restore_guard();
ALTER TABLE data.database_instances DROP COLUMN IF EXISTS reveal;
