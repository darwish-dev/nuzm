-- DEV/STAGING ONLY. Production is forward-fix: specs are the record of what was generated and are never dropped.
DROP TABLE IF EXISTS builder.app_specs;
DROP FUNCTION IF EXISTS builder.app_spec_guard();
