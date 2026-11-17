-- M03 S10c: dunning cases (docs/05: `billing.dunning_cases`; the policy itself is configuration, spec/billing/dunning-policy.yaml).
--  * One OPEN case per subscription (unique partial index); closed cases are kept (the dunning funnel report reads them).
--  * The stage only moves FORWARD (overdue → reminder_1 → reminder_2 → restricted → suspended → terminated_pending); a closed case never changes.
--  * Billing only EMITS requests (outbox events) for restriction, suspension and owner review. This table cannot delete or terminate anything.
CREATE TABLE billing.dunning_cases (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  subscription_id uuid NOT NULL REFERENCES billing.subscriptions(id),
  invoice_id uuid NOT NULL,                              -- logical reference to invoicing.invoices (the unpaid one)
  stage text NOT NULL DEFAULT 'overdue' CHECK (stage IN ('overdue','reminder_1','reminder_2','restricted','suspended','terminated_pending')),
  policy_version int NOT NULL CHECK (policy_version >= 1),
  opened_at timestamptz NOT NULL,
  stage_changed_at timestamptz NOT NULL,
  retries_done int NOT NULL DEFAULT 0 CHECK (retries_done >= 0),
  last_retry_at timestamptz,
  hold boolean NOT NULL DEFAULT false,
  hold_reason text CHECK (hold_reason IS NULL OR length(hold_reason) BETWEEN 1 AND 500),
  held_by uuid,
  closed_at timestamptz,
  closed_reason text CHECK (closed_reason IS NULL OR closed_reason IN ('paid','subscription_cancelled')),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((closed_at IS NULL) = (closed_reason IS NULL)),
  CHECK (NOT hold OR hold_reason IS NOT NULL)
);
CREATE UNIQUE INDEX dunning_one_open_idx ON billing.dunning_cases (subscription_id) WHERE closed_at IS NULL;
CREATE INDEX dunning_open_idx ON billing.dunning_cases (opened_at) WHERE closed_at IS NULL;
CREATE INDEX dunning_org_idx ON billing.dunning_cases (org_id, created_at DESC, id);

CREATE FUNCTION billing.dunning_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_of text[] := ARRAY['overdue','reminder_1','reminder_2','restricted','suspended','terminated_pending'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'dunning cases are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.subscription_id <> OLD.subscription_id OR NEW.invoice_id <> OLD.invoice_id
     OR NEW.opened_at <> OLD.opened_at OR NEW.policy_version <> OLD.policy_version OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity of a dunning case is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a closed dunning case cannot change' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF array_position(order_of, NEW.stage) < array_position(order_of, OLD.stage) THEN
    RAISE EXCEPTION 'a dunning case only moves forward' USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  IF NEW.retries_done < OLD.retries_done THEN
    RAISE EXCEPTION 'retries only grow' USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER dunning_guard BEFORE UPDATE OR DELETE ON billing.dunning_cases FOR EACH ROW EXECUTE FUNCTION billing.dunning_guard();
CREATE FUNCTION billing.dunning_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'dunning cases are never truncated' USING ERRCODE = 'check_violation', HINT = 'immutable'; END $$;
CREATE TRIGGER dunning_no_truncate BEFORE TRUNCATE ON billing.dunning_cases FOR EACH STATEMENT EXECUTE FUNCTION billing.dunning_no_truncate();

ALTER TABLE billing.dunning_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.dunning_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON billing.dunning_cases USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON billing.dunning_cases FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON billing.dunning_cases TO nuzm_app, nuzm_worker;
GRANT SELECT ON billing.dunning_cases TO nuzm_readonly_reporting;
GRANT UPDATE (stage, stage_changed_at, retries_done, last_retry_at, hold, hold_reason, held_by, closed_at, closed_reason, version, updated_at)
  ON billing.dunning_cases TO nuzm_app, nuzm_worker;
