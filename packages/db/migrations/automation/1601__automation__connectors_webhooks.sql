-- M11 S52: connectors (what a workflow may call and with which scopes), their authorizations (VAULT REFERENCES only), outbound webhook endpoints and the
-- append-only delivery log.
--    Rows per (endpoint, event): attempt 0 'pending' = the enqueue; for each attempt N a 'sending' CLAIM row (its next_attempt_at is the claim lease) and then ONE result row
--    ('delivered' | 'failed' with next_attempt_at | 'dead'). The unique (endpoint, event, attempt, status) makes the claim exclusive: two dispatchers cannot both send attempt N.
--  * connector types in scope: first-party Nuzm, generic HTTP, generic OAuth2 client (authorization code + PKCE, endpoints supplied by the tenant), email. No named third-party connector.
--  * connector_authorizations hold a vault reference, never a value. A revoked or expired authorization makes the connector unusable at the next step (fail closed).
--  * webhook_deliveries is APPEND-ONLY, one row per attempt (a trigger refuses UPDATE/DELETE): row attempt=0 is the enqueue, attempt N>=1 records the result of attempt N and
--    when the next attempt is due. The partial unique index makes (endpoint, event) a single delivery however often the event is redelivered.
CREATE TABLE automation.connectors (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('nuzm','http','oauth2','email')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  scopes text[] NOT NULL DEFAULT '{}' CHECK (cardinality(scopes) <= 50),
  rate_limit jsonb NOT NULL DEFAULT '{"perMinute":60,"burst":10}'::jsonb,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,             -- NON-secret: base URL, OAuth endpoints, client id, allowed hosts
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','revoked','disabled')),
  data_region text NOT NULL,
  transfer_assessment_id uuid,                           -- logical reference to compliance.transfer_assessments when the target host is outside approved regions
  version_lock int NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE INDEX connectors_org_idx ON automation.connectors (org_id, created_at DESC, id);
CREATE FUNCTION automation.connector_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.type <> OLD.type OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity and type of a connector are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  NEW.version_lock := OLD.version_lock + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER connector_guard BEFORE UPDATE ON automation.connectors FOR EACH ROW EXECUTE FUNCTION automation.connector_guard();

CREATE TABLE automation.connector_authorizations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  connector_id uuid NOT NULL REFERENCES automation.connectors(id),
  vault_ref text NOT NULL CHECK (vault_ref ~ '^vault://'),
  scopes text[] NOT NULL DEFAULT '{}',                   -- granted scopes (a subset of the connector's declared scopes)
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','revoked')),
  expires_at timestamptz,
  authorized_by uuid,
  oauth_state_hash text,                                 -- sha256 of the OAuth `state` while the authorization is pending
  pkce_verifier_ref text,                                -- vault reference of the PKCE verifier while pending
  revoked_at timestamptz,
  revoked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX connector_auth_idx ON automation.connector_authorizations (connector_id, created_at DESC);
CREATE UNIQUE INDEX connector_auth_state_idx ON automation.connector_authorizations (oauth_state_hash) WHERE oauth_state_hash IS NOT NULL AND status = 'pending';

CREATE TABLE automation.webhook_endpoints (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  url text NOT NULL CHECK (length(url) <= 2048 AND url ~ '^https://'),
  events text[] NOT NULL CHECK (cardinality(events) BETWEEN 1 AND 20),
  description text CHECK (description IS NULL OR length(description) <= 200),
  secret_vault_ref text NOT NULL CHECK (secret_vault_ref ~ '^vault://'),
  previous_secret_vault_ref text CHECK (previous_secret_vault_ref IS NULL OR previous_secret_vault_ref ~ '^vault://'),
  previous_secret_expires_at timestamptz,                -- rotation overlap: both secrets sign until this time
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled')),
  consecutive_failures int NOT NULL DEFAULT 0,
  data_region text NOT NULL,
  version_lock int NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_org_idx ON automation.webhook_endpoints (org_id, created_at DESC, id);
CREATE FUNCTION automation.endpoint_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.url <> OLD.url OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity and URL of a webhook endpoint are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  NEW.version_lock := OLD.version_lock + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER endpoint_guard BEFORE UPDATE ON automation.webhook_endpoints FOR EACH ROW EXECUTE FUNCTION automation.endpoint_guard();

CREATE TABLE automation.webhook_deliveries (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  endpoint_id uuid NOT NULL REFERENCES automation.webhook_endpoints(id),
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  topic text NOT NULL,
  attempt int NOT NULL CHECK (attempt >= 0),
  status text NOT NULL CHECK (status IN ('pending','sending','delivered','failed','dead')),
  status_code int,
  error text CHECK (error IS NULL OR length(error) <= 500),
  payload jsonb,                                         -- only on attempt 0: the event body that is signed and sent (customer-content)
  next_attempt_at timestamptz,
  duration_ms int,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id, attempt, status)
);
CREATE UNIQUE INDEX webhook_deliveries_once_idx ON automation.webhook_deliveries (endpoint_id, event_id) WHERE attempt = 0;
CREATE INDEX webhook_deliveries_due_idx ON automation.webhook_deliveries (next_attempt_at) WHERE next_attempt_at IS NOT NULL;
CREATE INDEX webhook_deliveries_endpoint_idx ON automation.webhook_deliveries (endpoint_id, created_at DESC);
CREATE TRIGGER webhook_deliveries_append_only BEFORE UPDATE OR DELETE ON automation.webhook_deliveries FOR EACH ROW EXECUTE FUNCTION automation.immutable_row();
CREATE TRIGGER webhook_deliveries_no_truncate BEFORE TRUNCATE ON automation.webhook_deliveries FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['connectors','connector_authorizations','webhook_endpoints','webhook_deliveries'] LOOP
    EXECUTE format('ALTER TABLE automation.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE automation.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON automation.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY platform_read ON automation.%I FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT, INSERT ON automation.%I TO nuzm_app, nuzm_worker', t);
    EXECUTE format('GRANT SELECT ON automation.%I TO nuzm_readonly_reporting', t);
  END LOOP;
END $$;
GRANT UPDATE (scopes, rate_limit, config, status, transfer_assessment_id) ON automation.connectors TO nuzm_app, nuzm_worker;
GRANT UPDATE (status, vault_ref, scopes, expires_at, authorized_by, oauth_state_hash, pkce_verifier_ref, revoked_at, revoked_by) ON automation.connector_authorizations TO nuzm_app, nuzm_worker;
GRANT UPDATE (events, description, secret_vault_ref, previous_secret_vault_ref, previous_secret_expires_at, status, consecutive_failures) ON automation.webhook_endpoints TO nuzm_app, nuzm_worker;
