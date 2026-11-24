-- S-AG4 (Session 02, renumbered from 1900 to 2210 when the hosting line joined; range 2210-2219): the history of a provider's customer rate card. Expand only: one new, platform-scoped, APPEND-ONLY table.
--  * `configure` replaces the rate card on `ai.model_providers` in place; before this table the previous prices were not recoverable except from audit text. Every change of the card's CONTENT
--    now appends one row here (same content under a new label, or a re-save of the same card, appends nothing), so a price at any past time can be explained.
--  * `models` is the card exactly as stored on the provider row ({modelId: {creditsPerMillionInput, creditsPerMillionOutput}}, integer strings); `basis` optionally records how it was derived
--    (vendor price reference, FX quote, margin) when an administrator saved a card produced by the derivation preview. No price, rate or margin is invented by this migration: it stores nothing by itself.
--  * Rows are never updated or deleted; no org_id: providers are platform data (same RLS shape as ai.model_capability_evidence).
CREATE TABLE ai.model_rate_card_versions (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES ai.model_providers (id),
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 40),
  models jsonb NOT NULL CHECK (jsonb_typeof(models) = 'object'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  basis jsonb CHECK (basis IS NULL OR jsonb_typeof(basis) = 'object'),
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_rate_card_versions_latest_idx ON ai.model_rate_card_versions (provider_id, recorded_at DESC, id DESC);
ALTER TABLE ai.model_rate_card_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.model_rate_card_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON ai.model_rate_card_versions USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
CREATE POLICY worker_read ON ai.model_rate_card_versions FOR SELECT USING (coalesce(current_setting('app.worker_scope', true), '') = 'claim');
GRANT SELECT, INSERT ON ai.model_rate_card_versions TO nuzm_app, nuzm_worker;
CREATE TRIGGER model_rate_card_versions_immutable BEFORE UPDATE OR DELETE ON ai.model_rate_card_versions FOR EACH ROW EXECUTE FUNCTION ai.deny_mutation();
CREATE TRIGGER model_rate_card_versions_no_truncate BEFORE TRUNCATE ON ai.model_rate_card_versions FOR EACH STATEMENT EXECUTE FUNCTION ai.deny_mutation();
