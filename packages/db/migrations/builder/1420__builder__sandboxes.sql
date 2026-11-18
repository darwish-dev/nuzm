-- M10A S45: sandboxes (isolated, per project) for untrusted generated code. The runtime technology is NOT decided (D-21 OPEN) and no isolating runtime exists yet:
--  * `runtime_kind` / `isolation` say what really ran it. `isolation = 'verified'` is reserved for a runtime whose escape suite ran against it AND whose security review
--    (HG-10-02) is recorded; nothing in this repository writes it. mock/local-dev rows are NOT isolation evidence.
--  * `project_id` is a logical reference to builder.projects (M09); `node_ref` is a logical reference to cloud.resources (M05).
--  * The terminal ticket is stored as a hash: single-use, 60 s, bound to one user and this sandbox (redeemed with an UPDATE that clears it).
CREATE TABLE builder.sandboxes (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  profile text NOT NULL DEFAULT 'standard' CHECK (profile ~ '^[a-z][a-z0-9-]{1,30}$'),
  runtime_kind text NOT NULL CHECK (runtime_kind IN ('mock','local-dev','isolated')),
  isolation text NOT NULL CHECK (isolation IN ('none','simulated','verified')),
  runtime_handle text,
  node_ref text,
  state text NOT NULL DEFAULT 'starting' CHECK (state IN ('starting','ready','terminating','terminated','failed','expired')),
  egress_profile text NOT NULL DEFAULT 'default',
  quota jsonb NOT NULL CHECK (jsonb_typeof(quota) = 'object'),
  ttl_at timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  cpu_metered numeric(18,3) NOT NULL DEFAULT 0 CHECK (cpu_metered >= 0),
  metered_until timestamptz,
  ws_ticket_hash text CHECK (ws_ticket_hash IS NULL OR ws_ticket_hash ~ '^[0-9a-f]{64}$'),
  ws_ticket_user uuid,
  ws_ticket_expires_at timestamptz,
  termination_reason text CHECK (termination_reason IS NULL OR length(termination_reason) <= 80),
  data_region text NOT NULL,
  operation_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  terminated_at timestamptz,
  version int NOT NULL DEFAULT 1,
  CHECK ((state IN ('terminated','expired')) = (terminated_at IS NOT NULL)),
  CHECK (isolation <> 'verified' OR runtime_kind = 'isolated')
);
CREATE INDEX sandboxes_org_state_idx ON builder.sandboxes (org_id, state, created_at DESC);
CREATE INDEX sandboxes_project_idx ON builder.sandboxes (org_id, project_id, created_at DESC);
CREATE INDEX sandboxes_reaper_idx ON builder.sandboxes (state, ttl_at) WHERE state IN ('starting','ready');
CREATE FUNCTION builder.sandbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'sandbox records are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.project_id <> OLD.project_id OR NEW.data_region <> OLD.data_region OR NEW.runtime_kind <> OLD.runtime_kind
     OR NEW.isolation <> OLD.isolation OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity, region and runtime of a sandbox are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'starting' AND NEW.state IN ('ready','failed','terminating'))
    OR (OLD.state = 'ready' AND NEW.state IN ('terminating','expired','failed'))
    OR (OLD.state = 'terminating' AND NEW.state IN ('terminated','failed'))
    OR (OLD.state = 'failed' AND NEW.state = 'terminating')) THEN
    RAISE EXCEPTION 'illegal sandbox state transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER sandbox_guard BEFORE UPDATE OR DELETE ON builder.sandboxes FOR EACH ROW EXECUTE FUNCTION builder.sandbox_guard();
CREATE TRIGGER sandbox_no_truncate BEFORE TRUNCATE ON builder.sandboxes FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();
ALTER TABLE builder.sandboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder.sandboxes FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON builder.sandboxes USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON builder.sandboxes FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON builder.sandboxes TO nuzm_app, nuzm_worker;
GRANT UPDATE (runtime_handle, node_ref, state, ttl_at, last_activity_at, cpu_metered, metered_until, ws_ticket_hash, ws_ticket_user, ws_ticket_expires_at, termination_reason, operation_id, started_at, terminated_at) ON builder.sandboxes TO nuzm_app, nuzm_worker;
GRANT SELECT ON builder.sandboxes TO nuzm_readonly_reporting;
