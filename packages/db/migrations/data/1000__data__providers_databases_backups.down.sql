-- DEV ONLY. Production is forward-fix: database records are customer resources and are never dropped.
DROP TABLE IF EXISTS data.database_backups;
DROP FUNCTION IF EXISTS data.database_backup_guard();
DROP TABLE IF EXISTS data.database_instances;
DROP FUNCTION IF EXISTS data.database_instance_guard();
DROP TABLE IF EXISTS data.data_providers;
DELETE FROM tenancy.role_permissions WHERE permission IN ('data:db:read','data:db:write','data:db:admin','admin:data:read','admin:data:manage','admin:data:approve');
DELETE FROM tenancy.permissions WHERE name IN ('data:db:read','data:db:write','data:db:admin','admin:data:read','admin:data:manage','admin:data:approve');
