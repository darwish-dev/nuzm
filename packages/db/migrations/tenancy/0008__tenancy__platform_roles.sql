-- M01 S04: platform-role assignments (PA-12) and the admin-console scope.
-- Platform roles are NOT organization memberships. A user holds a platform role only through this table,
-- AND must be flagged identity.users.is_platform_user AND sign in through the admin realm (MFA mandatory).
CREATE TABLE tenancy.platform_roles (
  user_id uuid NOT NULL,                       -- identity.users (no cross-schema FK; checked by the service)
  role text NOT NULL REFERENCES tenancy.roles(name),
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);
GRANT SELECT, INSERT, DELETE ON tenancy.platform_roles TO nuzm_app;
GRANT SELECT ON tenancy.platform_roles TO nuzm_worker, nuzm_readonly_reporting;

-- Org audit visibility: owner/admin see every domain; billing_admin only the billing domains.
INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('audit:read_all','org','Read audit events of every domain (billing_admin is limited to billing domains)');
INSERT INTO tenancy.role_permissions VALUES ('owner','audit:read_all'),('admin','audit:read_all');
-- docs/04 §2.1: impersonation is for `support` (with an approval reference) and `platform_admin`.
INSERT INTO tenancy.role_permissions VALUES ('platform_admin','admin:impersonate');

-- Admin console: cross-org READS of organizations/memberships (status changes run in the target org's own context). The GUC is set only by
-- Db.withPlatformScope(), which is only called from the admin module after a platform permission check.
CREATE POLICY platform_console_read ON tenancy.organizations FOR SELECT TO nuzm_app
  USING (current_setting('app.platform_scope', true) = 'admin');
CREATE POLICY platform_console_read ON tenancy.memberships FOR SELECT TO nuzm_app
  USING (current_setting('app.platform_scope', true) = 'admin');
