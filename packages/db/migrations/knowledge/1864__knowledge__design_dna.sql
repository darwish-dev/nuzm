-- S-K4 Design DNA and theme intelligence (ADR-065 addendum E, SCR-K-06): the DESIGN stage writes the design tokens and theme variants of a version.
--  * theme_tokens gain the facts the analysis proves: the mode a value applies to (base, light, dark or a named scheme), the line, the origin (which kind of source), whether the
--    value is computed (dynamic: no value is ever invented for it) and the value after references were resolved. Expand-only: every column has a default, nothing existing changes.
--  * The ingestion worker may INSERT tokens and variants of PLATFORM versions (org_id IS NULL, worker scope 'knowledge') only while the version is ANALYZING (the trigger of 1862);
--    it cannot update or delete them. Re-running a stage after a crash is safe: natural unique keys plus ON CONFLICT DO NOTHING.
--  * Design values are derived evidence; they carry no reuse permission (reuse is a later, explicit, permission-gated decision, D-43).
ALTER TABLE knowledge.theme_tokens
  ADD COLUMN mode text NOT NULL DEFAULT 'base' CHECK (length(mode) BETWEEN 1 AND 40),
  ADD COLUMN line integer CHECK (line IS NULL OR line BETWEEN 1 AND 10000000),
  ADD COLUMN origin text NOT NULL DEFAULT 'css-var' CHECK (origin IN ('css-var','scss-var','less-var','tailwind-theme','tailwind-config','tokens-json','js-theme','flutter-theme')),
  ADD COLUMN dynamic boolean NOT NULL DEFAULT false,
  ADD COLUMN resolved_value text CHECK (resolved_value IS NULL OR length(resolved_value) <= 400);
ALTER TABLE knowledge.theme_tokens ALTER COLUMN value DROP NOT NULL;
ALTER TABLE knowledge.theme_tokens ADD CONSTRAINT theme_tokens_value_required CHECK (dynamic OR value IS NOT NULL);
ALTER TABLE knowledge.theme_variants ADD CONSTRAINT theme_variants_descriptor_size CHECK (octet_length(descriptor::text) <= 20000);

CREATE UNIQUE INDEX theme_tokens_natural_idx ON knowledge.theme_tokens (version_id, (coalesce(source_path, '')), mode, name);
CREATE UNIQUE INDEX theme_variants_natural_idx ON knowledge.theme_variants (version_id, kind, name);

CREATE POLICY worker_knowledge ON knowledge.theme_tokens USING (current_setting('app.worker_scope', true) = 'knowledge' AND org_id IS NULL)
  WITH CHECK (current_setting('app.worker_scope', true) = 'knowledge' AND org_id IS NULL);
CREATE POLICY worker_knowledge ON knowledge.theme_variants USING (current_setting('app.worker_scope', true) = 'knowledge' AND org_id IS NULL)
  WITH CHECK (current_setting('app.worker_scope', true) = 'knowledge' AND org_id IS NULL);
GRANT INSERT ON knowledge.theme_tokens, knowledge.theme_variants TO nuzm_worker;
CREATE TRIGGER worker_derived_guard BEFORE INSERT ON knowledge.theme_tokens FOR EACH ROW EXECUTE FUNCTION knowledge.worker_derived_guard();
CREATE TRIGGER worker_derived_guard BEFORE INSERT ON knowledge.theme_variants FOR EACH ROW EXECUTE FUNCTION knowledge.worker_derived_guard();
