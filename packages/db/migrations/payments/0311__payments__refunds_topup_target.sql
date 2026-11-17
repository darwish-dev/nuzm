-- M03 S10a: refunds (docs/11 §7) and wallet top-ups as a second payable target of a payment intent.
--  * An intent pays EITHER an invoice OR a wallet top-up (billing.wallet_topups); never both, never neither.
--  * Refunds are rows with their own state machine (pending -> succeeded | failed). The money fields of the intent only grow, and only
--    from a succeeded refund. A pending refund RESERVES its amount (remaining = captured - refunded - pending), so two concurrent
--    refunds can never exceed what was captured.
ALTER TABLE payments.payment_intents ALTER COLUMN invoice_id DROP NOT NULL;
ALTER TABLE payments.payment_intents ADD COLUMN wallet_topup_id uuid;           -- logical reference to billing.wallet_topups
ALTER TABLE payments.payment_intents ADD CONSTRAINT payment_intents_target_chk CHECK ((invoice_id IS NULL) <> (wallet_topup_id IS NULL));
CREATE INDEX payment_intents_topup_idx ON payments.payment_intents (org_id, wallet_topup_id) WHERE wallet_topup_id IS NOT NULL;

CREATE OR REPLACE FUNCTION payments.intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payment intents are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id OR NEW.wallet_topup_id IS DISTINCT FROM OLD.wallet_topup_id
     OR NEW.amount_minor <> OLD.amount_minor OR NEW.currency <> OLD.currency
     OR NEW.merchant_reference <> OLD.merchant_reference OR NEW.psp_account_id <> OLD.psp_account_id THEN
    RAISE EXCEPTION 'the identity and amount of a payment intent are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.ledger_transaction_id IS NOT NULL AND NEW.ledger_transaction_id IS DISTINCT FROM OLD.ledger_transaction_id THEN
    RAISE EXCEPTION 'the ledger link is set once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.captured_minor < OLD.captured_minor OR NEW.refunded_minor < OLD.refunded_minor THEN
    RAISE EXCEPTION 'captured and refunded amounts only grow' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'requires_method'  AND NEW.status IN ('requires_action','processing','succeeded','failed','cancelled'))
    OR (OLD.status = 'requires_action'  AND NEW.status IN ('processing','succeeded','failed','cancelled'))
    OR (OLD.status = 'processing'       AND NEW.status IN ('succeeded','failed'))
    OR (OLD.status = 'succeeded'        AND NEW.status IN ('partially_refunded','refunded'))
    OR (OLD.status = 'partially_refunded' AND NEW.status = 'refunded')
  ) THEN
    RAISE EXCEPTION 'illegal payment intent transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE payments.refunds (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  intent_id uuid NOT NULL REFERENCES payments.payment_intents(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  unapplied_minor bigint NOT NULL DEFAULT 0 CHECK (unapplied_minor >= 0),     -- the part that comes out of unapplied customer payments (2500) rather than receivables (1200)
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  merchant_reference text NOT NULL UNIQUE CHECK (merchant_reference ~ '^nuzm_rf_[0-9a-f-]{36}$'),
  psp_refund_ref text CHECK (psp_refund_ref IS NULL OR psp_refund_ref !~ '^[0-9]{12,19}$'),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{2,60}$'),
  credit_note_id uuid,                                     -- logical reference to invoicing.credit_notes (optional link)
  requested_by uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  request_hash text NOT NULL,
  ledger_transaction_id uuid,                              -- logical reference to billing.ledger_transactions (set once)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (unapplied_minor <= amount_minor),
  UNIQUE (requested_by, idempotency_key)
);
CREATE INDEX refunds_intent_idx ON payments.refunds (intent_id, status);
CREATE INDEX refunds_pending_idx ON payments.refunds (created_at) WHERE status = 'pending';
CREATE INDEX refunds_org_idx ON payments.refunds (org_id, created_at DESC, id);

CREATE FUNCTION payments.refund_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'refunds are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF (to_jsonb(NEW) - 'status' - 'psp_refund_ref' - 'failure_code' - 'ledger_transaction_id' - 'updated_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'psp_refund_ref' - 'failure_code' - 'ledger_transaction_id' - 'updated_at') THEN
    RAISE EXCEPTION 'the identity and amount of a refund are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.ledger_transaction_id IS NOT NULL AND NEW.ledger_transaction_id IS DISTINCT FROM OLD.ledger_transaction_id THEN
    RAISE EXCEPTION 'the ledger link is set once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'pending' AND NEW.status IN ('succeeded','failed')) THEN
    RAISE EXCEPTION 'illegal refund transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refund_guard BEFORE UPDATE OR DELETE ON payments.refunds FOR EACH ROW EXECUTE FUNCTION payments.refund_guard();
CREATE FUNCTION payments.refund_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'refunds are never truncated' USING ERRCODE = 'check_violation', HINT = 'immutable'; END $$;
CREATE TRIGGER refunds_no_truncate BEFORE TRUNCATE ON payments.refunds FOR EACH STATEMENT EXECUTE FUNCTION payments.refund_no_truncate();

ALTER TABLE payments.refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments.refunds FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON payments.refunds USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON payments.refunds FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON payments.refunds TO nuzm_app, nuzm_worker;
GRANT SELECT ON payments.refunds TO nuzm_readonly_reporting;
GRANT UPDATE (status, psp_refund_ref, failure_code, ledger_transaction_id, updated_at) ON payments.refunds TO nuzm_app, nuzm_worker;
