-- Dev/staging reversal: restore the rule that a platform user cannot hold a password (existing staff passwords must be deleted first).
CREATE OR REPLACE FUNCTION identity.credentials_not_for_platform_users() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM identity.users u WHERE u.id = NEW.user_id AND u.is_platform_user) THEN
    RAISE EXCEPTION 'platform users cannot have a password' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credentials_not_for_platform_users BEFORE INSERT OR UPDATE ON identity.credentials
  FOR EACH ROW EXECUTE FUNCTION identity.credentials_not_for_platform_users();
