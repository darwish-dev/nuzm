-- M03 S11b: e-invoice onboarding, credential references and the submission queue (docs/11 §5, docs/05).
--  * zatca_onboarding / zatca_credentials_refs are platform-level (per billing entity and environment), reachable only with the admin scope;
--    the runtime reads credential REFERENCES through a security-definer function. Credentials hold vault references, never secret values.
--  * zatca_submissions is append-only: one row per state change of a document; the CURRENT state is the latest row. Transitions are checked by
--    a trigger against the previous row of the same document. A rejected document is terminal (a human decides; no automatic resubmission).
--  * Everything is SYNTHETIC/SIMULATED: no row means anything about ZATCA. `production` exists as a value only.
INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('admin:zatca:manage','platform','Request e-invoicing onboarding steps and retry submissions'),
  ('admin:zatca:approve','platform','Approve a credential step of e-invoicing onboarding (never your own request)');
INSERT INTO tenancy.role_permissions VALUES
  ('finance','admin:zatca:manage'),('platform_admin','admin:zatca:manage'),
  ('security','admin:zatca:approve'),('platform_admin','admin:zatca:approve'),
  ('security','admin:billing:read');

CREATE TABLE invoicing.zatca_onboarding (
  id uuid PRIMARY KEY,
  entity_id uuid NOT NULL REFERENCES invoicing.billing_entities(id),
  environment text NOT NULL CHECK (environment IN ('sandbox','simulation','production')),
  step text NOT NULL CHECK (step IN ('csr','compliance_csid','compliance_checks','production_csid')),
  status text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','completed','failed','rejected')),
  requested_by uuid NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,            -- whitelisted facts only (never an OTP, a secret or a private key)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'pending_approval') = (decided_at IS NULL)),
  CHECK (decided_by IS NULL OR decided_by <> requested_by OR step = 'compliance_checks')   -- two-person rule for credential steps
);
-- one completed step per (entity, environment, step); one pending request at a time
CREATE UNIQUE INDEX zatca_onboarding_completed_idx ON invoicing.zatca_onboarding (entity_id, environment, step) WHERE status = 'completed';
CREATE UNIQUE INDEX zatca_onboarding_pending_idx ON invoicing.zatca_onboarding (entity_id, environment) WHERE status = 'pending_approval';
CREATE FUNCTION invoicing.zatca_onboarding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'onboarding records are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF OLD.status <> 'pending_approval' THEN RAISE EXCEPTION 'a decided onboarding step cannot change' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF (to_jsonb(NEW) - 'status' - 'decided_by' - 'decided_at' - 'result' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'decided_by' - 'decided_at' - 'result' - 'updated_at') THEN
    RAISE EXCEPTION 'the identity of an onboarding step is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zatca_onboarding_guard BEFORE UPDATE OR DELETE ON invoicing.zatca_onboarding FOR EACH ROW EXECUTE FUNCTION invoicing.zatca_onboarding_guard();

CREATE TABLE invoicing.zatca_credentials_refs (
  id uuid PRIMARY KEY,
  entity_id uuid NOT NULL REFERENCES invoicing.billing_entities(id),
  environment text NOT NULL CHECK (environment IN ('sandbox','simulation','production')),
  kind text NOT NULL CHECK (kind IN ('csr_key','compliance_csid','production_csid')),
  key_ref text NOT NULL CHECK (key_ref ~ '^vault://[a-z]+/zatca/[a-z0-9][a-z0-9_-]{1,60}$'),
  token_ref text CHECK (token_ref IS NULL OR token_ref ~ '^vault://[a-z]+/zatca/[a-z0-9][a-z0-9_-]{1,60}$'),
  secret_ref text CHECK (secret_ref IS NULL OR secret_ref ~ '^vault://[a-z]+/zatca/[a-z0-9][a-z0-9_-]{1,60}$'),
  serial text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','revoked')),
  onboarding_id uuid REFERENCES invoicing.zatca_onboarding(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX zatca_credentials_active_idx ON invoicing.zatca_credentials_refs (entity_id, environment, kind) WHERE status = 'active';
CREATE FUNCTION invoicing.zatca_credentials_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'credential references are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN RAISE EXCEPTION 'a credential reference is immutable except its status' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF OLD.status <> 'active' AND NEW.status <> OLD.status THEN RAISE EXCEPTION 'a superseded or revoked credential cannot come back' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zatca_credentials_guard BEFORE UPDATE OR DELETE ON invoicing.zatca_credentials_refs FOR EACH ROW EXECUTE FUNCTION invoicing.zatca_credentials_guard();

DO $$ DECLARE t text; own text := current_user; BEGIN
  FOREACH t IN ARRAY ARRAY['zatca_onboarding','zatca_credentials_refs'] LOOP
    EXECUTE format('ALTER TABLE invoicing.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE invoicing.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY definer_all ON invoicing.%I TO %I USING (true) WITH CHECK (true)', t, own);
    EXECUTE format($p$CREATE POLICY platform_admin ON invoicing.%I USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
                      WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON invoicing.zatca_onboarding, invoicing.zatca_credentials_refs TO nuzm_app;
GRANT UPDATE (status, decided_by, decided_at, result, updated_at) ON invoicing.zatca_onboarding TO nuzm_app;
GRANT UPDATE (status) ON invoicing.zatca_credentials_refs TO nuzm_app;
GRANT SELECT ON invoicing.zatca_onboarding, invoicing.zatca_credentials_refs TO nuzm_readonly_reporting;

-- The runtime (stamping, submission) needs the ACTIVE credential REFERENCES of an entity/environment: refs only, never a secret.
CREATE FUNCTION invoicing.zatca_active_credential(p_entity uuid, p_env text)
RETURNS TABLE (kind text, key_ref text, token_ref text, secret_ref text, serial text, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.kind, c.key_ref, c.token_ref, c.secret_ref, c.serial, c.expires_at FROM invoicing.zatca_credentials_refs c
   WHERE c.entity_id = p_entity AND c.environment = p_env AND c.status = 'active' ORDER BY c.created_at DESC
$$;
REVOKE ALL ON FUNCTION invoicing.zatca_active_credential(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invoicing.zatca_active_credential(uuid, text) TO nuzm_app, nuzm_worker;

-- Cleared XML (what ZATCA returns for a standard invoice) is stored once next to the document.
ALTER TABLE invoicing.zatca_documents ADD COLUMN cleared_xml text, ADD COLUMN cleared_at timestamptz, ADD COLUMN cleared_archive_ref text;
ALTER TABLE invoicing.zatca_documents ADD CONSTRAINT zatca_cleared_chk CHECK ((cleared_xml IS NULL) = (cleared_at IS NULL));
CREATE OR REPLACE FUNCTION invoicing.zatca_document_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE tip record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT d.icv, d.invoice_hash INTO tip FROM invoicing.zatca_documents d WHERE d.entity_id = NEW.entity_id AND d.environment = NEW.environment ORDER BY d.icv DESC LIMIT 1;
    IF tip IS NULL THEN
      IF NEW.icv <> 1 THEN RAISE EXCEPTION 'the first document of a chain has icv 1' USING ERRCODE = 'check_violation', HINT = 'chain'; END IF;
    ELSE
      IF NEW.icv <> tip.icv + 1 THEN RAISE EXCEPTION 'icv must continue the chain (expected %)', tip.icv + 1 USING ERRCODE = 'check_violation', HINT = 'chain'; END IF;
      IF NEW.pih <> tip.invoice_hash THEN RAISE EXCEPTION 'pih must be the previous document hash' USING ERRCODE = 'check_violation', HINT = 'chain'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'e-invoice documents are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF (to_jsonb(NEW) - 'xml_final' - 'signature' - 'public_key' - 'qr' - 'stamped_at' - 'archive_ref' - 'archive_sha256' - 'archived_at' - 'cleared_xml' - 'cleared_at' - 'cleared_archive_ref')
     IS DISTINCT FROM (to_jsonb(OLD) - 'xml_final' - 'signature' - 'public_key' - 'qr' - 'stamped_at' - 'archive_ref' - 'archive_sha256' - 'archived_at' - 'cleared_xml' - 'cleared_at' - 'cleared_archive_ref') THEN
    RAISE EXCEPTION 'an e-invoice document is immutable except stamping, clearing and archiving' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.xml_final IS NOT NULL AND (NEW.xml_final IS DISTINCT FROM OLD.xml_final OR NEW.signature IS DISTINCT FROM OLD.signature OR NEW.qr IS DISTINCT FROM OLD.qr OR NEW.public_key IS DISTINCT FROM OLD.public_key) THEN
    RAISE EXCEPTION 'a stamped document cannot be re-stamped' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.archive_ref IS NOT NULL AND (NEW.archive_ref IS DISTINCT FROM OLD.archive_ref OR NEW.archive_sha256 IS DISTINCT FROM OLD.archive_sha256) THEN
    RAISE EXCEPTION 'the archive link is set once' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.cleared_xml IS NOT NULL AND (NEW.cleared_xml IS DISTINCT FROM OLD.cleared_xml OR NEW.cleared_at IS DISTINCT FROM OLD.cleared_at) THEN
    RAISE EXCEPTION 'cleared XML is set once' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  RETURN NEW;
END $$;
GRANT UPDATE (cleared_xml, cleared_at, cleared_archive_ref) ON invoicing.zatca_documents TO nuzm_app, nuzm_worker;

CREATE TABLE invoicing.zatca_submissions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  document_id uuid NOT NULL REFERENCES invoicing.zatca_documents(id),
  seq int NOT NULL CHECK (seq >= 1),
  state text NOT NULL CHECK (state IN ('generated','stamped','queued','submitted','cleared','reported','rejected','error')),
  attempt int NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  next_attempt_at timestamptz,
  dead_letter boolean NOT NULL DEFAULT false,
  response jsonb NOT NULL DEFAULT '{}'::jsonb,          -- whitelisted: status, warning/error codes and messages (never payloads with personal data)
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, seq),
  CHECK (NOT dead_letter OR state = 'error'),
  CHECK (state <> 'queued' OR next_attempt_at IS NOT NULL)
);
CREATE INDEX zatca_submissions_doc_idx ON invoicing.zatca_submissions (document_id, seq DESC);
CREATE INDEX zatca_submissions_org_idx ON invoicing.zatca_submissions (org_id, created_at DESC, id);
CREATE INDEX zatca_submissions_queue_idx ON invoicing.zatca_submissions (next_attempt_at) WHERE state = 'queued';
CREATE FUNCTION invoicing.zatca_submission_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE prev record;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'submission rows are append-only' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  SELECT s.seq, s.state INTO prev FROM invoicing.zatca_submissions s WHERE s.document_id = NEW.document_id ORDER BY s.seq DESC LIMIT 1;
  IF prev IS NULL THEN
    IF NEW.seq <> 1 OR NEW.state <> 'generated' THEN RAISE EXCEPTION 'the first submission row of a document is generated (seq 1)' USING ERRCODE = 'check_violation', HINT = 'state_machine'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.seq <> prev.seq + 1 THEN RAISE EXCEPTION 'submission rows are consecutive' USING ERRCODE = 'check_violation', HINT = 'state_machine'; END IF;
  IF NOT (
       (prev.state = 'generated' AND NEW.state = 'stamped')
    OR (prev.state = 'stamped'   AND NEW.state = 'queued')
    OR (prev.state = 'queued'    AND NEW.state = 'submitted')
    OR (prev.state = 'submitted' AND NEW.state IN ('cleared','reported','rejected','error'))
    OR (prev.state = 'error'     AND NEW.state = 'queued')
  ) THEN
    RAISE EXCEPTION 'illegal submission transition % -> %', prev.state, NEW.state USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zatca_submission_guard BEFORE INSERT OR UPDATE OR DELETE ON invoicing.zatca_submissions FOR EACH ROW EXECUTE FUNCTION invoicing.zatca_submission_guard();
CREATE TRIGGER zatca_submissions_no_truncate BEFORE TRUNCATE ON invoicing.zatca_submissions FOR EACH STATEMENT EXECUTE FUNCTION invoicing.zatca_no_truncate();
DO $$ DECLARE own text := current_user; BEGIN
  EXECUTE 'ALTER TABLE invoicing.zatca_submissions ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE invoicing.zatca_submissions FORCE ROW LEVEL SECURITY';
  EXECUTE format('CREATE POLICY definer_all ON invoicing.zatca_submissions TO %I USING (true) WITH CHECK (true)', own);
END $$;
CREATE POLICY org_isolation ON invoicing.zatca_submissions USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON invoicing.zatca_submissions FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON invoicing.zatca_submissions TO nuzm_app, nuzm_worker;
GRANT SELECT ON invoicing.zatca_submissions TO nuzm_readonly_reporting;

-- Work lists for the pipeline (cross-organization, ids only): documents whose CURRENT state is p_state (queued: only the due ones).
CREATE FUNCTION invoicing.zatca_pending(p_env text, p_state text, p_now timestamptz, p_limit int) RETURNS TABLE (org_id uuid, document_id uuid, seq int, attempt int)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.org_id, s.document_id, s.seq, s.attempt FROM invoicing.zatca_submissions s
    JOIN invoicing.zatca_documents d ON d.id = s.document_id
   WHERE d.environment = p_env AND s.state = p_state
     AND s.seq = (SELECT max(x.seq) FROM invoicing.zatca_submissions x WHERE x.document_id = s.document_id)
     AND (p_state <> 'queued' OR s.next_attempt_at <= p_now)
   ORDER BY s.created_at LIMIT p_limit
$$;
-- Issued legal documents that have no e-invoice yet in this environment (cutover date: nothing older is ever picked up).
CREATE FUNCTION invoicing.zatca_unprocessed(p_env text, p_from timestamptz, p_limit int) RETURNS TABLE (org_id uuid, source_type text, source_id uuid)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, pg_temp AS $$
  (SELECT i.org_id, 'invoice'::text, i.id FROM invoicing.invoices i
    WHERE i.status <> 'draft' AND i.issued_at >= p_from
      AND NOT EXISTS (SELECT 1 FROM invoicing.zatca_documents d WHERE d.source_type = 'invoice' AND d.source_id = i.id AND d.environment = p_env)
    ORDER BY i.issued_at LIMIT p_limit)
  UNION ALL
  (SELECT n.org_id, 'credit_note'::text, n.id FROM invoicing.credit_notes n
    WHERE n.status <> 'draft' AND n.issued_at >= p_from
      AND NOT EXISTS (SELECT 1 FROM invoicing.zatca_documents d WHERE d.source_type = 'credit_note' AND d.source_id = n.id AND d.environment = p_env)
    ORDER BY n.issued_at LIMIT p_limit)
$$;
REVOKE ALL ON FUNCTION invoicing.zatca_pending(text, text, timestamptz, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION invoicing.zatca_unprocessed(text, timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invoicing.zatca_pending(text, text, timestamptz, int) TO nuzm_app, nuzm_worker;
GRANT EXECUTE ON FUNCTION invoicing.zatca_unprocessed(text, timestamptz, int) TO nuzm_app, nuzm_worker;
