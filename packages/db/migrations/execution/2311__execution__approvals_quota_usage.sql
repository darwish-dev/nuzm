-- P3-S02 durable stores, part 2: approvals, quota reservations and usage records.
--  * An approval is bound by digest to the exact decision, HUMAN-decided only (`decider_kind = 'human'`: a model, API key or service account can never decide), single-use, expiring and
--    revocable. Single use is enforced by the consuming statement itself (see store.ts: one atomic UPDATE ... WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()).
--  * Money is integer minor units + currency; NO floats. SETTLEMENT IS NOT WRITTEN HERE: only the billing posting service writes ledger rows (CLAUDE.md §4). A reservation row holds the
--    hold; a usage record is the measured-use fact handed to the metering pipeline (`billed` flips once, by that pipeline).
CREATE TABLE execution.approvals (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  job_id uuid NOT NULL,
  decision_digest text NOT NULL CHECK (decision_digest ~ '^[0-9a-f]{64}$'),
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_by uuid,                               -- a human user id of the same organization
  decider_kind text CHECK (decider_kind IS NULL OR decider_kind = 'human'),
  decided_at timestamptz,
  consumed_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 80),
  data_region text NOT NULL,
  CHECK (expires_at > requested_at),
  CHECK ((decided_by IS NULL) = (decider_kind IS NULL) AND (decided_by IS NULL) = (decided_at IS NULL)),
  CHECK (consumed_at IS NULL OR decided_at IS NOT NULL),
  CHECK (NOT (consumed_at IS NOT NULL AND revoked_at IS NOT NULL)),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX approvals_job_idx ON execution.approvals (org_id, job_id);
CREATE FUNCTION execution.approval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.job_id <> OLD.job_id OR NEW.decision_digest <> OLD.decision_digest OR NEW.expires_at <> OLD.expires_at OR NEW.requested_at <> OLD.requested_at
  THEN RAISE EXCEPTION 'approval binding is immutable' USING ERRCODE = 'check_violation'; END IF;
  -- once decided, the decision never changes; consumption and revocation are one-way
  IF OLD.decided_at IS NOT NULL AND (NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at) THEN RAISE EXCEPTION 'a decision is final' USING ERRCODE = 'check_violation'; END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN RAISE EXCEPTION 'an approval is single use' USING ERRCODE = 'check_violation'; END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN RAISE EXCEPTION 'a revocation is final' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approvals_guard BEFORE UPDATE ON execution.approvals FOR EACH ROW EXECUTE FUNCTION execution.approval_guard();

CREATE TABLE execution.quota_reservations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  job_id uuid NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reserved_minor bigint NOT NULL CHECK (reserved_minor >= 0),
  concurrency_slots int NOT NULL CHECK (concurrency_slots >= 0 AND concurrency_slots <= 100),
  state text NOT NULL DEFAULT 'held' CHECK (state IN ('held','released','settled')),
  at timestamptz NOT NULL DEFAULT now(),
  data_region text NOT NULL,
  UNIQUE (org_id, job_id)
);
CREATE FUNCTION execution.reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> OLD.state AND OLD.state <> 'held' THEN RAISE EXCEPTION 'a released or settled reservation is final' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.reserved_minor <> OLD.reserved_minor OR NEW.currency <> OLD.currency OR NEW.org_id <> OLD.org_id OR NEW.job_id <> OLD.job_id THEN RAISE EXCEPTION 'reservation amounts are immutable' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reservations_guard BEFORE UPDATE ON execution.quota_reservations FOR EACH ROW EXECUTE FUNCTION execution.reservation_guard();

CREATE TABLE execution.usage_records (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  run_id text NOT NULL,
  job_id uuid,
  node_id text NOT NULL CHECK (length(node_id) <= 40),
  runtime_class text NOT NULL CHECK (length(runtime_class) <= 60),
  profile text NOT NULL CHECK (profile ~ '^[a-z][a-z0-9-]{0,40}$'),
  cpu_seconds numeric(12,3) NOT NULL CHECK (cpu_seconds >= 0),
  wall_ms bigint NOT NULL CHECK (wall_ms >= 0),
  peak_memory_mb int NOT NULL CHECK (peak_memory_mb >= 0),
  peak_pids int NOT NULL CHECK (peak_pids >= 0),
  disk_mb int NOT NULL CHECK (disk_mb >= 0),
  output_bytes bigint NOT NULL CHECK (output_bytes >= 0),
  status text NOT NULL CHECK (status IN ('completed','failed','timeout','terminated','refused')),
  estimated_minor bigint NOT NULL DEFAULT 0 CHECK (estimated_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  billed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  data_region text NOT NULL,
  UNIQUE (org_id, run_id, job_id)
);
CREATE INDEX usage_records_unbilled_idx ON execution.usage_records (created_at) WHERE NOT billed;
-- measurements never change; only `billed` may flip, once, false -> true
CREATE FUNCTION execution.usage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'billed') <> (to_jsonb(OLD) - 'billed') THEN RAISE EXCEPTION 'usage records are immutable' USING ERRCODE = 'check_violation'; END IF;
  IF OLD.billed AND NOT NEW.billed THEN RAISE EXCEPTION 'billed cannot be undone' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER usage_guard BEFORE UPDATE ON execution.usage_records FOR EACH ROW EXECUTE FUNCTION execution.usage_guard();
CREATE TRIGGER usage_no_delete BEFORE DELETE ON execution.usage_records FOR EACH ROW EXECUTE FUNCTION execution.deny_mutation();
CREATE TRIGGER usage_no_truncate BEFORE TRUNCATE ON execution.usage_records FOR EACH STATEMENT EXECUTE FUNCTION execution.deny_mutation();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['approvals','quota_reservations','usage_records'] LOOP
    EXECUTE format('ALTER TABLE execution.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE execution.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON execution.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY platform_read ON execution.%I FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT ON execution.%I TO nuzm_readonly_reporting', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON execution.approvals, execution.quota_reservations TO nuzm_app, nuzm_worker;
GRANT SELECT, INSERT ON execution.usage_records TO nuzm_app, nuzm_worker;
GRANT UPDATE (billed) ON execution.usage_records TO nuzm_app, nuzm_worker;
