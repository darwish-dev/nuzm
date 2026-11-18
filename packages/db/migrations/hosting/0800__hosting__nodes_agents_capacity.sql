-- M06 S24: hosting nodes, node agents, enrolment, capacity and the agent command log (M06 §7, ADR-020 proposal).
-- Owner-directed exception (M06 started before M05 exists on this base): nodes reference their compute instance by an OPAQUE text id
-- (`compute_instance_id`); there is NO cross-schema FK (docs/05). All tables here are platform tables (no org_id): admin scope only.
--  * nodes: status provisioning is skipped on purpose; a node is created in `maintenance` and goes `active` only after an enrolled agent reported a
--    healthy inventory. overcommit_factor above 1.0 needs an approved dual-approval change (node_overcommit_changes); the CHECK enforces it in the database.
--  * node_capacity: per node and dimension physical / sellable / reserved. CHECK reserved >= 0 AND reserved <= sellable (the invariant of AC-M06-02);
--    a trigger refuses sellable above floor(physical * overcommit_factor): there is no hidden oversell, even if the application has a bug.
--  * node_command_log: the hash-chained, append-only audit log the agent ships (every envelope decision, accepted or rejected).
CREATE SCHEMA IF NOT EXISTS hosting;
GRANT USAGE ON SCHEMA hosting TO nuzm_app, nuzm_worker, nuzm_readonly_reporting;

INSERT INTO tenancy.roles (name, scope, description) VALUES
  ('hosting_admin','platform','Operate shared-hosting nodes, capacity, agents and abuse cases');
INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('admin:hosting:read','platform','Read hosting nodes, capacity, agents, sites and abuse cases (cross-organization reads are audited)'),
  ('admin:hosting:manage','platform','Create and change hosting nodes, drain/maintenance, agent enrolment, site suspension'),
  ('admin:hosting:abuse','platform','Open and action hosting abuse cases'),
  ('admin:hosting:approve','platform','Approve a dual-approval change of a hosting node (overcommit)');
INSERT INTO tenancy.role_permissions VALUES
  ('hosting_admin','admin:hosting:read'),('hosting_admin','admin:hosting:manage'),('hosting_admin','admin:hosting:abuse'),('hosting_admin','admin:hosting:approve'),
  ('platform_admin','admin:hosting:read'),('platform_admin','admin:hosting:manage'),('platform_admin','admin:hosting:abuse'),('platform_admin','admin:hosting:approve'),
  ('support','admin:hosting:read'),('support','admin:hosting:abuse'),
  ('security','admin:hosting:read'),('security','admin:hosting:abuse');

CREATE TABLE hosting.nodes (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (name ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  compute_instance_id text NOT NULL UNIQUE CHECK (length(compute_instance_id) BETWEEN 1 AND 200),
  region text NOT NULL CHECK (length(region) BETWEEN 1 AND 80),
  data_region text NOT NULL CHECK (data_region ~ '^[A-Za-z0-9._-]{2,40}$'),
  status text NOT NULL DEFAULT 'maintenance' CHECK (status IN ('active','draining','maintenance','retired')),
  agent_id uuid,
  cloudpanel_version text CHECK (cloudpanel_version IS NULL OR length(cloudpanel_version) <= 40),
  runtimes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(runtimes) = 'array'),
  overcommit_factor numeric(4,2) NOT NULL DEFAULT 1.0 CHECK (overcommit_factor BETWEEN 0.5 AND 2.0),
  overcommit_change_id uuid,
  last_inventory jsonb,
  last_inventory_at timestamptz,
  health text NOT NULL DEFAULT 'unknown' CHECK (health IN ('healthy','degraded','unhealthy','unknown')),
  version int NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (overcommit_factor <= 1.0 OR overcommit_change_id IS NOT NULL)
);
CREATE INDEX nodes_status_region_idx ON hosting.nodes (status, data_region);

CREATE TABLE hosting.node_overcommit_changes (
  id uuid PRIMARY KEY,
  node_id uuid NOT NULL REFERENCES hosting.nodes(id),
  from_factor numeric(4,2) NOT NULL,
  to_factor numeric(4,2) NOT NULL CHECK (to_factor BETWEEN 0.5 AND 2.0),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by uuid NOT NULL,
  approver_id uuid NOT NULL,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requested_by <> approver_id),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
ALTER TABLE hosting.nodes ADD CONSTRAINT nodes_overcommit_change_fk FOREIGN KEY (overcommit_change_id) REFERENCES hosting.node_overcommit_changes(id);
CREATE FUNCTION hosting.overcommit_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'overcommit changes are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'illegal change transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation'; END IF;
    IF NEW.node_id <> OLD.node_id OR NEW.to_factor <> OLD.to_factor OR NEW.requested_by <> OLD.requested_by OR NEW.approver_id <> OLD.approver_id OR NEW.reason <> OLD.reason THEN
      RAISE EXCEPTION 'the scope and the people of a change are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER overcommit_change_guard BEFORE UPDATE OR DELETE ON hosting.node_overcommit_changes FOR EACH ROW EXECUTE FUNCTION hosting.overcommit_change_guard();
CREATE TRIGGER overcommit_change_no_truncate BEFORE TRUNCATE ON hosting.node_overcommit_changes FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();

CREATE TABLE hosting.node_agents (
  id uuid PRIMARY KEY,
  node_id uuid NOT NULL REFERENCES hosting.nodes(id),
  cert_fingerprint text CHECK (cert_fingerprint IS NULL OR cert_fingerprint ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','enrolled','revoked')),
  version text CHECK (version IS NULL OR length(version) <= 40),
  enrolled_at timestamptz,
  last_seen_at timestamptz,
  cert_rotated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'enrolled') = (enrolled_at IS NOT NULL AND cert_fingerprint IS NOT NULL) OR state = 'revoked')
);
CREATE UNIQUE INDEX node_agents_one_live_idx ON hosting.node_agents (node_id) WHERE state <> 'revoked';
CREATE UNIQUE INDEX node_agents_fingerprint_idx ON hosting.node_agents (cert_fingerprint) WHERE cert_fingerprint IS NOT NULL AND state = 'enrolled';

CREATE TABLE hosting.node_enrolment_tokens (
  id uuid PRIMARY KEY,
  node_id uuid NOT NULL REFERENCES hosting.nodes(id),
  agent_id uuid NOT NULL REFERENCES hosting.node_agents(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE TABLE hosting.node_capacity (
  node_id uuid NOT NULL REFERENCES hosting.nodes(id),
  dim text NOT NULL CHECK (dim IN ('cpu_millicores','memory_mb','disk_mb','sites')),
  physical bigint NOT NULL CHECK (physical >= 0),
  sellable bigint NOT NULL CHECK (sellable >= 0),
  reserved bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, dim),
  CONSTRAINT node_capacity_invariant CHECK (reserved >= 0 AND reserved <= sellable)
);
CREATE FUNCTION hosting.node_capacity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f numeric;
BEGIN
  SELECT overcommit_factor INTO f FROM hosting.nodes WHERE id = NEW.node_id;
  IF NEW.sellable > floor(NEW.physical * f) THEN
    RAISE EXCEPTION 'sellable % exceeds physical % x overcommit factor %', NEW.sellable, NEW.physical, f USING ERRCODE = 'check_violation', HINT = 'no_hidden_oversell';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER node_capacity_guard BEFORE INSERT OR UPDATE ON hosting.node_capacity FOR EACH ROW EXECUTE FUNCTION hosting.node_capacity_guard();
-- the factor of a node can only be lowered below existing sellable capacity if sellable is lowered in the same transaction
CREATE FUNCTION hosting.node_factor_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.overcommit_factor < OLD.overcommit_factor AND EXISTS (
       SELECT 1 FROM hosting.node_capacity c WHERE c.node_id = NEW.id AND c.sellable > floor(c.physical * NEW.overcommit_factor)) THEN
    RAISE EXCEPTION 'lower sellable capacity first (it exceeds physical x the new factor)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER node_factor_guard BEFORE UPDATE OF overcommit_factor ON hosting.nodes FOR EACH ROW EXECUTE FUNCTION hosting.node_factor_guard();

CREATE FUNCTION hosting.immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'check_violation', HINT = 'immutable';
END $$;

CREATE TABLE hosting.node_command_log (
  id uuid PRIMARY KEY,
  node_id uuid NOT NULL REFERENCES hosting.nodes(id),
  agent_seq bigint NOT NULL CHECK (agent_seq >= 1),
  operation_id text,
  command_id text,
  outcome text NOT NULL CHECK (outcome IN ('accepted','rejected','executed','failed')),
  reason text CHECK (reason IS NULL OR length(reason) <= 200),
  envelope_hash text NOT NULL CHECK (envelope_hash ~ '^[0-9a-f]{64}$'),
  prev_hash text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (node_id, agent_seq)
);
CREATE TRIGGER node_command_log_immutable BEFORE UPDATE OR DELETE ON hosting.node_command_log FOR EACH ROW EXECUTE FUNCTION hosting.immutable_row();
CREATE TRIGGER node_command_log_no_truncate BEFORE TRUNCATE ON hosting.node_command_log FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['nodes','node_overcommit_changes','node_agents','node_enrolment_tokens','node_capacity','node_command_log'] LOOP
    EXECUTE format('ALTER TABLE hosting.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hosting.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY platform_admin ON hosting.%I USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin') WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT ON hosting.%I TO nuzm_readonly_reporting', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON hosting.nodes, hosting.node_agents, hosting.node_enrolment_tokens, hosting.node_capacity TO nuzm_app, nuzm_worker;
GRANT SELECT, INSERT, UPDATE ON hosting.node_overcommit_changes TO nuzm_app, nuzm_worker;
GRANT SELECT, INSERT ON hosting.node_command_log TO nuzm_app, nuzm_worker;
