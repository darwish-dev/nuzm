-- M08 S34: object storage. Buckets (tenant-scoped, namespaced `nz-<orgShort>-<name>`, private by default) and their access policy.
--  * `name_global` is unique across ALL organizations; the namespace makes a collision between organizations practically impossible and a collision is
--    answered with the same error as a name that is simply taken, so names of other organizations cannot be enumerated.
--  * `public` is false by default; making a bucket public is recorded (`public_confirmed_by/at`) and audited; the policy row carries the ETag.
--  * `credential_vault_ref` is the bucket-scoped credential (vault reference only). No shared admin key exists at runtime.
--  * System buckets (backup + replica per data_region, owned by the platform) are rows of the reserved system organization; no tenant can see them.
INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('data:storage:read','org','Read buckets, policies, lifecycle rules and usage'),
  ('data:storage:write','org','Create buckets, issue signed URLs for writing, change lifecycle rules'),
  ('data:storage:admin','org','Change access policies, make a bucket public, force-delete a bucket');
INSERT INTO tenancy.role_permissions VALUES
  ('owner','data:storage:read'),('admin','data:storage:read'),('billing_admin','data:storage:read'),('developer','data:storage:read'),('viewer','data:storage:read'),
  ('owner','data:storage:write'),('admin','data:storage:write'),('developer','data:storage:write'),
  ('owner','data:storage:admin'),('admin','data:storage:admin');

CREATE TABLE data.storage_buckets (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  name text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name_global text NOT NULL CHECK (name_global ~ '^[a-z0-9][a-z0-9-]{2,61}[a-z0-9]$'),
  system boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'provisioning' CHECK (state IN ('provisioning','active','failed','deleting','deleted','unknown')),
  endpoint text,
  versioning boolean NOT NULL DEFAULT false,
  public boolean NOT NULL DEFAULT false,
  public_confirmed_by uuid,
  public_confirmed_at timestamptz,
  lifecycle jsonb NOT NULL DEFAULT '[]'::jsonb,
  quota_bytes bigint CHECK (quota_bytes IS NULL OR quota_bytes >= 0),
  credential_vault_ref text CHECK (credential_vault_ref IS NULL OR credential_vault_ref ~ '^vault://[A-Za-z0-9][A-Za-z0-9._/-]{1,200}$'),
  data_region text NOT NULL,
  provider_region_id text NOT NULL,
  provider_id uuid,                              -- logical reference to data.data_providers
  provider_ref text,
  create_token text NOT NULL,
  quote_id uuid,
  order_id uuid,
  usage jsonb,                                   -- last usage import: {at, bytesStored, requests, egressBytes, available{requests, egress}}
  operation_id uuid,
  version_lock int NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK ((state = 'deleted') = (deleted_at IS NOT NULL)),
  CHECK (NOT public OR (public_confirmed_by IS NOT NULL AND public_confirmed_at IS NOT NULL)),
  CHECK (state <> 'active' OR (endpoint IS NOT NULL AND provider_ref IS NOT NULL))
);
-- the global name is unique while the bucket exists; a deleted bucket frees it
CREATE UNIQUE INDEX storage_buckets_name_global_idx ON data.storage_buckets (name_global) WHERE state <> 'deleted';
CREATE UNIQUE INDEX storage_buckets_org_name_idx ON data.storage_buckets (org_id, name) WHERE state <> 'deleted';
CREATE UNIQUE INDEX storage_buckets_token_idx ON data.storage_buckets (create_token);
CREATE INDEX storage_buckets_org_idx ON data.storage_buckets (org_id, created_at DESC, id);
CREATE FUNCTION data.storage_bucket_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'buckets are never deleted (state=deleted)' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.name <> OLD.name OR NEW.name_global <> OLD.name_global OR NEW.data_region <> OLD.data_region
     OR NEW.provider_region_id <> OLD.provider_region_id OR NEW.create_token <> OLD.create_token OR NEW.system <> OLD.system OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity, name and region of a bucket are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.state = 'deleted' THEN RAISE EXCEPTION 'a deleted bucket cannot change' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'provisioning' AND NEW.state IN ('active','failed','unknown','deleting'))
    OR (OLD.state = 'unknown' AND NEW.state IN ('provisioning','active','failed','deleting'))
    OR (OLD.state = 'active' AND NEW.state IN ('deleting','unknown','failed'))
    OR (OLD.state = 'failed' AND NEW.state IN ('deleting','deleted'))
    OR (OLD.state = 'deleting' AND NEW.state IN ('deleted','unknown','failed','active'))) THEN
    RAISE EXCEPTION 'illegal bucket state transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  NEW.version_lock := OLD.version_lock + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER storage_bucket_guard BEFORE UPDATE OR DELETE ON data.storage_buckets FOR EACH ROW EXECUTE FUNCTION data.storage_bucket_guard();
CREATE TRIGGER storage_bucket_no_truncate BEFORE TRUNCATE ON data.storage_buckets FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();
ALTER TABLE data.storage_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE data.storage_buckets FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON data.storage_buckets USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON data.storage_buckets FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON data.storage_buckets TO nuzm_app, nuzm_worker;
GRANT UPDATE (state, endpoint, versioning, public, public_confirmed_by, public_confirmed_at, lifecycle, quota_bytes, credential_vault_ref, provider_ref, quote_id, order_id, usage, operation_id, deleted_at)
  ON data.storage_buckets TO nuzm_app, nuzm_worker;
GRANT SELECT ON data.storage_buckets TO nuzm_readonly_reporting;

CREATE TABLE data.bucket_policies (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  bucket_id uuid NOT NULL REFERENCES data.storage_buckets(id),
  policy jsonb NOT NULL,
  etag text NOT NULL CHECK (etag ~ '^[0-9a-f]{16,64}$'),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket_id)
);
ALTER TABLE data.bucket_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE data.bucket_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON data.bucket_policies USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON data.bucket_policies FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT, UPDATE ON data.bucket_policies TO nuzm_app, nuzm_worker;
GRANT SELECT ON data.bucket_policies TO nuzm_readonly_reporting;
