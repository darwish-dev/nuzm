-- M04 S13c: retention policies, legal holds and archival of append-only tables (docs/10 §5, M04 §4 task 5). Extends the audit module (docs/05: M04).
--  * retention_policies: VERSIONED, immutable. One policy per data class, optionally overridden per dataset (schema.table). Every seeded value is a
--    PROPOSAL (D-34, HG-04-01); a policy is only `approved` with a document reference and a human approver (database check).
--  * legal_holds: dual approval (requester and a DIFFERENT approver), scoped to an organization and/or a dataset. A hold is active only after the
--    second person approves; it ends only by an explicit release. Nothing is deleted.
--  * archivable_tables + detach_partition(): the ONLY archival path is detaching a whole old partition of a registered append-only table. It runs
--    under the break-glass role (NOLOGIN until a human grants a window; D-12), needs two different platform staff, refuses a partition that is not
--    older than the archive cutoff or that holds data of an organization under a legal hold, writes an audit event, and locks the detached table
--    away from every runtime role. No row is ever UPDATEd or DELETEd.
CREATE TABLE audit.retention_policies (
  id uuid PRIMARY KEY,
  data_class text NOT NULL CHECK (data_class ~ '^[a-z][a-z-]{2,30}$'),
  dataset text CHECK (dataset IS NULL OR dataset ~ '^[a-z_]+\.[a-z_]+$'),
  version int NOT NULL CHECK (version >= 1),
  retain_days int NOT NULL CHECK (retain_days BETWEEN 1 AND 36500),
  archive_after_days int NOT NULL CHECK (archive_after_days BETWEEN 1 AND 36500),
  basis text NOT NULL CHECK (length(basis) BETWEEN 3 AND 500),
  status text NOT NULL CHECK (status IN ('proposal','approved')),
  document_ref text CHECK (document_ref IS NULL OR length(document_ref) BETWEEN 1 AND 200),
  approved_by uuid,
  change_note text CHECK (change_note IS NULL OR length(change_note) BETWEEN 1 AND 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (archive_after_days <= retain_days),
  CHECK (status <> 'approved' OR (document_ref IS NOT NULL AND approved_by IS NOT NULL))
);
CREATE UNIQUE INDEX retention_policy_version_idx ON audit.retention_policies (data_class, coalesce(dataset, ''), version);
CREATE FUNCTION audit.retention_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev int;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'retention policies are versioned: insert a new version instead' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance.data_classes WHERE key = NEW.data_class) THEN
    RAISE EXCEPTION 'unknown data class %', NEW.data_class USING ERRCODE = 'check_violation';
  END IF;
  SELECT max(version) INTO prev FROM audit.retention_policies WHERE data_class = NEW.data_class AND dataset IS NOT DISTINCT FROM NEW.dataset;
  IF NEW.version <> coalesce(prev, 0) + 1 THEN
    RAISE EXCEPTION 'version must be %', coalesce(prev, 0) + 1 USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER retention_insert_guard BEFORE INSERT ON audit.retention_policies FOR EACH ROW EXECUTE FUNCTION audit.retention_guard();
CREATE TRIGGER retention_immutable BEFORE UPDATE OR DELETE ON audit.retention_policies FOR EACH ROW EXECUTE FUNCTION audit.retention_guard();
CREATE TRIGGER retention_no_truncate BEFORE TRUNCATE ON audit.retention_policies FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();

-- PROPOSALS only (docs/10 §5; D-34 / HG-04-01 decide the real values). Financial retention defaults to the longest configured value.
INSERT INTO audit.retention_policies (id, data_class, dataset, version, retain_days, archive_after_days, basis, status, change_note) VALUES
  (gen_random_uuid(),'financial',NULL,1,2190,365,'PROPOSAL (D-34): tax and accounting records, engineering default = longest configured; the legal period comes from HG-03-04/HG-04-01','proposal','seeded proposal'),
  (gen_random_uuid(),'personal',NULL,1,395,90,'PROPOSAL (D-34): 13 months unless a legal basis requires longer','proposal','seeded proposal'),
  (gen_random_uuid(),'credentials',NULL,1,30,30,'PROPOSAL (D-34): credential material is not kept after the account or key is gone','proposal','seeded proposal'),
  (gen_random_uuid(),'customer-content',NULL,1,30,30,'PROPOSAL (D-34): 30-day grace after account closure, then erase except mandatory retention','proposal','seeded proposal'),
  (gen_random_uuid(),'internal',NULL,1,395,90,'PROPOSAL (D-34)','proposal','seeded proposal'),
  (gen_random_uuid(),'public',NULL,1,3650,365,'PROPOSAL (D-34)','proposal','seeded proposal'),
  (gen_random_uuid(),'personal','audit.audit_logs',1,2190,395,'PROPOSAL docs/10 §5: 13 months online, then archive; total retention per D-34 (audit archival is built in M12: the table is hash-chained)','proposal','seeded proposal'),
  (gen_random_uuid(),'internal','metering.usage_events',1,730,180,'PROPOSAL (D-34): raw usage events; invoices keep the billed result','proposal','seeded proposal');

CREATE TABLE audit.legal_holds (
  id uuid PRIMARY KEY,
  org_id uuid,
  dataset text CHECK (dataset IS NULL OR dataset ~ '^[a-z_]+\.[a-z_]+$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  status text NOT NULL CHECK (status IN ('pending_approval','active','rejected','released')),
  requested_by uuid NOT NULL,
  approver_id uuid NOT NULL,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) BETWEEN 1 AND 500),
  released_by uuid,
  released_at timestamptz,
  release_reason text CHECK (release_reason IS NULL OR length(release_reason) BETWEEN 10 AND 500),
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (org_id IS NOT NULL OR dataset IS NOT NULL),
  CHECK (requested_by <> approver_id),
  CHECK ((status = 'released') = (released_at IS NOT NULL AND released_by IS NOT NULL AND release_reason IS NOT NULL)),
  CHECK (status = 'pending_approval' OR decided_at IS NOT NULL)
);
CREATE INDEX legal_holds_active_idx ON audit.legal_holds (org_id, dataset) WHERE status = 'active';
-- one open (pending or active) hold per scope; one create request per Idempotency-Key and requester
CREATE UNIQUE INDEX legal_holds_open_scope_idx ON audit.legal_holds ((coalesce(org_id::text, '')), (coalesce(dataset, ''))) WHERE status IN ('pending_approval','active');
CREATE UNIQUE INDEX legal_holds_idem_idx ON audit.legal_holds (requested_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE FUNCTION audit.legal_hold_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'legal holds are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.dataset IS DISTINCT FROM OLD.dataset OR NEW.reason <> OLD.reason
     OR NEW.requested_by <> OLD.requested_by OR NEW.approver_id <> OLD.approver_id OR NEW.created_at <> OLD.created_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'the scope and the people of a legal hold are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF NOT ((OLD.status = 'pending_approval' AND NEW.status IN ('active','rejected')) OR (OLD.status = 'active' AND NEW.status = 'released')) THEN
    RAISE EXCEPTION 'illegal legal hold transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  IF NEW.status IN ('active','rejected') AND NEW.decided_at IS NULL THEN RAISE EXCEPTION 'a decision needs a time' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER legal_hold_guard BEFORE UPDATE OR DELETE ON audit.legal_holds FOR EACH ROW EXECUTE FUNCTION audit.legal_hold_guard();
CREATE TRIGGER legal_hold_no_truncate BEFORE TRUNCATE ON audit.legal_holds FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();

ALTER TABLE audit.retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.retention_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_admin ON audit.retention_policies USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
ALTER TABLE audit.legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.legal_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_admin ON audit.legal_holds USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON audit.retention_policies TO nuzm_app, nuzm_worker;
GRANT SELECT, INSERT ON audit.legal_holds TO nuzm_app, nuzm_worker;
GRANT UPDATE (status, decided_at, decision_note, released_by, released_at, release_reason) ON audit.legal_holds TO nuzm_app, nuzm_worker;
GRANT SELECT ON audit.retention_policies, audit.legal_holds TO nuzm_readonly_reporting, nuzm_admin_breakglass;

-- Archival: only whole partitions of registered append-only tables, only through detach_partition().
CREATE TABLE audit.archivable_tables (
  parent text PRIMARY KEY CHECK (parent ~ '^[a-z_]+\.[a-z_]+$'),
  org_column text NOT NULL,
  note text NOT NULL
);
INSERT INTO audit.archivable_tables (parent, org_column, note) VALUES
  ('metering.usage_events','org_id','append-only, partitioned monthly by window_start; the audit log is NOT registered: it is hash-chained and its archival is M12');
GRANT SELECT ON audit.archivable_tables TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

CREATE FUNCTION audit.detach_partition(p_parent text, p_partition text, p_requested_by uuid, p_approved_by uuid, p_reason text)
RETURNS TABLE (archived_table text, rows_archived bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  reg audit.archivable_tables;
  part_schema text; part_name text; bound text; upper_bound timestamptz;
  pol audit.retention_policies; cutoff timestamptz;
  n bigint; held text; archived text;
BEGIN
  SELECT * INTO reg FROM audit.archivable_tables WHERE parent = p_parent;
  IF NOT FOUND THEN RAISE EXCEPTION 'retention_mandatory: % is not registered for archival', p_parent USING ERRCODE = 'check_violation'; END IF;
  IF p_requested_by IS NULL OR p_approved_by IS NULL OR p_requested_by = p_approved_by THEN
    RAISE EXCEPTION 'archival needs two different people (requester and approver)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (SELECT count(*) FROM identity.users u WHERE u.id IN (p_requested_by, p_approved_by) AND u.is_platform_user
        AND EXISTS (SELECT 1 FROM tenancy.platform_roles r WHERE r.user_id = u.id AND r.role IN ('compliance_officer','platform_admin'))) <> 2 THEN
    RAISE EXCEPTION 'both people must be compliance officers or platform admins' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL OR length(p_reason) < 10 THEN RAISE EXCEPTION 'a reason of 10+ characters is required' USING ERRCODE = 'check_violation'; END IF;
  -- the partition must belong to the parent
  SELECT n.nspname, c.relname, pg_get_expr(c.relpartbound, c.oid) INTO part_schema, part_name, bound
    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE i.inhparent = p_parent::regclass AND n.nspname || '.' || c.relname = p_partition;
  IF NOT FOUND THEN RAISE EXCEPTION '% is not a partition of %', p_partition, p_parent USING ERRCODE = 'check_violation'; END IF;
  IF bound IS NULL OR bound = 'DEFAULT' THEN RAISE EXCEPTION 'the default partition is never archived' USING ERRCODE = 'check_violation'; END IF;
  upper_bound := substring(bound from 'TO \(''([^'']+)''\)')::timestamptz;
  -- the dataset's own retention policy (the newest version); a dataset without one is never archived
  SELECT * INTO pol FROM audit.retention_policies WHERE dataset = p_parent ORDER BY version DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'retention_mandatory: no retention policy for dataset %', p_parent USING ERRCODE = 'check_violation'; END IF;
  cutoff := now() - make_interval(days => pol.archive_after_days);
  IF upper_bound > cutoff THEN
    RAISE EXCEPTION 'retention_mandatory: partition % is newer than the archive cutoff (%)', p_partition, cutoff USING ERRCODE = 'check_violation';
  END IF;
  -- legal holds: a dataset hold, or a hold on any organization that has rows in this partition
  EXECUTE format('SELECT h.id::text FROM audit.legal_holds h WHERE h.status = ''active'' AND (h.dataset IS NULL OR h.dataset = %L)
                    AND (h.org_id IS NULL OR EXISTS (SELECT 1 FROM %s p WHERE p.%I = h.org_id)) LIMIT 1', p_parent, p_partition, reg.org_column) INTO held;
  IF held IS NOT NULL THEN RAISE EXCEPTION 'legal_hold_active: legal hold % covers data in %', held, p_partition USING ERRCODE = 'check_violation'; END IF;
  EXECUTE format('SELECT count(*) FROM %s', p_partition) INTO n;
  EXECUTE format('ALTER TABLE %s DETACH PARTITION %s', p_parent, p_partition);
  archived := 'archived_' || part_name;
  EXECUTE format('ALTER TABLE %s RENAME TO %I', p_partition, archived);
  archived := part_schema || '.' || archived;
  -- lock the archive away from every runtime role: no grants, forced RLS with a policy that admits nothing
  EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, nuzm_app, nuzm_worker, nuzm_readonly_reporting', archived);
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', archived);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', archived);
  EXECUTE format('CREATE POLICY archived_none ON %s USING (false)', archived);
  EXECUTE format('GRANT SELECT ON %s TO nuzm_admin_breakglass', archived);
  -- the archive stays append-only: a detached partition does not keep its parent's triggers
  EXECUTE format('CREATE TRIGGER archived_no_change BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION audit.deny_mutation()', archived);
  EXECUTE format('CREATE TRIGGER archived_no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation()', archived);
  INSERT INTO audit.audit_logs (id, actor_type, actor_user_id, action, resource_type, resource_id, outcome, detail)
    VALUES (gen_random_uuid(), 'user', p_approved_by, 'compliance.retention.partition_detached', 'partition', p_partition, 'success',
            jsonb_build_object('parent', p_parent, 'archivedAs', archived, 'rows', n, 'requestedBy', p_requested_by, 'approvedBy', p_approved_by,
                               'reason', p_reason, 'policyVersion', pol.version, 'policyStatus', pol.status, 'cutoff', cutoff));
  RETURN QUERY SELECT archived, n;
END $$;
REVOKE ALL ON FUNCTION audit.detach_partition(text, text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.detach_partition(text, text, uuid, uuid, text) TO nuzm_admin_breakglass;
