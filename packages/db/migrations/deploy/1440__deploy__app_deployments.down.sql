-- DEV/STAGING ONLY. Production is forward-fix: deployment records and their logs are audit evidence and are never dropped.
DROP TABLE IF EXISTS deploy.app_deployment_logs;
DROP TABLE IF EXISTS deploy.app_deployments;
DROP FUNCTION IF EXISTS deploy.app_deployment_guard();
