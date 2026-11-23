-- S-K5 retrieval and recommendation (ADR-065 addendum F, SCR-K-07).
--  * The ingestion worker's INDEX stage may INSERT search documents of PLATFORM versions (org_id IS NULL, worker scope 'knowledge') only while the version is ANALYZING
--    (the trigger of 1862); it cannot update or delete them. Re-running a stage after a crash is safe: the table already has a natural key (version, kind, ref) and the worker
--    inserts with ON CONFLICT DO NOTHING.
--  * The recommendation weights (D-48) are platform settings with an audit trail: `engine_settings` holds the current value of a key, `engine_setting_revisions` is the
--    append-only history (who, when, why, what changed). Only a person with the publish permission changes them (the API enforces it); the database keeps the history
--    immutable and the revision numbers gap-free per key.
--  * Nothing here stores a credential, an embedding or source text beyond the bounded documents the analysis already produced.
CREATE POLICY worker_knowledge ON knowledge.resource_search_documents USING (current_setting('app.worker_scope', true) = 'knowledge' AND org_id IS NULL)
  WITH CHECK (current_setting('app.worker_scope', true) = 'knowledge' AND org_id IS NULL);
GRANT INSERT ON knowledge.resource_search_documents TO nuzm_worker;
CREATE TRIGGER worker_derived_guard BEFORE INSERT ON knowledge.resource_search_documents FOR EACH ROW EXECUTE FUNCTION knowledge.worker_derived_guard();

CREATE TABLE knowledge.engine_settings (
  key text PRIMARY KEY CHECK (key IN ('recommendation')),
  value jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object' AND octet_length(value::text) <= 4000),
  revision int NOT NULL CHECK (revision >= 1),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE knowledge.engine_setting_revisions (
  id uuid PRIMARY KEY,
  key text NOT NULL CHECK (key IN ('recommendation')),
  revision int NOT NULL CHECK (revision >= 1),
  value jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object' AND octet_length(value::text) <= 4000),
  previous jsonb CHECK (previous IS NULL OR (jsonb_typeof(previous) = 'object' AND octet_length(previous::text) <= 4000)),
  changed_by uuid,
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key, revision)
);
CREATE TRIGGER engine_setting_revisions_append_only BEFORE UPDATE OR DELETE ON knowledge.engine_setting_revisions FOR EACH ROW EXECUTE FUNCTION knowledge.append_only();
ALTER TABLE knowledge.engine_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.engine_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON knowledge.engine_settings USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
ALTER TABLE knowledge.engine_setting_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.engine_setting_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON knowledge.engine_setting_revisions USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT, UPDATE ON knowledge.engine_settings TO nuzm_app;
GRANT SELECT, INSERT ON knowledge.engine_setting_revisions TO nuzm_app;
GRANT SELECT ON knowledge.engine_settings, knowledge.engine_setting_revisions TO nuzm_worker, nuzm_readonly_reporting;
