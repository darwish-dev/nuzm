-- DEV ONLY. Production is forward-fix: registrar rows are platform configuration and are never dropped there.
DELETE FROM domains.registrars WHERE provider_code = 'dynadot' AND NOT EXISTS (SELECT 1 FROM domains.registrar_accounts a WHERE a.registrar_id = domains.registrars.id);
