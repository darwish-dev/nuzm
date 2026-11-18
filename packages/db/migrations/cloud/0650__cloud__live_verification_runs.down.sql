-- DEV/STAGING ONLY. Production is forward-fix (docs/05): never drop evidence of a live verification.
DROP TABLE IF EXISTS cloud.live_verification_runs;
