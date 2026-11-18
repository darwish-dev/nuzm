-- Owner decision 2026-11-18 (ADR-008, amended): platform staff may sign in to the admin console with email + password.
-- Two-factor verification stays MANDATORY for the admin realm (enforced by the session guard, not by this table), so a password alone
-- never opens the console. The earlier trigger that refused a password for a platform user is removed.
DROP TRIGGER IF EXISTS credentials_not_for_platform_users ON identity.credentials;
DROP FUNCTION IF EXISTS identity.credentials_not_for_platform_users();
