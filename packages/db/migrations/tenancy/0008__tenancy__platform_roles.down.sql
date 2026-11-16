-- Dev/staging reversal.
DROP POLICY IF EXISTS platform_console_read ON tenancy.memberships;
DROP POLICY IF EXISTS platform_console_read ON tenancy.organizations;
DELETE FROM tenancy.role_permissions WHERE permission = 'audit:read_all' OR (role = 'platform_admin' AND permission = 'admin:impersonate');
DELETE FROM tenancy.permissions WHERE name = 'audit:read_all';
DROP TABLE IF EXISTS tenancy.platform_roles;
