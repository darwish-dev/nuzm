-- DEV ONLY. Production is forward-fix (reconciliation results are financial control records and are never dropped).
DROP SCHEMA IF EXISTS finrec CASCADE;
DELETE FROM tenancy.role_permissions WHERE permission = 'admin:reports:read';
DELETE FROM tenancy.permissions WHERE name = 'admin:reports:read';
