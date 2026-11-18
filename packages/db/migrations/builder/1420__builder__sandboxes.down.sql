-- DEV/STAGING ONLY. Production is forward-fix: sandbox records are audit evidence and are never dropped.
DROP TABLE IF EXISTS builder.sandboxes;
DROP FUNCTION IF EXISTS builder.sandbox_guard();
