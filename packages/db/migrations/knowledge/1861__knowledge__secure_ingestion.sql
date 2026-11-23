-- S-K2a secure project ingestion (ADR-065 addendum, SCR-K-02): the asynchronous processing pipeline for uploaded packages and the review gate in front of activation.
--  * A version moves QUARANTINED -> VALIDATING -> ANALYZING -> AWAITING_REVIEW only along the edges below; the database refuses every other edge (including a direct
--    jump to ACTIVE). Nothing in the pipeline executes uploaded code: the worker parses bytes only (packages/domain/src/knowledge).
--  * The worker runs under app.worker_scope = 'knowledge': it sees and writes PLATFORM rows only (org_id IS NULL) and only the columns it needs (column grants).
--    It can never set a licence verdict, activate a version or write a review.
--  * Activation is guarded in the database: AWAITING_REVIEW (or a re-enable from DISABLED), the licence proposal and the reviewer-asserted verdict both ALLOWED,
--    no `block` finding in the current analysis, and approvals from different people (two for third-party resources, neither of them the uploader).
--  * Processing logs, scan findings and reviews are append-only evidence. Findings carry kinds and path:line only, never matched text.
CREATE OR REPLACE FUNCTION knowledge.resource_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'resources are archived, never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.slug <> OLD.slug OR NEW.source_kind <> OLD.source_kind
     OR NEW.resource_type <> OLD.resource_type OR NEW.data_region <> OLD.data_region OR NEW.provenance_class <> OLD.provenance_class THEN
    RAISE EXCEPTION 'the identity, owner, type, source, region and provenance class of a resource are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;

-- THIRD_PARTY is the safe default: it needs two approvers. FIRST_PARTY (our own work) is set at creation by an administrator holding admin:ai_knowledge:publish.
ALTER TABLE knowledge.resources ADD COLUMN provenance_class text NOT NULL DEFAULT 'THIRD_PARTY' CHECK (provenance_class IN ('FIRST_PARTY','THIRD_PARTY'));

ALTER TABLE knowledge.resource_versions
  ADD COLUMN state_reason text CHECK (state_reason IS NULL OR state_reason ~ '^[a-z_]{1,60}$'),
  ADD COLUMN analysis_job_id uuid,                                              -- the EXTRACT job whose findings reviewers approved (logical reference)
  ADD COLUMN license_proposal jsonb CHECK (license_proposal IS NULL OR jsonb_typeof(license_proposal) = 'object'),
  ADD COLUMN ingest_summary jsonb CHECK (ingest_summary IS NULL OR jsonb_typeof(ingest_summary) = 'object');

ALTER TABLE knowledge.processing_jobs
  ADD COLUMN lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) <= 120),
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN heartbeat_at timestamptz,
  ADD COLUMN run_after timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN trace_id text CHECK (trace_id IS NULL OR length(trace_id) <= 80),
  ADD COLUMN result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  ADD COLUMN created_by uuid;
CREATE UNIQUE INDEX processing_jobs_one_active_idx ON knowledge.processing_jobs (version_id, kind) WHERE state IN ('QUEUED','RUNNING');
CREATE INDEX processing_jobs_claim_idx ON knowledge.processing_jobs (run_after, created_at) WHERE state = 'QUEUED';
CREATE INDEX processing_jobs_lease_idx ON knowledge.processing_jobs (lease_expires_at) WHERE state = 'RUNNING';

CREATE FUNCTION knowledge.job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'processing jobs are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.version_id <> OLD.version_id OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.kind <> OLD.kind OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity of a processing job is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'QUEUED' AND NEW.state IN ('RUNNING','CANCELLED'))
    OR (OLD.state = 'RUNNING' AND NEW.state IN ('QUEUED','SUCCEEDED','FAILED','CANCELLED','DEAD_LETTER'))) THEN
    RAISE EXCEPTION 'processing job transition % -> % is not allowed', OLD.state, NEW.state USING ERRCODE = 'check_violation', HINT = 'invalid_transition';
  END IF;
  IF OLD.state IN ('SUCCEEDED','FAILED','CANCELLED','DEAD_LETTER') THEN
    RAISE EXCEPTION 'a finished processing job cannot change' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_guard BEFORE UPDATE OR DELETE ON knowledge.processing_jobs FOR EACH ROW EXECUTE FUNCTION knowledge.job_guard();

-- ---- Evidence -------------------------------------------------------------------------------------------------------------------
CREATE TABLE knowledge.processing_logs (
  id uuid PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  job_id uuid NOT NULL,
  version_id uuid NOT NULL,
  org_id uuid,
  level text NOT NULL CHECK (level IN ('debug','info','warn','error')),
  stage text NOT NULL CHECK (stage ~ '^[A-Z_]{1,30}$'),
  code text NOT NULL CHECK (code ~ '^[a-z0-9_.]{1,80}$'),
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 500),            -- never file content, never a matched secret
  data jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(data) = 'object' AND octet_length(data::text) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX processing_logs_job_idx ON knowledge.processing_logs (job_id, seq);
CREATE INDEX processing_logs_version_idx ON knowledge.processing_logs (version_id, seq);

CREATE TABLE knowledge.scan_findings (
  id uuid PRIMARY KEY,
  version_id uuid NOT NULL,
  org_id uuid,
  job_id uuid NOT NULL,
  scanner text NOT NULL CHECK (scanner IN ('secrets','license','dependencies','risky_files','sensitive_files','archive')),
  code text NOT NULL CHECK (code ~ '^[a-z0-9_]{1,60}$'),
  severity text NOT NULL CHECK (severity IN ('info','warn','block')),
  path text CHECK (path IS NULL OR length(path) <= 500),
  line int CHECK (line IS NULL OR line >= 1),
  detail text NOT NULL CHECK (length(detail) BETWEEN 1 AND 500),            -- a kind and path:line, never the matched text
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scan_findings_version_idx ON knowledge.scan_findings (version_id, job_id, severity);

CREATE TABLE knowledge.resource_reviews (
  id uuid PRIMARY KEY,
  version_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  org_id uuid,
  analysis_job_id uuid NOT NULL,                                              -- the findings the reviewer saw; a new analysis voids earlier approvals
  decision text NOT NULL CHECK (decision IN ('APPROVE','REJECT')),
  reviewer_id uuid NOT NULL,
  reason text CHECK (reason IS NULL OR length(reason) <= 2000),
  checklist jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(checklist) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (decision <> 'REJECT' OR length(btrim(coalesce(reason, ''))) >= 10)
);
CREATE UNIQUE INDEX resource_reviews_one_approval_idx ON knowledge.resource_reviews (version_id, analysis_job_id, reviewer_id) WHERE decision = 'APPROVE';
CREATE INDEX resource_reviews_version_idx ON knowledge.resource_reviews (version_id, created_at);

CREATE TRIGGER processing_logs_append_only BEFORE UPDATE OR DELETE ON knowledge.processing_logs FOR EACH ROW EXECUTE FUNCTION knowledge.append_only();
CREATE TRIGGER scan_findings_append_only BEFORE UPDATE OR DELETE ON knowledge.scan_findings FOR EACH ROW EXECUTE FUNCTION knowledge.append_only();
CREATE TRIGGER resource_reviews_append_only BEFORE UPDATE OR DELETE ON knowledge.resource_reviews FOR EACH ROW EXECUTE FUNCTION knowledge.append_only();

-- ---- The state machine ----------------------------------------------------------------------------------------------------------
CREATE FUNCTION knowledge.version_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ok boolean;
  third_party boolean;
  need int;
  have int;
BEGIN
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  ok := CASE OLD.state
    WHEN 'UPLOADING' THEN NEW.state IN ('QUARANTINED','FAILED','ARCHIVED')
    WHEN 'QUARANTINED' THEN NEW.state IN ('VALIDATING','DISABLED','ARCHIVED')
    WHEN 'VALIDATING' THEN NEW.state IN ('ANALYZING','QUARANTINED','FAILED')
    WHEN 'ANALYZING' THEN NEW.state IN ('INDEXING','AWAITING_REVIEW','QUARANTINED','FAILED')
    WHEN 'INDEXING' THEN NEW.state IN ('AWAITING_REVIEW','QUARANTINED','FAILED')
    WHEN 'AWAITING_REVIEW' THEN NEW.state IN ('ACTIVE','QUARANTINED','DISABLED','ARCHIVED')
    WHEN 'ACTIVE' THEN NEW.state IN ('DISABLED','ARCHIVED')
    WHEN 'DISABLED' THEN NEW.state IN ('ACTIVE','AWAITING_REVIEW','ARCHIVED')
    WHEN 'FAILED' THEN NEW.state IN ('QUARANTINED','ARCHIVED')
    ELSE false
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'version transition % -> % is not allowed', OLD.state, NEW.state USING ERRCODE = 'check_violation', HINT = 'invalid_transition';
  END IF;

  IF NEW.state = 'ACTIVE' THEN
    -- the gate: every condition is checked here, whatever the caller did before
    IF NEW.license_verdict <> 'ALLOWED' OR coalesce(NEW.license_proposal ->> 'verdict', '') <> 'ALLOWED' THEN
      RAISE EXCEPTION 'activation needs an ALLOWED licence verdict and an ALLOWED licence proposal' USING ERRCODE = 'check_violation', HINT = 'license_not_allowed';
    END IF;
    IF NEW.analysis_job_id IS NULL OR NOT EXISTS (SELECT 1 FROM knowledge.processing_jobs j WHERE j.id = NEW.analysis_job_id AND j.version_id = NEW.id AND j.kind = 'EXTRACT' AND j.state = 'SUCCEEDED') THEN
      RAISE EXCEPTION 'activation needs a completed analysis' USING ERRCODE = 'check_violation', HINT = 'not_analyzed';
    END IF;
    IF EXISTS (SELECT 1 FROM knowledge.scan_findings f WHERE f.version_id = NEW.id AND f.job_id = NEW.analysis_job_id AND f.severity = 'block') THEN
      RAISE EXCEPTION 'a version with blocking scan findings cannot be activated' USING ERRCODE = 'check_violation', HINT = 'blocking_findings';
    END IF;
    IF EXISTS (SELECT 1 FROM knowledge.resource_reviews r WHERE r.version_id = NEW.id AND r.analysis_job_id = NEW.analysis_job_id AND r.decision = 'REJECT') THEN
      RAISE EXCEPTION 'a rejected analysis cannot be activated' USING ERRCODE = 'check_violation', HINT = 'rejected';
    END IF;
    SELECT (coalesce(r.provenance_class, 'THIRD_PARTY') = 'THIRD_PARTY') INTO third_party FROM knowledge.resources r WHERE r.id = NEW.resource_id;
    third_party := coalesce(third_party, true);                                -- not visible to the caller: fail closed
    need := CASE WHEN third_party THEN 2 ELSE 1 END;
    SELECT count(DISTINCT r.reviewer_id) INTO have FROM knowledge.resource_reviews r
      WHERE r.version_id = NEW.id AND r.analysis_job_id = NEW.analysis_job_id AND r.decision = 'APPROVE'
        AND (NOT third_party OR r.reviewer_id IS DISTINCT FROM NEW.created_by);
    IF have < need THEN
      RAISE EXCEPTION 'activation needs % approval(s) from different people (the uploader cannot approve third-party resources); found %', need, have USING ERRCODE = 'check_violation', HINT = 'approvals_missing';
    END IF;
    NEW.activated_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER version_transition_guard BEFORE UPDATE OF state ON knowledge.resource_versions FOR EACH ROW EXECUTE FUNCTION knowledge.version_transition_guard();

CREATE FUNCTION knowledge.review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v knowledge.resource_versions%ROWTYPE;
  third_party boolean;
BEGIN
  SELECT * INTO v FROM knowledge.resource_versions WHERE id = NEW.version_id;
  IF NOT FOUND OR v.resource_id <> NEW.resource_id OR v.org_id IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION 'the review does not match the version' USING ERRCODE = 'check_violation', HINT = 'mismatch';
  END IF;
  IF v.state <> 'AWAITING_REVIEW' OR v.analysis_job_id IS DISTINCT FROM NEW.analysis_job_id THEN
    RAISE EXCEPTION 'only the current analysis of a version awaiting review can be reviewed' USING ERRCODE = 'check_violation', HINT = 'not_reviewable';
  END IF;
  SELECT (coalesce(r.provenance_class, 'THIRD_PARTY') = 'THIRD_PARTY') INTO third_party FROM knowledge.resources r WHERE r.id = NEW.resource_id;
  IF coalesce(third_party, true) AND NEW.reviewer_id IS NOT DISTINCT FROM v.created_by THEN
    RAISE EXCEPTION 'the uploader cannot review a third-party resource they uploaded' USING ERRCODE = 'check_violation', HINT = 'self_review';
  END IF;
  IF NEW.decision = 'APPROVE' AND (NEW.checklist ->> 'findingsReviewed' IS DISTINCT FROM 'true' OR NEW.checklist ->> 'licenseReviewed' IS DISTINCT FROM 'true') THEN
    RAISE EXCEPTION 'an approval confirms that the findings and the licence were reviewed' USING ERRCODE = 'check_violation', HINT = 'checklist_incomplete';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_guard BEFORE INSERT ON knowledge.resource_reviews FOR EACH ROW EXECUTE FUNCTION knowledge.review_guard();

-- ---- Row-level security and grants ----------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['processing_logs','scan_findings','resource_reviews']
  LOOP
    EXECUTE format('ALTER TABLE knowledge.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE knowledge.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY platform_all ON knowledge.%I USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
                      WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format($p$CREATE POLICY org_isolation ON knowledge.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
                      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
  END LOOP;
  -- the ingestion worker: PLATFORM rows only, and only the tables it works on
  FOREACH t IN ARRAY ARRAY['processing_jobs','processing_logs','scan_findings','resource_versions','resources','resource_files','resource_dependencies','resource_reviews']
  LOOP
    EXECUTE format($p$CREATE POLICY worker_knowledge ON knowledge.%I USING (current_setting('app.worker_scope', true) = 'knowledge' AND org_id IS NULL)
                      WITH CHECK (current_setting('app.worker_scope', true) = 'knowledge' AND org_id IS NULL)$p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON knowledge.processing_logs, knowledge.resource_reviews TO nuzm_app;
GRANT SELECT ON knowledge.scan_findings TO nuzm_app;
GRANT SELECT ON ALL TABLES IN SCHEMA knowledge TO nuzm_worker, nuzm_readonly_reporting;
GRANT INSERT ON knowledge.processing_logs, knowledge.scan_findings, knowledge.resource_files, knowledge.resource_dependencies, knowledge.processing_jobs TO nuzm_worker;
GRANT UPDATE (state, attempt, progress, error_code, error_detail, started_at, finished_at, lease_owner, lease_expires_at, heartbeat_at, run_after, result) ON knowledge.processing_jobs TO nuzm_worker;
GRANT UPDATE (state, state_reason, analysis_job_id, license_proposal, ingest_summary, snapshot_key) ON knowledge.resource_versions TO nuzm_worker;
GRANT UPDATE (status) ON knowledge.resources TO nuzm_worker;
