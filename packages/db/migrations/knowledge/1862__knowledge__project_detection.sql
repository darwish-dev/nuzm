-- S-K2b project detection (ADR-065 addendum B, SCR-K-03): the DETECT stage writes the evidence-backed project manifest of a version.
--  * The ingestion worker may INSERT manifests and analysis results of PLATFORM versions (org_id IS NULL, worker scope 'knowledge') and nothing else: both tables are
--    append-only (S-K1), so a manifest can never be edited, and the worker can write one only while the version is ANALYZING (the stage that produces it).
--  * A manifest is bounded (2 MB) and must be an object; every capability it carries has evidence (enforced by the analyzer and re-checked by the reviewers' UI).
--  * The state machine, activation guard and review guard of 1861 are unchanged: a version reaches AWAITING_REVIEW only after DETECT succeeded, and approvals still
--    belong to the EXTRACT analysis they were given for.
ALTER TABLE knowledge.resource_manifests ADD CONSTRAINT resource_manifests_size CHECK (octet_length(manifest::text) <= 2000000);
ALTER TABLE knowledge.analysis_results ADD CONSTRAINT analysis_results_size CHECK (octet_length(result::text) <= 200000);

CREATE POLICY worker_knowledge ON knowledge.resource_manifests USING (current_setting('app.worker_scope', true) = 'knowledge' AND org_id IS NULL)
  WITH CHECK (current_setting('app.worker_scope', true) = 'knowledge' AND org_id IS NULL);
CREATE POLICY worker_knowledge ON knowledge.analysis_results USING (current_setting('app.worker_scope', true) = 'knowledge' AND org_id IS NULL)
  WITH CHECK (current_setting('app.worker_scope', true) = 'knowledge' AND org_id IS NULL);
GRANT INSERT ON knowledge.resource_manifests, knowledge.analysis_results TO nuzm_worker;

CREATE FUNCTION knowledge.worker_derived_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.worker_scope', true) = 'knowledge' AND NOT EXISTS (SELECT 1 FROM knowledge.resource_versions v WHERE v.id = NEW.version_id AND v.state = 'ANALYZING') THEN
    RAISE EXCEPTION 'the worker writes derived analysis only for a version that is being analysed' USING ERRCODE = 'check_violation', HINT = 'not_analyzing';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER worker_derived_guard BEFORE INSERT ON knowledge.resource_manifests FOR EACH ROW EXECUTE FUNCTION knowledge.worker_derived_guard();
CREATE TRIGGER worker_derived_guard BEFORE INSERT ON knowledge.analysis_results FOR EACH ROW EXECUTE FUNCTION knowledge.worker_derived_guard();
