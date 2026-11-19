-- DEV/STAGING ONLY. Production is forward-fix; `mobile.*` may be dropped only before the first data exists (expand/contract applies afterwards).
DROP TABLE IF EXISTS mobile.artifacts;
DROP TABLE IF EXISTS mobile.builds;
DROP FUNCTION IF EXISTS mobile.build_guard();
DROP FUNCTION IF EXISTS mobile.deny_mutation();
DELETE FROM tenancy.role_permissions WHERE permission IN ('mobile:build','mobile:signing','mobile:release','mobile:release:approve');
DELETE FROM tenancy.permissions WHERE name IN ('mobile:build','mobile:signing','mobile:release','mobile:release:approve');
