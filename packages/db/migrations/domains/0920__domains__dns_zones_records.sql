-- M07 S30: DNS zones and records (hosted by the registrar adapter's `dns` capability only; no Nuzm authoritative DNS in this milestone).
--  * Our copy of the zone is authoritative for what the customer sees and for validation; the registrar's copy is what is live. A change-set is applied
--    through the adapter and VERIFIED by re-reading before this copy changes (snapshot/rollback when the adapter is not atomic).
--  * dns_zones.version is the optimistic-concurrency ETag; `degraded` marks a zone whose rollback could not be verified (a reconcile is open).
--  * dns_records.managed_by says who owns a record: `user`, `linkage` (DnsLinkagePort: hosting) or `email-verification` (M08); users cannot edit the others.
CREATE TABLE domains.dns_zones (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  domain_id uuid NOT NULL REFERENCES domains.domains(id),
  name text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('creating','active','degraded','failed')),
  version int NOT NULL DEFAULT 1,
  provider_zone_ref text,
  degraded boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (domain_id),
  CHECK (degraded = (state = 'degraded'))
);
CREATE INDEX dns_zones_org_idx ON domains.dns_zones (org_id, created_at DESC, id);

CREATE TABLE domains.dns_records (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  zone_id uuid NOT NULL REFERENCES domains.dns_zones(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 253),
  type text NOT NULL CHECK (type IN ('A','AAAA','CNAME','MX','TXT','SRV','CAA','NS')),
  ttl int NOT NULL CHECK (ttl BETWEEN 60 AND 86400),
  value jsonb NOT NULL,
  value_hash text NOT NULL CHECK (length(value_hash) = 64),
  managed_by text NOT NULL DEFAULT 'user' CHECK (managed_by IN ('user','linkage','email-verification')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (zone_id, name, type, value_hash)
);
CREATE INDEX dns_records_lookup_idx ON domains.dns_records (zone_id, name, type);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['dns_zones','dns_records'] LOOP
    EXECUTE format('ALTER TABLE domains.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE domains.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON domains.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
                      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY platform_read ON domains.%I FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON domains.%I TO nuzm_app', t);
    EXECUTE format('GRANT SELECT ON domains.%I TO nuzm_worker, nuzm_readonly_reporting', t);
  END LOOP;
END $$;
GRANT DELETE ON domains.dns_records TO nuzm_app;
