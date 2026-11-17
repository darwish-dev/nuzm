-- DEV/STAGING ONLY. Payment applications are financial records and are never dropped in production.
DROP TABLE IF EXISTS invoicing.invoice_payment_applications;
DROP FUNCTION IF EXISTS invoicing.deny_application_mutation();
