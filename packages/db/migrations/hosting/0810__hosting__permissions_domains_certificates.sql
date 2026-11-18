-- M06 S25: customer permissions, site domain bindings and TLS certificates (M06 §6-§7).
--  * Permissions (org scope) for the hosting API (docs/04 §2.6): plan/site/backup/domain/ssl/database; owner and admin get all, developer everything but delete,
--    billing_admin and viewer read.
--  * site_domain_bindings: a domain is UNIQUE among verified/active bindings across ALL organizations (the unique index is global: two orgs can never both own it,
--    which prevents hijacking); pending (unverified) bindings do not reserve a name, so nobody can squat a domain they cannot prove.
--  * ssl_certificates: private keys are NEVER stored here; `secret_ref` is a vault reference (custom certificates only).
INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('hosting:plan:read','org','Read hosting plans that have capacity'),
  ('hosting:site:create','org','Create hosting sites'),
  ('hosting:site:read','org','Read hosting sites and their usage'),
  ('hosting:site:update','org','Change a hosting site (settings, plan)'),
  ('hosting:site:delete','org','Delete (offboard) a hosting site'),
  ('hosting:backup:create','org','Create hosting site backups'),
  ('hosting:backup:read','org','List hosting site backups'),
  ('hosting:backup:restore','org','Restore a hosting site from a backup'),
  ('hosting:domain:manage','org','Bind and unbind domains of a hosting site'),
  ('hosting:ssl:manage','org','Issue, renew and upload TLS certificates of a hosting site'),
  ('hosting:database:manage','org','Bind databases to a hosting site');
INSERT INTO tenancy.role_permissions SELECT r, p FROM unnest(ARRAY['owner','admin']) r, unnest(ARRAY['hosting:plan:read','hosting:site:create','hosting:site:read','hosting:site:update','hosting:site:delete','hosting:backup:create','hosting:backup:read','hosting:backup:restore','hosting:domain:manage','hosting:ssl:manage','hosting:database:manage']) p;
INSERT INTO tenancy.role_permissions SELECT 'developer', p FROM unnest(ARRAY['hosting:plan:read','hosting:site:create','hosting:site:read','hosting:site:update','hosting:backup:create','hosting:backup:read','hosting:backup:restore','hosting:domain:manage','hosting:ssl:manage','hosting:database:manage']) p;
INSERT INTO tenancy.role_permissions SELECT r, p FROM unnest(ARRAY['billing_admin','viewer']) r, unnest(ARRAY['hosting:plan:read','hosting:site:read','hosting:backup:read']) p;

CREATE TABLE hosting.site_domain_bindings (
  id uuid PRIMARY KEY,
  site_id uuid NOT NULL REFERENCES hosting.sites(id),
  org_id uuid NOT NULL,
  domain text NOT NULL CHECK (domain ~ '^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','verified','active','removed')),
  is_primary boolean NOT NULL DEFAULT false,
  verification_method text NOT NULL DEFAULT 'dns_txt' CHECK (verification_method IN ('dns_txt','http')),
  verification_token text NOT NULL CHECK (verification_token ~ '^[0-9a-f]{32}$'),
  verified_at timestamptz,
  last_checked_at timestamptz,
  removed_at timestamptz,
  operation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state IN ('verified','active')) = (verified_at IS NOT NULL AND state <> 'removed') OR state IN ('pending','removed')),
  CHECK ((state = 'removed') = (removed_at IS NOT NULL))
);
-- global uniqueness among verified/active bindings (cross-organization hijack prevention); one live binding per (site, domain)
CREATE UNIQUE INDEX site_domain_bindings_global_idx ON hosting.site_domain_bindings (domain) WHERE state IN ('verified','active');
CREATE UNIQUE INDEX site_domain_bindings_site_idx ON hosting.site_domain_bindings (site_id, domain) WHERE state <> 'removed';
CREATE UNIQUE INDEX site_domain_bindings_primary_idx ON hosting.site_domain_bindings (site_id) WHERE is_primary AND state IN ('verified','active');
CREATE INDEX site_domain_bindings_org_idx ON hosting.site_domain_bindings (org_id, site_id);

CREATE TABLE hosting.ssl_certificates (
  id uuid PRIMARY KEY,
  site_id uuid NOT NULL REFERENCES hosting.sites(id),
  org_id uuid NOT NULL,
  domains text[] NOT NULL CHECK (cardinality(domains) BETWEEN 1 AND 20),
  mode text NOT NULL CHECK (mode IN ('managed','custom')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','issued','failed','removed')),
  not_after timestamptz,
  issued_at timestamptz,
  renew_after timestamptz,
  secret_ref text CHECK (secret_ref IS NULL OR secret_ref ~ '^vault://'),
  node_cert_id text CHECK (node_cert_id IS NULL OR length(node_cert_id) <= 80),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 200),
  operation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (mode = 'custom' OR secret_ref IS NULL),
  CHECK (status <> 'issued' OR not_after IS NOT NULL)
);
CREATE INDEX ssl_certificates_site_idx ON hosting.ssl_certificates (org_id, site_id, created_at DESC);
CREATE INDEX ssl_certificates_renew_idx ON hosting.ssl_certificates (renew_after) WHERE status = 'issued';

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['site_domain_bindings','ssl_certificates'] LOOP
    EXECUTE format('ALTER TABLE hosting.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hosting.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON hosting.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY platform_admin ON hosting.%I USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin') WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON hosting.%I TO nuzm_app, nuzm_worker', t);
    EXECUTE format('GRANT SELECT ON hosting.%I TO nuzm_readonly_reporting', t);
  END LOOP;
END $$;
