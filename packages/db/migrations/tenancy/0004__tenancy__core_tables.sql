-- M01 S03: tenancy + RBAC. org_id carries RLS everywhere; `organizations` is keyed on `id`.
-- Context GUCs: app.org_id (active org), app.user_id (the caller; membership/org discovery),
-- app.auth_scope='invitation_accept' (token lookup before the invitee belongs to the org).
CREATE SCHEMA IF NOT EXISTS tenancy;
GRANT USAGE ON SCHEMA tenancy TO nuzm_app, nuzm_worker, nuzm_readonly_reporting;

-- Reference data (tenant-less) ----------------------------------------------------------------
CREATE TABLE tenancy.roles (
  name text PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('org','platform')),
  description text NOT NULL
);
CREATE TABLE tenancy.permissions (
  name text PRIMARY KEY CHECK (name ~ '^[a-z_]+(:[a-z_*]+)+$'),
  scope text NOT NULL CHECK (scope IN ('org','platform')),
  description text NOT NULL
);
CREATE TABLE tenancy.role_permissions (
  role text NOT NULL REFERENCES tenancy.roles(name),
  permission text NOT NULL REFERENCES tenancy.permissions(name),
  PRIMARY KEY (role, permission)
);

INSERT INTO tenancy.roles (name, scope, description) VALUES
  ('owner','org','Everything including billing, role grants and ownership; at least one per organization'),
  ('admin','org','Manage members, projects and keys; no organization deletion or ownership transfer'),
  ('billing_admin','org','Billing, usage and invoices; no resource mutation'),
  ('developer','org','Create and manage workspaces, projects, resources, own API keys and operations'),
  ('viewer','org','Read-only'),
  ('platform_admin','platform','Admin console, everything except break-glass data access'),
  ('support','platform','Read organizations and users; impersonation with approval; no financial adjustment'),
  ('finance','platform','Ledger and billing administration'),
  ('compliance_officer','platform','Audit and compliance read'),
  ('security','platform','Audit, sessions, key revocation, incident actions');

INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('org:read','org','Read organization'),
  ('org:update','org','Update organization settings'),
  ('org:delete','org','Delete organization'),
  ('org:security','org','Manage organization security policy'),
  ('member:read','org','List members'),
  ('member:invite','org','Invite members'),
  ('member:manage','org','Change roles and remove members'),
  ('workspace:read','org','Read workspaces'),
  ('workspace:create','org','Create workspaces'),
  ('workspace:update','org','Update workspaces'),
  ('workspace:delete','org','Delete workspaces'),
  ('project:read','org','Read projects and environments'),
  ('project:create','org','Create projects and environments'),
  ('project:update','org','Update projects and environments'),
  ('project:delete','org','Delete projects and environments'),
  ('apikey:read','org','List API keys'),
  ('apikey:manage','org','Create, rotate and revoke API keys'),
  ('operation:read','org','Read operations'),
  ('operation:cancel','org','Cancel operations'),
  ('resource:read','org','Read resource inventory'),
  ('audit:read','org','Read the organization audit log'),
  ('billing:read','org','Read billing, usage and invoices'),
  ('billing:manage','org','Manage plans, payment methods and spend limits'),
  ('usage:events:read','org','Read raw usage events'),
  ('admin:org:read','platform','Read any organization'),
  ('admin:org:manage','platform','Suspend or reinstate organizations'),
  ('admin:user:read','platform','Read any user'),
  ('admin:impersonate','platform','Impersonate a customer user (approval flag, time-boxed)'),
  ('admin:flags:manage','platform','Change feature flags'),
  ('admin:audit:read','platform','Read the cross-organization audit log'),
  ('admin:billing:manage','platform','Ledger and billing administration'),
  ('admin:compliance:read','platform','Compliance read'),
  ('admin:security:manage','platform','Sessions, key revocation, incident actions');

-- owner: every org permission
INSERT INTO tenancy.role_permissions SELECT 'owner', name FROM tenancy.permissions WHERE scope = 'org';
-- admin: everything but org deletion
INSERT INTO tenancy.role_permissions SELECT 'admin', name FROM tenancy.permissions WHERE scope = 'org' AND name <> 'org:delete';
INSERT INTO tenancy.role_permissions VALUES
  ('billing_admin','org:read'),('billing_admin','member:read'),('billing_admin','billing:read'),('billing_admin','billing:manage'),
  ('billing_admin','usage:events:read'),('billing_admin','audit:read'),
  ('developer','org:read'),('developer','member:read'),
  ('developer','workspace:read'),('developer','workspace:create'),('developer','workspace:update'),
  ('developer','project:read'),('developer','project:create'),('developer','project:update'),('developer','project:delete'),
  ('developer','apikey:read'),('developer','apikey:manage'),
  ('developer','operation:read'),('developer','operation:cancel'),('developer','resource:read'),
  ('viewer','org:read'),('viewer','member:read'),('viewer','workspace:read'),('viewer','project:read'),
  ('viewer','operation:read'),('viewer','resource:read'),
  ('platform_admin','admin:org:read'),('platform_admin','admin:org:manage'),('platform_admin','admin:user:read'),
  ('platform_admin','admin:flags:manage'),('platform_admin','admin:audit:read'),
  ('support','admin:org:read'),('support','admin:user:read'),('support','admin:impersonate'),
  ('finance','admin:org:read'),('finance','admin:billing:manage'),
  ('compliance_officer','admin:audit:read'),('compliance_officer','admin:compliance:read'),
  ('security','admin:audit:read'),('security','admin:security:manage');

-- Organizations ---------------------------------------------------------------------------------
CREATE TABLE tenancy.organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  type text NOT NULL CHECK (type IN ('customer','agency','reseller')),
  country char(2) NOT NULL,
  default_locale text NOT NULL DEFAULT 'ar' CHECK (default_locale IN ('ar','en')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  suspended_reason text,
  created_by uuid NOT NULL REFERENCES identity.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX organizations_slug_idx ON tenancy.organizations (slug) WHERE deleted_at IS NULL;

CREATE TABLE tenancy.memberships (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES tenancy.organizations(id),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  role text NOT NULL REFERENCES tenancy.roles(name),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  UNIQUE (org_id, user_id)
);
CREATE INDEX memberships_user_idx ON tenancy.memberships (user_id);

CREATE TABLE tenancy.invitations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES tenancy.organizations(id),
  email text NOT NULL,
  role text NOT NULL REFERENCES tenancy.roles(name),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES identity.users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES identity.users(id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_org_idx ON tenancy.invitations (org_id, created_at DESC);
CREATE UNIQUE INDEX invitations_open_idx ON tenancy.invitations (org_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE tenancy.workspaces (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES tenancy.organizations(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  created_by uuid NOT NULL REFERENCES identity.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (org_id, id)
);
CREATE UNIQUE INDEX workspaces_slug_idx ON tenancy.workspaces (org_id, slug) WHERE deleted_at IS NULL;

CREATE TABLE tenancy.projects (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  default_region_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL REFERENCES identity.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, workspace_id) REFERENCES tenancy.workspaces (org_id, id)  -- a project can never point at another org's workspace
);
CREATE UNIQUE INDEX projects_name_idx ON tenancy.projects (workspace_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE tenancy.environments (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  kind text NOT NULL CHECK (kind IN ('dev','staging','prod')),
  data_region text NOT NULL DEFAULT 'sa-pending',  -- placeholder until M04 residency enforcement (NOT VERIFIED)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  FOREIGN KEY (org_id, project_id) REFERENCES tenancy.projects (org_id, id)
);
CREATE UNIQUE INDEX environments_name_idx ON tenancy.environments (project_id, lower(name)) WHERE deleted_at IS NULL;

-- RLS ---------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['memberships','invitations','workspaces','projects','environments'] LOOP
    EXECUTE format('ALTER TABLE tenancy.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE tenancy.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON tenancy.%I
      USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

ALTER TABLE tenancy.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON tenancy.organizations
  USING (id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.org_id', true), '')::uuid);
-- A user can see the organizations they belong to (org picker) without choosing one first.
CREATE POLICY member_visibility ON tenancy.organizations FOR SELECT
  USING (EXISTS (SELECT 1 FROM tenancy.memberships m
                  WHERE m.org_id = organizations.id
                    AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid));
CREATE POLICY own_memberships ON tenancy.memberships FOR SELECT
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY invitation_token_lookup ON tenancy.invitations FOR SELECT
  USING (current_setting('app.auth_scope', true) = 'invitation_accept');

-- Grants ------------------------------------------------------------------------------------------
GRANT SELECT ON tenancy.roles, tenancy.permissions, tenancy.role_permissions TO nuzm_app, nuzm_worker, nuzm_readonly_reporting;
GRANT SELECT, INSERT, UPDATE ON tenancy.organizations TO nuzm_app;
GRANT SELECT ON tenancy.organizations TO nuzm_worker, nuzm_readonly_reporting;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenancy.memberships, tenancy.invitations, tenancy.workspaces,
  tenancy.projects, tenancy.environments TO nuzm_app;
GRANT SELECT ON tenancy.memberships, tenancy.invitations, tenancy.workspaces, tenancy.projects, tenancy.environments TO nuzm_worker;
GRANT SELECT ON tenancy.memberships, tenancy.workspaces, tenancy.projects, tenancy.environments TO nuzm_readonly_reporting;
