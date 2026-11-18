-- M12 S55: enterprise SSO connections (SAML 2.0 / OIDC), verified email domains, SCIM tokens and identities.
-- NOTE for the owner (manifest items): docs/05 lists only identity.sso_connections and identity.scim_tokens for M12. Three supporting tables are
-- added here and need the manifest entry: sso_domain_proofs (domain claims: "409 domain claimed" needs a uniqueness rule across organizations),
-- sso_assertion_replays (the SAML replay cache must survive restarts and be shared by instances) and scim_identities (SCIM externalId -> user,
-- per organization, for idempotent create). Numbering starts at 1710 because 1700 is identity.credentials (customer sign-in work, ADR-008).
-- Everything here is org-scoped (org_id + RLS); secrets are never stored: OIDC client secrets are vault references, SCIM tokens are SHA-256 hashes.
CREATE TABLE identity.sso_connections (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  protocol text NOT NULL CHECK (protocol IN ('saml','oidc')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),   -- public IdP metadata only: entity id, endpoints, signing certificates (PEM), issuer, client id
  vault_ref text CHECK (vault_ref IS NULL OR vault_ref ~ '^vault://'),                  -- OIDC client secret reference; never the secret
  domains text[] NOT NULL DEFAULT '{}',                                                 -- claimed email domains
  verified_domains text[] NOT NULL DEFAULT '{}',                                        -- subset proven through DNS TXT (identity.sso_domain_proofs)
  jit jsonb NOT NULL DEFAULT '{"enabled":false,"defaultRole":"viewer"}'::jsonb,
  enforce boolean NOT NULL DEFAULT false,
  idp_initiated boolean NOT NULL DEFAULT false,                                          -- IdP-initiated SAML is OFF unless explicitly enabled (M12 §9)
  status text NOT NULL DEFAULT 'pending_domain_proof' CHECK (status IN ('pending_domain_proof','active','disabled')),
  last_test_result jsonb,                                                                -- test login outcome; written by the SSO flow (SCR-M12-05, not yet approved)
  created_by uuid NOT NULL,
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  CHECK (jsonb_typeof(jit) = 'object' AND jit ? 'enabled' AND jit ? 'defaultRole'),
  -- JIT never grants administrative roles (M12 §9): owner/admin and every platform role are refused at the database.
  CHECK (jit->>'defaultRole' IN ('viewer','developer','billing_admin')),
  CHECK (verified_domains <@ domains),
  CHECK (NOT enforce OR (status = 'active' AND cardinality(verified_domains) > 0))
);
CREATE INDEX sso_connections_org_idx ON identity.sso_connections (org_id, created_at DESC);
CREATE UNIQUE INDEX sso_connections_idem_idx ON identity.sso_connections (org_id, created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX sso_connections_verified_domains_idx ON identity.sso_connections USING gin (verified_domains);

CREATE TABLE identity.sso_domain_proofs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES identity.sso_connections(id) ON DELETE CASCADE,
  domain text NOT NULL CHECK (domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
  token text NOT NULL CHECK (token ~ '^[A-Za-z0-9_-]{22,64}$'),           -- the public TXT challenge value (published in DNS by design)
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified')),
  checked_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, domain),
  CHECK ((status = 'verified') = (verified_at IS NOT NULL))
);
-- a domain can be verified for exactly ONE organization (409 domain claimed)
CREATE UNIQUE INDEX sso_domain_proofs_verified_idx ON identity.sso_domain_proofs (domain) WHERE status = 'verified';
CREATE INDEX sso_domain_proofs_pending_idx ON identity.sso_domain_proofs (checked_at NULLS FIRST) WHERE status = 'pending';

CREATE TABLE identity.sso_assertion_replays (
  connection_id uuid NOT NULL REFERENCES identity.sso_connections(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  assertion_hash text NOT NULL CHECK (assertion_hash ~ '^[0-9a-f]{64}$'),  -- SHA-256 of the assertion id; never the assertion
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, assertion_hash)
);
CREATE INDEX sso_assertion_replays_expiry_idx ON identity.sso_assertion_replays (expires_at);

CREATE TABLE identity.scim_tokens (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES identity.sso_connections(id),
  prefix text NOT NULL UNIQUE CHECK (prefix ~ '^nzscim_[A-Za-z0-9]{8}$'),  -- non-secret lookup prefix
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),   -- SHA-256 of the whole token; the token is shown once
  scopes text[] NOT NULL DEFAULT '{scim}',
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scim_tokens_org_idx ON identity.scim_tokens (org_id, created_at DESC);

CREATE TABLE identity.scim_identities (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES identity.sso_connections(id),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 255),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deprovisioned_at timestamptz,
  UNIQUE (org_id, external_id),
  UNIQUE (org_id, user_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sso_connections','sso_domain_proofs','sso_assertion_replays','scim_tokens','scim_identities'] LOOP
    EXECUTE format('ALTER TABLE identity.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE identity.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON identity.%I
      USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- Pre-org lookups (the connection or the token identifies the organization): read-only auth scopes.
CREATE POLICY sso_lookup ON identity.sso_connections FOR SELECT TO nuzm_app
  USING (current_setting('app.auth_scope', true) = 'sso_lookup');
CREATE POLICY scim_lookup ON identity.scim_tokens FOR SELECT TO nuzm_app
  USING (current_setting('app.auth_scope', true) = 'scim_lookup');
CREATE POLICY scim_lookup_touch ON identity.scim_tokens FOR UPDATE TO nuzm_app
  USING (current_setting('app.auth_scope', true) = 'scim_lookup')
  WITH CHECK (current_setting('app.auth_scope', true) = 'scim_lookup');
-- Email-domain discovery for the sign-in page ("is this domain enforced?") happens before any org is known.
CREATE POLICY sso_domain_lookup ON identity.sso_domain_proofs FOR SELECT TO nuzm_app
  USING (current_setting('app.auth_scope', true) = 'sso_lookup');
-- The domain verifier is a platform job (cross-organization, claim scope; the GUC is set only by Db.withWorkerClaim).
CREATE POLICY worker_verifier ON identity.sso_domain_proofs
  USING (current_setting('app.worker_scope', true) = 'claim')
  WITH CHECK (current_setting('app.worker_scope', true) = 'claim');
CREATE POLICY worker_verifier_conn ON identity.sso_connections
  USING (current_setting('app.worker_scope', true) = 'claim')
  WITH CHECK (current_setting('app.worker_scope', true) = 'claim');

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.sso_connections, identity.sso_domain_proofs, identity.sso_assertion_replays,
  identity.scim_tokens, identity.scim_identities TO nuzm_app;
GRANT SELECT, UPDATE ON identity.sso_connections, identity.sso_domain_proofs TO nuzm_worker;
GRANT DELETE ON identity.sso_assertion_replays TO nuzm_worker;
GRANT SELECT ON identity.sso_connections, identity.scim_tokens TO nuzm_readonly_reporting;
