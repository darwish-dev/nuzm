-- M03 S12a: financial reconciliation store (docs/05 `finrec`, docs/11 §9). The single place where reconciliation results live.
--  * Runs are immutable once finished; items keep their detail and only move through the break workflow (open -> assigned -> resolved);
--    resolutions are append-only rows that link an approved adjustment (the ledger is never edited by reconciliation).
--  * Tenant-less on purpose: a run spans organizations. Reachable only with the admin scope (finance, platform admin; read: compliance officer).
--  * One run per (type, period) may be in progress at a time (unique partial index): a second request is a 409.
CREATE SCHEMA IF NOT EXISTS finrec;
GRANT USAGE ON SCHEMA finrec TO nuzm_app, nuzm_worker, nuzm_readonly_reporting;

INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('admin:reports:read','platform','Read revenue and finance reports (reads the ledger across organizations; audited)');
INSERT INTO tenancy.role_permissions VALUES ('finance','admin:reports:read'),('platform_admin','admin:reports:read');

CREATE TABLE finrec.reconciliation_runs (
  id uuid PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('RC-01','RC-02','RC-03','RC-04','RC-05','RC-06')),
  period_from date NOT NULL,
  period_to date NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  trigger text NOT NULL CHECK (trigger IN ('manual','scheduled')),
  requested_by uuid,
  tolerance jsonb NOT NULL DEFAULT '{}'::jsonb,
  items_checked int NOT NULL DEFAULT 0 CHECK (items_checked >= 0),
  breaks_count int NOT NULL DEFAULT 0 CHECK (breaks_count >= 0),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  CHECK (period_to >= period_from),
  CHECK (period_to - period_from <= 400),
  CHECK ((status IN ('completed','failed')) = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX finrec_run_in_progress_idx ON finrec.reconciliation_runs (type, period_from, period_to) WHERE status IN ('queued','running');
CREATE UNIQUE INDEX finrec_run_scheduled_idx ON finrec.reconciliation_runs (type, period_from, period_to) WHERE trigger = 'scheduled';
CREATE INDEX finrec_run_list_idx ON finrec.reconciliation_runs (created_at DESC, id);
CREATE FUNCTION finrec.run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'reconciliation runs are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF OLD.status IN ('completed','failed') THEN RAISE EXCEPTION 'a finished reconciliation run is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.type <> OLD.type OR NEW.period_from <> OLD.period_from OR NEW.period_to <> OLD.period_to OR NEW.trigger <> OLD.trigger
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.tolerance IS DISTINCT FROM OLD.tolerance OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity of a reconciliation run is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'queued' AND NEW.status IN ('running','failed')) OR (OLD.status = 'running' AND NEW.status IN ('completed','failed'))) THEN
    RAISE EXCEPTION 'illegal reconciliation run transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER run_guard BEFORE UPDATE OR DELETE ON finrec.reconciliation_runs FOR EACH ROW EXECUTE FUNCTION finrec.run_guard();

CREATE TABLE finrec.reconciliation_items (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES finrec.reconciliation_runs(id),
  type text NOT NULL CHECK (type IN ('RC-01','RC-02','RC-03','RC-04','RC-05','RC-06')),
  match_key text NOT NULL CHECK (length(match_key) BETWEEN 1 AND 300),
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{2,60}$'),
  related_org uuid,                                  -- the organization concerned, when there is one (a filter, not an isolation key)
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','assigned','resolved')),
  assigned_to uuid,
  assigned_at timestamptz,
  resolved_at timestamptz,
  sla_alerted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, match_key, kind),
  CHECK ((status = 'open') = (assigned_to IS NULL AND resolved_at IS NULL) OR status <> 'open'),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE INDEX finrec_items_run_idx ON finrec.reconciliation_items (run_id, status);
CREATE INDEX finrec_items_open_idx ON finrec.reconciliation_items (created_at) WHERE status <> 'resolved';
CREATE FUNCTION finrec.item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'reconciliation items are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF (to_jsonb(NEW) - 'status' - 'assigned_to' - 'assigned_at' - 'resolved_at' - 'sla_alerted_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'assigned_to' - 'assigned_at' - 'resolved_at' - 'sla_alerted_at') THEN
    RAISE EXCEPTION 'a reconciliation item is immutable except its break workflow' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.status = 'resolved' THEN RAISE EXCEPTION 'a resolved break cannot change' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'open' AND NEW.status IN ('assigned','resolved')) OR (OLD.status = 'assigned' AND NEW.status = 'resolved')) THEN
    RAISE EXCEPTION 'illegal break transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER item_guard BEFORE UPDATE OR DELETE ON finrec.reconciliation_items FOR EACH ROW EXECUTE FUNCTION finrec.item_guard();

CREATE TABLE finrec.reconciliation_resolutions (
  id uuid PRIMARY KEY,
  item_id uuid NOT NULL REFERENCES finrec.reconciliation_items(id),
  action text NOT NULL CHECK (action IN ('assign','adjustment','accept')),
  adjustment_id uuid,                                -- logical reference to billing.adjustment_requests (an APPROVED adjustment)
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (action <> 'adjustment' OR adjustment_id IS NOT NULL),
  CHECK (action <> 'accept' OR note IS NOT NULL)
);
CREATE INDEX finrec_resolutions_item_idx ON finrec.reconciliation_resolutions (item_id, created_at);
CREATE FUNCTION finrec.deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation', HINT = 'immutable'; END $$;
CREATE TRIGGER resolutions_immutable BEFORE UPDATE OR DELETE ON finrec.reconciliation_resolutions FOR EACH ROW EXECUTE FUNCTION finrec.deny_mutation();
CREATE TRIGGER resolutions_no_truncate BEFORE TRUNCATE ON finrec.reconciliation_resolutions FOR EACH STATEMENT EXECUTE FUNCTION finrec.deny_mutation();
CREATE TRIGGER runs_no_truncate BEFORE TRUNCATE ON finrec.reconciliation_runs FOR EACH STATEMENT EXECUTE FUNCTION finrec.deny_mutation();
CREATE TRIGGER items_no_truncate BEFORE TRUNCATE ON finrec.reconciliation_items FOR EACH STATEMENT EXECUTE FUNCTION finrec.deny_mutation();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['reconciliation_runs','reconciliation_items','reconciliation_resolutions'] LOOP
    EXECUTE format('ALTER TABLE finrec.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE finrec.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY platform_admin ON finrec.%I USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
                      WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT, INSERT ON finrec.%I TO nuzm_app, nuzm_worker', t);
    EXECUTE format('GRANT SELECT ON finrec.%I TO nuzm_readonly_reporting', t);
  END LOOP;
END $$;
GRANT UPDATE (status, started_at, completed_at, items_checked, breaks_count, summary, error) ON finrec.reconciliation_runs TO nuzm_app, nuzm_worker;
GRANT UPDATE (status, assigned_to, assigned_at, resolved_at, sla_alerted_at) ON finrec.reconciliation_items TO nuzm_app, nuzm_worker;
