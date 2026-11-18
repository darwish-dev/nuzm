-- DEV/STAGING ONLY. Production is forward-fix (authorizations are financial records).
DROP TABLE IF EXISTS commerce.authorization_releases;
DROP INDEX IF EXISTS commerce.authorizations_hold_once;
DELETE FROM commerce.authorizations WHERE kind = 'hold';
ALTER TABLE commerce.authorizations DROP CONSTRAINT IF EXISTS authorizations_kind_check;
ALTER TABLE commerce.authorizations ADD CONSTRAINT authorizations_kind_check CHECK (kind IN ('spend_approval','credit','payment'));
