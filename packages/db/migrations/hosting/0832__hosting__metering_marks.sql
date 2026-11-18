-- M06 S27: metering high-water marks (M06 §10). Like the compute sampler (M05) a mark moves in the SAME transaction as the outbox rows it covers, so a rerun or a
-- crash never double counts: `emitted_until` is the end of the last accrued day (site_months, disk_gb_months, backup_gb_months); bandwidth uses `last_value`
-- (the cumulative bytes of the month at the last emission) and `period` (the UTC month it belongs to).
CREATE TABLE hosting.metering_marks (
  site_id uuid NOT NULL REFERENCES hosting.sites(id),
  org_id uuid NOT NULL,
  meter_id text NOT NULL CHECK (meter_id IN ('hosting.site_months','hosting.disk_gb_months','hosting.bandwidth_gb','hosting.backup_gb_months')),
  emitted_until timestamptz,
  last_value bigint CHECK (last_value IS NULL OR last_value >= 0),
  period text CHECK (period IS NULL OR period ~ '^[0-9]{4}-[0-9]{2}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, meter_id)
);
ALTER TABLE hosting.metering_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosting.metering_marks FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON hosting.metering_marks USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_admin ON hosting.metering_marks USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin') WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT, UPDATE ON hosting.metering_marks TO nuzm_app, nuzm_worker;
GRANT SELECT ON hosting.metering_marks TO nuzm_readonly_reporting;
