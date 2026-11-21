-- DNet (dnet.sa) registrar entry and non-secret account settings (owner request 2026-11-21; D-50, HG-07-03).
--  * `domains.registrars` gets the `dnet` row DISABLED: nothing is sold through it until an owner enables it AND an account is probed with live evidence.
--    There is no DNet adapter yet (its API documentation is not supplied): a probe answers `unsupported_capability`, never a made-up success.
--  * `registrar_accounts.settings` holds NON-SECRET connection settings an administrator types in the console (base URL, reseller id, timeout).
--    Credentials never live here: they are in the secret store and only the `vault_ref` is kept.
INSERT INTO domains.registrars (id, provider_code, title, contract_version, enabled)
  VALUES (gen_random_uuid(), 'dnet', 'DNet', '1.0.0', false)
  ON CONFLICT (provider_code) DO NOTHING;
ALTER TABLE domains.registrar_accounts
  ADD COLUMN settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object');
