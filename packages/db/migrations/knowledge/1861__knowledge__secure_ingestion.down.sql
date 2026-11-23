-- DEV/STAGING ONLY. Production is forward-fix: processing logs, scan findings and reviews are evidence and are not dropped. Documented reversal of 1861 (SCR-K-02).
DROP TRIGGER IF EXISTS version_transition_guard ON knowledge.resource_versions;
DROP FUNCTION IF EXISTS knowledge.version_transition_guard();
DROP TABLE IF EXISTS knowledge.resource_reviews;
DROP FUNCTION IF EXISTS knowledge.review_guard();
DROP TABLE IF EXISTS knowledge.scan_findings;
DROP TABLE IF EXISTS knowledge.processing_logs;
DROP TRIGGER IF EXISTS job_guard ON knowledge.processing_jobs;
DROP FUNCTION IF EXISTS knowledge.job_guard();
DROP POLICY IF EXISTS worker_knowledge ON knowledge.processing_jobs;
DROP POLICY IF EXISTS worker_knowledge ON knowledge.resource_versions;
DROP POLICY IF EXISTS worker_knowledge ON knowledge.resources;
DROP POLICY IF EXISTS worker_knowledge ON knowledge.resource_files;
DROP POLICY IF EXISTS worker_knowledge ON knowledge.resource_dependencies;
DROP INDEX IF EXISTS knowledge.processing_jobs_one_active_idx;
DROP INDEX IF EXISTS knowledge.processing_jobs_claim_idx;
DROP INDEX IF EXISTS knowledge.processing_jobs_lease_idx;
ALTER TABLE knowledge.processing_jobs DROP COLUMN IF EXISTS lease_owner, DROP COLUMN IF EXISTS lease_expires_at, DROP COLUMN IF EXISTS heartbeat_at, DROP COLUMN IF EXISTS run_after,
  DROP COLUMN IF EXISTS cancel_requested, DROP COLUMN IF EXISTS trace_id, DROP COLUMN IF EXISTS result, DROP COLUMN IF EXISTS created_by;
ALTER TABLE knowledge.resource_versions DROP COLUMN IF EXISTS state_reason, DROP COLUMN IF EXISTS analysis_job_id, DROP COLUMN IF EXISTS license_proposal, DROP COLUMN IF EXISTS ingest_summary;
CREATE OR REPLACE FUNCTION knowledge.resource_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'resources are archived, never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.slug <> OLD.slug OR NEW.source_kind <> OLD.source_kind
     OR NEW.resource_type <> OLD.resource_type OR NEW.data_region <> OLD.data_region THEN
    RAISE EXCEPTION 'the identity, owner, type, source and region of a resource are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
ALTER TABLE knowledge.resources DROP COLUMN IF EXISTS provenance_class;
