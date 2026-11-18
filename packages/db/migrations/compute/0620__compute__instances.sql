-- M05 S17: compute schema (instances, actions, images, snapshots, running intervals) and the permissions of the compute API.
--  * compute.instances.resource_id is an OPAQUE logical reference to cloud.resources (no cross-schema FK, docs/05); quote_id/order_id likewise.
--  * Instances are tenant data (RLS); images are a tenant-less catalogue written by catalog syncs (admin scope) and read by the wizard through the service.
--  * Personal-data columns: ssh_public_keys (class internal), public_ips (class personal in some contexts; classified personal, retention per M04).
CREATE SCHEMA IF NOT EXISTS compute;
GRANT USAGE ON SCHEMA compute TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('offers:read','org','Browse compute offers (verified inventory only)'),
  ('compute:quote:create','org','Create compute quotes'),
  ('compute:instance:create','org','Create compute instances from a quote'),
  ('compute:instance:read','org','Read compute instances, their metrics and snapshots'),
  ('compute:instance:act','org','Start, stop, reboot, resize and snapshot compute instances'),
  ('compute:instance:delete','org','Delete compute instances');
INSERT INTO tenancy.role_permissions SELECT r, p FROM unnest(ARRAY['owner','admin','developer']) r, unnest(ARRAY['compute:quote:create','compute:instance:create','compute:instance:act','compute:instance:delete']) p;
INSERT INTO tenancy.role_permissions SELECT r, p FROM unnest(ARRAY['owner','admin','billing_admin','developer','viewer']) r, unnest(ARRAY['offers:read','compute:instance:read']) p;

CREATE TABLE compute.instances (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid,
  environment_id uuid,
  resource_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  plan jsonb NOT NULL,                              -- {vcpu, memoryMb, diskGb, bandwidth?}
  status text NOT NULL CHECK (status IN ('provisioning','running','stopped','failed','deleting','deleted','unknown')),
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,  -- capability ids supported by the account when the instance was placed
  quote_id uuid NOT NULL,
  order_id uuid,
  data_region text NOT NULL,
  country char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  public_ips jsonb NOT NULL DEFAULT '[]'::jsonb,
  ssh_public_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags jsonb NOT NULL DEFAULT '{}'::jsonb,
  deletion_protected boolean NOT NULL DEFAULT false,
  operation_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  UNIQUE (org_id, quote_id)                          -- a quote provisions at most one instance request
);
CREATE INDEX instances_org_status_idx ON compute.instances (org_id, status);
CREATE INDEX instances_org_created_idx ON compute.instances (org_id, created_at DESC, id);

CREATE TABLE compute.instance_actions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  instance_id uuid NOT NULL REFERENCES compute.instances(id),
  type text NOT NULL CHECK (type IN ('start','stop','reboot','resize','snapshot')),
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  operation_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed','needs_reconcile')),
  idempotency_key text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instance_id, idempotency_key)
);

CREATE TABLE compute.snapshots (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  instance_id uuid NOT NULL REFERENCES compute.instances(id),
  provider_ref text,
  size_gb numeric(14,3) CHECK (size_gb IS NULL OR size_gb >= 0),   -- NULL until the provider reports it (snapshot metering stays NOT VERIFIED without it)
  data_region text NOT NULL,                                        -- snapshots inherit the instance's region
  state text NOT NULL DEFAULT 'creating' CHECK (state IN ('creating','available','failed','deleted')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE compute.instance_intervals (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  instance_id uuid NOT NULL REFERENCES compute.instances(id),
  resource_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  vcpu int NOT NULL CHECK (vcpu > 0),
  memory_mb int NOT NULL CHECK (memory_mb > 0),
  disk_gb int NOT NULL CHECK (disk_gb > 0),
  data_region text NOT NULL,
  emitted_until timestamptz,                                         -- usage emitted for [started_at, emitted_until)
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX instance_intervals_open_idx ON compute.instance_intervals (instance_id) WHERE ended_at IS NULL;
-- At most one OPEN interval per instance: a duplicate "running" observation can never double count.
CREATE UNIQUE INDEX instance_intervals_one_open ON compute.instance_intervals (instance_id) WHERE ended_at IS NULL;

CREATE TABLE compute.images (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL,                                          -- logical reference to cloud.provider_accounts
  provider_region_id text NOT NULL,
  image_ref text NOT NULL,
  name text NOT NULL,
  os_family text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_region_id, image_ref)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['instances','instance_actions','snapshots','instance_intervals'] LOOP
    EXECUTE format('ALTER TABLE compute.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE compute.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON compute.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
                      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY platform_read ON compute.%I FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON compute.%I TO nuzm_app', t);
    EXECUTE format('GRANT SELECT ON compute.%I TO nuzm_worker, nuzm_readonly_reporting', t);
  END LOOP;
END $$;
ALTER TABLE compute.images ENABLE ROW LEVEL SECURITY;
ALTER TABLE compute.images FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_admin ON compute.images USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT, UPDATE ON compute.images TO nuzm_app;
GRANT SELECT ON compute.images TO nuzm_readonly_reporting;
