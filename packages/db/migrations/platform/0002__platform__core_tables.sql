-- M01 S02: platform mechanisms (docs/04 §1, docs/02 §3). org_id FKs to tenancy.organizations are
-- added by the tenancy migration in S03 (tenancy does not exist yet).
-- RLS: every org_id table is ENABLED + FORCED. Worker access: explicit org switch
-- (SET LOCAL app.org_id) or the audited claim scope (SET LOCAL app.worker_scope = 'claim').

CREATE TABLE platform.operations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  kind text NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','running','waiting_provider','succeeded','failed','cancelled','needs_reconcile')),
  resource_kind text,
  resource_id uuid,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  error jsonb,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  idempotency_key text,
  trace_id text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);
CREATE INDEX operations_due_idx ON platform.operations (next_run_at)
  WHERE state IN ('pending','running','waiting_provider','needs_reconcile');
CREATE INDEX operations_org_idx ON platform.operations (org_id, created_at DESC);

CREATE TABLE platform.operation_steps (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  operation_id uuid NOT NULL REFERENCES platform.operations(id) ON DELETE CASCADE,
  seq int NOT NULL,
  name text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','succeeded','failed','skipped')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (operation_id, seq)
);

CREATE TABLE platform.outbox (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  lock_until timestamptz,
  published_at timestamptz
);
CREATE INDEX outbox_unpublished_idx ON platform.outbox (created_at) WHERE published_at IS NULL;

CREATE TABLE platform.idempotency_keys (
  org_id uuid NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL DEFAULT 'in_progress' CHECK (state IN ('in_progress','completed')),
  response_status int,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (org_id, key)
);

CREATE TABLE platform.feature_flags (
  id uuid PRIMARY KEY,
  key text NOT NULL,
  org_id uuid,
  value jsonb NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX feature_flags_scope_idx
  ON platform.feature_flags (key, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE platform.notifications (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  kind text NOT NULL,
  body jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON platform.notifications (org_id, user_id, created_at DESC);

-- Tenant-less: provider callbacks arrive before an org is known; deduped by (provider, event_id).
CREATE TABLE platform.webhook_events_inbound (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  event_id text NOT NULL,
  signature_ok boolean NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, event_id)
);

-- RLS --------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['operations','operation_steps','outbox','idempotency_keys','notifications'] LOOP
    EXECUTE format('ALTER TABLE platform.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE platform.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON platform.%I
      USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- Worker claim scope: only the worker role, only while app.worker_scope = 'claim'.
CREATE POLICY worker_claim ON platform.operations TO nuzm_worker
  USING (current_setting('app.worker_scope', true) = 'claim');
CREATE POLICY worker_claim ON platform.outbox TO nuzm_worker
  USING (current_setting('app.worker_scope', true) = 'claim');

-- Feature flags: global (org_id NULL) readable by all runtime roles; org flags need org context;
-- global writes are break-glass/admin only.
ALTER TABLE platform.feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.feature_flags FORCE ROW LEVEL SECURITY;
CREATE POLICY flags_read ON platform.feature_flags FOR SELECT
  USING (org_id IS NULL OR org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY flags_org_write ON platform.feature_flags FOR ALL
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY flags_admin ON platform.feature_flags TO nuzm_admin_breakglass USING (true) WITH CHECK (true);

-- Grants (least privilege) ------------------------------------------------------------------
GRANT USAGE ON SCHEMA platform TO nuzm_admin_breakglass;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.operations, platform.operation_steps,
  platform.idempotency_keys, platform.notifications, platform.feature_flags TO nuzm_app, nuzm_worker;
GRANT SELECT, INSERT ON platform.outbox TO nuzm_app;
GRANT SELECT, INSERT, UPDATE ON platform.outbox TO nuzm_worker;
GRANT SELECT, INSERT, UPDATE ON platform.webhook_events_inbound TO nuzm_app, nuzm_worker;
GRANT SELECT ON platform.operations, platform.notifications, platform.feature_flags TO nuzm_readonly_reporting;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.feature_flags TO nuzm_admin_breakglass;
