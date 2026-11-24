-- S-AG5 (Session 03; renumbered from 1921 to 2212 when the hosting line joined): the append-only record log of the benchmark governance workflow. Expand only: one new, platform-scoped table. Current state is the latest row per (kind, subject).
--  * kinds: threshold acceptance (owner), approved budget, agent security review, named reviewers, review plan and reviews, qualification snapshots, refused live-run attempts.
--  * Payloads carry names, references and numbers only: never a credential, a prompt or customer content. Rows are never updated or deleted.
--  * `request_id` (nullable) makes a creating POST idempotent.
CREATE TABLE ai.benchmark_records (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('threshold_acceptance', 'budget', 'security_review', 'reviewers', 'review_plan', 'review', 'qualification', 'live_attempt')),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 120),
  payload jsonb NOT NULL,
  request_id uuid UNIQUE,
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX benchmark_records_latest_idx ON ai.benchmark_records (kind, subject, recorded_at DESC, id DESC);
ALTER TABLE ai.benchmark_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.benchmark_records FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON ai.benchmark_records USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON ai.benchmark_records TO nuzm_app;
