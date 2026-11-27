-- Admin console tools (owner request 2026-11-27): staff may create customer accounts. A NEW permission, granted to platform_admin only;
-- creating organizations for a customer reuses `admin:org:manage`. No table changes.
INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('admin:user:manage', 'platform', 'Create customer accounts from the admin console')
ON CONFLICT (name) DO NOTHING;
INSERT INTO tenancy.role_permissions (role, permission) VALUES ('platform_admin', 'admin:user:manage')
ON CONFLICT DO NOTHING;
