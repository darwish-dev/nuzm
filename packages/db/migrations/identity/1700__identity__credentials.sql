-- Built-in email+password sign-in for the customer console (ADR-008). Tenant-less, user-scoped, hashes only.

CREATE TABLE identity.credentials (
  user_id uuid PRIMARY KEY REFERENCES identity.users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,              -- scrypt$N$r$p$salt$hash; never the password
  password_set_at timestamptz NOT NULL DEFAULT now(),
  failed_attempts int NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  last_failed_at timestamptz,
  locked_until timestamptz
);

CREATE TABLE identity.auth_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('email_verification','password_reset')),
  token_hash text NOT NULL UNIQUE,          -- SHA-256 of the emailed token
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_idx ON identity.auth_tokens (user_id, purpose) WHERE used_at IS NULL;

-- Platform staff sign in through the identity provider with MFA only: never a password.
CREATE FUNCTION identity.credentials_not_for_platform_users() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM identity.users u WHERE u.id = NEW.user_id AND u.is_platform_user) THEN
    RAISE EXCEPTION 'platform users cannot have a password' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credentials_not_for_platform_users BEFORE INSERT OR UPDATE ON identity.credentials
  FOR EACH ROW EXECUTE FUNCTION identity.credentials_not_for_platform_users();

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.credentials, identity.auth_tokens TO nuzm_app;
