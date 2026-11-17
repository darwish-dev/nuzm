-- DEV/STAGING ONLY. Production uses forward fixes: intents, attempts and PSP events are financial records and are never dropped.
DROP FUNCTION IF EXISTS payments.resolve_intent(text);
DROP TABLE IF EXISTS payments.psp_events;
DROP TABLE IF EXISTS payments.payment_attempts;
DROP TABLE IF EXISTS payments.payment_intents;
DROP TABLE IF EXISTS payments.payment_methods;
DROP TABLE IF EXISTS payments.customers_psp;
DROP TABLE IF EXISTS payments.psp_accounts;
DROP FUNCTION IF EXISTS payments.intent_guard();
DROP FUNCTION IF EXISTS payments.method_guard();
DROP FUNCTION IF EXISTS payments.deny_mutation();
DROP SCHEMA IF EXISTS payments;
