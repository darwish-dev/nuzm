-- DEV ONLY. Production is forward-fix: bucket records are customer resources and are never dropped.
DROP TABLE IF EXISTS data.bucket_policies;
DROP TABLE IF EXISTS data.storage_buckets;
DROP FUNCTION IF EXISTS data.storage_bucket_guard();
DELETE FROM tenancy.role_permissions WHERE permission IN ('data:storage:read','data:storage:write','data:storage:admin');
DELETE FROM tenancy.permissions WHERE name IN ('data:storage:read','data:storage:write','data:storage:admin');
