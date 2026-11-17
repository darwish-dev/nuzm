-- DEV/STAGING ONLY. Production is forward-fix (provider accounts and evidence are operational records).
DELETE FROM tenancy.role_permissions WHERE permission IN ('admin:provider:read','admin:provider:manage');
DELETE FROM tenancy.permissions WHERE name IN ('admin:provider:read','admin:provider:manage');
DROP TABLE IF EXISTS cloud.provider_jobs;
DROP TABLE IF EXISTS cloud.catalog_snapshots;
DROP TABLE IF EXISTS cloud.provider_capabilities;
DROP TABLE IF EXISTS cloud.provider_plans;
DROP TABLE IF EXISTS cloud.provider_regions;
DROP TABLE IF EXISTS cloud.evidence_items;
DROP TABLE IF EXISTS cloud.provider_accounts;
DROP TABLE IF EXISTS cloud.providers;
DROP FUNCTION IF EXISTS cloud.deny_mutation();
DROP SCHEMA IF EXISTS cloud;
