-- S04: a VPS that installs HestiaCP automatically (Alibaba ECS via SCCC Riyadh `me-central-1`, Contabo `EU`), owner request 2026-11-24 (ADR-067 §5).
--  * compute.panel_image_approvals: an administrator's approval that ONE provider image (account + region + image ref) is verified for ONE Hestia version. A customer is only offered
--    Hestia on an approved image (docs: Hestia supports Debian 12/13 and Ubuntu 22.04/24.04/26.04; the provider must also state cloud-init support). Platform table (admin scope).
--  * compute.panel_installs: the staged install of the panel on one customer VPS: ONE row per order and per instance (a unique constraint, not application code, prevents a second
--    server for the same order). It holds the order SNAPSHOT (image, template, region, provider plan, pinned installer), the state of every step and the single-use registration
--    record (hash only: the secret is derived, never stored). Tenant data (RLS).
--  * compute.instances: `held` (the provider has no capacity in the sold region; the order waits, it is NEVER re-routed to another region) and `panel_kind`.
--  * compute.images: `cloud_init` as stated by the provider's own listing.
ALTER TABLE compute.instances DROP CONSTRAINT IF EXISTS instances_status_check;
ALTER TABLE compute.instances ADD CONSTRAINT instances_status_check
  CHECK (status IN ('provisioning','running','stopped','failed','deleting','deleted','unknown','held'));
ALTER TABLE compute.instances
  ADD COLUMN panel_kind text NOT NULL DEFAULT 'none' CHECK (panel_kind IN ('none','hestia')),
  ADD COLUMN hold_reason text CHECK (hold_reason IS NULL OR hold_reason IN ('provider_capacity_unavailable')),
  ADD COLUMN held_at timestamptz,
  ADD CONSTRAINT instances_hold_has_reason CHECK (status <> 'held' OR hold_reason IS NOT NULL);
ALTER TABLE compute.images ADD COLUMN cloud_init boolean;

CREATE TABLE compute.panel_image_approvals (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL,                       -- logical reference to cloud.provider_accounts
  provider_region_id text NOT NULL,
  image_ref text NOT NULL,
  panel_kind text NOT NULL CHECK (panel_kind IN ('hestia')),
  panel_version text NOT NULL CHECK (panel_version ~ '^[0-9]{1,3}(\.[0-9]{1,3}){1,3}$'),
  os_id text NOT NULL CHECK (os_id IN ('debian','ubuntu')),
  os_version text NOT NULL CHECK (os_version ~ '^[0-9]{1,2}(\.[0-9]{2})?$'),
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('live','fixture','mock')),
  evidence_note text NOT NULL CHECK (length(evidence_note) BETWEEN 3 AND 500),
  approved_by uuid NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (account_id, provider_region_id, image_ref, panel_kind, panel_version)
);

CREATE TABLE compute.panel_installs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  instance_id uuid NOT NULL UNIQUE REFERENCES compute.instances(id),
  order_id uuid NOT NULL UNIQUE,                  -- one panel install (hence one server) per order
  panel_kind text NOT NULL CHECK (panel_kind IN ('hestia')),
  -- the order snapshot
  provider_key text NOT NULL,
  provider_region_id text NOT NULL,
  plan_ref text NOT NULL,
  image_ref text NOT NULL,
  image_name text NOT NULL,
  os_id text NOT NULL,
  os_version text NOT NULL,
  template jsonb NOT NULL CHECK (jsonb_typeof(template) = 'object'),   -- {id, mail}: the explicit service choice
  panel_version text NOT NULL,
  installer_url text NOT NULL,
  installer_sha256 text NOT NULL CHECK (installer_sha256 ~ '^[0-9a-f]{64}$'),
  panel_host text NOT NULL CHECK (panel_host ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),   -- the FIXED FQDN of the panel, decided at order time
  panel_port int NOT NULL DEFAULT 8083 CHECK (panel_port BETWEEN 1 AND 65535),
  -- progress
  stage text NOT NULL DEFAULT 'create_server' CHECK (stage IN ('create_server','waiting_boot','installing_panel','registering','readiness','ready','needs_attention','held')),
  resume_stage text CHECK (resume_stage IS NULL OR resume_stage IN ('create_server','waiting_boot','installing_panel','registering','readiness')),
  steps jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(steps) = 'object'),
  attention_code text CHECK (attention_code IS NULL OR attention_code ~ '^[a-z0-9_]{3,60}$'),
  attention_detail text CHECK (attention_detail IS NULL OR length(attention_detail) <= 300),
  attempts int NOT NULL DEFAULT 0,
  server_ref text,                                -- the provider reference this install is bound to
  server_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
  boot_seen_at timestamptz,
  last_event_at timestamptz,
  stage_entered_at timestamptz NOT NULL DEFAULT now(),
  -- the single-use registration record (bound to this order, this instance and this server)
  registration_id uuid NOT NULL UNIQUE,
  registration_hash text NOT NULL CHECK (registration_hash ~ '^[0-9a-f]{64}$'),
  registration_secret_ref text CHECK (registration_secret_ref IS NULL OR registration_secret_ref ~ '^vault://[A-Za-z0-9][A-Za-z0-9._/-]{1,200}$'),   -- sealed; read only to build the (identical-on-retry) user data; deleted once consumed
  registration_expires_at timestamptz,            -- set when the server was created: the window starts with the server, not with the order
  registration_consumed_at timestamptz,
  registration_source_ip text,
  -- the registered panel connection
  panel_node_id uuid,                             -- logical reference to hosting.nodes (no cross-schema FK)
  panel_link text NOT NULL DEFAULT 'none' CHECK (panel_link IN ('none','connected','lost')),
  panel_link_checked_at timestamptz,
  panel_version_seen text,
  ready_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  CHECK ((stage = 'needs_attention') = (attention_code IS NOT NULL)),
  CHECK (registration_consumed_at IS NULL OR registration_source_ip IS NOT NULL)
);
CREATE INDEX panel_installs_open_idx ON compute.panel_installs (stage) WHERE stage NOT IN ('ready');
CREATE INDEX panel_installs_org_idx ON compute.panel_installs (org_id, created_at DESC);

ALTER TABLE compute.panel_installs ENABLE ROW LEVEL SECURITY;
ALTER TABLE compute.panel_installs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON compute.panel_installs USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON compute.panel_installs FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT, UPDATE ON compute.panel_installs TO nuzm_app;
GRANT SELECT ON compute.panel_installs TO nuzm_worker, nuzm_readonly_reporting;

ALTER TABLE compute.panel_image_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE compute.panel_image_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_admin ON compute.panel_image_approvals USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT, UPDATE ON compute.panel_image_approvals TO nuzm_app;
GRANT SELECT ON compute.panel_image_approvals TO nuzm_readonly_reporting;
