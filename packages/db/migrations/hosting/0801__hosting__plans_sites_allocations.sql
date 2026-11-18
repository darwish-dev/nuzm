-- M06 S24/S25: plan catalogue, sites, capacity allocations and the capacity invariant trigger (M06 §7).
--  * plan_definitions: tenant-less catalogue (PLACEHOLDER prices until the owner publishes real ones; D-xx/HG-03-04). Readable by every runtime role, written from the admin scope only.
--  * sites: one row per customer site (org_id + RLS forced). `node_name` = the site name ON the node (`s-<token prefix>`): the reconcile key of findByToken.
--  * site_allocations: what a site reserves on its node, per dimension (tenant-less, admin scope only: customers never read node data).
--  * The deferred trigger below makes `node_capacity.reserved` EQUAL the sum of the allocations of the node at every COMMIT, in addition to the CHECK
--    reserved <= sellable: a bug in the application can neither oversell a node nor leak a reservation without the transaction failing.
CREATE TABLE hosting.plan_definitions (
  id uuid PRIMARY KEY,
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9][a-z0-9_-]{1,40}$'),
  name_ar text NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 100),
  name_en text NOT NULL CHECK (length(name_en) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  quotas jsonb NOT NULL CHECK (jsonb_typeof(quotas) = 'object'),
  runtimes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(runtimes) = 'array'),
  reservation jsonb NOT NULL CHECK (jsonb_typeof(reservation) = 'object'),
  price_minor bigint CHECK (price_minor IS NULL OR price_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'SAR',
  placeholder boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE hosting.plan_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosting.plan_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY plan_read ON hosting.plan_definitions FOR SELECT USING (true);
CREATE POLICY platform_admin ON hosting.plan_definitions USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin') WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT ON hosting.plan_definitions TO nuzm_app, nuzm_worker, nuzm_readonly_reporting;
GRANT INSERT, UPDATE ON hosting.plan_definitions TO nuzm_app;

CREATE TABLE hosting.sites (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid,
  environment_id uuid,
  name text NOT NULL CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$'),
  token text NOT NULL UNIQUE CHECK (token ~ '^[0-9a-f]{64}$'),
  node_name text NOT NULL UNIQUE CHECK (node_name ~ '^s-[a-z0-9]{12,40}$'),
  plan_id uuid NOT NULL REFERENCES hosting.plan_definitions(id),
  runtime text NOT NULL CHECK (runtime ~ '^((php|nodejs|python):[0-9]{1,2}(\.[0-9]{1,2})?|static|reverse-proxy)$'),
  status text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','active','suspended','restoring','deleting','deleted','failed')),
  suspension_reason text CHECK (suspension_reason IS NULL OR length(suspension_reason) <= 200),
  suspended_by text CHECK (suspended_by IS NULL OR suspended_by IN ('admin','abuse','dunning','quota')),
  data_region text NOT NULL CHECK (data_region ~ '^[A-Za-z0-9._-]{2,40}$'),
  node_id uuid REFERENCES hosting.nodes(id),
  site_user text CHECK (site_user IS NULL OR length(site_user) <= 40),
  domain_primary text,
  credentials_ref text CHECK (credentials_ref IS NULL OR credentials_ref ~ '^vault://'),
  backup_key_ref text CHECK (backup_key_ref IS NULL OR backup_key_ref ~ '^vault://'),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  quote_id uuid,
  operation_id uuid,
  failure_reason text CHECK (failure_reason IS NULL OR length(failure_reason) <= 300),
  deletion_requested_at timestamptz,
  deleted_at timestamptz,
  export_until timestamptz,
  version int NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'suspended') = (suspended_by IS NOT NULL)),
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);
CREATE UNIQUE INDEX sites_org_name_idx ON hosting.sites (org_id, lower(name)) WHERE status <> 'deleted';
CREATE INDEX sites_org_list_idx ON hosting.sites (org_id, created_at DESC, id);
CREATE INDEX sites_node_idx ON hosting.sites (node_id) WHERE status <> 'deleted';
CREATE UNIQUE INDEX sites_quote_idx ON hosting.sites (org_id, quote_id) WHERE quote_id IS NOT NULL;
ALTER TABLE hosting.sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosting.sites FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON hosting.sites USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_admin ON hosting.sites USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin') WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
CREATE POLICY worker_claim ON hosting.sites FOR SELECT USING (coalesce(current_setting('app.worker_scope', true), '') = 'claim');
GRANT SELECT, INSERT, UPDATE ON hosting.sites TO nuzm_app, nuzm_worker;
GRANT SELECT ON hosting.sites TO nuzm_readonly_reporting;

CREATE TABLE hosting.site_allocations (
  site_id uuid PRIMARY KEY REFERENCES hosting.sites(id),
  node_id uuid NOT NULL REFERENCES hosting.nodes(id),
  cpu_millicores bigint NOT NULL CHECK (cpu_millicores >= 0),
  memory_mb bigint NOT NULL CHECK (memory_mb >= 0),
  disk_mb bigint NOT NULL CHECK (disk_mb >= 0),
  sites bigint NOT NULL DEFAULT 1 CHECK (sites = 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX site_allocations_node_idx ON hosting.site_allocations (node_id);
ALTER TABLE hosting.site_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosting.site_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_admin ON hosting.site_allocations USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin') WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT, UPDATE, DELETE ON hosting.site_allocations TO nuzm_app, nuzm_worker;
GRANT SELECT ON hosting.site_allocations TO nuzm_readonly_reporting;

-- reserved = the sum of the allocations, checked at COMMIT for every node touched in the transaction
CREATE FUNCTION hosting.check_node_reserved(p_node uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.dim, c.reserved,
           CASE c.dim WHEN 'cpu_millicores' THEN coalesce(sum(a.cpu_millicores),0) WHEN 'memory_mb' THEN coalesce(sum(a.memory_mb),0)
                      WHEN 'disk_mb' THEN coalesce(sum(a.disk_mb),0) WHEN 'sites' THEN coalesce(sum(a.sites),0) END AS allocated
      FROM hosting.node_capacity c LEFT JOIN hosting.site_allocations a ON a.node_id = c.node_id
     WHERE c.node_id = p_node GROUP BY c.dim, c.reserved
  LOOP
    IF r.reserved <> r.allocated THEN
      RAISE EXCEPTION 'capacity ledger broken on node %: % reserved % but allocated %', p_node, r.dim, r.reserved, r.allocated USING ERRCODE = 'check_violation', HINT = 'reservation_mismatch';
    END IF;
  END LOOP;
  -- allocations on a node that has no capacity rows are never legal
  IF EXISTS (SELECT 1 FROM hosting.site_allocations a WHERE a.node_id = p_node) AND NOT EXISTS (SELECT 1 FROM hosting.node_capacity c WHERE c.node_id = p_node) THEN
    RAISE EXCEPTION 'allocations exist for node % without capacity rows', p_node USING ERRCODE = 'check_violation', HINT = 'reservation_mismatch';
  END IF;
END $$;
CREATE FUNCTION hosting.check_reserved_trg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('INSERT','UPDATE') THEN PERFORM hosting.check_node_reserved(NEW.node_id); END IF;
  IF TG_OP IN ('UPDATE','DELETE') AND (TG_OP = 'DELETE' OR OLD.node_id <> NEW.node_id) THEN PERFORM hosting.check_node_reserved(OLD.node_id); END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER site_allocations_reserved AFTER INSERT OR UPDATE OR DELETE ON hosting.site_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hosting.check_reserved_trg();
CREATE CONSTRAINT TRIGGER node_capacity_reserved AFTER INSERT OR UPDATE OF reserved ON hosting.node_capacity DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hosting.check_reserved_trg();
