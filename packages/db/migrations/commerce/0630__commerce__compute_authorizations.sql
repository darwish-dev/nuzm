-- M05 S17: cost authorization for provisioning (extension of the M02 commerce module by its owner contract: commerce extended_by M05).
-- A `hold` authorization records the first-billing-period amount reserved for ONE order. It is NOT a ledger posting (postings only through the
-- billing service). Authorizations stay immutable; a release is a separate append-only row (compensation on definitive failure/cancellation).
ALTER TABLE commerce.authorizations DROP CONSTRAINT authorizations_kind_check;
ALTER TABLE commerce.authorizations ADD CONSTRAINT authorizations_kind_check CHECK (kind IN ('spend_approval','credit','payment','hold'));
CREATE UNIQUE INDEX authorizations_hold_once ON commerce.authorizations (org_id, order_id) WHERE kind = 'hold';

CREATE TABLE commerce.authorization_releases (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  authorization_id uuid NOT NULL UNIQUE REFERENCES commerce.authorizations(id),   -- an authorization is released at most once
  reason text NOT NULL CHECK (reason IN ('operation_failed','operation_cancelled','price_changed','residency_denied','capability_unsupported','quota_exceeded','instance_deleted','other')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  released_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER authorization_releases_immutable BEFORE UPDATE OR DELETE ON commerce.authorization_releases FOR EACH ROW EXECUTE FUNCTION commerce.deny_record_mutation();
CREATE TRIGGER authorization_releases_no_truncate BEFORE TRUNCATE ON commerce.authorization_releases FOR EACH STATEMENT EXECUTE FUNCTION commerce.deny_record_mutation();
ALTER TABLE commerce.authorization_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.authorization_releases FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON commerce.authorization_releases USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON commerce.authorization_releases FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON commerce.authorization_releases TO nuzm_app;
GRANT SELECT ON commerce.authorization_releases TO nuzm_worker, nuzm_readonly_reporting;
