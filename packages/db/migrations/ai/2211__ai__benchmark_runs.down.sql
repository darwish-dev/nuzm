-- DEV/STAGING ONLY. Production is forward-fix (the table is an audit trail of benchmark evidence). Documented reversal of 2211 (was 1920) (S-AG5): dropping the table removes the stored reports;
-- no model is qualified from a missing row (the gate and the qualification workflow fail closed without evidence), which is the safe direction.
DROP TABLE IF EXISTS ai.benchmark_runs;
