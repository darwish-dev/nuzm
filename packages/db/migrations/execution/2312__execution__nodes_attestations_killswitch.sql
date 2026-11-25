-- P3-S02 durable stores, part 3: the node registry, attestation PUBLIC records and the kill-switch history.
--  * runtime_nodes and attestations are PLATFORM data (no org_id; admin scope only). They hold PUBLIC facts only: ids, labels, dates, digests, the reviewer's name and review reference.
--    NO key material, no signed JSON body (the signed attestation is evidence stored by the owner; the verifier still runs on every service start and every use).
--  * kill_switch is an append-only HISTORY of engage/release events; the current state of a scope is its latest row. A global row has org_id NULL; an org row is visible to that
--    organization (it must know it is stopped) and to the platform; only the platform scope may write a global row.
CREATE TABLE execution.runtime_nodes (
  id uuid PRIMARY KEY,
  node_id text NOT NULL UNIQUE CHECK (node_id ~ '^[a-z0-9-]{3,40}$'),
  endpoint_id text NOT NULL CHECK (length(endpoint_id) BETWEEN 1 AND 60),
  environment text NOT NULL CHECK (environment IN ('staging','production')),
  runtime_class text NOT NULL CHECK (runtime_class IN ('gvisor-runsc','kata-qemu','kata-firecracker','firecracker-microvm')),
  state text NOT NULL DEFAULT 'admitted' CHECK (state IN ('admitted','quarantined','dropped','retired')),
  quarantine_reason text CHECK (quarantine_reason IS NULL OR length(quarantine_reason) <= 80),
  admitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE execution.attestations (
  id uuid PRIMARY KEY,
  attestation_id text NOT NULL UNIQUE CHECK (length(attestation_id) BETWEEN 1 AND 120),
  node_id text NOT NULL CHECK (length(node_id) <= 40),
  label text NOT NULL CHECK (label IN ('LIVE-VERIFIED','SIMULATED','NOT VERIFIED')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  report_sha256 text NOT NULL CHECK (report_sha256 ~ '^[0-9a-f]{64}$'),
  reviewer text NOT NULL CHECK (length(reviewer) BETWEEN 1 AND 120),
  review_ref text NOT NULL CHECK (length(review_ref) BETWEEN 1 AND 120),
  evidence_ref text CHECK (evidence_ref IS NULL OR length(evidence_ref) <= 300),
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 80),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > issued_at),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX attestations_node_idx ON execution.attestations (node_id, expires_at DESC);
-- a recorded attestation never changes except to be revoked (once)
CREATE FUNCTION execution.attestation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'revoked_at' - 'revoke_reason') <> (to_jsonb(OLD) - 'revoked_at' - 'revoke_reason') THEN RAISE EXCEPTION 'attestation records are immutable' USING ERRCODE = 'check_violation'; END IF;
  IF OLD.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'a revocation is final' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attestations_guard BEFORE UPDATE ON execution.attestations FOR EACH ROW EXECUTE FUNCTION execution.attestation_guard();
CREATE TRIGGER attestations_no_delete BEFORE DELETE ON execution.attestations FOR EACH ROW EXECUTE FUNCTION execution.deny_mutation();

CREATE TABLE execution.kill_switch (
  id uuid PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('global','org')),
  org_id uuid,
  engaged boolean NOT NULL,
  by_user_id uuid,
  reason_code text NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 60),
  at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'global') = (org_id IS NULL))
);
CREATE INDEX kill_switch_latest_idx ON execution.kill_switch (scope, org_id, at DESC);
CREATE TRIGGER kill_switch_immutable BEFORE UPDATE OR DELETE ON execution.kill_switch FOR EACH ROW EXECUTE FUNCTION execution.deny_mutation();
CREATE TRIGGER kill_switch_no_truncate BEFORE TRUNCATE ON execution.kill_switch FOR EACH STATEMENT EXECUTE FUNCTION execution.deny_mutation();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['runtime_nodes','attestations'] LOOP
    EXECUTE format('ALTER TABLE execution.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE execution.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY platform_all ON execution.%I USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin') WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT ON execution.%I TO nuzm_readonly_reporting', t);
  END LOOP;
END $$;
ALTER TABLE execution.kill_switch ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution.kill_switch FORCE ROW LEVEL SECURITY;
CREATE POLICY org_read ON execution.kill_switch FOR SELECT USING (org_id IS NULL OR org_id = nullif(current_setting('app.org_id', true), '')::uuid OR coalesce(current_setting('app.platform_scope', true), '') = 'admin');
CREATE POLICY org_write ON execution.kill_switch FOR INSERT WITH CHECK (scope = 'org' AND org_id = nullif(current_setting('app.org_id', true), '')::uuid OR coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT ON execution.kill_switch TO nuzm_readonly_reporting;
GRANT SELECT, INSERT, UPDATE ON execution.runtime_nodes TO nuzm_app, nuzm_worker;
GRANT SELECT, INSERT ON execution.attestations TO nuzm_app, nuzm_worker;
GRANT UPDATE (revoked_at, revoke_reason) ON execution.attestations TO nuzm_app, nuzm_worker;
GRANT SELECT, INSERT ON execution.kill_switch TO nuzm_app, nuzm_worker;
