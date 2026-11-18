-- M08 S32: data schema. Provider selection config (tenant-less, admin scope), managed database instances and backups.
--  * data.data_providers is the ONLY place a provider is turned on. A row can be enabled only with: verified_at, an evidence reference and, outside
--    environment=local, an ADR acceptance recorded by a human, `live` probe evidence and a second approver (CHECKs below, defense in depth; the service
--    checks the same rules first). Nothing is seeded: no provider row exists, so every managed-data feature answers 422 unsupported_capability.
--    Rows whose provider code starts with mock- or local- (dev-reference adapters) can only exist with environment=local and are refused by the service
--    when NODE_ENV=production.
--  * database_instances: connection secrets live in the vault (vault_ref only); `rotation` tracks the dual-credential window (rotation itself is a
--    platform.operations kind + audit: docs/05 lists no rotations table). A name is unique among live instances of an org.
--  * database_backups: where the artifact lives (`storage_ref`) is always inside the instance's own data_region; checksum + manifest let a restore be verified.
CREATE SCHEMA IF NOT EXISTS data;
GRANT USAGE ON SCHEMA data TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('data:db:read','org','Read managed databases, backups and restores'),
  ('data:db:write','org','Create managed databases, change their settings and take manual backups'),
  ('data:db:admin','org','Restore, rotate credentials, change backup policy and delete managed databases'),
  ('admin:data:read','platform','Read data provider selection, probes and the database fleet (metadata only)'),
  ('admin:data:manage','platform','Configure data providers and request enabling one'),
  ('admin:data:approve','platform','Approve enabling a data provider (second person) and record an ADR acceptance');
INSERT INTO tenancy.role_permissions VALUES
  ('owner','data:db:read'),('admin','data:db:read'),('billing_admin','data:db:read'),('developer','data:db:read'),('viewer','data:db:read'),
  ('owner','data:db:write'),('admin','data:db:write'),('developer','data:db:write'),
  ('owner','data:db:admin'),('admin','data:db:admin'),
  ('platform_admin','admin:data:read'),('support','admin:data:read'),('security','admin:data:read'),('compliance_officer','admin:data:read'),
  ('platform_admin','admin:data:manage'),
  ('platform_admin','admin:data:approve'),('security','admin:data:approve');

CREATE TABLE data.data_providers (
  id uuid PRIMARY KEY,
  service text NOT NULL CHECK (service IN ('database','cache','object-storage','transactional-email','mailbox')),
  family text NOT NULL CHECK (family ~ '^(provider|self-operated)-[a-z][a-z0-9-]{1,40}$'),
  provider_code text NOT NULL CHECK (provider_code ~ '^[a-z][a-z0-9-]{1,40}$'),
  provider_account_id text CHECK (provider_account_id IS NULL OR length(provider_account_id) BETWEEN 1 AND 200),   -- logical reference to cloud.provider_accounts (M05); no cross-schema FK
  environment text NOT NULL DEFAULT 'production' CHECK (environment IN ('local','staging','production')),
  enabled boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  evidence_ref text CHECK (evidence_ref IS NULL OR length(evidence_ref) BETWEEN 3 AND 300),
  adr_ref text CHECK (adr_ref IS NULL OR adr_ref ~ '^ADR-[0-9]{3}$'),
  adr_accepted_at timestamptz,
  adr_accepted_by uuid,
  probe jsonb,                                   -- {probedAt, evidenceKinds[], passed, capabilities{id: state}}: the last probe of the account
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by uuid,                             -- first person: asked to enable
  approved_by uuid,                              -- second person: approved enabling
  enabled_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (provider_code !~ '^(mock|local)-' OR environment = 'local'),
  CHECK (environment <> 'local' OR provider_code ~ '^(mock|local)-'),
  CHECK (NOT enabled OR (verified_at IS NOT NULL AND evidence_ref IS NOT NULL)),
  CHECK (NOT enabled OR environment = 'local' OR (adr_ref IS NOT NULL AND adr_accepted_at IS NOT NULL AND adr_accepted_by IS NOT NULL)),
  CHECK (NOT enabled OR environment = 'local' OR (probe IS NOT NULL AND (probe->>'passed') = 'true' AND probe->'evidenceKinds' @> '["live"]'::jsonb)),
  CHECK (NOT enabled OR environment = 'local' OR (requested_by IS NOT NULL AND approved_by IS NOT NULL AND requested_by <> approved_by)),
  CHECK (NOT enabled OR enabled_at IS NOT NULL)
);
CREATE UNIQUE INDEX data_providers_unique_idx ON data.data_providers (service, provider_code, coalesce(provider_account_id, ''));
CREATE INDEX data_providers_enabled_idx ON data.data_providers (service) WHERE enabled;
ALTER TABLE data.data_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE data.data_providers FORCE ROW LEVEL SECURITY;
-- tenant-less: the admin console scope reads and writes; runtime code resolves the enabled provider through the service
CREATE POLICY platform_all ON data.data_providers USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
CREATE POLICY worker_read ON data.data_providers FOR SELECT USING (coalesce(current_setting('app.worker_scope', true), '') = 'claim');
CREATE POLICY runtime_read_enabled ON data.data_providers FOR SELECT USING (enabled);
GRANT SELECT, INSERT, UPDATE ON data.data_providers TO nuzm_app, nuzm_worker;
GRANT SELECT ON data.data_providers TO nuzm_readonly_reporting;

CREATE TABLE data.database_instances (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid,
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{1,38}[a-z0-9]$'),
  engine text NOT NULL CHECK (engine IN ('postgresql','mysql','redis')),
  version text NOT NULL CHECK (version ~ '^[0-9]{1,3}(\.[0-9]{1,3}){0,2}$'),
  plan_ref text NOT NULL CHECK (length(plan_ref) BETWEEN 1 AND 100),
  storage_gb int NOT NULL DEFAULT 0 CHECK (storage_gb >= 0),
  state text NOT NULL DEFAULT 'provisioning' CHECK (state IN ('provisioning','running','failed','deleting','deleted','unknown')),
  host text,
  port int CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
  tls_required boolean NOT NULL DEFAULT true CHECK (tls_required),    -- TLS is not optional
  network jsonb NOT NULL DEFAULT '{"access":"private"}'::jsonb,
  vault_ref text CHECK (vault_ref IS NULL OR vault_ref ~ '^vault://[A-Za-z0-9][A-Za-z0-9._/-]{1,200}$'),
  data_region text NOT NULL,
  provider_region_id text NOT NULL,
  provider_id uuid,                              -- logical reference to data.data_providers (a provider row is never deleted)
  provider_ref text,
  create_token text NOT NULL,                    -- deterministic idempotency token of the create step: sha256(orgId|operationId|stepId)
  resource_id uuid,                              -- logical reference to cloud.resources (M05), set once the registry exists
  quote_id uuid,
  order_id uuid,
  backup_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  rotation jsonb,                                -- {state, role, newCredentialId, previousCredentialId, previousVaultRef, windowEndsAt, operationId}
  operation_id uuid,
  version_lock int NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK ((state = 'deleted') = (deleted_at IS NOT NULL)),
  CHECK (state NOT IN ('running') OR (host IS NOT NULL AND port IS NOT NULL AND vault_ref IS NOT NULL))
);
CREATE UNIQUE INDEX database_instances_name_idx ON data.database_instances (org_id, name) WHERE state <> 'deleted';
CREATE INDEX database_instances_org_idx ON data.database_instances (org_id, created_at DESC, id);
CREATE UNIQUE INDEX database_instances_token_idx ON data.database_instances (create_token);
CREATE FUNCTION data.database_instance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'database instances are never deleted (state=deleted)' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.engine <> OLD.engine OR NEW.data_region <> OLD.data_region OR NEW.provider_region_id <> OLD.provider_region_id
     OR NEW.create_token <> OLD.create_token OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity, engine and region of a database instance are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.state = 'deleted' THEN RAISE EXCEPTION 'a deleted database instance cannot change' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'provisioning' AND NEW.state IN ('running','failed','unknown','deleting'))
    OR (OLD.state = 'unknown' AND NEW.state IN ('provisioning','running','failed','deleting'))
    OR (OLD.state = 'running' AND NEW.state IN ('deleting','unknown','failed'))
    OR (OLD.state = 'failed' AND NEW.state IN ('deleting','deleted'))
    OR (OLD.state = 'deleting' AND NEW.state IN ('deleted','unknown','failed','running'))) THEN
    RAISE EXCEPTION 'illegal database state transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  NEW.version_lock := OLD.version_lock + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER database_instance_guard BEFORE UPDATE OR DELETE ON data.database_instances FOR EACH ROW EXECUTE FUNCTION data.database_instance_guard();
CREATE TRIGGER database_instance_no_truncate BEFORE TRUNCATE ON data.database_instances FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();
ALTER TABLE data.database_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE data.database_instances FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON data.database_instances USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON data.database_instances FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON data.database_instances TO nuzm_app, nuzm_worker;
GRANT UPDATE (name, state, host, port, network, vault_ref, provider_id, provider_ref, resource_id, quote_id, order_id, backup_policy, rotation, operation_id, project_id, deleted_at) ON data.database_instances TO nuzm_app, nuzm_worker;
GRANT SELECT ON data.database_instances TO nuzm_readonly_reporting;

CREATE TABLE data.database_backups (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  instance_id uuid NOT NULL REFERENCES data.database_instances(id),
  type text NOT NULL CHECK (type IN ('manual','scheduled','pre_restore','final')),
  state text NOT NULL DEFAULT 'creating' CHECK (state IN ('creating','available','failed','deleted','expired')),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  storage_ref text,
  checksum text CHECK (checksum IS NULL OR checksum ~ '^[0-9a-f]{64}$'),
  manifest jsonb,                                -- row counts and checksums of the sampled tables at backup time
  provider_backup_ref text,
  idempotency_token text NOT NULL,
  expires_at timestamptz,
  data_region text NOT NULL,
  operation_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'available' OR (storage_ref IS NOT NULL AND checksum IS NOT NULL AND size_bytes IS NOT NULL)),
  UNIQUE (instance_id, idempotency_token)
);
CREATE INDEX database_backups_instance_idx ON data.database_backups (org_id, instance_id, created_at DESC, id);
CREATE FUNCTION data.database_backup_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'backups are never deleted (state=deleted)' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.instance_id <> OLD.instance_id OR NEW.type <> OLD.type OR NEW.data_region <> OLD.data_region OR NEW.idempotency_token <> OLD.idempotency_token THEN
    RAISE EXCEPTION 'the identity of a backup is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.state IN ('deleted','expired','failed') AND NEW.state <> OLD.state THEN RAISE EXCEPTION 'a finished backup cannot change state' USING ERRCODE = 'check_violation', HINT = 'state_machine'; END IF;
  IF OLD.state = 'available' AND (NEW.checksum IS DISTINCT FROM OLD.checksum OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes OR NEW.storage_ref IS DISTINCT FROM OLD.storage_ref) THEN
    RAISE EXCEPTION 'an available backup is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER database_backup_guard BEFORE UPDATE OR DELETE ON data.database_backups FOR EACH ROW EXECUTE FUNCTION data.database_backup_guard();
CREATE TRIGGER database_backup_no_truncate BEFORE TRUNCATE ON data.database_backups FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();
ALTER TABLE data.database_backups ENABLE ROW LEVEL SECURITY;
ALTER TABLE data.database_backups FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON data.database_backups USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON data.database_backups FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON data.database_backups TO nuzm_app, nuzm_worker;
GRANT UPDATE (state, size_bytes, storage_ref, checksum, manifest, provider_backup_ref, expires_at, operation_id) ON data.database_backups TO nuzm_app, nuzm_worker;
GRANT SELECT ON data.database_backups TO nuzm_readonly_reporting;
