-- M03 S09: how payments reach invoices. One application per (invoice, payment) makes applying idempotent: a retry or a duplicate
-- event can never add the same payment twice. Owned by invoicing; written only through InvoiceService.applyPayment.
CREATE TABLE invoicing.invoice_payment_applications (
  invoice_id uuid NOT NULL REFERENCES invoicing.invoices(id),
  payment_id uuid NOT NULL,                      -- logical reference to payments.payment_intents
  org_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invoice_id, payment_id)
);
CREATE FUNCTION invoicing.deny_application_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'payment applications are append-only' USING ERRCODE = 'check_violation', HINT = 'immutable'; END $$;
CREATE TRIGGER payment_applications_immutable BEFORE UPDATE OR DELETE ON invoicing.invoice_payment_applications FOR EACH ROW EXECUTE FUNCTION invoicing.deny_application_mutation();
CREATE TRIGGER payment_applications_no_truncate BEFORE TRUNCATE ON invoicing.invoice_payment_applications FOR EACH STATEMENT EXECUTE FUNCTION invoicing.deny_application_mutation();
ALTER TABLE invoicing.invoice_payment_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoicing.invoice_payment_applications FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON invoicing.invoice_payment_applications USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON invoicing.invoice_payment_applications FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON invoicing.invoice_payment_applications TO nuzm_app, nuzm_worker;
GRANT SELECT ON invoicing.invoice_payment_applications TO nuzm_readonly_reporting;
