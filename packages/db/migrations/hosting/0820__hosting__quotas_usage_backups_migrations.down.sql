-- DEV/STAGING ONLY. Production is forward-fix: backups are customer data references and never dropped.
DROP TABLE IF EXISTS hosting.site_migrations;
DROP TABLE IF EXISTS hosting.site_backups;
DROP TABLE IF EXISTS hosting.site_usage_reports;
DROP TABLE IF EXISTS hosting.quota_events;
DROP TABLE IF EXISTS hosting.site_quotas;
DROP FUNCTION IF EXISTS hosting.backup_guard();
