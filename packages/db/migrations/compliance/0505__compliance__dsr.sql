-- M04 S14b: data-subject requests (docs/10 §4, M04 §4 task 10). Exports are NOT a table (docs/05 §4): they are `platform.operations` + an ExportSink.
--  * dsr_requests: one row per request; status machine received -> identity_verified -> in_progress -> fulfilled | rejected | partially_fulfilled;
--    the identity of a request (organization, subject, type, requester, deadline) never changes; a closed request is immutable. The free-text details are
--    SEALED (field-level encryption, details_enc); subject_ref is an opaque id.
--  * dsr_tasks: one row per (request, handler, action); forward-only status.
INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('privacy:dsr:self','org','Open and follow data-subject requests about oneself'),
  ('privacy:dsr:manage','org','Open and read data-subject requests about the organization and its end users'),
  ('privacy:export:manage','org','Request and download organization data exports');
INSERT INTO tenancy.role_permissions VALUES
  ('owner','privacy:dsr:self'),('admin','privacy:dsr:self'),('billing_admin','privacy:dsr:self'),('developer','privacy:dsr:self'),('viewer','privacy:dsr:self'),
  ('owner','privacy:dsr:manage'),('admin','privacy:dsr:manage'),
  ('owner','privacy:export:manage'),('admin','privacy:export:manage');

CREATE TABLE compliance.dsr_requests (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  subject_ref text NOT NULL CHECK (subject_ref ~ '^[A-Za-z0-9:_.-]{1,128}$'),
  type text NOT NULL CHECK (type IN ('access','correction','deletion','portability')),
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','identity_verified','in_progress','fulfilled','rejected','partially_fulfilled')),
  requested_by uuid NOT NULL,
  identity_method text NOT NULL CHECK (identity_method IN ('session','org_attestation')),
  identity_note text CHECK (identity_note IS NULL OR length(identity_note) BETWEEN 10 AND 500),
  identity_verified_at timestamptz,
  details_enc text CHECK (details_enc IS NULL OR details_enc ~ '^enc:v1:[A-Za-z0-9_-]{1,40}:[A-Za-z0-9_-]{38,}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  outcome jsonb,
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[a-z_]{3,40}$'),
  operation_id uuid,
  sla_warned_at timestamptz,
  sla_escalated_at timestamptz,
  closed_at timestamptz,
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 255),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (due_at > received_at),
  CHECK ((status IN ('fulfilled','rejected','partially_fulfilled')) = (closed_at IS NOT NULL)),
  CHECK (status <> 'rejected' OR reason_code IS NOT NULL),
  CHECK (identity_method <> 'org_attestation' OR identity_note IS NOT NULL)
);
CREATE INDEX dsr_requests_open_idx ON compliance.dsr_requests (org_id, status, due_at);
CREATE UNIQUE INDEX dsr_requests_idem_idx ON compliance.dsr_requests (requested_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE FUNCTION compliance.dsr_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ord text[] := ARRAY['received','identity_verified','in_progress'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'data-subject requests are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.subject_ref <> OLD.subject_ref OR NEW.type <> OLD.type OR NEW.requested_by <> OLD.requested_by
     OR NEW.identity_method <> OLD.identity_method OR NEW.identity_note IS DISTINCT FROM OLD.identity_note OR NEW.details_enc IS DISTINCT FROM OLD.details_enc
     OR NEW.received_at <> OLD.received_at OR NEW.due_at <> OLD.due_at OR NEW.created_at <> OLD.created_at OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'the identity of a data-subject request is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.closed_at IS NOT NULL THEN RAISE EXCEPTION 'a closed data-subject request cannot change' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'received' AND NEW.status IN ('identity_verified','rejected'))
    OR (OLD.status = 'identity_verified' AND NEW.status IN ('in_progress','rejected'))
    OR (OLD.status = 'in_progress' AND NEW.status IN ('fulfilled','rejected','partially_fulfilled'))) THEN
    RAISE EXCEPTION 'illegal data-subject request transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER dsr_request_guard BEFORE UPDATE OR DELETE ON compliance.dsr_requests FOR EACH ROW EXECUTE FUNCTION compliance.dsr_request_guard();
CREATE TRIGGER dsr_request_no_truncate BEFORE TRUNCATE ON compliance.dsr_requests FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();
ALTER TABLE compliance.dsr_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance.dsr_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON compliance.dsr_requests USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON compliance.dsr_requests FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON compliance.dsr_requests TO nuzm_app, nuzm_worker;
GRANT UPDATE (status, identity_verified_at, outcome, reason_code, operation_id, sla_warned_at, sla_escalated_at, closed_at) ON compliance.dsr_requests TO nuzm_app, nuzm_worker;
GRANT SELECT ON compliance.dsr_requests TO nuzm_readonly_reporting;

CREATE TABLE compliance.dsr_tasks (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES compliance.dsr_requests(id),
  org_id uuid NOT NULL,
  handler text NOT NULL CHECK (handler ~ '^[a-z][a-z0-9_-]{1,40}$'),
  action text NOT NULL CHECK (action IN ('export','erase','rectify')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','refused','failed')),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[a-z_]{3,40}$'),
  result jsonb,
  error text CHECK (error IS NULL OR length(error) <= 300),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, handler, action),
  CHECK ((status = 'pending') = (finished_at IS NULL)),
  CHECK (status <> 'refused' OR reason_code IS NOT NULL)
);
CREATE INDEX dsr_tasks_request_idx ON compliance.dsr_tasks (request_id);
CREATE FUNCTION compliance.dsr_task_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'data-subject request tasks are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.request_id <> OLD.request_id OR NEW.org_id <> OLD.org_id OR NEW.handler <> OLD.handler OR NEW.action <> OLD.action OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity of a task is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.status <> 'pending' THEN RAISE EXCEPTION 'a finished task cannot change' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.attempts < OLD.attempts THEN RAISE EXCEPTION 'attempts only grow' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dsr_task_guard BEFORE UPDATE OR DELETE ON compliance.dsr_tasks FOR EACH ROW EXECUTE FUNCTION compliance.dsr_task_guard();
CREATE TRIGGER dsr_task_no_truncate BEFORE TRUNCATE ON compliance.dsr_tasks FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();
ALTER TABLE compliance.dsr_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance.dsr_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON compliance.dsr_tasks USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON compliance.dsr_tasks FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON compliance.dsr_tasks TO nuzm_app, nuzm_worker;
GRANT UPDATE (status, attempts, reason_code, result, error, started_at, finished_at) ON compliance.dsr_tasks TO nuzm_app, nuzm_worker;
GRANT SELECT ON compliance.dsr_tasks TO nuzm_readonly_reporting;
