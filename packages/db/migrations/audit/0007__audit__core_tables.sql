-- M01 S04: audit store. Append-only, per-chain SHA-256 hash chain computed INSIDE the database so the
-- application cannot forge or reorder links. Chain = one per organization, plus one platform chain for
-- events with no organization (chain_key = nil UUID). Signed checkpoints (audit_checkpoints) anchor each
-- chain head with a key held outside the database, so a DB-level rewrite of history is detectable.
-- Context GUCs: app.org_id (own-org reads/inserts), app.platform_scope='admin' (admin-console reads).
CREATE SCHEMA IF NOT EXISTS audit;
GRANT USAGE ON SCHEMA audit TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

-- Chain heads: private to the trigger/verifier functions. No runtime role has any grant on it.
CREATE TABLE audit.chain_heads (
  chain_key uuid PRIMARY KEY,
  last_seq bigint NOT NULL,
  last_hash text NOT NULL
);

CREATE TABLE audit.audit_logs (
  id uuid PRIMARY KEY,
  chain_key uuid NOT NULL,
  chain_seq bigint NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  org_id uuid,                                  -- target organization; NULL = platform chain
  acting_org_id uuid,                           -- organization the actor was acting from (delegation, M11)
  actor_type text NOT NULL CHECK (actor_type IN ('user','api_key','system','impersonator')),
  actor_user_id uuid,
  actor_api_key_id uuid,
  impersonator_user_id uuid,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$'), -- <domain>.<resource>.<action>
  resource_type text,
  resource_id text,
  outcome text NOT NULL CHECK (outcome IN ('success','failure')),
  trace_id text,
  ip_hash text,
  ua_hash text,
  before jsonb,
  after jsonb,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash text NOT NULL,
  hash text NOT NULL,
  UNIQUE (chain_key, chain_seq)
);
CREATE INDEX audit_logs_org_time_idx ON audit.audit_logs (org_id, occurred_at DESC, id DESC);
CREATE INDEX audit_logs_time_idx ON audit.audit_logs (occurred_at DESC, id DESC);
CREATE INDEX audit_logs_actor_idx ON audit.audit_logs (actor_user_id, occurred_at DESC);
CREATE INDEX audit_logs_action_idx ON audit.audit_logs (action, occurred_at DESC);

CREATE TABLE audit.audit_checkpoints (
  id uuid PRIMARY KEY,
  org_id uuid,                                  -- NULL = platform chain
  chain_key uuid NOT NULL,
  upto_seq bigint NOT NULL,
  head_hash text NOT NULL,
  key_ref text NOT NULL,                        -- vault reference of the signing key (D-12: dev stub until then)
  signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_key, upto_seq)
);

-- Canonical row hash: SHA-256 over a JSON array of every audited field (jsonb text form is canonical).
CREATE FUNCTION audit.row_hash(r audit.audit_logs) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(
    r.prev_hash, r.id, r.chain_key, r.chain_seq,
    to_char(r.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    r.org_id, r.acting_org_id, r.actor_type, r.actor_user_id, r.actor_api_key_id, r.impersonator_user_id,
    r.action, r.resource_type, r.resource_id, r.outcome, r.trace_id, r.ip_hash, r.ua_hash,
    r.before, r.after, r.detail)::text, 'UTF8')), 'hex')
$$;

-- Links each new row to its chain. SECURITY DEFINER so it can reach chain_heads (no runtime grants) without
-- widening what the caller may read. The row lock on the head serialises writers per chain.
CREATE FUNCTION audit.chain_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  k uuid := coalesce(NEW.org_id, '00000000-0000-0000-0000-000000000000'::uuid);
  h record;
BEGIN
  INSERT INTO audit.chain_heads (chain_key, last_seq, last_hash)
    VALUES (k, 0, repeat('0', 64)) ON CONFLICT (chain_key) DO NOTHING;
  SELECT last_seq, last_hash INTO h FROM audit.chain_heads WHERE chain_key = k FOR UPDATE;
  NEW.chain_key := k;
  NEW.chain_seq := h.last_seq + 1;
  NEW.prev_hash := h.last_hash;
  NEW.occurred_at := clock_timestamp();          -- never caller-supplied
  NEW.hash := audit.row_hash(NEW);
  UPDATE audit.chain_heads SET last_seq = NEW.chain_seq, last_hash = NEW.hash WHERE chain_key = k;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_logs_chain BEFORE INSERT ON audit.audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit.chain_before_insert();

-- Append-only: no UPDATE/DELETE/TRUNCATE, for anyone (including the table owner) while the triggers exist.
CREATE FUNCTION audit.deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit tables are append-only (% on %.%)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit.audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit.deny_mutation();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit.audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();
CREATE TRIGGER audit_checkpoints_no_update BEFORE UPDATE OR DELETE ON audit.audit_checkpoints
  FOR EACH ROW EXECUTE FUNCTION audit.deny_mutation();
CREATE TRIGGER audit_checkpoints_no_truncate BEFORE TRUNCATE ON audit.audit_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();

-- Chain verification: re-derives every hash and link, and compares the chain tip with chain_heads.
-- Returns one row; `ok` false names the first broken sequence and why. Scope: the caller's own org
-- chain, or any chain with app.platform_scope='admin' (verifier job / admin console).
CREATE FUNCTION audit.verify_chain(p_chain uuid)
RETURNS TABLE (ok boolean, checked bigint, first_bad_seq bigint, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r audit.audit_logs;
  expected_prev text := repeat('0', 64);
  expected_seq bigint := 1;
  n bigint := 0;
  head record;
BEGIN
  IF NOT (current_setting('app.platform_scope', true) = 'admin'
          OR p_chain = nullif(current_setting('app.org_id', true), '')::uuid) THEN
    RAISE EXCEPTION 'verify_chain: chain not in scope' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR r IN SELECT * FROM audit.audit_logs WHERE chain_key = p_chain ORDER BY chain_seq LOOP
    n := n + 1;
    IF r.chain_seq <> expected_seq THEN
      RETURN QUERY SELECT false, n, expected_seq, 'sequence gap (row missing or reordered)'; RETURN;
    END IF;
    IF r.prev_hash <> expected_prev THEN
      RETURN QUERY SELECT false, n, r.chain_seq, 'prev_hash does not match the previous row'; RETURN;
    END IF;
    IF r.hash <> audit.row_hash(r) THEN
      RETURN QUERY SELECT false, n, r.chain_seq, 'row content does not match its hash'; RETURN;
    END IF;
    expected_prev := r.hash;
    expected_seq := r.chain_seq + 1;
  END LOOP;
  SELECT last_seq, last_hash INTO head FROM audit.chain_heads WHERE chain_key = p_chain;
  IF FOUND AND (head.last_seq <> n OR head.last_hash <> expected_prev) THEN
    RETURN QUERY SELECT false, n, n + 1, 'chain tip does not match chain_heads (tail truncated?)'; RETURN;
  END IF;
  IF NOT FOUND AND n > 0 THEN
    RETURN QUERY SELECT false, n, 1::bigint, 'rows exist without a chain head'; RETURN;
  END IF;
  RETURN QUERY SELECT true, n, NULL::bigint, NULL::text;
END $$;

-- Chain tips (for the verifier/checkpoint job): platform scope only.
CREATE FUNCTION audit.chain_tips() RETURNS TABLE (chain_key uuid, last_seq bigint, last_hash text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_setting('app.platform_scope', true) IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'chain_tips: platform scope required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT h.chain_key, h.last_seq, h.last_hash FROM audit.chain_heads h ORDER BY h.chain_key;
END $$;
REVOKE ALL ON FUNCTION audit.verify_chain(uuid), audit.chain_tips() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.verify_chain(uuid), audit.chain_tips() TO nuzm_app, nuzm_worker;

-- RLS ---------------------------------------------------------------------------------------------------
ALTER TABLE audit.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_read ON audit.audit_logs FOR SELECT
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON audit.audit_logs FOR SELECT
  USING (current_setting('app.platform_scope', true) = 'admin');
-- Inserts must target exactly the context org; platform-chain rows (org_id NULL) need NO org context.
CREATE POLICY org_insert ON audit.audit_logs FOR INSERT
  WITH CHECK (org_id IS NOT DISTINCT FROM nullif(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE audit.audit_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.audit_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY org_read ON audit.audit_checkpoints FOR SELECT
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid
         OR current_setting('app.platform_scope', true) = 'admin');
CREATE POLICY checkpoint_insert ON audit.audit_checkpoints FOR INSERT
  WITH CHECK (org_id IS NOT DISTINCT FROM nullif(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.platform_scope', true) = 'admin');

GRANT SELECT, INSERT ON audit.audit_logs, audit.audit_checkpoints TO nuzm_app, nuzm_worker;
GRANT SELECT ON audit.audit_logs, audit.audit_checkpoints TO nuzm_admin_breakglass;
