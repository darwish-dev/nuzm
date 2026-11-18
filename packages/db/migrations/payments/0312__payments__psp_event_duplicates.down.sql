-- DEV ONLY. Production is forward-fix (the counters hold audit-relevant history).
ALTER TABLE payments.psp_events DROP COLUMN IF EXISTS last_duplicate_at, DROP COLUMN IF EXISTS duplicate_count;
