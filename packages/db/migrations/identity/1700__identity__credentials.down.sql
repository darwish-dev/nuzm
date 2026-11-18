-- Dev/staging only. Production is forward-fix: credentials are never dropped there.
DROP TRIGGER IF EXISTS credentials_not_for_platform_users ON identity.credentials;
DROP FUNCTION IF EXISTS identity.credentials_not_for_platform_users();
DROP TABLE IF EXISTS identity.auth_tokens;
DROP TABLE IF EXISTS identity.credentials;
