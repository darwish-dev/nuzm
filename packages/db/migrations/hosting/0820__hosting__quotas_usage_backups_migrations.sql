-- M06 S26: per-site quotas, quota notification dedupe, usage reports, backups and node-to-node migrations (M06 §7, §4 tasks 10-13).
--  * site_quotas: one row per site and dimension (disk_mb, inodes, bandwidth_gb, processes, memory_mb, db_count, backup_count, backup_gb); `soft_limit` warns, `limit_value` blocks.
--  * quota_events: UNIQUE (site, dim, threshold, period): a threshold notifies ONCE per period (the insert is the arbiter).
--  * site_usage_reports: what the agent reported (hourly); the latest row is the usage summary of the site.
--  * site_backups: encrypted per-site archives; the archive lives in the sink, the row keeps only the reference, the checksum and the manifest (path, sha256, bytes; NEVER file content or keys).
--  * site_migrations: drain/maintenance moves (backup -> restore on target -> verify -> switch -> notify); the source stays until verified (admin scope only).
CREATE TABLE hosting.site_quotas (
  site_id uuid NOT NULL REFERENCES hosting.sites(id),
  org_id uuid NOT NULL,
  dim text NOT NULL CHECK (dim IN ('disk_mb','inodes','bandwidth_gb','processes','memory_mb','db_count','backup_count','backup_gb')),
  limit_value bigint NOT NULL CHECK (limit_value >= 0),
  soft_limit bigint NOT NULL CHECK (soft_limit >= 0),
  state text NOT NULL DEFAULT 'ok' CHECK (state IN ('ok','soft','hard')),
  enforced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, dim),
  CHECK (soft_limit <= limit_value)
);
CREATE TABLE hosting.quota_events (
  id uuid PRIMARY KEY,
  site_id uuid NOT NULL REFERENCES hosting.sites(id),
  org_id uuid NOT NULL,
  dim text NOT NULL,
  threshold text NOT NULL CHECK (threshold IN ('soft','hard')),
  period text NOT NULL DEFAULT '' CHECK (length(period) <= 20),
  observed bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, dim, threshold, period)
);
CREATE TABLE hosting.site_usage_reports (
  site_id uuid NOT NULL REFERENCES hosting.sites(id),
  org_id uuid NOT NULL,
  period_start timestamptz NOT NULL,
  disk_bytes bigint NOT NULL CHECK (disk_bytes >= 0),
  inodes bigint NOT NULL CHECK (inodes >= 0),
  bandwidth_bytes_month bigint NOT NULL CHECK (bandwidth_bytes_month >= 0),
  backup_bytes bigint NOT NULL DEFAULT 0 CHECK (backup_bytes >= 0),
  processes int NOT NULL DEFAULT 0 CHECK (processes >= 0),
  cpu_seconds bigint NOT NULL DEFAULT 0 CHECK (cpu_seconds >= 0),
  reported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, period_start)
);
CREATE TABLE hosting.site_backups (
  id uuid PRIMARY KEY,
  site_id uuid NOT NULL REFERENCES hosting.sites(id),
  org_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'on_demand' CHECK (kind IN ('scheduled','on_demand','pre_restore','pre_migration','export')),
  label text CHECK (label IS NULL OR length(label) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','available','failed','corrupt','deleted')),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  checksum text CHECK (checksum IS NULL OR checksum ~ '^[0-9a-f]{64}$'),
  manifest jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(manifest) = 'array'),
  enc_key_ref text NOT NULL CHECK (enc_key_ref ~ '^vault://'),
  sink_kind text CHECK (sink_kind IS NULL OR sink_kind IN ('node-local-segregated','production-in-region')),
  sink_ref text CHECK (sink_ref IS NULL OR length(sink_ref) <= 300),
  data_region text NOT NULL CHECK (data_region ~ '^[A-Za-z0-9._-]{2,40}$'),
  failure_reason text CHECK (failure_reason IS NULL OR length(failure_reason) <= 200),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  deleted_at timestamptz,
  CHECK ((status = 'available') = (checksum IS NOT NULL AND size_bytes IS NOT NULL AND sink_ref IS NOT NULL) OR status <> 'available')
);
CREATE INDEX site_backups_site_idx ON hosting.site_backups (org_id, site_id, created_at DESC, id);
CREATE TABLE hosting.site_migrations (
  id uuid PRIMARY KEY,
  site_id uuid NOT NULL REFERENCES hosting.sites(id),
  from_node_id uuid NOT NULL REFERENCES hosting.nodes(id),
  to_node_id uuid NOT NULL REFERENCES hosting.nodes(id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','backing_up','restoring','verifying','switched','failed','rolled_back')),
  backup_id uuid,
  operation_id uuid,
  error text CHECK (error IS NULL OR length(error) <= 300),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_node_id <> to_node_id)
);
CREATE UNIQUE INDEX site_migrations_one_active_idx ON hosting.site_migrations (site_id) WHERE state IN ('pending','backing_up','restoring','verifying');

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['site_quotas','quota_events','site_usage_reports','site_backups'] LOOP
    EXECUTE format('ALTER TABLE hosting.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hosting.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON hosting.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY platform_admin ON hosting.%I USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin') WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON hosting.%I TO nuzm_app, nuzm_worker', t);
    EXECUTE format('GRANT SELECT ON hosting.%I TO nuzm_readonly_reporting', t);
  END LOOP;
  ALTER TABLE hosting.site_migrations ENABLE ROW LEVEL SECURITY;
  ALTER TABLE hosting.site_migrations FORCE ROW LEVEL SECURITY;
  CREATE POLICY platform_admin ON hosting.site_migrations USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin') WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
  GRANT SELECT, INSERT, UPDATE ON hosting.site_migrations TO nuzm_app, nuzm_worker;
  GRANT SELECT ON hosting.site_migrations TO nuzm_readonly_reporting;
END $$;
-- a backup row never loses its identity: only status/size/checksum/manifest/sink/failure/expiry/deletion move
CREATE FUNCTION hosting.backup_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.site_id <> OLD.site_id OR NEW.org_id <> OLD.org_id OR NEW.enc_key_ref <> OLD.enc_key_ref OR NEW.data_region <> OLD.data_region OR NEW.kind <> OLD.kind OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a backup keeps its site, organization, key, region and kind' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER backup_guard BEFORE UPDATE ON hosting.site_backups FOR EACH ROW EXECUTE FUNCTION hosting.backup_guard();
