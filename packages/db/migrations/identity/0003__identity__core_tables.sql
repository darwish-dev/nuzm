-- M01 S02: identity. Users, sessions, MFA are user-scoped (no org_id) and listed as tenant_less in
-- spec/db/ownership.yaml; they hold hashes and vault references only, never secrets in plaintext.
CREATE SCHEMA IF NOT EXISTS identity;
GRANT USAGE ON SCHEMA identity TO nuzm_app, nuzm_worker, nuzm_readonly_reporting;

CREATE TABLE identity.users (
  id uuid PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  email text NOT NULL,
  email_verified boolean NOT NULL DEFAULT false,
  display_name text,
  locale text NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar','en')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  is_platform_user boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  UNIQUE (issuer, subject)
);
CREATE UNIQUE INDEX users_email_idx ON identity.users (lower(email), issuer);

CREATE TABLE identity.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  realm text NOT NULL DEFAULT 'web' CHECK (realm IN ('web','admin')),
  token_hash text NOT NULL UNIQUE,
  csrf_hash text NOT NULL,
  mfa_level text NOT NULL DEFAULT 'none' CHECK (mfa_level IN ('none','totp','recovery')),
  mfa_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip text,
  user_agent text
);
CREATE INDEX sessions_user_idx ON identity.sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE identity.mfa_factors (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('totp')),
  secret_ref text NOT NULL,                 -- vault://… reference, never the secret itself
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active')),
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_used_step bigint,                    -- TOTP replay protection (RFC 6238 time step)
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz
);
CREATE UNIQUE INDEX mfa_one_pending_idx ON identity.mfa_factors (user_id, type) WHERE status = 'pending';
CREATE UNIQUE INDEX mfa_one_active_idx ON identity.mfa_factors (user_id, type) WHERE status = 'active';

CREATE TABLE identity.recovery_codes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recovery_user_idx ON identity.recovery_codes (user_id) WHERE used_at IS NULL;

CREATE TABLE identity.api_keys (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES identity.users(id),
  name text NOT NULL,
  prefix text NOT NULL UNIQUE,
  secret_hash text NOT NULL,                -- argon2id
  scopes text[] NOT NULL,
  ip_allow_list text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_org_idx ON identity.api_keys (org_id);
ALTER TABLE identity.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON identity.api_keys
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
-- Key lookup by prefix happens before the org is known (the key identifies the org):
CREATE POLICY api_key_lookup ON identity.api_keys FOR SELECT TO nuzm_app
  USING (current_setting('app.auth_scope', true) = 'api_key_lookup');

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.users, identity.sessions, identity.mfa_factors,
  identity.recovery_codes, identity.api_keys TO nuzm_app;
GRANT SELECT, UPDATE ON identity.sessions TO nuzm_worker;
GRANT SELECT ON identity.users, identity.sessions, identity.mfa_factors TO nuzm_readonly_reporting;
