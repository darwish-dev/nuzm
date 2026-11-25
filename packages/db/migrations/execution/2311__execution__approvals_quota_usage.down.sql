-- DEV/STAGING ONLY. Production is forward-fix (approvals and usage are audit and billing evidence). Documented reversal of 2311 (P3-S02): drop after the flag is off and the queue drained.
DROP TABLE IF EXISTS execution.usage_records;
DROP FUNCTION IF EXISTS execution.usage_guard();
DROP TABLE IF EXISTS execution.quota_reservations;
DROP FUNCTION IF EXISTS execution.reservation_guard();
DROP TABLE IF EXISTS execution.approvals;
DROP FUNCTION IF EXISTS execution.approval_guard();
