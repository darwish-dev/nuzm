-- DEV ONLY. Production is forward-fix.
DROP TABLE IF EXISTS deploy.deployment_logs;
DROP TABLE IF EXISTS deploy.deployments;
DROP TABLE IF EXISTS deploy.builds;
DROP FUNCTION IF EXISTS deploy.deployment_guard();
DROP FUNCTION IF EXISTS deploy.deny_mutation();
DELETE FROM tenancy.role_permissions WHERE permission IN ('deploy:read','deploy:write');
DELETE FROM tenancy.permissions WHERE name IN ('deploy:read','deploy:write');
