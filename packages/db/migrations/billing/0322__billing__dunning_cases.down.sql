-- DEV ONLY. Production is forward-fix (dunning cases are financial history and are never dropped).
DROP TABLE IF EXISTS billing.dunning_cases;
DROP FUNCTION IF EXISTS billing.dunning_guard();
DROP FUNCTION IF EXISTS billing.dunning_no_truncate();
