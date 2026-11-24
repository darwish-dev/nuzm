-- Phase 2, Session 06 (migration id 2180, range 2180-2199): per-organization deployment POLICY SWITCHES for owner decisions O-1 and O-2.
-- Expand-only: one new table, no existing object changes. A missing row means the DEFAULTS, and the defaults equal the behaviour before this migration:
--   production_publish_roles          = {owner,admin,developer}  (anyone with deploy:write may confirm a production publish)
--   rollback_requires_own_approval    = false                    (a rollback reuses the earlier approval)
-- Only owner/admin may change a row (service + permission org:security); every change is audited (`deploy.policy.updated`, before/after) by the service.
CREATE TABLE deploy.org_policies (
  org_id uuid PRIMARY KEY,
  production_publish_roles text[] NOT NULL DEFAULT ARRAY['owner','admin','developer']::text[]
    CHECK (cardinality(production_publish_roles) BETWEEN 1 AND 3
           AND production_publish_roles <@ ARRAY['owner','admin','developer']::text[]),
  rollback_requires_own_approval boolean NOT NULL DEFAULT false,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);
ALTER TABLE deploy.org_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE deploy.org_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON deploy.org_policies
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON deploy.org_policies FOR SELECT
  USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT ON deploy.org_policies TO nuzm_readonly_reporting;
GRANT SELECT, INSERT, UPDATE ON deploy.org_policies TO nuzm_app, nuzm_worker;
