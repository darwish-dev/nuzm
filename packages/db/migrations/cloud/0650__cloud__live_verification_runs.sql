-- M05 S23: live-verification run register (M05 §5 LV-1..LV-6, UI-M05-15).
--  * Records the RESULT of a human-triggered live verification (the owner runs the job; the platform only stores what it reported).
--  * A run can be LIVE-VERIFIED only with an owner-recorded gate evidence id, at least one evidence id and zero residual resources (CHECK).
--    Mock/fixture runs are `NOT VERIFIED` by construction (the runner never labels them otherwise); nothing here can turn BLOCKED into PASS.
--  * Append-only, tenant-less, platform (admin console) scope only. No secret columns.
CREATE TABLE cloud.live_verification_runs (
  id uuid PRIMARY KEY,
  job_id text NOT NULL CHECK (job_id IN ('live-verify-alibaba','live-verify-huawei','live-verify-contabo')),
  provider_key text NOT NULL CHECK (provider_key IN ('alibaba','huawei','contabo')),
  gate text NOT NULL CHECK (gate IN ('HG-05-01','HG-05-02','HG-05-03','HG-05-04')),
  gate_evidence_id text CHECK (gate_evidence_id IS NULL OR gate_evidence_id ~ '^[A-Za-z0-9._:-]{3,120}$'),
  status text NOT NULL CHECK (status IN ('NOT RUN','NOT VERIFIED','LIVE-VERIFIED','FAIL')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  steps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(steps) = 'array'),
  evidence_ids text[] NOT NULL DEFAULT '{}',
  spend_cap_minor bigint CHECK (spend_cap_minor IS NULL OR spend_cap_minor >= 0),
  currency char(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  residual_resources int NOT NULL DEFAULT 0 CHECK (residual_resources >= 0),
  recorded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'LIVE-VERIFIED' OR (gate_evidence_id IS NOT NULL AND cardinality(evidence_ids) > 0 AND residual_resources = 0)),
  CHECK ((spend_cap_minor IS NULL) = (currency IS NULL))
);
CREATE INDEX live_verification_runs_job_idx ON cloud.live_verification_runs (job_id, created_at DESC);

-- cloud.deny_mutation() is defined by 0600 (append-only evidence tables)
CREATE TRIGGER live_verification_runs_no_mutation BEFORE UPDATE OR DELETE ON cloud.live_verification_runs
  FOR EACH ROW EXECUTE FUNCTION cloud.deny_mutation();
CREATE TRIGGER live_verification_runs_no_truncate BEFORE TRUNCATE ON cloud.live_verification_runs
  FOR EACH STATEMENT EXECUTE FUNCTION cloud.deny_mutation();

ALTER TABLE cloud.live_verification_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud.live_verification_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_admin ON cloud.live_verification_runs
  USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT ON cloud.live_verification_runs TO nuzm_readonly_reporting;
GRANT SELECT, INSERT ON cloud.live_verification_runs TO nuzm_app;
