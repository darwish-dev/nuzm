-- S-AG5 (Session 03; renumbered from 1920 to 2211 when the hosting line joined): stored benchmark runs. Expand only: one new, platform-scoped, APPEND-ONLY table (benchmarks are platform data: no org_id, no customer content; every task is
-- synthetic, data class public).
--  * A row is the OFFLINE replay report of a set of recordings plus the per-task scores. `evidence_label` says what kind of evidence it is (a reference oracle, a mock, or an offline replay
--    of a recorded run); a row never claims real-model performance. Rows are never updated or deleted (history is the audit trail).
--  * `request_id` makes the creating POST idempotent (a repeated request returns the stored row).
CREATE TABLE ai.benchmark_runs (
  id uuid PRIMARY KEY,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  dataset_version text NOT NULL CHECK (dataset_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  dataset_hash text NOT NULL CHECK (dataset_hash ~ '^[0-9a-f]{64}$'),
  evidence_label text NOT NULL CHECK (evidence_label IN ('NONE', 'OFFLINE_REFERENCE_ORACLE', 'OFFLINE_MOCK_REPLAY', 'OFFLINE_REPLAY_OF_RECORDED_RUN', 'MIXED_ORIGINS_NOT_COMPARABLE')),
  origins text[] NOT NULL,
  adapters text[] NOT NULL,
  report jsonb NOT NULL,
  scores jsonb NOT NULL,
  report_fingerprint text NOT NULL CHECK (report_fingerprint ~ '^[0-9a-f]{64}$'),
  request_id uuid NOT NULL UNIQUE,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX benchmark_runs_created_idx ON ai.benchmark_runs (created_at DESC, id DESC);
ALTER TABLE ai.benchmark_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.benchmark_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON ai.benchmark_runs USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON ai.benchmark_runs TO nuzm_app;
