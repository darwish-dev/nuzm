-- DEV ONLY. Production is forward-fix (top-ups are financial records and are never dropped).
DROP TABLE IF EXISTS billing.wallet_topups;
DROP FUNCTION IF EXISTS billing.wallet_topup_guard();
DROP FUNCTION IF EXISTS billing.wallet_topup_no_truncate();
