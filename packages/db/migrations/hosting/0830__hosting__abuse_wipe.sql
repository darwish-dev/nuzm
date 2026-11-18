-- M06 S27: abuse cases (with an appeal workflow) and wipe verification reports (M06 §4 tasks 15-16).
--  * abuse_cases: detectors and staff open them; actions (throttle/suspend/notify) are appended to `actions` with a reason code; the customer can appeal; a different
--    person than the one who actioned decides the appeal (CHECK on the decision columns). Evidence is by reference only (no content).
--  * wipe_reports: the verified-wipe report of an offboarded site (0 residual files/DB/user/vhost/certificate/cron entries on the node; backups per retention).
CREATE TABLE hosting.abuse_cases (
  id uuid PRIMARY KEY,
  site_id uuid NOT NULL REFERENCES hosting.sites(id),
  org_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('detector','report','staff')),
  detector text CHECK (detector IS NULL OR detector ~ '^[a-z_]{3,40}$'),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','actioned','appealed','closed')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z_]{3,60}$'),
  actions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(actions) = 'array'),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array' AND jsonb_array_length(evidence_refs) <= 20),
  appeal_text text CHECK (appeal_text IS NULL OR length(appeal_text) BETWEEN 10 AND 2000),
  appealed_at timestamptz,
  appeal_decision text CHECK (appeal_decision IS NULL OR appeal_decision IN ('upheld','overturned')),
  appeal_decided_by uuid,
  appeal_decided_at timestamptz,
  actioned_by uuid,
  created_by uuid,
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK (appeal_decided_by IS NULL OR actioned_by IS NULL OR appeal_decided_by <> actioned_by)
);
CREATE INDEX abuse_cases_open_idx ON hosting.abuse_cases (state, created_at DESC, id);
CREATE INDEX abuse_cases_site_idx ON hosting.abuse_cases (org_id, site_id, created_at DESC);
CREATE UNIQUE INDEX abuse_cases_idem_idx ON hosting.abuse_cases (created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- one open detector case per site and detector: a detector that keeps firing does not flood the queue
CREATE UNIQUE INDEX abuse_cases_detector_open_idx ON hosting.abuse_cases (site_id, detector) WHERE detector IS NOT NULL AND state IN ('open','actioned','appealed');

CREATE TABLE hosting.wipe_reports (
  id uuid PRIMARY KEY,
  site_id uuid NOT NULL REFERENCES hosting.sites(id),
  org_id uuid NOT NULL,
  node_residual jsonb NOT NULL CHECK (jsonb_typeof(node_residual) = 'object'),
  backups_remaining int NOT NULL CHECK (backups_remaining >= 0),
  vault_refs_remaining int NOT NULL CHECK (vault_refs_remaining >= 0),
  verified boolean NOT NULL,
  residual_total int NOT NULL CHECK (residual_total >= 0),
  note text CHECK (note IS NULL OR length(note) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (verified = (residual_total = 0))
);
CREATE UNIQUE INDEX wipe_reports_site_idx ON hosting.wipe_reports (site_id, created_at);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['abuse_cases','wipe_reports'] LOOP
    EXECUTE format('ALTER TABLE hosting.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hosting.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON hosting.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY platform_admin ON hosting.%I USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin') WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON hosting.%I TO nuzm_app, nuzm_worker', t);
    EXECUTE format('GRANT SELECT ON hosting.%I TO nuzm_readonly_reporting', t);
  END LOOP;
END $$;
CREATE TRIGGER wipe_reports_immutable BEFORE UPDATE OR DELETE ON hosting.wipe_reports FOR EACH ROW EXECUTE FUNCTION hosting.immutable_row();
CREATE TRIGGER wipe_reports_no_truncate BEFORE TRUNCATE ON hosting.wipe_reports FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();
