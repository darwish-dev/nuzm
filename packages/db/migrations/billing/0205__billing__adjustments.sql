-- M02 S07b: manual ledger adjustments with two-person approval. A request holds the proposed lines (or the transaction to
-- reverse); the ledger is only touched when a DIFFERENT person approves, through billing.post (idempotent per request id).
-- Platform data: customers can never see these rows.
INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('admin:billing:approve','platform','Approve or reject manual ledger adjustments (never your own request)');
INSERT INTO tenancy.role_permissions VALUES ('finance','admin:billing:approve'),('platform_admin','admin:billing:approve');

CREATE TABLE billing.adjustment_requests (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  reverses_transaction_id uuid,                  -- full reversal of this ledger transaction, or
  lines jsonb,                                   -- explicit balanced posting lines
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  request_hash text NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  transaction_id uuid,                           -- the ledger transaction posted on approval
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((reverses_transaction_id IS NOT NULL) <> (lines IS NOT NULL)),
  CHECK ((status = 'pending' AND decided_by IS NULL AND decided_at IS NULL)
      OR (status <> 'pending' AND decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status <> 'approved' OR transaction_id IS NOT NULL OR decided_at IS NOT NULL),
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
-- a replayed request (same requester, same key) is the same request
CREATE UNIQUE INDEX adjustment_requests_idem_idx ON billing.adjustment_requests (requested_by, idempotency_key);
-- one pending reversal per transaction (the ledger itself allows a transaction to be reversed once)
CREATE UNIQUE INDEX adjustment_requests_reversal_idx ON billing.adjustment_requests (reverses_transaction_id) WHERE reverses_transaction_id IS NOT NULL AND status = 'pending';
CREATE INDEX adjustment_requests_org_idx ON billing.adjustment_requests (org_id, created_at DESC);

-- A decided request is final; the proposal itself never changes. Linking the posted transaction is allowed once, on approval.
CREATE FUNCTION billing.adjustment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'adjustment requests are never deleted' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.lines IS DISTINCT FROM OLD.lines OR NEW.reason <> OLD.reason
     OR NEW.requested_by <> OLD.requested_by OR NEW.reverses_transaction_id IS DISTINCT FROM OLD.reverses_transaction_id THEN
    RAISE EXCEPTION 'the adjustment proposal is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'adjustment request % is already %', OLD.id, OLD.status USING ERRCODE = 'check_violation', HINT = 'decided';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER adjustment_guard BEFORE UPDATE OR DELETE ON billing.adjustment_requests FOR EACH ROW EXECUTE FUNCTION billing.adjustment_guard();
-- statement-level triggers have no NEW/OLD row, so TRUNCATE gets its own function that always refuses
CREATE FUNCTION billing.adjustment_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'adjustment requests are never truncated' USING ERRCODE = 'check_violation'; END $$;
CREATE TRIGGER adjustment_no_truncate BEFORE TRUNCATE ON billing.adjustment_requests FOR EACH STATEMENT EXECUTE FUNCTION billing.adjustment_no_truncate();

ALTER TABLE billing.adjustment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.adjustment_requests FORCE ROW LEVEL SECURITY;
-- platform scope only: no org policy exists, so an organization-scoped session sees nothing
CREATE POLICY platform_only ON billing.adjustment_requests
  USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT, UPDATE ON billing.adjustment_requests TO nuzm_app;
GRANT SELECT ON billing.adjustment_requests TO nuzm_readonly_reporting;
