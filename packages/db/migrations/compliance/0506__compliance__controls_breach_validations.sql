-- M04 S15: control register, evidence, breach cases, regulatory validation register (docs/10 §2, §6, §7; M04 §4 tasks 12-15).
-- NOTHING here asserts compliance with any regime:
--  * control_catalog is loaded from spec/compliance/controls.yaml by the sync tool under the admin role; claims_compliance is CHECKed false; the runtime role has SELECT only.
--  * evidence_items are immutable; the runtime role can INSERT manual evidence only (a policy refuses type 'automated': only the collectors, run under the admin role, write that).
--  * regulatory_validations are versioned and immutable; 'validated' needs a document reference, a human validator and a decided applicability (CHECK).
--  * breach_cases keep an append-only timeline; the notification decision is a human step and the platform sends nothing to any regulator.
-- All four tables are tenant-less platform registers: admin scope only.
INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('admin:controls:manage','platform','Map controls to features and add manual evidence'),
  ('admin:breach:manage','platform','Open breach cases and move them through the workflow');
INSERT INTO tenancy.role_permissions VALUES
  ('compliance_officer','admin:controls:manage'),('security','admin:controls:manage'),('platform_admin','admin:controls:manage'),
  ('compliance_officer','admin:breach:manage'),('security','admin:breach:manage'),('platform_admin','admin:breach:manage');

CREATE TABLE compliance.control_catalog (
  control_id text PRIMARY KEY CHECK (control_id ~ '^CTL-[A-Z]{2,6}-[0-9]{3}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  frameworks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(frameworks) = 'array'),
  applicability text NOT NULL DEFAULT 'to_confirm' CHECK (applicability IN ('to_confirm','applicable','not_applicable')),
  owner_role text NOT NULL CHECK (owner_role ~ '^[a-z_]{3,40}$'),
  implementation jsonb NOT NULL CHECK (jsonb_typeof(implementation) = 'object'),
  evidence_spec jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_spec) = 'array'),
  review_cadence_days int NOT NULL CHECK (review_cadence_days BETWEEN 1 AND 730),
  claims_compliance boolean NOT NULL DEFAULT false CHECK (claims_compliance = false),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  loaded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE compliance.control_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance.control_catalog FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_read ON compliance.control_catalog FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT ON compliance.control_catalog TO nuzm_app;
GRANT SELECT ON compliance.control_catalog TO nuzm_readonly_reporting;

CREATE TABLE compliance.control_mappings (
  id uuid PRIMARY KEY,
  control_id text NOT NULL REFERENCES compliance.control_catalog(control_id),
  module text NOT NULL CHECK (module ~ '^[a-z][a-z0-9_-]{1,40}$'),
  feature text NOT NULL CHECK (length(feature) BETWEEN 1 AND 120),
  evidence_requirement text NOT NULL CHECK (length(evidence_requirement) BETWEEN 1 AND 300),
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 255),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (control_id, module, feature)
);
CREATE UNIQUE INDEX control_mappings_idem_idx ON compliance.control_mappings (created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE FUNCTION compliance.immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'check_violation', HINT = 'immutable';
END $$;
CREATE TRIGGER control_mappings_immutable BEFORE UPDATE OR DELETE ON compliance.control_mappings FOR EACH ROW EXECUTE FUNCTION compliance.immutable_row();
CREATE TRIGGER control_mappings_no_truncate BEFORE TRUNCATE ON compliance.control_mappings FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();
ALTER TABLE compliance.control_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance.control_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON compliance.control_mappings USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON compliance.control_mappings TO nuzm_app;
GRANT SELECT ON compliance.control_mappings TO nuzm_readonly_reporting;

CREATE TABLE compliance.evidence_items (
  id uuid PRIMARY KEY,
  control_id text NOT NULL REFERENCES compliance.control_catalog(control_id),
  type text NOT NULL CHECK (type IN ('automated','document','attestation','external-report')),
  source text NOT NULL CHECK (source ~ '^[a-z0-9][a-z0-9._:-]{0,59}$'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  collected_at timestamptz NOT NULL DEFAULT now(),
  collector text CHECK (collector IS NULL OR collector ~ '^[a-z][a-z0-9._-]{2,60}$'),
  collector_version text CHECK (collector_version IS NULL OR length(collector_version) BETWEEN 1 AND 40),
  document_ref text CHECK (document_ref IS NULL OR length(document_ref) BETWEEN 3 AND 300),
  attested_by uuid,
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 1000),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object' AND length(summary::text) <= 8000),
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 255),
  CHECK ((type = 'automated') = (collector IS NOT NULL)),
  CHECK (type <> 'automated' OR (attested_by IS NULL AND document_ref IS NULL)),
  CHECK (type = 'automated' OR attested_by IS NOT NULL),
  CHECK (type NOT IN ('document','external-report') OR document_ref IS NOT NULL)
);
-- a collector run over identical input yields the identical hash and therefore no second row (AC-M04-09)
CREATE UNIQUE INDEX evidence_automated_uidx ON compliance.evidence_items (control_id, collector, content_hash) WHERE type = 'automated';
CREATE UNIQUE INDEX evidence_idem_idx ON compliance.evidence_items (attested_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX evidence_control_idx ON compliance.evidence_items (control_id, collected_at DESC);
CREATE TRIGGER evidence_immutable BEFORE UPDATE OR DELETE ON compliance.evidence_items FOR EACH ROW EXECUTE FUNCTION compliance.immutable_row();
CREATE TRIGGER evidence_no_truncate BEFORE TRUNCATE ON compliance.evidence_items FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();
ALTER TABLE compliance.evidence_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance.evidence_items FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_read ON compliance.evidence_items FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
-- the runtime role writes MANUAL evidence only: automated rows come from the collectors under the admin role
CREATE POLICY platform_insert_manual ON compliance.evidence_items FOR INSERT
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin' AND type <> 'automated');
GRANT SELECT, INSERT ON compliance.evidence_items TO nuzm_app;
GRANT SELECT ON compliance.evidence_items TO nuzm_readonly_reporting;

CREATE TABLE compliance.regulatory_validations (
  id uuid PRIMARY KEY,
  validation_key text NOT NULL CHECK (validation_key ~ '^[a-z][a-z0-9-]{2,60}$'),
  version int NOT NULL CHECK (version >= 1),
  regime text NOT NULL CHECK (length(regime) BETWEEN 2 AND 120),
  question text NOT NULL CHECK (length(question) BETWEEN 10 AND 800),
  applicability text NOT NULL DEFAULT 'to_confirm' CHECK (applicability IN ('to_confirm','applicable','not_applicable')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','validated','rejected')),
  answer text CHECK (answer IS NULL OR length(answer) BETWEEN 1 AND 2000),
  document_ref text CHECK (document_ref IS NULL OR length(document_ref) BETWEEN 3 AND 300),
  validated_by uuid,
  validated_at timestamptz,
  change_note text CHECK (change_note IS NULL OR length(change_note) BETWEEN 1 AND 500),
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 255),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (validation_key, version),
  CHECK (status <> 'validated' OR (document_ref IS NOT NULL AND validated_by IS NOT NULL AND validated_at IS NOT NULL AND applicability <> 'to_confirm')),
  CHECK (status = 'validated' OR (validated_by IS NULL AND validated_at IS NULL)),
  CHECK (status <> 'answered' OR answer IS NOT NULL)
);
CREATE UNIQUE INDEX validations_idem_idx ON compliance.regulatory_validations (validation_key, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TRIGGER validations_immutable BEFORE UPDATE OR DELETE ON compliance.regulatory_validations FOR EACH ROW EXECUTE FUNCTION compliance.immutable_row();
CREATE TRIGGER validations_no_truncate BEFORE TRUNCATE ON compliance.regulatory_validations FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();
ALTER TABLE compliance.regulatory_validations ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance.regulatory_validations FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON compliance.regulatory_validations USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON compliance.regulatory_validations TO nuzm_app;
GRANT SELECT ON compliance.regulatory_validations TO nuzm_readonly_reporting;
-- The open questions of docs/10 §1 (created by the platform, not by a person): applicability stays to_confirm until a human with counsel answers.
INSERT INTO compliance.regulatory_validations (id, validation_key, version, regime, question, created_by) VALUES
  (gen_random_uuid(),'pdpl-role-and-bases',1,'Personal Data Protection Law (PDPL) and implementing regulations','Which PDPL role does Nuzm hold for each processing activity (controller or processor), which lawful bases apply, and is a DPO required? (D-16, HG-04-01)',NULL),
  (gen_random_uuid(),'cross-border-transfer',1,'Data residency and cross-border transfer rules','Which cross-border transfer rules and sector or customer-contract rules apply to provider regions, backups, AI inference and email vendors? (D-14, HG-04-01)',NULL),
  (gen_random_uuid(),'nca-ecc',1,'NCA Essential Cybersecurity Controls (ECC)','Does the ECC apply to Nuzm, at what scope, and which control references should the register map to? (D-17, HG-04-02)',NULL),
  (gen_random_uuid(),'nca-ccc',1,'NCA Cloud Cybersecurity Controls (CCC)','Is Nuzm classed as a cloud service provider for the CCC, and what does that require? (D-17, HG-04-02)',NULL),
  (gen_random_uuid(),'nca-other',1,'Other NCA instruments','Which other NCA instruments are customer-driven or sector-driven and should be mapped? (D-17)',NULL),
  (gen_random_uuid(),'cst-cloud-framework',1,'CST cloud computing regulatory framework','Does service-provider registration or classification apply to Nuzm, and who files it? (D-17, HG-04-02)',NULL),
  (gen_random_uuid(),'zatca-einvoicing-vat',1,'ZATCA e-invoicing and VAT','Which e-invoicing phase and VAT rules apply, and what retention period applies to invoices? (HG-03-03, HG-03-04, D-34)',NULL),
  (gen_random_uuid(),'sama-payments',1,'SAMA rules (payments)','Do Nuzm''s payment flows touch regulated activity beyond using a licensed PSP? (D-10, D-26)',NULL),
  (gen_random_uuid(),'domain-registry-sa',1,'Domain registry rules (.sa eligibility)','What eligibility rules apply to .sa registrations and who verifies them? (D-19, HG-07-02)',NULL);

CREATE TABLE compliance.breach_cases (
  id uuid PRIMARY KEY,
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  state text NOT NULL DEFAULT 'detected' CHECK (state IN ('detected','triaged','assessed','notification_decision','notified','remediation','closed')),
  summary text NOT NULL CHECK (length(summary) BETWEEN 10 AND 2000),
  detected_at timestamptz NOT NULL CHECK (detected_at <= now() + interval '5 minutes'),
  timeline jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(timeline) = 'array' AND jsonb_array_length(timeline) <= 200),
  assessment jsonb CHECK (assessment IS NULL OR jsonb_typeof(assessment) = 'object'),
  decision jsonb CHECK (decision IS NULL OR jsonb_typeof(decision) = 'object'),
  linked_incident_id text CHECK (linked_incident_id IS NULL OR linked_incident_id ~ '^[A-Za-z0-9:_.-]{1,128}$'),
  created_by uuid NOT NULL,
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 255),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK ((state = 'closed') = (closed_at IS NOT NULL)),
  CHECK (state IN ('detected','triaged') OR assessment IS NOT NULL),
  CHECK (state IN ('detected','triaged','assessed') OR decision IS NOT NULL)
);
CREATE UNIQUE INDEX breach_idem_idx ON compliance.breach_cases (created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX breach_list_idx ON compliance.breach_cases (created_at DESC, id);
CREATE FUNCTION compliance.breach_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n int := jsonb_array_length(OLD.timeline);
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'breach cases are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.summary <> OLD.summary OR NEW.detected_at <> OLD.detected_at OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'the identity of a breach case is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.state = 'closed' THEN RAISE EXCEPTION 'a closed breach case cannot change' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  -- the timeline only grows: the first n entries are exactly the old ones
  IF jsonb_array_length(NEW.timeline) < n
     OR coalesce((SELECT jsonb_agg(e ORDER BY o) FROM jsonb_array_elements(NEW.timeline) WITH ORDINALITY t(e, o) WHERE o <= n), '[]'::jsonb) <> OLD.timeline THEN
    RAISE EXCEPTION 'the timeline of a breach case is append-only' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'detected' AND NEW.state = 'triaged')
    OR (OLD.state = 'triaged' AND NEW.state = 'assessed')
    OR (OLD.state = 'assessed' AND NEW.state = 'notification_decision')
    OR (OLD.state = 'notification_decision' AND NEW.state IN ('notified','remediation'))
    OR (OLD.state = 'notified' AND NEW.state = 'remediation')
    OR (OLD.state = 'remediation' AND NEW.state = 'closed')) THEN
    RAISE EXCEPTION 'illegal breach case transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  IF NEW.state = 'remediation' AND OLD.state = 'notification_decision' AND coalesce((NEW.decision->>'notify')::boolean, true) THEN
    RAISE EXCEPTION 'notification was decided: record it as notified first' USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  IF NEW.state = 'notified' AND NOT coalesce((NEW.decision->>'notify')::boolean, false) THEN
    RAISE EXCEPTION 'no notification was decided' USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER breach_guard BEFORE UPDATE OR DELETE ON compliance.breach_cases FOR EACH ROW EXECUTE FUNCTION compliance.breach_guard();
CREATE TRIGGER breach_no_truncate BEFORE TRUNCATE ON compliance.breach_cases FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();
ALTER TABLE compliance.breach_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance.breach_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON compliance.breach_cases USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON compliance.breach_cases TO nuzm_app;
GRANT UPDATE (state, timeline, assessment, decision, severity, closed_at) ON compliance.breach_cases TO nuzm_app;
GRANT SELECT ON compliance.breach_cases TO nuzm_readonly_reporting;
