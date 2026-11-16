-- M02 S05: double-entry ledger, plans/plan versions, entitlements, wallet projection.
-- Design (docs/11 §3, docs/05 rule 8):
--  * Postings are written ONLY by billing.post(): runtime roles have no INSERT/UPDATE/DELETE on ledger tables.
--  * Money is integer minor units + currency; a deferred constraint trigger enforces sum(debit) = sum(credit) per
--    transaction and currency at COMMIT; append-only triggers reject UPDATE/DELETE/TRUNCATE for everyone.
--  * Idempotency: unique (org, idempotency_key); a repeat with the same payload returns the first transaction, a repeat
--    with a different payload fails (the caller maps it to idempotency_key_reuse).
--  * Platform accounts (org_id NULL) are invisible to customer roles; customers see only postings on THEIR accounts.
--  * SECURITY DEFINER functions run as the migration owner; every forced-RLS table gets a policy for that owner.
CREATE SCHEMA IF NOT EXISTS billing;
GRANT USAGE ON SCHEMA billing TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

-- Chart of accounts template (docs/11 §3): scope org = per-organization sub-account, platform = single account,
-- subledger = platform account per provider_account / psp_account / publisher (key supplied by the caller).
CREATE FUNCTION billing.chart_template(p_code text)
RETURNS TABLE (name text, type text, normal_side text, scope text)
LANGUAGE sql IMMUTABLE AS $$
  SELECT t.name, t.type, t.normal_side, t.scope FROM (VALUES
    ('1100','PSP clearing (funds in transit)','asset','debit','subledger'),
    ('1200','Accounts receivable','asset','debit','org'),
    ('1300','Provider prepayments','asset','debit','subledger'),
    ('1400','VAT input (recoverable)','asset','debit','platform'),
    ('2100','Customer wallet / prepaid credits','liability','credit','org'),
    ('2200','Deferred revenue','liability','credit','org'),
    ('2300','VAT output payable','liability','credit','platform'),
    ('2400','Provider payables (accrued cost)','liability','credit','subledger'),
    ('2500','Unapplied customer payments','liability','credit','org'),
    ('2600','Publisher payables (marketplace)','liability','credit','subledger'),
    ('4100','Usage revenue','revenue','credit','platform'),
    ('4200','Subscription revenue','revenue','credit','platform'),
    ('4300','Domain & registration revenue','revenue','credit','platform'),
    ('4400','Marketplace commission revenue','revenue','credit','platform'),
    ('4900','Discounts & promotional credits (contra)','contra_revenue','debit','platform'),
    ('5100','Provider cost of revenue','expense','debit','subledger'),
    ('5200','PSP fees','expense','debit','platform'),
    ('5300','Bad debt','expense','debit','platform'),
    ('5400','FX gain/loss','expense','debit','platform')
  ) AS t(code, name, type, normal_side, scope) WHERE t.code = p_code
$$;

CREATE TABLE billing.ledger_accounts (
  id uuid PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('asset','liability','revenue','contra_revenue','expense')),
  normal_side text NOT NULL CHECK (normal_side IN ('debit','credit')),
  org_id uuid,                                   -- NULL = platform account
  subledger_key text,                            -- provider_account / psp_account / publisher id
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ledger_accounts_unique_idx ON billing.ledger_accounts
  (code, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(subledger_key, ''), currency);

CREATE TABLE billing.ledger_transactions (
  id uuid PRIMARY KEY,
  org_id uuid,                                   -- organization the event belongs to; NULL = platform-level
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL,
  kind text NOT NULL,
  description text NOT NULL DEFAULT '',
  source_event_id text,
  reverses_id uuid REFERENCES billing.ledger_transactions(id),
  created_by uuid,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ledger_transactions_idem_idx ON billing.ledger_transactions
  (COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), idempotency_key);
CREATE INDEX ledger_transactions_org_idx ON billing.ledger_transactions (org_id, occurred_at DESC, id DESC);
-- a transaction can be reversed at most once
CREATE UNIQUE INDEX ledger_transactions_reverses_idx ON billing.ledger_transactions (reverses_id) WHERE reverses_id IS NOT NULL;

CREATE TABLE billing.ledger_postings (
  id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES billing.ledger_transactions(id),
  account_id uuid NOT NULL REFERENCES billing.ledger_accounts(id),
  account_org_id uuid,                           -- copy of the account's org: drives customer visibility
  org_id uuid,                                   -- copy of the transaction's org
  direction text NOT NULL CHECK (direction IN ('debit','credit')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_postings_account_idx ON billing.ledger_postings (account_id, created_at, id);
CREATE INDEX ledger_postings_org_idx ON billing.ledger_postings (org_id, created_at, id);
CREATE INDEX ledger_postings_tx_idx ON billing.ledger_postings (transaction_id);
CREATE INDEX ledger_postings_acct_org_idx ON billing.ledger_postings (account_org_id, created_at DESC, id DESC);

-- Append-only for everyone (owner included) while the triggers exist.
CREATE FUNCTION billing.deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger tables are append-only (% on %.%)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER ledger_accounts_no_delete BEFORE DELETE ON billing.ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION billing.deny_mutation();
CREATE TRIGGER ledger_transactions_no_mutation BEFORE UPDATE OR DELETE ON billing.ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION billing.deny_mutation();
CREATE TRIGGER ledger_transactions_no_truncate BEFORE TRUNCATE ON billing.ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION billing.deny_mutation();
CREATE TRIGGER ledger_postings_no_mutation BEFORE UPDATE OR DELETE ON billing.ledger_postings
  FOR EACH ROW EXECUTE FUNCTION billing.deny_mutation();
CREATE TRIGGER ledger_postings_no_truncate BEFORE TRUNCATE ON billing.ledger_postings
  FOR EACH STATEMENT EXECUTE FUNCTION billing.deny_mutation();

-- Deferred balance check: at COMMIT every transaction must balance per currency.
CREATE FUNCTION billing.check_balanced() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE bad record;
BEGIN
  SELECT currency, sum(CASE direction WHEN 'debit' THEN amount_minor ELSE -amount_minor END) AS diff INTO bad
    FROM billing.ledger_postings WHERE transaction_id = NEW.transaction_id
   GROUP BY currency HAVING sum(CASE direction WHEN 'debit' THEN amount_minor ELSE -amount_minor END) <> 0 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'unbalanced ledger transaction % (% off by %)', NEW.transaction_id, bad.currency, bad.diff
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_postings_balanced AFTER INSERT ON billing.ledger_postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing.check_balanced();

-- The ONLY writer of postings. p_postings: [{account:{code, org:bool, subledger?}, direction, amountMinor, currency,
-- dimensions?, nonNegative?}]. nonNegative = the account balance (in its normal side) may not go below zero after the
-- transaction (wallet consume cannot overdraw); the account rows are locked in id order so parallel consumes serialize.
CREATE FUNCTION billing.post(
  p_tx_id uuid, p_org uuid, p_key text, p_kind text, p_description text, p_source_event text,
  p_actor uuid, p_postings jsonb, p_reverses uuid DEFAULT NULL
) RETURNS TABLE (transaction_id uuid, duplicate boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx_org uuid := nullif(current_setting('app.org_id', true), '')::uuid;
  platform boolean := coalesce(current_setting('app.platform_scope', true) = 'admin', false);
  h text;
  inserted uuid;
  found_id uuid;
  found_hash text;
  el jsonb;
  tpl record;
  acct uuid;
  acct_org uuid;
  ids uuid[] := ARRAY[]::uuid[];
  guard uuid[] := ARRAY[]::uuid[];
  bal bigint;
  side text;
BEGIN
  -- coalesce: with no scope set the comparisons are NULL, and NOT NULL is NULL (the check would silently pass)
  IF NOT coalesce(platform OR (p_org IS NOT NULL AND p_org = ctx_org), false) THEN
    RAISE EXCEPTION 'billing.post: organization context does not match' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF jsonb_typeof(p_postings) <> 'array' OR jsonb_array_length(p_postings) < 2 THEN
    RAISE EXCEPTION 'billing.post: at least two postings are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  h := encode(sha256(convert_to(jsonb_build_array(p_kind, p_description, p_source_event, p_reverses, p_postings)::text, 'UTF8')), 'hex');

  INSERT INTO billing.ledger_transactions (id, org_id, idempotency_key, request_hash, kind, description, source_event_id, reverses_id, created_by)
    VALUES (p_tx_id, p_org, p_key, h, p_kind, p_description, p_source_event, p_reverses, p_actor)
    ON CONFLICT (COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), idempotency_key) DO NOTHING
    RETURNING id INTO inserted;
  IF inserted IS NULL THEN
    SELECT t.id, t.request_hash INTO found_id, found_hash FROM billing.ledger_transactions t
     WHERE COALESCE(t.org_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(p_org, '00000000-0000-0000-0000-000000000000'::uuid)
       AND t.idempotency_key = p_key;
    IF found_hash <> h THEN
      RAISE EXCEPTION 'idempotency key reused with a different request' USING ERRCODE = 'unique_violation', HINT = 'idempotency_key_reuse';
    END IF;
    RETURN QUERY SELECT found_id, true;
    RETURN;
  END IF;

  -- resolve (and lazily create) accounts
  FOR el IN SELECT * FROM jsonb_array_elements(p_postings) LOOP
    SELECT * INTO tpl FROM billing.chart_template(el #>> '{account,code}');
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown account code %', el #>> '{account,code}' USING ERRCODE = 'invalid_parameter_value'; END IF;
    IF (tpl.scope = 'org') <> coalesce((el #>> '{account,org}')::boolean, false) THEN
      RAISE EXCEPTION 'account % has scope %, posting said org=%', el #>> '{account,code}', tpl.scope, el #>> '{account,org}'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF tpl.scope = 'subledger' AND coalesce(el #>> '{account,subledger}', '') = '' THEN
      RAISE EXCEPTION 'account % needs a subledger key', el #>> '{account,code}' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF tpl.scope = 'org' AND p_org IS NULL THEN
      RAISE EXCEPTION 'account % is per organization but the transaction has none', el #>> '{account,code}' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    acct_org := CASE WHEN tpl.scope = 'org' THEN p_org ELSE NULL END;
    INSERT INTO billing.ledger_accounts (id, code, name, type, normal_side, org_id, subledger_key, currency)
      VALUES (gen_random_uuid(), el #>> '{account,code}', tpl.name, tpl.type, tpl.normal_side, acct_org,
              nullif(el #>> '{account,subledger}', ''), el ->> 'currency')
      ON CONFLICT (code, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(subledger_key, ''), currency) DO NOTHING;
  END LOOP;
  -- Account ids are looked up again (an account that already existed keeps its id). Lock in id order.
  SELECT array_agg(DISTINCT a.id ORDER BY a.id) INTO guard
    FROM jsonb_array_elements(p_postings) e
    JOIN billing.ledger_accounts a
      ON a.code = e #>> '{account,code}' AND a.currency = e ->> 'currency'
     AND COALESCE(a.org_id, '00000000-0000-0000-0000-000000000000'::uuid) =
         CASE WHEN coalesce((e #>> '{account,org}')::boolean, false) THEN p_org ELSE '00000000-0000-0000-0000-000000000000'::uuid END
     AND COALESCE(a.subledger_key, '') = coalesce(e #>> '{account,subledger}', '');
  PERFORM 1 FROM billing.ledger_accounts WHERE id = ANY(guard) ORDER BY id FOR UPDATE;

  FOR el IN SELECT * FROM jsonb_array_elements(p_postings) LOOP
    SELECT a.id, a.org_id INTO acct, acct_org FROM billing.ledger_accounts a
     WHERE a.code = el #>> '{account,code}' AND a.currency = el ->> 'currency'
       AND COALESCE(a.org_id, '00000000-0000-0000-0000-000000000000'::uuid) =
           CASE WHEN coalesce((el #>> '{account,org}')::boolean, false) THEN p_org ELSE '00000000-0000-0000-0000-000000000000'::uuid END
       AND COALESCE(a.subledger_key, '') = coalesce(el #>> '{account,subledger}', '');
    INSERT INTO billing.ledger_postings (id, transaction_id, account_id, account_org_id, org_id, direction, amount_minor, currency, dimensions)
      VALUES (gen_random_uuid(), p_tx_id, acct, acct_org, p_org, el ->> 'direction', (el ->> 'amountMinor')::bigint,
              el ->> 'currency', coalesce(el -> 'dimensions', '{}'::jsonb));
    IF coalesce((el ->> 'nonNegative')::boolean, false) AND NOT (acct = ANY(ids)) THEN ids := ids || acct; END IF;
  END LOOP;

  -- overdraw guard
  FOREACH acct IN ARRAY ids LOOP
    SELECT normal_side INTO side FROM billing.ledger_accounts WHERE id = acct;
    SELECT coalesce(sum(CASE WHEN p.direction = side THEN p.amount_minor ELSE -p.amount_minor END), 0) INTO bal
      FROM billing.ledger_postings p WHERE p.account_id = acct;
    IF bal < 0 THEN
      RAISE EXCEPTION 'insufficient funds on account %', acct USING ERRCODE = 'check_violation', HINT = 'insufficient_funds';
    END IF;
  END LOOP;
  RETURN QUERY SELECT p_tx_id, false;
END $$;
REVOKE ALL ON FUNCTION billing.post(uuid, uuid, text, text, text, text, uuid, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.post(uuid, uuid, text, text, text, text, uuid, jsonb, uuid) TO nuzm_app, nuzm_worker;

-- Wallet projection (rebuildable; RC-06 compares it with the ledger).
CREATE TABLE billing.wallet_balances (
  org_id uuid NOT NULL,
  currency char(3) NOT NULL,
  balance_minor bigint NOT NULL,
  last_posting_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, currency)
);
CREATE FUNCTION billing.refresh_wallet(p_org uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT coalesce(current_setting('app.platform_scope', true) = 'admin' OR p_org = nullif(current_setting('app.org_id', true), '')::uuid, false) THEN
    RAISE EXCEPTION 'billing.refresh_wallet: organization context does not match' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO billing.wallet_balances (org_id, currency, balance_minor, last_posting_id, updated_at)
    SELECT p_org, a.currency,
           sum(CASE WHEN p.direction = 'credit' THEN p.amount_minor ELSE -p.amount_minor END),
           (array_agg(p.id ORDER BY p.created_at DESC, p.id DESC))[1], now()
      FROM billing.ledger_accounts a JOIN billing.ledger_postings p ON p.account_id = a.id
     WHERE a.code = '2100' AND a.org_id = p_org GROUP BY a.currency
    ON CONFLICT (org_id, currency) DO UPDATE
      SET balance_minor = EXCLUDED.balance_minor, last_posting_id = EXCLUDED.last_posting_id, updated_at = now();
END $$;
REVOKE ALL ON FUNCTION billing.refresh_wallet(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.refresh_wallet(uuid) TO nuzm_app, nuzm_worker;

-- Plans (platform reference data; writes only from the admin console scope) -------------------------------
CREATE TABLE billing.plans (
  id uuid PRIMARY KEY,
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_-]{1,40}$'),
  name_ar text NOT NULL,
  name_en text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  placeholder boolean NOT NULL DEFAULT false,    -- true = DRAFT-NOT-APPROVED seed (HG-02-01)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE billing.plan_versions (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES billing.plans(id),
  version int NOT NULL CHECK (version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  currency char(3) NOT NULL DEFAULT 'SAR',
  published_at timestamptz,
  published_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, version)
);
-- one draft per plan at a time
CREATE UNIQUE INDEX plan_versions_one_draft_idx ON billing.plan_versions (plan_id) WHERE status = 'draft';

CREATE FUNCTION billing.plan_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION 'published plan versions are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_versions_immutable BEFORE UPDATE OR DELETE ON billing.plan_versions
  FOR EACH ROW EXECUTE FUNCTION billing.plan_version_immutable();

-- Entitlements: plan rows (scope plan), organization overrides, and the org's plan assignment.
-- docs/05 §rules: the org→plan assignment is an entitlements row with source='plan' (M02 prompt says
-- 'plan_assignment'; docs/05 wins, recorded in the S05 report). kind='plan_assignment' marks it.
CREATE TABLE billing.entitlements (
  id uuid PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('plan','org_override')),
  source text NOT NULL CHECK (source IN ('plan','override')),
  kind text NOT NULL CHECK (kind IN ('meter_limit','feature','plan_assignment')),
  plan_version_id uuid REFERENCES billing.plan_versions(id),
  org_id uuid,
  meter_group text,
  feature_key text,
  limit_value bigint CHECK (limit_value IS NULL OR limit_value >= 0),
  allowance bigint CHECK (allowance IS NULL OR allowance >= 0),
  mode text NOT NULL DEFAULT 'soft' CHECK (mode IN ('soft','hard')),
  enabled boolean NOT NULL DEFAULT true,
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (scope <> 'plan' OR (plan_version_id IS NOT NULL AND org_id IS NULL AND source = 'plan' AND kind <> 'plan_assignment')),
  CHECK (scope <> 'org_override' OR org_id IS NOT NULL),
  CHECK (kind <> 'plan_assignment' OR (scope = 'org_override' AND source = 'plan' AND plan_version_id IS NOT NULL)),
  CHECK (kind <> 'meter_limit' OR meter_group IS NOT NULL),
  CHECK (kind <> 'feature' OR feature_key IS NOT NULL)
);
CREATE INDEX entitlements_plan_idx ON billing.entitlements (plan_version_id);
CREATE INDEX entitlements_org_idx ON billing.entitlements (org_id, kind, created_at DESC);

-- A published plan version's own entitlement rows are frozen.
CREATE FUNCTION billing.entitlement_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text; vid uuid := coalesce(NEW.plan_version_id, OLD.plan_version_id);
BEGIN
  IF coalesce(NEW.scope, OLD.scope) = 'plan' THEN
    SELECT status INTO st FROM billing.plan_versions WHERE id = vid;
    IF st = 'published' THEN
      RAISE EXCEPTION 'entitlements of a published plan version are immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER entitlements_frozen BEFORE INSERT OR UPDATE OR DELETE ON billing.entitlements
  FOR EACH ROW EXECUTE FUNCTION billing.entitlement_frozen();

-- RLS -------------------------------------------------------------------------------------------------------
DO $$
DECLARE t text; own text := current_user;
BEGIN
  FOREACH t IN ARRAY ARRAY['ledger_accounts','ledger_transactions','ledger_postings','wallet_balances','entitlements'] LOOP
    EXECUTE format('ALTER TABLE billing.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE billing.%I FORCE ROW LEVEL SECURITY', t);
    -- the SECURITY DEFINER functions run as the owner; give that role full access under FORCE
    EXECUTE format('CREATE POLICY definer_all ON billing.%I TO %I USING (true) WITH CHECK (true)', t, own);
  END LOOP;
END $$;
CREATE POLICY org_read ON billing.ledger_accounts FOR SELECT
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.platform_scope', true) = 'admin');
CREATE POLICY org_read ON billing.ledger_transactions FOR SELECT
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.platform_scope', true) = 'admin');
CREATE POLICY org_read ON billing.ledger_postings FOR SELECT
  USING (account_org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.platform_scope', true) = 'admin');
CREATE POLICY org_read ON billing.wallet_balances FOR SELECT
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.platform_scope', true) = 'admin');
CREATE POLICY read_visible ON billing.entitlements FOR SELECT
  USING (org_id IS NULL OR org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.platform_scope', true) = 'admin');
CREATE POLICY platform_write ON billing.entitlements FOR ALL
  USING (current_setting('app.platform_scope', true) = 'admin') WITH CHECK (current_setting('app.platform_scope', true) = 'admin');

ALTER TABLE billing.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.plans FORCE ROW LEVEL SECURITY;
CREATE POLICY read_all ON billing.plans FOR SELECT USING (true);
CREATE POLICY platform_write ON billing.plans FOR ALL
  USING (current_setting('app.platform_scope', true) = 'admin') WITH CHECK (current_setting('app.platform_scope', true) = 'admin');
ALTER TABLE billing.plan_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.plan_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY read_all ON billing.plan_versions FOR SELECT USING (true);
CREATE POLICY platform_write ON billing.plan_versions FOR ALL
  USING (current_setting('app.platform_scope', true) = 'admin') WITH CHECK (current_setting('app.platform_scope', true) = 'admin');

-- Grants: ledger tables are READ-ONLY for runtime roles (billing.post / refresh_wallet are the writers).
GRANT SELECT ON billing.ledger_accounts, billing.ledger_transactions, billing.ledger_postings, billing.wallet_balances,
  billing.plans, billing.plan_versions, billing.entitlements TO nuzm_app, nuzm_worker;
GRANT INSERT, UPDATE, DELETE ON billing.plans, billing.plan_versions, billing.entitlements TO nuzm_app; -- gated by platform_write RLS
GRANT SELECT ON billing.ledger_accounts, billing.ledger_transactions, billing.ledger_postings, billing.wallet_balances,
  billing.plans, billing.plan_versions, billing.entitlements TO nuzm_admin_breakglass;

-- Permissions (platform) for the finance/admin read APIs; org permissions billing:read/manage already exist.
INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('admin:billing:read','platform','Read ledger accounts/transactions, plans and price books');
INSERT INTO tenancy.role_permissions VALUES
  ('finance','admin:billing:read'),('platform_admin','admin:billing:read'),('compliance_officer','admin:billing:read');

-- Seed: platform accounts without a sub-ledger (SAR base currency). Per-org and per-provider accounts are created lazily.
INSERT INTO billing.ledger_accounts (id, code, name, type, normal_side, org_id, subledger_key, currency)
  SELECT gen_random_uuid(), c.code, t.name, t.type, t.normal_side, NULL, NULL, 'SAR'
    FROM (VALUES ('1400'),('2300'),('4100'),('4200'),('4300'),('4400'),('4900'),('5200'),('5300'),('5400')) AS c(code),
         LATERAL billing.chart_template(c.code) t;

-- Seed: placeholder plans, DRAFT-NOT-APPROVED (HG-02-01): values are examples, not a price list.
WITH p AS (
  INSERT INTO billing.plans (id, key, name_ar, name_en, placeholder) VALUES
    (gen_random_uuid(), 'free',    'مجانية (قيم مؤقتة)',  'Free (placeholder values)',  true),
    (gen_random_uuid(), 'starter', 'المبتدئ (قيم مؤقتة)', 'Starter (placeholder values)', true)
  RETURNING id, key
), v AS (
  INSERT INTO billing.plan_versions (id, plan_id, version, status, published_at)
    SELECT gen_random_uuid(), id, 1, 'draft', NULL FROM p RETURNING id, plan_id
)
INSERT INTO billing.entitlements (id, scope, source, kind, plan_version_id, meter_group, feature_key, limit_value, allowance, mode, note)
  SELECT gen_random_uuid(), 'plan', 'plan', e.kind, v.id, e.meter_group, e.feature_key, e.limit_value, e.allowance, e.mode,
         'DRAFT-NOT-APPROVED placeholder (HG-02-01)'
    FROM v JOIN p ON p.id = v.plan_id
    JOIN LATERAL (VALUES
      ('feature',     NULL,       'projects',        NULL::bigint, NULL::bigint, 'soft'),
      ('meter_limit', 'compute',  NULL,              CASE p.key WHEN 'free' THEN 0 ELSE 100 END::bigint, CASE p.key WHEN 'free' THEN 0 ELSE 50 END::bigint, 'hard'),
      ('meter_limit', 'storage',  NULL,              CASE p.key WHEN 'free' THEN 5 ELSE 100 END::bigint, CASE p.key WHEN 'free' THEN 5 ELSE 50 END::bigint, 'soft')
    ) AS e(kind, meter_group, feature_key, limit_value, allowance, mode) ON true;
UPDATE billing.plan_versions SET status = 'published', published_at = now();
