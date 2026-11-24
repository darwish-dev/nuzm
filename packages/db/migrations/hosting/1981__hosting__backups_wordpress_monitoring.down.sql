-- DEV ONLY. Production is forward-fix: restore drills and alerts are evidence and are never dropped there.
DROP TABLE IF EXISTS hosting.monitor_alerts;
DROP TABLE IF EXISTS hosting.restore_drills;
DROP TABLE IF EXISTS hosting.site_apps;
ALTER TABLE hosting.site_backups DROP COLUMN IF EXISTS provider_state, DROP COLUMN IF EXISTS archive_name;
ALTER TABLE hosting.sites DROP COLUMN IF EXISTS app_kind;
ALTER TABLE hosting.plan_definitions DROP COLUMN IF EXISTS app_kind;
ALTER TABLE hosting.nodes DROP CONSTRAINT IF EXISTS nodes_drill_never_active, DROP COLUMN IF EXISTS purpose;
