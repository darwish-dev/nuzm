-- M04 S13b: record of processing activities (ROPA; docs/10 §3, M04 §4 task 4).
--  * Entries are VERSIONED and immutable: a change inserts version n+1; the current version of an entry_key is the highest. Nothing is updated or deleted.
--  * org_id is NULL for platform-level entries (the only kind the admin API writes in S13b). RLS: admin scope only.
--  * Seeded PLACEHOLDERS (status 'placeholder', created_by NULL): one per adapter kind of docs/09 §1 and one per platform activity, so that every adapter
--    kind and every data class in use has an entry from day one (AC-M04-04). Their contents are proposals for the DPO/counsel (HG-04-01, D-16): a
--    placeholder lists NO processor, because no provider has been chosen. `reviewed` needs a human reviewer id.
INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('admin:compliance:manage','platform','Maintain the compliance registers (ROPA, retention, legal holds, transfer assessments, controls, evidence)');
INSERT INTO tenancy.role_permissions VALUES
  ('compliance_officer','admin:compliance:manage'),
  ('platform_admin','admin:compliance:read'),('platform_admin','admin:compliance:manage'),
  ('security','admin:compliance:read');

CREATE TABLE compliance.ropa_entries (
  id uuid PRIMARY KEY,
  entry_key text NOT NULL CHECK (entry_key ~ '^[a-z][a-z0-9-]*(:[a-z0-9][a-z0-9-]*)?$' AND length(entry_key) <= 80),
  version int NOT NULL CHECK (version >= 1),
  org_id uuid,
  kind text NOT NULL CHECK (kind IN ('activity','adapter')),
  adapter_kind text CHECK (adapter_kind IS NULL OR adapter_kind ~ '^[a-z][a-z-]{1,40}$'),
  activity text NOT NULL CHECK (length(activity) BETWEEN 1 AND 200),
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 500),
  data_classes text[] NOT NULL CHECK (cardinality(data_classes) BETWEEN 1 AND 6),
  processors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(processors) = 'array' AND jsonb_array_length(processors) <= 50),
  regions text[] NOT NULL DEFAULT '{}',
  retention_ref text CHECK (retention_ref IS NULL OR length(retention_ref) BETWEEN 1 AND 100),
  status text NOT NULL CHECK (status IN ('placeholder','draft','reviewed')),
  reviewed_by uuid,
  change_note text CHECK (change_note IS NULL OR length(change_note) BETWEEN 1 AND 500),
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 255),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_key, version),
  CHECK ((kind = 'adapter') = (adapter_kind IS NOT NULL)),
  CHECK (status <> 'reviewed' OR reviewed_by IS NOT NULL)
);
CREATE UNIQUE INDEX ropa_idem_idx ON compliance.ropa_entries (entry_key, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX ropa_list_idx ON compliance.ropa_entries (created_at DESC, id);

CREATE FUNCTION compliance.ropa_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bad text;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'ROPA entries are versioned: insert a new version instead' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  -- every data class (entry and each processor) must exist in the catalogue
  SELECT c INTO bad FROM unnest(NEW.data_classes) c WHERE NOT EXISTS (SELECT 1 FROM compliance.data_classes d WHERE d.key = c) LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'unknown data class %', bad USING ERRCODE = 'check_violation'; END IF;
  SELECT c INTO bad FROM jsonb_array_elements(NEW.processors) p, jsonb_array_elements_text(coalesce(p->'dataClasses','[]'::jsonb)) c
    WHERE NOT EXISTS (SELECT 1 FROM compliance.data_classes d WHERE d.key = c) LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'unknown data class % in a processor', bad USING ERRCODE = 'check_violation'; END IF;
  -- versions are contiguous per entry; kind and adapter kind never change
  IF NEW.version = 1 THEN
    IF EXISTS (SELECT 1 FROM compliance.ropa_entries WHERE entry_key = NEW.entry_key) THEN
      RAISE EXCEPTION 'entry % already exists', NEW.entry_key USING ERRCODE = 'unique_violation';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM compliance.ropa_entries WHERE entry_key = NEW.entry_key AND version = NEW.version - 1
                    AND kind = NEW.kind AND adapter_kind IS NOT DISTINCT FROM NEW.adapter_kind AND org_id IS NOT DISTINCT FROM NEW.org_id) THEN
      RAISE EXCEPTION 'version % of % must follow version % with the same kind', NEW.version, NEW.entry_key, NEW.version - 1 USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ropa_insert_guard BEFORE INSERT ON compliance.ropa_entries FOR EACH ROW EXECUTE FUNCTION compliance.ropa_guard();
CREATE TRIGGER ropa_immutable BEFORE UPDATE OR DELETE ON compliance.ropa_entries FOR EACH ROW EXECUTE FUNCTION compliance.ropa_guard();
CREATE TRIGGER ropa_no_truncate BEFORE TRUNCATE ON compliance.ropa_entries FOR EACH STATEMENT EXECUTE FUNCTION compliance.ropa_guard();

ALTER TABLE compliance.ropa_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance.ropa_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_admin ON compliance.ropa_entries USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON compliance.ropa_entries TO nuzm_app, nuzm_worker;
GRANT SELECT ON compliance.ropa_entries TO nuzm_readonly_reporting;

-- PLACEHOLDERS: no processor is named (no provider has been chosen); the DPO / counsel completes them (HG-04-01, D-16).
INSERT INTO compliance.ropa_entries (id, entry_key, version, kind, adapter_kind, activity, purpose, data_classes, regions, status, change_note) VALUES
  (gen_random_uuid(),'adapter:compute',1,'adapter','compute','Compute provider (virtual servers)','Provision and operate customer virtual servers at a compute provider','{customer-content,internal}','{}','placeholder','seeded placeholder'),
  (gen_random_uuid(),'adapter:hosting',1,'adapter','hosting','Hosting nodes (CloudPanel)','Host customer websites on Nuzm-operated nodes','{customer-content,internal}','{}','placeholder','seeded placeholder'),
  (gen_random_uuid(),'adapter:registrar',1,'adapter','registrar','Domain registrar','Register and manage domains for customers (registrant contact data goes to the registrar)','{personal,internal}','{}','placeholder','seeded placeholder'),
  (gen_random_uuid(),'adapter:database',1,'adapter','database','Managed database provider','Operate customer databases','{customer-content,credentials}','{}','placeholder','seeded placeholder'),
  (gen_random_uuid(),'adapter:cache',1,'adapter','cache','Managed cache provider','Operate customer caches','{customer-content}','{}','placeholder','seeded placeholder'),
  (gen_random_uuid(),'adapter:object-storage',1,'adapter','object-storage','Object storage provider','Store customer files and backups','{customer-content}','{}','placeholder','seeded placeholder'),
  (gen_random_uuid(),'adapter:transactional-email',1,'adapter','transactional-email','Transactional email vendor','Send account and service emails (recipient addresses and message content go to the vendor)','{personal}','{}','placeholder','seeded placeholder'),
  (gen_random_uuid(),'adapter:mailbox',1,'adapter','mailbox','Mailbox provider','Provision customer mailboxes','{personal,customer-content}','{}','placeholder','seeded placeholder'),
  (gen_random_uuid(),'adapter:psp',1,'adapter','psp','Payment service provider','Collect payments and refunds (card data is entered at the provider, never at Nuzm)','{financial,personal}','{}','placeholder','seeded placeholder'),
  (gen_random_uuid(),'adapter:einvoice',1,'adapter','einvoice','E-invoicing (ZATCA) provider','Clear and report tax invoices with the tax authority (regulator-mandated)','{financial,personal}','{}','placeholder','seeded placeholder'),
  (gen_random_uuid(),'adapter:model',1,'adapter','model','AI model provider','Run customer prompts and content through AI models','{customer-content,personal}','{}','placeholder','seeded placeholder'),
  (gen_random_uuid(),'activity:identity-and-access',1,'activity',NULL,'Accounts, sign-in and security','Authenticate users, protect accounts and keep security records','{personal,credentials,internal}','{}','placeholder','seeded placeholder'),
  (gen_random_uuid(),'activity:organizations-and-projects',1,'activity',NULL,'Organizations, projects and team management','Let customers organise their teams, projects and environments','{customer-content,personal,internal}','{}','placeholder','seeded placeholder'),
  (gen_random_uuid(),'activity:billing-and-invoicing',1,'activity',NULL,'Billing, payments and tax invoicing','Rate usage, invoice customers, collect payment and meet tax obligations','{financial,personal}','{}','placeholder','seeded placeholder'),
  (gen_random_uuid(),'activity:audit-and-security-logging',1,'activity',NULL,'Audit trail and security logging','Record who did what for accountability and incident response','{personal,internal}','{}','placeholder','seeded placeholder'),
  (gen_random_uuid(),'activity:public-information',1,'activity',NULL,'Public catalogue and documentation','Publish plans, prices and documentation','{public}','{}','placeholder','seeded placeholder');
