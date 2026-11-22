-- S-AG4b (SCR-K-11 item 3, decision D8 approved 2026-11-22): the recorded evidence behind a provider's tool-calling declarations. Expand only: one new, platform-scoped, APPEND-ONLY table.
--  * A capability of contract 1.1 (tool-use, streaming-tool-calls, parallel-tool-calls) counts for a real provider only while the LATEST row for (provider, model, capability) is VERIFIED
--    and was recorded for the contract version the adapter implements now. "Unknown = unsupported": no row means no declaration. A NOT VERIFIED row withdraws a declaration.
--  * `evidence_ref` points at the stored probe report (docs/ai-intelligence/S-AG4-PROBE-PLAN.md). Rows are never updated or deleted (history is the audit trail); no org_id: providers are platform data.
CREATE TABLE ai.model_capability_evidence (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES ai.model_providers (id),
  model_id text NOT NULL CHECK (model_id ~ '^[A-Za-z0-9._:/-]{1,80}$'),
  capability text NOT NULL CHECK (capability IN ('tool-use', 'streaming-tool-calls', 'parallel-tool-calls')),
  state text NOT NULL CHECK (state IN ('VERIFIED', 'NOT VERIFIED')),
  evidence_ref text NOT NULL CHECK (length(evidence_ref) BETWEEN 3 AND 200),
  contract_version text NOT NULL CHECK (contract_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_capability_evidence_latest_idx ON ai.model_capability_evidence (provider_id, model_id, capability, recorded_at DESC, id DESC);
ALTER TABLE ai.model_capability_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.model_capability_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON ai.model_capability_evidence USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
CREATE POLICY worker_read ON ai.model_capability_evidence FOR SELECT USING (coalesce(current_setting('app.worker_scope', true), '') = 'claim');
GRANT SELECT, INSERT ON ai.model_capability_evidence TO nuzm_app, nuzm_worker;
