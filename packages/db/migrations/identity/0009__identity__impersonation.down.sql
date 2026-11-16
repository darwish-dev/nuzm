-- Dev/staging reversal.
ALTER TABLE identity.sessions
  DROP CONSTRAINT IF EXISTS sessions_impersonation_consistent,
  DROP COLUMN IF EXISTS impersonation_ref,
  DROP COLUMN IF EXISTS impersonation_reason,
  DROP COLUMN IF EXISTS impersonator_user_id;
