-- M02 S07b: commerce core. ONE quote mechanism for every kind (docs/04); quotes are immutable once issued (trigger) and
-- valid until expires_at; an order is created from exactly one quote; an authorization records WHY spend was allowed.
--  * No cross-schema FKs: price_book_version_id / spend_approval_id are logical references checked by the services.
--  * Money is integer minor units; quantities are exact decimals (numeric(24,8), the metering scale).
CREATE SCHEMA IF NOT EXISTS commerce;
GRANT USAGE ON SCHEMA commerce TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('quote:create','org','Create quotes and place orders from them'),
  ('quote:read','org','Read quotes');
INSERT INTO tenancy.role_permissions VALUES
  ('owner','quote:create'),('admin','quote:create'),('billing_admin','quote:create'),('developer','quote:create'),
  ('owner','quote:read'),('admin','quote:read'),('billing_admin','quote:read'),('developer','quote:read');

CREATE TABLE commerce.quotes (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('compute','hosting','domain','database','storage','email','ai-credit','plan','marketplace')),
  project_id uuid,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor bigint NOT NULL CHECK (tax_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  tax_estimate jsonb NOT NULL,                   -- {status:'provisional', rateBps, source, note}: replaced by the M03 tax engine
  residency jsonb NOT NULL,                      -- {status:'not_evaluated'}: replaced by the M04 residency evaluation
  requires_approval boolean NOT NULL,
  approval_detail jsonb NOT NULL DEFAULT '[]'::jsonb,
  price_book_version_id uuid,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (total_minor = subtotal_minor + tax_minor),
  CHECK (expires_at > created_at)
);
CREATE INDEX quotes_org_idx ON commerce.quotes (org_id, created_at DESC, id);

CREATE TABLE commerce.quote_items (
  id uuid PRIMARY KEY,
  quote_id uuid NOT NULL REFERENCES commerce.quotes(id),
  org_id uuid NOT NULL,
  position int NOT NULL CHECK (position >= 1),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  meter_id text,                                 -- logical reference to metering.meters
  meter_group text,
  quantity numeric(24,8) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL,
  unit_price_minor numeric(24,8),                -- informational (flat items); the amount below is authoritative
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (quote_id, position)
);

-- A quote is a fact that was shown to the customer: it is never changed or removed.
CREATE FUNCTION commerce.deny_quote_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'commerce.% rows are immutable once issued', TG_TABLE_NAME USING ERRCODE = 'check_violation', HINT = 'immutable';
END $$;
CREATE TRIGGER quotes_immutable BEFORE UPDATE OR DELETE ON commerce.quotes FOR EACH ROW EXECUTE FUNCTION commerce.deny_quote_mutation();
CREATE TRIGGER quotes_no_truncate BEFORE TRUNCATE ON commerce.quotes FOR EACH STATEMENT EXECUTE FUNCTION commerce.deny_quote_mutation();
CREATE TRIGGER quote_items_immutable BEFORE UPDATE OR DELETE ON commerce.quote_items FOR EACH ROW EXECUTE FUNCTION commerce.deny_quote_mutation();
CREATE TRIGGER quote_items_no_truncate BEFORE TRUNCATE ON commerce.quote_items FOR EACH STATEMENT EXECUTE FUNCTION commerce.deny_quote_mutation();

CREATE TABLE commerce.orders (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  quote_id uuid NOT NULL REFERENCES commerce.quotes(id),
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','fulfilled','failed','cancelled')),
  currency char(3) NOT NULL,
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, quote_id)                      -- a quote becomes at most one order
);
CREATE INDEX orders_org_idx ON commerce.orders (org_id, created_at DESC, id);

CREATE TABLE commerce.order_items (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES commerce.orders(id),
  org_id uuid NOT NULL,
  position int NOT NULL CHECK (position >= 1),
  description text NOT NULL,
  meter_id text,
  quantity numeric(24,8) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  UNIQUE (order_id, position)
);

-- Why an order was allowed to proceed. 'payment' arrives with M03; 'credit' (wallet hold) is not implemented in M02.
CREATE TABLE commerce.authorizations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('spend_approval','credit','payment')),
  order_id uuid NOT NULL REFERENCES commerce.orders(id),
  spend_approval_id uuid,                        -- logical reference to billing.spend_approvals
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'spend_approval' OR spend_approval_id IS NOT NULL)
);
-- An approval authorizes ONE order, once.
CREATE UNIQUE INDEX authorizations_approval_once ON commerce.authorizations (org_id, spend_approval_id) WHERE spend_approval_id IS NOT NULL;

CREATE FUNCTION commerce.deny_record_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'commerce.% rows are never deleted or rewritten', TG_TABLE_NAME USING ERRCODE = 'check_violation', HINT = 'immutable';
END $$;
CREATE TRIGGER order_items_immutable BEFORE UPDATE OR DELETE ON commerce.order_items FOR EACH ROW EXECUTE FUNCTION commerce.deny_record_mutation();
CREATE TRIGGER order_items_no_truncate BEFORE TRUNCATE ON commerce.order_items FOR EACH STATEMENT EXECUTE FUNCTION commerce.deny_record_mutation();
CREATE TRIGGER authorizations_immutable BEFORE UPDATE OR DELETE ON commerce.authorizations FOR EACH ROW EXECUTE FUNCTION commerce.deny_record_mutation();
CREATE TRIGGER authorizations_no_truncate BEFORE TRUNCATE ON commerce.authorizations FOR EACH STATEMENT EXECUTE FUNCTION commerce.deny_record_mutation();
CREATE FUNCTION commerce.order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'orders are never deleted' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.quote_id <> OLD.quote_id OR NEW.total_minor <> OLD.total_minor OR NEW.currency <> OLD.currency OR NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'order terms are immutable (only status moves)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_guard BEFORE UPDATE OR DELETE ON commerce.orders FOR EACH ROW EXECUTE FUNCTION commerce.order_guard();
CREATE TRIGGER orders_no_truncate BEFORE TRUNCATE ON commerce.orders FOR EACH STATEMENT EXECUTE FUNCTION commerce.deny_record_mutation();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['quotes','quote_items','orders','order_items','authorizations'] LOOP
    EXECUTE format('ALTER TABLE commerce.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE commerce.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON commerce.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
                      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY platform_read ON commerce.%I FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT, INSERT ON commerce.%I TO nuzm_app', t);
    EXECUTE format('GRANT SELECT ON commerce.%I TO nuzm_worker, nuzm_readonly_reporting', t);
  END LOOP;
END $$;
GRANT UPDATE (status) ON commerce.orders TO nuzm_app;  -- fulfilment moves status (M05+); terms stay frozen by the guard
