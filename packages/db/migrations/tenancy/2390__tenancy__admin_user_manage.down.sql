-- Dev/staging reversal.
DELETE FROM tenancy.role_permissions WHERE permission = 'admin:user:manage';
DELETE FROM tenancy.permissions WHERE name = 'admin:user:manage';
