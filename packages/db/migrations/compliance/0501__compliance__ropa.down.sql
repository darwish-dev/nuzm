-- DEV ONLY. Production is forward-fix (the record of processing is compliance evidence and is never dropped).
DROP TABLE IF EXISTS compliance.ropa_entries;
DROP FUNCTION IF EXISTS compliance.ropa_guard();
DELETE FROM tenancy.role_permissions WHERE permission = 'admin:compliance:manage'
  OR (role = 'platform_admin' AND permission = 'admin:compliance:read') OR (role = 'security' AND permission = 'admin:compliance:read');
DELETE FROM tenancy.permissions WHERE name = 'admin:compliance:manage';
