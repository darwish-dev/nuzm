-- M07 S29: registrant contacts (PERSONAL data, sealed with the field cipher: AES-256-GCM bound to column and row) and transfer-in records.
--  * domain_contacts.payload_enc is a sealed value (`enc:v1:…`); a CHECK refuses anything else, so plaintext contact data cannot be stored by mistake.
--  * domain_transfers.auth_code_ref is a vault:// REFERENCE; the auth code itself never exists in this database (write-only API, vault).
--  * Rows follow the domain's lifecycle; contacts are deleted after the domain is released/failed per retention policy (D-34, registry-retention caveat HG-04-01).
CREATE TABLE domains.domain_contacts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  domain_id uuid NOT NULL REFERENCES domains.domains(id),
  role text NOT NULL CHECK (role IN ('registrant','admin','tech','billing')),
  payload_enc text NOT NULL CHECK (payload_enc ~ '^enc:v1:[A-Za-z0-9_-]{1,40}:[A-Za-z0-9_-]{38,}$'),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (domain_id, role)
);
CREATE INDEX domain_contacts_org_idx ON domains.domain_contacts (org_id, domain_id);

CREATE TABLE domains.domain_transfers (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  domain_id uuid REFERENCES domains.domains(id),
  order_id uuid REFERENCES domains.domain_orders(id),
  name text NOT NULL,
  registrar_account_id uuid NOT NULL REFERENCES domains.registrar_accounts(id),
  auth_code_ref text NOT NULL CHECK (auth_code_ref ~ '^vault://[A-Za-z0-9][A-Za-z0-9._/-]{1,200}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','in_progress','completed','failed','cancelled')),
  provider_ref text,
  failure_code text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((state IN ('completed','failed','cancelled')) = (completed_at IS NOT NULL))
);
CREATE INDEX domain_transfers_org_idx ON domains.domain_transfers (org_id, created_at DESC, id);
CREATE UNIQUE INDEX domain_transfers_active_name ON domains.domain_transfers (registrar_account_id, name) WHERE state IN ('pending','in_progress');

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['domain_contacts','domain_transfers'] LOOP
    EXECUTE format('ALTER TABLE domains.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE domains.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON domains.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
                      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY platform_read ON domains.%I FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON domains.%I TO nuzm_app', t);
    EXECUTE format('GRANT SELECT ON domains.%I TO nuzm_worker, nuzm_readonly_reporting', t);
  END LOOP;
END $$;
-- retention/DSR erase removes contact rows (never other rows)
GRANT DELETE ON domains.domain_contacts TO nuzm_app;
