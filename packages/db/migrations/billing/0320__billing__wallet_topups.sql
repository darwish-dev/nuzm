-- M03 S10a: wallet top-ups (docs/04 POST /v1/billing/wallet-topups, docs/11 §3.1). A top-up is a request to add prepaid credit; it is
-- credited (ledger Dr 1100 -> Cr 2100) only when its payment is captured. No ledger row exists until then.
CREATE TABLE billing.wallet_topups (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','credited')),
  ledger_transaction_id uuid,                       -- logical reference to billing.ledger_transactions (set once, with status credited)
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  credited_at timestamptz,
  CHECK ((status = 'credited') = (ledger_transaction_id IS NOT NULL AND credited_at IS NOT NULL))
);
CREATE INDEX wallet_topups_org_idx ON billing.wallet_topups (org_id, created_at DESC, id);
CREATE FUNCTION billing.wallet_topup_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'wallet top-ups are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF (to_jsonb(NEW) - 'status' - 'ledger_transaction_id' - 'credited_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'ledger_transaction_id' - 'credited_at') THEN
    RAISE EXCEPTION 'a wallet top-up is immutable except its crediting' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.status = 'credited' THEN RAISE EXCEPTION 'a credited top-up cannot change' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wallet_topup_guard BEFORE UPDATE OR DELETE ON billing.wallet_topups FOR EACH ROW EXECUTE FUNCTION billing.wallet_topup_guard();
CREATE FUNCTION billing.wallet_topup_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'wallet top-ups are never truncated' USING ERRCODE = 'check_violation', HINT = 'immutable'; END $$;
CREATE TRIGGER wallet_topups_no_truncate BEFORE TRUNCATE ON billing.wallet_topups FOR EACH STATEMENT EXECUTE FUNCTION billing.wallet_topup_no_truncate();

ALTER TABLE billing.wallet_topups ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.wallet_topups FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON billing.wallet_topups USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON billing.wallet_topups FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON billing.wallet_topups TO nuzm_app, nuzm_worker;
GRANT SELECT ON billing.wallet_topups TO nuzm_readonly_reporting;
GRANT UPDATE (status, ledger_transaction_id, credited_at) ON billing.wallet_topups TO nuzm_app, nuzm_worker;
