-- HestiaCP S06 + the WordPress part of S03 (ADR-068): off-server backups through Hestia, managed WordPress, restore drills, monitoring alerts.
--  * nodes.purpose: a `restore_drill` node is an isolated machine that never takes customer sites (the CHECK keeps it out of `active`); restore tests run there.
--  * plan_definitions.app_kind / sites.app_kind: a plan can carry an application that is installed after the site exists (`wordpress`).
--  * site_backups.archive_name / provider_state: the Hestia archive name and the idempotency state of the schedule/poll (what was there before, whether it was scheduled).
--  * site_apps: the installed application of a site, its observed phase, verification evidence and the ONE-TIME handover of the admin secret (vault references only).
--  * restore_drills: a restore of a real backup into an isolated node, with its duration and result (admin scope only).
--  * monitor_alerts: de-duplicated operational alerts (capacity, activation, certificates, backups, panel link); one OPEN row per (kind, scope) (admin scope only).
ALTER TABLE hosting.nodes
  ADD COLUMN purpose text NOT NULL DEFAULT 'customer' CHECK (purpose IN ('customer','restore_drill')),
  ADD CONSTRAINT nodes_drill_never_active CHECK (purpose = 'customer' OR status IN ('maintenance','retired'));
ALTER TABLE hosting.plan_definitions ADD COLUMN app_kind text NOT NULL DEFAULT 'none' CHECK (app_kind IN ('none','wordpress'));
ALTER TABLE hosting.sites ADD COLUMN app_kind text NOT NULL DEFAULT 'none' CHECK (app_kind IN ('none','wordpress'));
ALTER TABLE hosting.site_backups
  ADD COLUMN archive_name text CHECK (archive_name IS NULL OR archive_name ~ '^[A-Za-z0-9._-]{1,120}$'),
  ADD COLUMN provider_state jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provider_state) = 'object');

CREATE TABLE hosting.site_apps (
  id uuid PRIMARY KEY,
  site_id uuid NOT NULL UNIQUE REFERENCES hosting.sites(id),
  org_id uuid NOT NULL,
  app text NOT NULL CHECK (app IN ('wordpress')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','installing','ready','failed')),
  phase text CHECK (phase IS NULL OR phase IN ('none','unconfigured','uninstalled','installed')),
  admin_user text CHECK (admin_user IS NULL OR admin_user ~ '^[a-z][a-z0-9_]{2,30}$'),
  admin_secret_ref text CHECK (admin_secret_ref IS NULL OR admin_secret_ref ~ '^vault://'),
  db_secret_ref text CHECK (db_secret_ref IS NULL OR db_secret_ref ~ '^vault://'),
  db_name text CHECK (db_name IS NULL OR db_name ~ '^[a-z0-9_]{1,40}$'),
  locale text NOT NULL DEFAULT 'en_US' CHECK (locale ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  handover_state text NOT NULL DEFAULT 'none' CHECK (handover_state IN ('none','pending','consumed','expired')),
  handover_expires_at timestamptz,
  handover_consumed_at timestamptz,
  verification jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(verification) = 'object'),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 300),
  installed_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'ready' OR verified_at IS NOT NULL)
);
CREATE INDEX site_apps_state_idx ON hosting.site_apps (state, updated_at);

CREATE TABLE hosting.restore_drills (
  id uuid PRIMARY KEY,
  backup_id uuid NOT NULL REFERENCES hosting.site_backups(id),
  site_id uuid NOT NULL REFERENCES hosting.sites(id),
  org_id uuid NOT NULL,
  node_id uuid NOT NULL REFERENCES hosting.nodes(id),
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running','passed','failed')),
  checks jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checks) = 'object'),
  error text CHECK (error IS NULL OR length(error) <= 300),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_by uuid,
  CHECK ((state = 'running') = (finished_at IS NULL))
);
CREATE INDEX restore_drills_backup_idx ON hosting.restore_drills (backup_id, started_at DESC);

CREATE TABLE hosting.monitor_alerts (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('capacity_low','activation_failed','activation_stuck','certificate_expiring','certificate_failed','backup_failed','backup_missing','backup_host_unreachable','panel_unreachable','wordpress_failed','restore_drill_failed')),
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  scope_key text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 120),
  node_id uuid,
  site_id uuid,
  org_id uuid,
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 200),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK ((state = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX monitor_alerts_one_open_idx ON hosting.monitor_alerts (kind, scope_key) WHERE state = 'open';
CREATE INDEX monitor_alerts_list_idx ON hosting.monitor_alerts (state, opened_at DESC, id);

ALTER TABLE hosting.site_apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosting.site_apps FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON hosting.site_apps USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_admin ON hosting.site_apps USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin') WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT, UPDATE ON hosting.site_apps TO nuzm_app, nuzm_worker;
GRANT SELECT ON hosting.site_apps TO nuzm_readonly_reporting;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['restore_drills','monitor_alerts'] LOOP
    EXECUTE format('ALTER TABLE hosting.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hosting.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY platform_admin ON hosting.%I USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin') WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON hosting.%I TO nuzm_app, nuzm_worker', t);
    EXECUTE format('GRANT SELECT ON hosting.%I TO nuzm_readonly_reporting', t);
  END LOOP;
END $$;
