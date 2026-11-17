-- M04 S14a: residency policy and transfer assessments (docs/10 §3, M04 §4 tasks 7-8).
--  * residency_policies: VERSIONED, immutable. org_id NULL = the PLATFORM FLOOR (per data class, the loosest mode the platform allows; seeded from the
--    values of spec/compliance/defaults.yaml: PROPOSAL, D-14/HG-04-01). An organization row holds its mode, per-class country allow-lists and the ids of
--    the approved transfer assessments it relies on (exceptions). An organization may only TIGHTEN the floor: the service refuses a loosening (422).
--  * transfer_assessments: create -> a DIFFERENT person decides (check) -> approved ones expire. Scope = data class × region (country or group) × processor.
INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('privacy:residency:read','org','Read the organization''s data residency policy and the platform floor'),
  ('privacy:residency:manage','org','Change the organization''s data residency policy (tighten only)');
INSERT INTO tenancy.role_permissions VALUES
  ('owner','privacy:residency:read'),('admin','privacy:residency:read'),('billing_admin','privacy:residency:read'),('developer','privacy:residency:read'),('viewer','privacy:residency:read'),
  ('owner','privacy:residency:manage'),('admin','privacy:residency:manage');

CREATE TABLE compliance.residency_policies (
  id uuid PRIMARY KEY,
  org_id uuid,
  version int NOT NULL CHECK (version >= 1),
  mode text NOT NULL CHECK (mode IN ('in_kingdom_only','allow_listed','unrestricted_with_assessment')),
  allowed jsonb NOT NULL,
  exceptions uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(exceptions) <= 50),
  effective_from timestamptz NOT NULL DEFAULT now(),
  change_note text CHECK (change_note IS NULL OR length(change_note) BETWEEN 1 AND 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((org_id IS NULL AND allowed ? 'floorByClass' AND cardinality(exceptions) = 0) OR (org_id IS NOT NULL AND allowed ? 'allowedCountriesByClass'))
);
CREATE UNIQUE INDEX residency_policy_version_idx ON compliance.residency_policies ((coalesce(org_id::text, '')), version);
CREATE FUNCTION compliance.residency_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev int;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'residency policies are versioned: insert a new version instead' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  SELECT max(version) INTO prev FROM compliance.residency_policies WHERE org_id IS NOT DISTINCT FROM NEW.org_id;
  IF NEW.version <> coalesce(prev, 0) + 1 THEN RAISE EXCEPTION 'version must be %', coalesce(prev, 0) + 1 USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER residency_policy_insert BEFORE INSERT ON compliance.residency_policies FOR EACH ROW EXECUTE FUNCTION compliance.residency_policy_guard();
CREATE TRIGGER residency_policy_immutable BEFORE UPDATE OR DELETE ON compliance.residency_policies FOR EACH ROW EXECUTE FUNCTION compliance.residency_policy_guard();
CREATE TRIGGER residency_policy_no_truncate BEFORE TRUNCATE ON compliance.residency_policies FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();
ALTER TABLE compliance.residency_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance.residency_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON compliance.residency_policies USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
-- the platform floor (org_id NULL) is readable by every runtime role: every module that asks the residency service needs it
CREATE POLICY platform_floor_read ON compliance.residency_policies FOR SELECT USING (org_id IS NULL);
CREATE POLICY platform_admin ON compliance.residency_policies USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON compliance.residency_policies TO nuzm_app, nuzm_worker;
GRANT SELECT ON compliance.residency_policies TO nuzm_readonly_reporting;
-- PROPOSAL floor (= spec/compliance/defaults.yaml; a test keeps the two equal)
INSERT INTO compliance.residency_policies (id, org_id, version, mode, allowed, change_note) VALUES
  (gen_random_uuid(), NULL, 1, 'in_kingdom_only',
   '{"floorByClass":{"public":"unrestricted_with_assessment","internal":"unrestricted_with_assessment","customer-content":"unrestricted_with_assessment","personal":"unrestricted_with_assessment","financial":"unrestricted_with_assessment","credentials":"in_kingdom_only"}}',
   'seeded proposal (D-14, HG-04-01)');

CREATE TABLE compliance.transfer_assessments (
  id uuid PRIMARY KEY,
  org_id uuid,
  data_class text NOT NULL CHECK (data_class ~ '^[a-z][a-z-]{2,30}$'),
  region text NOT NULL CHECK (region ~ '^([A-Z]{2}|in_kingdom|gcc|eu|other)$'),
  processor_id text CHECK (processor_id IS NULL OR length(processor_id) BETWEEN 1 AND 120),
  risk text NOT NULL CHECK (risk IN ('low','medium','high')),
  mitigations text NOT NULL CHECK (length(mitigations) BETWEEN 10 AND 2000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by uuid NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) BETWEEN 1 AND 500),
  expires_at timestamptz NOT NULL,
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requested_by <> decided_by),
  CHECK ((status = 'pending') = (decided_at IS NULL AND decided_by IS NULL)),
  CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX transfer_assessments_idem_idx ON compliance.transfer_assessments (requested_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX transfer_assessments_list_idx ON compliance.transfer_assessments (created_at DESC, id);
CREATE FUNCTION compliance.transfer_assessment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'transfer assessments are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM compliance.data_classes WHERE key = NEW.data_class) THEN RAISE EXCEPTION 'unknown data class %', NEW.data_class USING ERRCODE = 'check_violation'; END IF;
    IF NEW.status <> 'pending' THEN RAISE EXCEPTION 'an assessment starts pending' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.data_class <> OLD.data_class OR NEW.region <> OLD.region OR NEW.processor_id IS DISTINCT FROM OLD.processor_id
     OR NEW.risk <> OLD.risk OR NEW.mitigations <> OLD.mitigations OR NEW.requested_by <> OLD.requested_by OR NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'the scope and the people of an assessment are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved','rejected') THEN
    RAISE EXCEPTION 'illegal assessment transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  IF NEW.status = 'approved' AND (NEW.expires_at <= now() OR NEW.expires_at > now() + interval '730 days') THEN
    RAISE EXCEPTION 'an approved assessment must expire in the future and within 730 days' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER transfer_assessment_guard BEFORE INSERT OR UPDATE OR DELETE ON compliance.transfer_assessments FOR EACH ROW EXECUTE FUNCTION compliance.transfer_assessment_guard();
CREATE TRIGGER transfer_assessment_no_truncate BEFORE TRUNCATE ON compliance.transfer_assessments FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();
ALTER TABLE compliance.transfer_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance.transfer_assessments FORCE ROW LEVEL SECURITY;
-- an organization reads its own assessments and the platform-wide ones (to validate the exceptions of its policy); only the admin scope writes
CREATE POLICY org_read ON compliance.transfer_assessments FOR SELECT
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR org_id IS NULL);
CREATE POLICY platform_admin ON compliance.transfer_assessments USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON compliance.transfer_assessments TO nuzm_app, nuzm_worker;
GRANT UPDATE (status, decided_by, decided_at, decision_note) ON compliance.transfer_assessments TO nuzm_app, nuzm_worker;
GRANT SELECT ON compliance.transfer_assessments TO nuzm_readonly_reporting;
