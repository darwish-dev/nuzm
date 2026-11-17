-- M03 S10b: subscriptions (docs/05 rule 2: items are a JSON column, no items table; docs/11 §2 state machine).
--  * `items` is the PRICED SNAPSHOT taken from the price book when the subscription (or its plan) was set: a later price-book change never
--    silently re-prices a running subscription.
--  * Every change that needs an invoice (first period, renewal, plan change) records `pending_invoice` IN THE SAME TRANSACTION as the state
--    change; issuing the invoice is idempotent by its source key, so a crash in between is repaired by the next run (never lost, never doubled).
--  * status moves only along the state machine (trigger); identity is frozen; cancelled is terminal; rows are never deleted.
--  * One live subscription per organization (unique partial index).
CREATE TABLE billing.subscriptions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  plan_version_id uuid NOT NULL REFERENCES billing.plan_versions(id),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK (status IN ('trialing','active','past_due','unpaid','cancelled')),
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 20),
  quantity int NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 1000),
  payment_method_id uuid NOT NULL,                       -- logical reference to payments.payment_methods
  anchor_day int NOT NULL CHECK (anchor_day BETWEEN 1 AND 31),
  period_start date NOT NULL,
  period_end date NOT NULL,                              -- exclusive: the next period starts here
  trial_end date,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  cancelled_at timestamptz,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500),
  pending_credit_minor bigint NOT NULL DEFAULT 0 CHECK (pending_credit_minor >= 0),
  pending_invoice jsonb,                                 -- {key, periodStart, periodEnd, lines[...]} still to be issued, or null
  last_invoice_id uuid,                                  -- logical reference to invoicing.invoices
  assigned_plan_version_id uuid,                         -- the plan version last written to the entitlements
  version int NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE UNIQUE INDEX subscriptions_one_live_idx ON billing.subscriptions (org_id) WHERE status <> 'cancelled';
CREATE INDEX subscriptions_due_idx ON billing.subscriptions (period_end) WHERE status IN ('trialing','active');
CREATE INDEX subscriptions_pending_idx ON billing.subscriptions (updated_at) WHERE pending_invoice IS NOT NULL;
CREATE INDEX subscriptions_org_idx ON billing.subscriptions (org_id, created_at DESC, id);

CREATE FUNCTION billing.subscription_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'subscriptions are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.currency <> OLD.currency OR NEW.anchor_day <> OLD.anchor_day OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity of a subscription is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'a cancelled subscription cannot change' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'trialing' AND NEW.status IN ('active','past_due','cancelled'))
    OR (OLD.status = 'active'   AND NEW.status IN ('past_due','cancelled'))
    OR (OLD.status = 'past_due' AND NEW.status IN ('active','unpaid','cancelled'))
    OR (OLD.status = 'unpaid'   AND NEW.status IN ('active','cancelled'))
  ) THEN
    RAISE EXCEPTION 'illegal subscription transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  IF NEW.period_start < OLD.period_start OR (NEW.period_start = OLD.period_start AND NEW.period_end <> OLD.period_end) THEN
    RAISE EXCEPTION 'subscription periods only move forward' USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER subscription_guard BEFORE UPDATE OR DELETE ON billing.subscriptions FOR EACH ROW EXECUTE FUNCTION billing.subscription_guard();
CREATE FUNCTION billing.subscription_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'subscriptions are never truncated' USING ERRCODE = 'check_violation', HINT = 'immutable'; END $$;
CREATE TRIGGER subscriptions_no_truncate BEFORE TRUNCATE ON billing.subscriptions FOR EACH STATEMENT EXECUTE FUNCTION billing.subscription_no_truncate();

ALTER TABLE billing.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON billing.subscriptions USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON billing.subscriptions FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON billing.subscriptions TO nuzm_app, nuzm_worker;
GRANT SELECT ON billing.subscriptions TO nuzm_readonly_reporting;
GRANT UPDATE (plan_version_id, status, items, quantity, payment_method_id, period_start, period_end, trial_end, cancel_at_period_end, cancelled_at,
              cancel_reason, pending_credit_minor, pending_invoice, last_invoice_id, assigned_plan_version_id, version, updated_at)
  ON billing.subscriptions TO nuzm_app, nuzm_worker;
