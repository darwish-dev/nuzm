-- DEV/STAGING ONLY. Production is forward-fix (an audit trail of acceptances, reviews and qualifications). Documented reversal of 2212 (was 1921) (S-AG5): dropping the table withdraws every
-- acceptance, review and qualification; the gates then fail closed (no acceptance = not accepted, no qualification = not qualified), which is the safe direction.
DROP TABLE IF EXISTS ai.benchmark_records;
