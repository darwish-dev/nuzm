-- M11 S54: partner programs. AGENCY = delegated ACCESS (scoped, time-boxed, client-controlled); RESELLER = COMMERCIAL structure (sub-organizations, price rules, statements). Separate models.
--  * agency_clients / delegated_access are visible and changeable from BOTH sides: the agency organization (org_id) and the client organization (client_org_id). Two policies say so;
--    a trigger enforces WHO may make WHICH transition: the agency proposes (pending) and may withdraw or revoke; only the CLIENT accepts, declines or revokes its side. The client
--    can revoke at any time. Scopes, client and expiry never change after the row exists (a different grant = a new row), and expires_at is mandatory and at most 365 days after
--    the grant was accepted (CHECK).
--  * Impersonation of client USERS does not exist here: a grant carries permission scopes, never a user identity.
--  * reseller_statements are immutable snapshots per (reseller, period, currency).
CREATE SCHEMA IF NOT EXISTS programs;
GRANT USAGE ON SCHEMA programs TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('agency:manage','org','Manage the agency profile, client links and delegated access requests'),
  ('agency:finance','org','View consolidated billing of the agency clients'),
  ('partners:manage','org','Client side: accept, decline and revoke agency links, delegated access and reseller links'),
  ('reseller:manage','org','Manage the reseller profile and sub-organizations'),
  ('reseller:pricing','org','Edit reseller price rules'),
  ('reseller:finance','org','View reseller statements'),
  ('admin:programs','platform','Oversee agencies and resellers (suspend, review)');
INSERT INTO tenancy.role_permissions VALUES
  ('owner','agency:manage'),('admin','agency:manage'),
  ('owner','agency:finance'),('admin','agency:finance'),('billing_admin','agency:finance'),
  ('owner','partners:manage'),('admin','partners:manage'),
  ('owner','reseller:manage'),('admin','reseller:manage'),
  ('owner','reseller:pricing'),('admin','reseller:pricing'),
  ('owner','reseller:finance'),('admin','reseller:finance'),('billing_admin','reseller:finance'),
  ('platform_admin','admin:programs'),('support','admin:programs');

CREATE TABLE programs.agencies (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL UNIQUE,                            -- the agency-type organization
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  consolidated_billing boolean NOT NULL DEFAULT false,    -- opt-in view
  created_by uuid,
  version_lock int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION programs.touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity of a program row is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  NEW.version_lock := OLD.version_lock + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER agencies_touch BEFORE UPDATE ON programs.agencies FOR EACH ROW EXECUTE FUNCTION programs.touch();

CREATE TABLE programs.agency_clients (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,                                   -- the AGENCY organization
  agency_id uuid NOT NULL REFERENCES programs.agencies(id),
  client_org_id uuid NOT NULL,                            -- logical reference: an unknown id stays pending forever (no existence oracle)
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','revoked','declined')),
  invited_by uuid,
  accepted_by uuid,
  accepted_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  version_lock int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (org_id <> client_org_id),
  CHECK ((status = 'active') = (accepted_at IS NOT NULL AND accepted_by IS NOT NULL AND revoked_at IS NULL) OR status IN ('revoked','declined')),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX agency_clients_live_idx ON programs.agency_clients (agency_id, client_org_id) WHERE status IN ('pending','active');
CREATE INDEX agency_clients_client_idx ON programs.agency_clients (client_org_id, created_at DESC);
CREATE INDEX agency_clients_agency_idx ON programs.agency_clients (org_id, created_at DESC, id);

CREATE TABLE programs.delegated_access (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,                                   -- the AGENCY organization
  agency_id uuid NOT NULL REFERENCES programs.agencies(id),
  client_org_id uuid NOT NULL,
  scopes text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 60),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','revoked','expired','declined')),
  proposed_by uuid,
  granted_by uuid,                                        -- the client administrator who accepted
  granted_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  version_lock int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (org_id <> client_org_id),
  CHECK (expires_at <= coalesce(granted_at, created_at) + interval '365 days'),
  CHECK (expires_at > created_at),
  CHECK ((status = 'active') = (granted_at IS NOT NULL AND granted_by IS NOT NULL AND revoked_at IS NULL) OR status IN ('revoked','expired')),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX delegated_access_lookup_idx ON programs.delegated_access (org_id, client_org_id, status);
CREATE INDEX delegated_access_client_idx ON programs.delegated_access (client_org_id, created_at DESC);

-- who may do which transition (the side is decided by the organization context of the transaction)
CREATE FUNCTION programs.link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE side text; ctx uuid := nullif(current_setting('app.org_id', true), '')::uuid; plat boolean := coalesce(current_setting('app.platform_scope', true), '') = 'admin';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN RAISE EXCEPTION 'a link starts pending' USING ERRCODE = 'check_violation', HINT = 'invalid_state'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.client_org_id <> OLD.client_org_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the parties of a link are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF TG_TABLE_NAME = 'delegated_access' THEN
    -- (a nested IF: the statement naming NEW.scopes is only planned when this table is the one being updated)
    IF NEW.scopes <> OLD.scopes OR NEW.expires_at <> OLD.expires_at OR NEW.agency_id <> OLD.agency_id THEN
      RAISE EXCEPTION 'scopes and expiry of a grant never change; issue a new grant' USING ERRCODE = 'check_violation', HINT = 'immutable';
    END IF;
  END IF;
  side := CASE WHEN ctx = OLD.client_org_id THEN 'client' WHEN ctx = OLD.org_id THEN 'agency' WHEN plat THEN 'platform' ELSE 'system' END;
  IF NEW.status <> OLD.status THEN
    IF OLD.status IN ('revoked','declined','expired') THEN RAISE EXCEPTION 'the link is closed' USING ERRCODE = 'check_violation', HINT = 'invalid_state'; END IF;
    IF NEW.status IN ('active','declined') AND (OLD.status <> 'pending' OR side NOT IN ('client')) THEN
      RAISE EXCEPTION 'only the client organization accepts or declines a pending link' USING ERRCODE = 'check_violation', HINT = 'forbidden_transition';
    END IF;
    IF NEW.status = 'revoked' AND side NOT IN ('client','agency','platform') THEN
      RAISE EXCEPTION 'only a party can revoke' USING ERRCODE = 'check_violation', HINT = 'forbidden_transition';
    END IF;
    IF NEW.status = 'expired' AND NOT (OLD.status = 'active' OR OLD.status = 'pending') THEN
      RAISE EXCEPTION 'invalid transition' USING ERRCODE = 'check_violation', HINT = 'invalid_state';
    END IF;
  END IF;
  NEW.version_lock := OLD.version_lock + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER agency_clients_guard BEFORE INSERT OR UPDATE ON programs.agency_clients FOR EACH ROW EXECUTE FUNCTION programs.link_guard();
CREATE TRIGGER delegated_access_guard BEFORE INSERT OR UPDATE ON programs.delegated_access FOR EACH ROW EXECUTE FUNCTION programs.link_guard();

CREATE TABLE programs.resellers (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL UNIQUE,                            -- the reseller-type organization
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  currency char(3) NOT NULL DEFAULT 'SAR' CHECK (currency ~ '^[A-Z]{3}$'),
  created_by uuid,
  version_lock int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER resellers_touch BEFORE UPDATE ON programs.resellers FOR EACH ROW EXECUTE FUNCTION programs.touch();

CREATE TABLE programs.reseller_sub_orgs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,                                   -- the RESELLER organization
  reseller_id uuid NOT NULL REFERENCES programs.resellers(id),
  sub_org_id uuid NOT NULL,                               -- logical reference to the sub-organization (it accepts the link)
  price_book_ref text CHECK (price_book_ref IS NULL OR length(price_book_ref) <= 200),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','removed','declined')),
  invited_by uuid,
  accepted_by uuid,
  accepted_at timestamptz,
  version_lock int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (org_id <> sub_org_id),
  CHECK ((status = 'active') = (accepted_at IS NOT NULL) OR status IN ('removed'))
);
-- an organization belongs to at most one reseller at a time
CREATE UNIQUE INDEX reseller_sub_orgs_live_idx ON programs.reseller_sub_orgs (sub_org_id) WHERE status IN ('pending','active');
CREATE INDEX reseller_sub_orgs_reseller_idx ON programs.reseller_sub_orgs (org_id, created_at DESC, id);
CREATE FUNCTION programs.sub_org_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ctx uuid := nullif(current_setting('app.org_id', true), '')::uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN RAISE EXCEPTION 'a sub-organization link starts pending' USING ERRCODE = 'check_violation', HINT = 'invalid_state'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.sub_org_id <> OLD.sub_org_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the parties of a link are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF NEW.status <> OLD.status AND NEW.status IN ('active','declined') AND (OLD.status <> 'pending' OR ctx IS DISTINCT FROM OLD.sub_org_id) THEN
    RAISE EXCEPTION 'only the sub-organization accepts or declines the link' USING ERRCODE = 'check_violation', HINT = 'forbidden_transition';
  END IF;
  IF NEW.status <> OLD.status AND OLD.status IN ('removed','declined') THEN
    RAISE EXCEPTION 'the link is closed' USING ERRCODE = 'check_violation', HINT = 'invalid_state';
  END IF;
  NEW.version_lock := OLD.version_lock + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER sub_org_guard BEFORE INSERT OR UPDATE ON programs.reseller_sub_orgs FOR EACH ROW EXECUTE FUNCTION programs.sub_org_guard();

CREATE TABLE programs.reseller_statements (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,                                   -- the RESELLER organization
  reseller_id uuid NOT NULL REFERENCES programs.resellers(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  wholesale_minor bigint NOT NULL CHECK (wholesale_minor >= 0),
  retail_minor bigint NOT NULL CHECK (retail_minor >= 0),
  margin_minor bigint NOT NULL,
  tax_minor bigint NOT NULL CHECK (tax_minor >= 0),
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,              -- per sub-organization and meter; no customer content
  rule_set_version int,
  issuer_model text NOT NULL DEFAULT 'disabled' CHECK (issuer_model IN ('disabled','platform_issues_wholesale','reseller_issues_own')),
  ledger_wholesale_minor bigint,                         -- what the ledger shows for the same sub-organizations and period (variance check)
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reseller_id, period_start, currency),
  CHECK (margin_minor = retail_minor - wholesale_minor)
);
CREATE TRIGGER statements_immutable BEFORE UPDATE OR DELETE ON programs.reseller_statements FOR EACH ROW EXECUTE FUNCTION automation.immutable_row();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['agencies','agency_clients','delegated_access','resellers','reseller_sub_orgs','reseller_statements'] LOOP
    EXECUTE format('ALTER TABLE programs.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE programs.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON programs.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY platform_read ON programs.%I FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT, INSERT ON programs.%I TO nuzm_app, nuzm_worker', t);
    EXECUTE format('GRANT SELECT ON programs.%I TO nuzm_readonly_reporting', t);
  END LOOP;
END $$;
-- the CLIENT side of a link / grant (and the sub-organization side of a reseller link): read and answer; the guard trigger limits what an answer may be
CREATE POLICY client_side ON programs.agency_clients FOR SELECT USING (client_org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY client_answer ON programs.agency_clients FOR UPDATE USING (client_org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (client_org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY client_side ON programs.delegated_access FOR SELECT USING (client_org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY client_answer ON programs.delegated_access FOR UPDATE USING (client_org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (client_org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY sub_org_side ON programs.reseller_sub_orgs FOR SELECT USING (sub_org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY sub_org_answer ON programs.reseller_sub_orgs FOR UPDATE USING (sub_org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (sub_org_id = nullif(current_setting('app.org_id', true), '')::uuid);
-- a client organization can read the PROFILE (id, name, status) of an agency that holds a link to it: it needs the id and name to answer the invitation
CREATE POLICY linked_client_read ON programs.agencies FOR SELECT USING (EXISTS (SELECT 1 FROM programs.agency_clients ac WHERE ac.agency_id = agencies.id AND ac.client_org_id = nullif(current_setting('app.org_id', true), '')::uuid));
CREATE POLICY linked_sub_org_read ON programs.resellers FOR SELECT USING (EXISTS (SELECT 1 FROM programs.reseller_sub_orgs so WHERE so.reseller_id = resellers.id AND so.sub_org_id = nullif(current_setting('app.org_id', true), '')::uuid));
-- the admin console may suspend a program profile and revoke a link
CREATE POLICY platform_suspend ON programs.agencies FOR UPDATE USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin') WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
CREATE POLICY platform_suspend ON programs.resellers FOR UPDATE USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin') WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
CREATE POLICY platform_revoke ON programs.delegated_access FOR UPDATE USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin') WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT UPDATE (name, status, consolidated_billing) ON programs.agencies TO nuzm_app, nuzm_worker;
GRANT UPDATE (status, accepted_by, accepted_at, revoked_at, revoked_by) ON programs.agency_clients TO nuzm_app, nuzm_worker;
GRANT UPDATE (status, granted_by, granted_at, revoked_at, revoked_by) ON programs.delegated_access TO nuzm_app, nuzm_worker;
GRANT UPDATE (name, status) ON programs.resellers TO nuzm_app, nuzm_worker;
GRANT UPDATE (status, price_book_ref, accepted_by, accepted_at) ON programs.reseller_sub_orgs TO nuzm_app, nuzm_worker;
