-- DEV ONLY. Production is forward-fix: registrar accounts are platform configuration and are never dropped there.
ALTER TABLE domains.registrar_accounts DROP COLUMN IF EXISTS settings;
DELETE FROM domains.registrars WHERE provider_code = 'dnet' AND NOT EXISTS (SELECT 1 FROM domains.registrar_accounts a WHERE a.registrar_id = domains.registrars.id);
