-- DEV/STAGING ONLY. Production is forward-fix: export records are audit evidence and are never dropped.
DROP TABLE IF EXISTS builder.exports;
DROP FUNCTION IF EXISTS builder.export_guard();
