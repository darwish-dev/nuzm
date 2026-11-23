-- DEV/STAGING ONLY. Production is forward-fix (the table is an audit trail of capability decisions). Documented reversal of 1870 (S-AG4b): removing the table withdraws every
-- recorded tool-calling declaration (no evidence = unsupported), which is the safe direction.
DROP TABLE IF EXISTS ai.model_capability_evidence;
