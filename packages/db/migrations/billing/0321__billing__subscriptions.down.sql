-- DEV ONLY. Production is forward-fix (subscriptions drive invoices and are never dropped).
DROP TABLE IF EXISTS billing.subscriptions;
DROP FUNCTION IF EXISTS billing.subscription_guard();
DROP FUNCTION IF EXISTS billing.subscription_no_truncate();
