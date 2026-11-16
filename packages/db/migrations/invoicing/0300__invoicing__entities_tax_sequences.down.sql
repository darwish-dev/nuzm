-- DEV/STAGING ONLY. Production uses forward fixes: invoice numbering history is a legal record and is never dropped.
DROP FUNCTION IF EXISTS invoicing.allocate_number(uuid, text);
DROP TABLE IF EXISTS invoicing.invoice_sequences;
DROP TABLE IF EXISTS invoicing.tax_profiles;
DROP TABLE IF EXISTS invoicing.tax_rates;
DROP TABLE IF EXISTS invoicing.billing_entities;
DROP SCHEMA IF EXISTS invoicing;
