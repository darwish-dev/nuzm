-- M10A S44: evaluation harness results (`ai.evaluations`): a score per agent (or per suite) of a run against a recorded fixture.
--  * `mock_model` is TRUE when the run used the scripted model adapter: such a row proves the plumbing only and is never evidence of model quality (NOT VERIFIED).
--  * `run_id` is a logical reference to ai.runs (M09). Rows are never changed: a re-evaluation inserts a new row.
CREATE TABLE ai.evaluations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  run_id uuid,                                   -- logical reference to ai.runs (M09)
  suite text NOT NULL CHECK (suite ~ '^[a-z][a-z0-9_.-]{1,60}$'),
  agent text CHECK (agent IS NULL OR agent IN ('requirements','architecture','database','backend','frontend','qa','devops','test-fix')),
  fixture text NOT NULL CHECK (length(fixture) BETWEEN 1 AND 120),
  score numeric(5,4) NOT NULL CHECK (score >= 0 AND score <= 1),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  mock_model boolean NOT NULL,
  data_region text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evaluations_org_idx ON ai.evaluations (org_id, created_at DESC, id);
CREATE INDEX evaluations_run_idx ON ai.evaluations (run_id) WHERE run_id IS NOT NULL;
CREATE TRIGGER evaluations_immutable BEFORE UPDATE OR DELETE ON ai.evaluations FOR EACH ROW EXECUTE FUNCTION audit.deny_mutation();
CREATE TRIGGER evaluations_no_truncate BEFORE TRUNCATE ON ai.evaluations FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();
ALTER TABLE ai.evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.evaluations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON ai.evaluations USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON ai.evaluations FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON ai.evaluations TO nuzm_app, nuzm_worker;
GRANT SELECT ON ai.evaluations TO nuzm_readonly_reporting;
