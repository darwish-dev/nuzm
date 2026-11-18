-- DEV/STAGING ONLY. Production is forward-fix.
DROP TABLE IF EXISTS hosting.ssl_certificates;
DROP TABLE IF EXISTS hosting.site_domain_bindings;
DELETE FROM tenancy.role_permissions WHERE permission LIKE 'hosting:%';
DELETE FROM tenancy.permissions WHERE name LIKE 'hosting:%';
