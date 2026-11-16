-- M03 S08b: invoices, invoice lines and credit notes (docs/11 §2, §4).
--  * An issued invoice is a legal document: every column except `status`, `paid_minor` and `ledger_transaction_id` is frozen by
--    trigger (also for the table owner); status moves only along the legal state machine; `paid_minor` only grows; lines and
--    credit notes are never edited or deleted. Corrections are credit notes (or debit notes), never edits.
--  * Numbers come from invoicing.allocate_number() inside the issuing transaction (gapless, S08a).
--  * (org_id, entity_id, source_key) makes the period close idempotent: re-running it returns the same invoice.
--  * (org_id, source_id) on lines means a rated meter, order item or subscription charge is billed once, ever.
--  * Every document carries `data_region` (placeholder tag until M04) and `environment` (sandbox until HG-03-01/-03 allow live).
CREATE TABLE invoicing.invoices (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  entity_id uuid NOT NULL REFERENCES invoicing.billing_entities(id),
  series text NOT NULL CHECK (series ~ '^[A-Z]{2,6}$'),
  number bigint NOT NULL CHECK (number >= 1),
  number_text text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('draft','open','partially_paid','paid','void','uncollectible')),
  environment text NOT NULL CHECK (environment IN ('sandbox','live')),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  period_start date NOT NULL,
  period_end date NOT NULL,                       -- inclusive last day
  issued_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  source_key text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 200),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor bigint NOT NULL CHECK (tax_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor > 0),
  paid_minor bigint NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  tax_review jsonb NOT NULL DEFAULT '{"required":false,"reasons":[]}'::jsonb,
  buyer jsonb NOT NULL,                           -- snapshot of the tax profile at issue
  seller jsonb NOT NULL,                          -- snapshot of the billing entity at issue
  data_region text NOT NULL DEFAULT 'sa-pending',
  ledger_transaction_id uuid,                     -- logical reference to billing.ledger_transactions (set once)
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, series, number),
  UNIQUE (org_id, entity_id, source_key),
  CHECK (total_minor = subtotal_minor + tax_minor),
  CHECK (paid_minor <= total_minor),
  CHECK (status <> 'paid' OR paid_minor = total_minor),
  CHECK (period_end >= period_start)
);
CREATE INDEX invoices_org_idx ON invoicing.invoices (org_id, status, issued_at DESC, id);

CREATE TABLE invoicing.invoice_lines (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES invoicing.invoices(id),
  org_id uuid NOT NULL,
  position int NOT NULL CHECK (position >= 1),
  kind text NOT NULL CHECK (kind IN ('usage','order','subscription')),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  meter_id text,
  quantity numeric(24,8) NOT NULL CHECK (quantity >= 0),
  unit text NOT NULL,
  net_minor bigint NOT NULL CHECK (net_minor >= 0),
  tax_minor bigint NOT NULL CHECK (tax_minor >= 0),
  rate_code text NOT NULL,
  rate_bps int NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  revenue_account text NOT NULL CHECK (revenue_account IN ('4100','4200','4300','4400')),
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 200),
  UNIQUE (invoice_id, position),
  UNIQUE (org_id, source_id)
);

CREATE TABLE invoicing.credit_notes (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES invoicing.invoices(id),
  entity_id uuid NOT NULL REFERENCES invoicing.billing_entities(id),
  series text NOT NULL CHECK (series ~ '^[A-Z]{2,6}$'),
  number bigint NOT NULL CHECK (number >= 1),
  number_text text NOT NULL,
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('draft','issued','applied','refunded')),
  environment text NOT NULL CHECK (environment IN ('sandbox','live')),
  currency char(3) NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z_]{3,40}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  lines jsonb NOT NULL,                           -- [{invoiceLineId, netMinor, taxMinor}]
  net_minor bigint NOT NULL CHECK (net_minor > 0),
  tax_minor bigint NOT NULL CHECK (tax_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor > 0),
  issued_at timestamptz NOT NULL,
  data_region text NOT NULL DEFAULT 'sa-pending',
  ledger_transaction_id uuid,
  source_key text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 200),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, series, number),
  UNIQUE (org_id, source_key),
  CHECK (total_minor = net_minor + tax_minor)
);
CREATE INDEX credit_notes_org_idx ON invoicing.credit_notes (org_id, issued_at DESC, id);

-- Invoice guard: frozen except status / paid_minor / ledger link, with the legal state machine.
CREATE FUNCTION invoicing.invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'invoices are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF (to_jsonb(NEW) - 'status' - 'paid_minor' - 'ledger_transaction_id' - 'updated_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'paid_minor' - 'ledger_transaction_id' - 'updated_at') THEN
    RAISE EXCEPTION 'an issued invoice is immutable (correct it with a credit note)' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF NEW.paid_minor < OLD.paid_minor THEN
    RAISE EXCEPTION 'paid_minor can only grow' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.ledger_transaction_id IS NOT NULL AND NEW.ledger_transaction_id IS DISTINCT FROM OLD.ledger_transaction_id THEN
    RAISE EXCEPTION 'the ledger link is set once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft'          AND NEW.status = 'open')
    OR (OLD.status = 'open'           AND NEW.status IN ('partially_paid','paid','void','uncollectible'))
    OR (OLD.status = 'partially_paid' AND NEW.status IN ('paid','uncollectible'))
  ) THEN
    RAISE EXCEPTION 'illegal invoice status transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_guard BEFORE UPDATE OR DELETE ON invoicing.invoices FOR EACH ROW EXECUTE FUNCTION invoicing.invoice_guard();

-- Statement-level triggers have no row: TRUNCATE gets its own always-refusing function.
CREATE FUNCTION invoicing.deny_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is never truncated', TG_TABLE_NAME USING ERRCODE = 'check_violation'; END $$;
CREATE FUNCTION invoicing.deny_line_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'invoice lines are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable'; END $$;
CREATE TRIGGER invoices_no_truncate BEFORE TRUNCATE ON invoicing.invoices FOR EACH STATEMENT EXECUTE FUNCTION invoicing.deny_truncate();
CREATE TRIGGER invoice_lines_immutable BEFORE UPDATE OR DELETE ON invoicing.invoice_lines FOR EACH ROW EXECUTE FUNCTION invoicing.deny_line_mutation();
CREATE TRIGGER invoice_lines_no_truncate BEFORE TRUNCATE ON invoicing.invoice_lines FOR EACH STATEMENT EXECUTE FUNCTION invoicing.deny_truncate();
CREATE TRIGGER credit_notes_no_truncate BEFORE TRUNCATE ON invoicing.credit_notes FOR EACH STATEMENT EXECUTE FUNCTION invoicing.deny_truncate();

-- Lines of an issued invoice cannot be added later: the invoice must still be in its creation transaction.
CREATE FUNCTION invoicing.invoice_line_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv_created timestamptz;
BEGIN
  SELECT created_at INTO inv_created FROM invoicing.invoices WHERE id = NEW.invoice_id;
  IF inv_created IS NULL OR inv_created <> now() THEN
    RAISE EXCEPTION 'lines can only be added in the transaction that creates the invoice' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_line_insert_guard BEFORE INSERT ON invoicing.invoice_lines FOR EACH ROW EXECUTE FUNCTION invoicing.invoice_line_insert_guard();

-- Credit notes: frozen except status / ledger link; the sum of credit notes of an invoice never exceeds the invoice
-- (the invoice row lock serializes concurrent credit notes).
CREATE FUNCTION invoicing.credit_note_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv record; used bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO inv FROM invoicing.invoices WHERE id = NEW.invoice_id AND org_id = NEW.org_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'credit note references an unknown invoice' USING ERRCODE = 'foreign_key_violation'; END IF;
    IF inv.currency <> NEW.currency THEN RAISE EXCEPTION 'credit note currency must equal the invoice currency' USING ERRCODE = 'check_violation'; END IF;
    SELECT coalesce(sum(total_minor), 0) INTO used FROM invoicing.credit_notes WHERE invoice_id = NEW.invoice_id;
    IF used + NEW.total_minor > inv.total_minor THEN
      RAISE EXCEPTION 'credit notes would exceed the invoice total' USING ERRCODE = 'check_violation', HINT = 'exceeds_invoice';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'credit notes are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF (to_jsonb(NEW) - 'status' - 'ledger_transaction_id') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'ledger_transaction_id') THEN
    RAISE EXCEPTION 'an issued credit note is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.ledger_transaction_id IS NOT NULL AND NEW.ledger_transaction_id IS DISTINCT FROM OLD.ledger_transaction_id THEN
    RAISE EXCEPTION 'the ledger link is set once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft'  AND NEW.status = 'issued')
    OR (OLD.status = 'issued' AND NEW.status IN ('applied','refunded'))
  ) THEN
    RAISE EXCEPTION 'illegal credit note status transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credit_note_guard BEFORE INSERT OR UPDATE OR DELETE ON invoicing.credit_notes FOR EACH ROW EXECUTE FUNCTION invoicing.credit_note_guard();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['invoices','invoice_lines','credit_notes'] LOOP
    EXECUTE format('ALTER TABLE invoicing.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE invoicing.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON invoicing.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
                      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY platform_read ON invoicing.%I FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT, INSERT ON invoicing.%I TO nuzm_app', t);
    EXECUTE format('GRANT SELECT ON invoicing.%I TO nuzm_worker, nuzm_readonly_reporting', t);
  END LOOP;
END $$;
-- Only the moving parts are updatable at all (the triggers police the rest, also for the owner).
GRANT UPDATE (status, paid_minor, ledger_transaction_id, updated_at) ON invoicing.invoices TO nuzm_app, nuzm_worker;
GRANT UPDATE (status, ledger_transaction_id) ON invoicing.credit_notes TO nuzm_app, nuzm_worker;
GRANT INSERT ON invoicing.invoices, invoicing.invoice_lines, invoicing.credit_notes TO nuzm_worker;
