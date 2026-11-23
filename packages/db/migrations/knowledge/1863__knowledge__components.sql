-- S-K2c component and architecture analysis (ADR-065 addendum C, SCR-K-04): the COMPONENTS stage writes the component registry and the relationships of a version.
--  * The ingestion worker may INSERT components and relationships of PLATFORM versions (org_id IS NULL, worker scope 'knowledge') only while the version is ANALYZING
--    (the trigger of 1862); it cannot update or delete them. Re-running a stage after a crash is safe: both tables get natural unique keys and the worker inserts with
--    ON CONFLICT DO NOTHING.
--  * Components are never reusable by default: `reuse_allowed` stays false until a person with the publish permission allows it (S-K5/S-K7), whatever the analyzer found.
CREATE UNIQUE INDEX resource_components_natural_idx ON knowledge.resource_components (version_id, path, name, kind);
CREATE UNIQUE INDEX resource_relationships_natural_idx ON knowledge.resource_relationships (version_id, from_kind, from_ref, to_kind, to_ref, relation);

CREATE POLICY worker_knowledge ON knowledge.resource_components USING (current_setting('app.worker_scope', true) = 'knowledge' AND org_id IS NULL)
  WITH CHECK (current_setting('app.worker_scope', true) = 'knowledge' AND org_id IS NULL AND reuse_allowed = false);
CREATE POLICY worker_knowledge ON knowledge.resource_relationships USING (current_setting('app.worker_scope', true) = 'knowledge' AND org_id IS NULL)
  WITH CHECK (current_setting('app.worker_scope', true) = 'knowledge' AND org_id IS NULL);
GRANT INSERT ON knowledge.resource_components, knowledge.resource_relationships TO nuzm_worker;
CREATE TRIGGER worker_derived_guard BEFORE INSERT ON knowledge.resource_components FOR EACH ROW EXECUTE FUNCTION knowledge.worker_derived_guard();
CREATE TRIGGER worker_derived_guard BEFORE INSERT ON knowledge.resource_relationships FOR EACH ROW EXECUTE FUNCTION knowledge.worker_derived_guard();
