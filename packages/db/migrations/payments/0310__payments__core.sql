-- M03 S09: payments core (docs/11 §2, §7). Tokenized payment methods (NO card data of any kind), intents with a legal state machine,
-- immutable attempts, and PSP event intake deduplicated by (psp, event_id).
--  * Card numbers never exist here: tokens, brand, last4, expiry and a fingerprint only. CHECK constraints reject anything that
--    looks like a card number in the columns that could carry one.
--  * psp_accounts is platform configuration (migrations only, read-only at runtime). A production account needs HG-03-02 and is not seeded.
--  * psp_events is reachable only with the `psp_webhook` auth scope (the webhook handler), never from a tenant session.
--  * payment_intents.status moves only along the state machine (trigger); the money fields and identity are frozen.
CREATE SCHEMA IF NOT EXISTS payments;
GRANT USAGE ON SCHEMA payments TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

CREATE TABLE payments.psp_accounts (
  id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{1,30}$'),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_-]{1,40}$'),     -- also the ledger sub-ledger key of account 1100
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO payments.psp_accounts (id, provider, code, environment) VALUES (gen_random_uuid(), 'mock', 'mock-sandbox', 'sandbox');
ALTER TABLE payments.psp_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments.psp_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY read_all ON payments.psp_accounts FOR SELECT USING (true);
GRANT SELECT ON payments.psp_accounts TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

CREATE TABLE payments.customers_psp (
  org_id uuid NOT NULL,
  psp_account_id uuid NOT NULL REFERENCES payments.psp_accounts(id),
  psp_customer_ref text NOT NULL CHECK (psp_customer_ref !~ '^[0-9]{12,19}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, psp_account_id)
);

CREATE TABLE payments.payment_methods (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  psp_account_id uuid NOT NULL REFERENCES payments.psp_accounts(id),
  token_ref text NOT NULL CHECK (length(token_ref) BETWEEN 3 AND 200 AND token_ref !~ '^[0-9 -]{12,23}$'),
  brand text NOT NULL CHECK (brand ~ '^[a-z][a-z_]{1,19}$'),
  last4 char(4) NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
  exp_month int NOT NULL CHECK (exp_month BETWEEN 1 AND 12),
  exp_year int NOT NULL CHECK (exp_year BETWEEN 2000 AND 2100),
  fingerprint text NOT NULL CHECK (length(fingerprint) BETWEEN 8 AND 100 AND fingerprint !~ '^[0-9 -]{12,23}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  is_default boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  UNIQUE (org_id, psp_account_id, token_ref),
  CHECK (NOT is_default OR status = 'active'),
  CHECK ((status = 'active' AND removed_at IS NULL) OR (status = 'removed' AND removed_at IS NOT NULL))
);
-- the same physical card (fingerprint) is saved once per organization while it is active; a removed card can be added again
CREATE UNIQUE INDEX payment_methods_fingerprint_idx ON payments.payment_methods (org_id, psp_account_id, fingerprint) WHERE status = 'active';
CREATE UNIQUE INDEX payment_methods_one_default_idx ON payments.payment_methods (org_id) WHERE is_default AND status = 'active';
CREATE INDEX payment_methods_org_idx ON payments.payment_methods (org_id, status, created_at DESC, id);
CREATE FUNCTION payments.method_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payment methods are never deleted (they are marked removed)' USING ERRCODE = 'check_violation'; END IF;
  IF (to_jsonb(NEW) - 'status' - 'is_default' - 'removed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'is_default' - 'removed_at') THEN
    RAISE EXCEPTION 'a payment method is immutable except its status and default flag' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.status = 'removed' THEN RAISE EXCEPTION 'a removed payment method cannot change' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER method_guard BEFORE UPDATE OR DELETE ON payments.payment_methods FOR EACH ROW EXECUTE FUNCTION payments.method_guard();

CREATE TABLE payments.payment_intents (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  psp_account_id uuid NOT NULL REFERENCES payments.psp_accounts(id),
  invoice_id uuid NOT NULL,                      -- logical reference to invoicing.invoices
  payment_method_id uuid REFERENCES payments.payment_methods(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'requires_method' CHECK (status IN ('requires_method','requires_action','processing','succeeded','failed','cancelled','partially_refunded','refunded')),
  merchant_reference text NOT NULL UNIQUE CHECK (merchant_reference ~ '^nuzm_pi_[0-9a-f-]{36}$'),
  psp_payment_ref text CHECK (psp_payment_ref IS NULL OR psp_payment_ref !~ '^[0-9]{12,19}$'),
  next_action jsonb,
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{2,60}$'),
  return_url text,
  captured_minor bigint NOT NULL DEFAULT 0 CHECK (captured_minor >= 0),
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  ledger_transaction_id uuid,                    -- logical reference to billing.ledger_transactions (set once)
  last_event_at timestamptz,                     -- PSP time of the last applied event (stale events are ignored)
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (captured_minor <= amount_minor),
  CHECK (refunded_minor <= captured_minor),
  CHECK (status NOT IN ('succeeded','partially_refunded','refunded') OR captured_minor = amount_minor)
);
CREATE INDEX payment_intents_org_idx ON payments.payment_intents (org_id, created_at DESC, id);
CREATE INDEX payment_intents_invoice_idx ON payments.payment_intents (org_id, invoice_id, status);
CREATE FUNCTION payments.intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payment intents are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.invoice_id <> OLD.invoice_id OR NEW.amount_minor <> OLD.amount_minor OR NEW.currency <> OLD.currency
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
CREATE TRIGGER intent_guard BEFORE UPDATE OR DELETE ON payments.payment_intents FOR EACH ROW EXECUTE FUNCTION payments.intent_guard();

-- Attempts are facts about what was sent to the PSP: append-only.
CREATE TABLE payments.payment_attempts (
  id uuid PRIMARY KEY,
  intent_id uuid NOT NULL REFERENCES payments.payment_intents(id),
  org_id uuid NOT NULL,
  seq int NOT NULL CHECK (seq >= 1),
  status text NOT NULL CHECK (status IN ('succeeded','failed','requires_action','uncertain','processing')),
  psp_attempt_ref text,
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{2,60}$'),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (intent_id, seq)
);
CREATE FUNCTION payments.deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation', HINT = 'immutable'; END $$;
CREATE TRIGGER attempts_immutable BEFORE UPDATE OR DELETE ON payments.payment_attempts FOR EACH ROW EXECUTE FUNCTION payments.deny_mutation();
CREATE TRIGGER attempts_no_truncate BEFORE TRUNCATE ON payments.payment_attempts FOR EACH STATEMENT EXECUTE FUNCTION payments.deny_mutation();
CREATE TRIGGER intents_no_truncate BEFORE TRUNCATE ON payments.payment_intents FOR EACH STATEMENT EXECUTE FUNCTION payments.deny_mutation();
CREATE TRIGGER methods_no_truncate BEFORE TRUNCATE ON payments.payment_methods FOR EACH STATEMENT EXECUTE FUNCTION payments.deny_mutation();

-- PSP events: tenant-less intake (the organization is resolved from the merchant reference); only the webhook scope can touch it.
CREATE TABLE payments.psp_events (
  id uuid PRIMARY KEY,
  psp text NOT NULL,
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  type text NOT NULL,
  org_id uuid,
  intent_id uuid,
  event_at timestamptz NOT NULL,
  payload jsonb NOT NULL,                        -- sanitized: whitelisted fields only, never card data
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','ignored','failed')),
  error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (psp, event_id)
);
CREATE INDEX psp_events_pending_idx ON payments.psp_events (received_at) WHERE status IN ('received','failed');
ALTER TABLE payments.psp_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments.psp_events FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_scope ON payments.psp_events
  USING (coalesce(current_setting('app.auth_scope', true), '') = 'psp_webhook')
  WITH CHECK (coalesce(current_setting('app.auth_scope', true), '') = 'psp_webhook');
CREATE POLICY platform_read ON payments.psp_events FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT, UPDATE ON payments.psp_events TO nuzm_app, nuzm_worker;
GRANT SELECT ON payments.psp_events TO nuzm_readonly_reporting;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['customers_psp','payment_methods','payment_intents','payment_attempts'] LOOP
    EXECUTE format('ALTER TABLE payments.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE payments.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON payments.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
                      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY platform_read ON payments.%I FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT, INSERT ON payments.%I TO nuzm_app, nuzm_worker', t);
    EXECUTE format('GRANT SELECT ON payments.%I TO nuzm_readonly_reporting', t);
  END LOOP;
END $$;
GRANT UPDATE (status, is_default, removed_at) ON payments.payment_methods TO nuzm_app, nuzm_worker;
GRANT UPDATE (payment_method_id, status, psp_payment_ref, next_action, failure_code, captured_minor, refunded_minor, ledger_transaction_id, last_event_at, updated_at)
  ON payments.payment_intents TO nuzm_app, nuzm_worker;

-- A webhook names an intent only by merchant reference: resolve (org, id, status) without an organization context. Exposes nothing else.
DO $$ DECLARE own text := current_user; BEGIN
  EXECUTE format('CREATE POLICY definer_all ON payments.payment_intents TO %I USING (true) WITH CHECK (true)', own);
END $$;
CREATE FUNCTION payments.resolve_intent(p_ref text) RETURNS TABLE (id uuid, org_id uuid, status text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT i.id, i.org_id, i.status FROM payments.payment_intents i WHERE i.merchant_reference = p_ref
$$;
REVOKE ALL ON FUNCTION payments.resolve_intent(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION payments.resolve_intent(text) TO nuzm_app, nuzm_worker;
