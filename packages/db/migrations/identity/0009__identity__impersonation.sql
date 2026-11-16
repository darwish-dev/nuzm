-- M01 S04: support impersonation. An impersonation session is an ordinary web-realm session for the TARGET user
-- that records who started it and why; it is short-lived (<= 30 min, enforced by the service and the CHECK).
ALTER TABLE identity.sessions
  ADD COLUMN impersonator_user_id uuid,
  ADD COLUMN impersonation_reason text,
  ADD COLUMN impersonation_ref text,
  ADD CONSTRAINT sessions_impersonation_consistent CHECK (
    (impersonator_user_id IS NULL AND impersonation_reason IS NULL)
    OR (impersonator_user_id IS NOT NULL AND length(impersonation_reason) >= 10
        AND absolute_expires_at <= created_at + interval '30 minutes' + interval '5 seconds'));
