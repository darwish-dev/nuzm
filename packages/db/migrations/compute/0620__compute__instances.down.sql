-- DEV/STAGING ONLY. Production is forward-fix (instances and snapshots are customer records).
DELETE FROM tenancy.role_permissions WHERE permission IN ('offers:read','compute:quote:create','compute:instance:create','compute:instance:read','compute:instance:act','compute:instance:delete');
DELETE FROM tenancy.permissions WHERE name IN ('offers:read','compute:quote:create','compute:instance:create','compute:instance:read','compute:instance:act','compute:instance:delete');
DROP TABLE IF EXISTS compute.images;
DROP TABLE IF EXISTS compute.instance_intervals;
DROP TABLE IF EXISTS compute.snapshots;
DROP TABLE IF EXISTS compute.instance_actions;
DROP TABLE IF EXISTS compute.instances;
DROP SCHEMA IF EXISTS compute;
