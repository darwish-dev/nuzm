-- DEV/STAGING ONLY. Production uses forward fixes: invoices and credit notes are legal documents and are never dropped.
DROP TABLE IF EXISTS invoicing.credit_notes;
DROP TABLE IF EXISTS invoicing.invoice_lines;
DROP TABLE IF EXISTS invoicing.invoices;
DROP FUNCTION IF EXISTS invoicing.credit_note_guard();
DROP FUNCTION IF EXISTS invoicing.invoice_line_insert_guard();
DROP FUNCTION IF EXISTS invoicing.invoice_guard();
DROP FUNCTION IF EXISTS invoicing.deny_line_mutation();
DROP FUNCTION IF EXISTS invoicing.deny_truncate();
