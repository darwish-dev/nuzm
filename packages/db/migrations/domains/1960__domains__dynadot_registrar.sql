-- Dynadot registrar entry (owner request 2026-11-24). DISABLED: nothing is sold through it until an administrator saves an account (admin console → Domains →
-- Registrars → Dynadot), probes it and enables it, and the probe's evidence is live (HG-07-01). Non-secret settings (timeout, search batch) live in
-- `registrar_accounts.settings` (added by 1900); credentials never do: they are in the sealed secret store and only the `vault_ref` is kept.
INSERT INTO domains.registrars (id, provider_code, title, contract_version, enabled)
  VALUES (gen_random_uuid(), 'dynadot', 'Dynadot', '1.0.0', false)
  ON CONFLICT (provider_code) DO NOTHING;
