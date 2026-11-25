-- Provisioning network details per provider and region, typed by an administrator in the admin console (owner request 2026-11-24).
--  * Alibaba ECS needs a vSwitch + security group, Huawei ECS a VPC + subnet + security group (and the project id of the region) to create a server. Until now they
--    came from the CLOUD_VENDOR_CONFIG environment variable; the console now owns them and the environment value stays only as a fallback.
--  * These are resource IDENTIFIERS of the owner's own cloud account, never credentials: no secret column exists (the keys are in the vault, see provider_accounts.vault_ref).
--  * Platform (admin console) scope only. A missing row means "not configured": provisioning in that region is refused, never guessed.
CREATE TABLE cloud.provider_network_settings (
  provider_key text NOT NULL CHECK (provider_key IN ('alibaba','huawei')),
  region_id text NOT NULL CHECK (region_id ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_key, region_id)
);
ALTER TABLE cloud.provider_network_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud.provider_network_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_admin ON cloud.provider_network_settings
  USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT ON cloud.provider_network_settings TO nuzm_readonly_reporting;
GRANT SELECT, INSERT, UPDATE, DELETE ON cloud.provider_network_settings TO nuzm_app;
