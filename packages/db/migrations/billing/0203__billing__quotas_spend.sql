-- M02 S07a: quotas (consumption state), spending limits, spend approvals, usage/spend permissions.
--  * quotas are a rebuildable projection of usage_aggregates against the effective entitlement limits; the quota state
--    only ever blocks NEW consumption (callers decide), it never deletes anything.
--  * a meter GROUP (entitlement key, e.g. 'compute') is measured by exactly one quota meter (a group mixes units, so
--    summing its meters would be meaningless). Groups without a mapping are reported as not measured, never as 'ok'.
--  * spend approvals are decided once; when four-eyes applies the requester can never be the decider (CHECK + service).
--  * every scope check uses coalesce(): with no scope set the comparisons are NULL and NOT NULL is NULL (the S05 lesson).

-- Permissions -------------------------------------------------------------------------------------------------------
INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('usage:read','org','Read aggregated usage and quotas'),
  ('spend:request','org','Request spend approvals');
INSERT INTO tenancy.role_permissions VALUES
  ('owner','usage:read'),('admin','usage:read'),('billing_admin','usage:read'),('developer','usage:read'),('viewer','usage:read'),
  ('owner','spend:request'),('admin','spend:request'),('billing_admin','spend:request'),('developer','spend:request');

-- Which meter measures a quota group (tenant-less reference data; placeholders until the pricing/limits policy, HG-02-01).
CREATE TABLE billing.quota_meters (
  meter_group text PRIMARY KEY CHECK (meter_group ~ '^[a-z][a-z0-9_]*$'),
  meter_id text NOT NULL,                       -- logical reference to metering.meters (no cross-schema FK)
  note text NOT NULL DEFAULT 'placeholder mapping (HG-02-01)'
);
INSERT INTO billing.quota_meters (meter_group, meter_id) VALUES
  ('compute','compute.vcpu_hours'),
  ('storage','storage.object_gb_months'),
  ('network','network.egress_gb'),
  ('email','email.transactional_messages'),
  ('ai','ai.credits_consumed');
GRANT SELECT ON billing.quota_meters TO nuzm_app, nuzm_worker, nuzm_readonly_reporting;

-- Effective limits per meter group: assigned plan version (or the published default plan) + newest override per group.
-- Same rule as EntitlementService.resolve (a test keeps them identical).
CREATE FUNCTION billing.effective_limits(p_org uuid)
RETURNS TABLE (meter_group text, limit_value bigint, allowance bigint, mode text, source text)
LANGUAGE sql STABLE AS $$
  WITH ver AS (
    SELECT coalesce(
      (SELECT e.plan_version_id FROM billing.entitlements e
        WHERE e.kind = 'plan_assignment' AND e.org_id = p_org ORDER BY e.created_at DESC, e.id DESC LIMIT 1),
      (SELECT v.id FROM billing.plans p JOIN billing.plan_versions v ON v.plan_id = p.id
        WHERE p.key = 'free' AND v.status = 'published' ORDER BY v.version DESC LIMIT 1)
    ) AS id
  ), plan_rows AS (
    SELECT DISTINCT ON (e.meter_group) e.meter_group, e.limit_value, e.allowance, e.mode, 'plan'::text AS source
      FROM billing.entitlements e, ver
     WHERE e.scope = 'plan' AND e.kind = 'meter_limit' AND e.plan_version_id = ver.id
     ORDER BY e.meter_group, e.created_at DESC, e.id DESC
  ), ov AS (
    SELECT DISTINCT ON (e.meter_group) e.meter_group, e.limit_value, e.allowance, e.mode, 'override'::text AS source
      FROM billing.entitlements e
     WHERE e.scope = 'org_override' AND e.kind = 'meter_limit' AND e.org_id = p_org
     ORDER BY e.meter_group, e.created_at DESC, e.id DESC
  )
  SELECT * FROM ov
  UNION ALL
  SELECT * FROM plan_rows WHERE plan_rows.meter_group NOT IN (SELECT ov.meter_group FROM ov);
$$;
GRANT EXECUTE ON FUNCTION billing.effective_limits(uuid) TO nuzm_app, nuzm_worker;

-- Quota consumption state (projection). One row per org, group and UTC billing month.
CREATE TABLE billing.quotas (
  org_id uuid NOT NULL,
  meter_group text NOT NULL,
  period_start date NOT NULL,
  meter_id text,                                 -- the measuring meter; NULL = group is not measured
  limit_value bigint,                            -- NULL = unlimited
  mode text NOT NULL CHECK (mode IN ('soft','hard')),
  used numeric(24,8) NOT NULL DEFAULT 0,
  state text NOT NULL CHECK (state IN ('ok','soft','hard')),
  last_threshold int NOT NULL DEFAULT 0 CHECK (last_threshold IN (0,80,100)),  -- highest threshold already announced
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, meter_group, period_start)
);
ALTER TABLE billing.quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.quotas FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON billing.quotas
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON billing.quotas FOR SELECT
  USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT, UPDATE ON billing.quotas TO nuzm_app, nuzm_worker;
GRANT SELECT ON billing.quotas TO nuzm_readonly_reporting;

-- Evaluate every limited group of one organization for the month containing p_now. Returns one row per group; `crossed`
-- is the threshold (80 or 100) newly crossed by THIS call (0 = nothing new), so callers announce each threshold once.
CREATE FUNCTION billing.evaluate_quotas(p_org uuid, p_now timestamptz DEFAULT now())
RETURNS TABLE (meter_group text, period_start date, meter_id text, limit_value bigint, mode text, used numeric,
               state text, crossed int)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  period date := (date_trunc('month', p_now AT TIME ZONE 'UTC'))::date;
  r record; m text; u numeric; pct int; st text; prev int;
BEGIN
  IF coalesce(current_setting('app.org_id', true), '') <> p_org::text THEN
    RAISE EXCEPTION 'billing.evaluate_quotas: organization context mismatch' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR r IN SELECT * FROM billing.effective_limits(p_org) ORDER BY 1 LOOP
    SELECT qm.meter_id INTO m FROM billing.quota_meters qm WHERE qm.meter_group = r.meter_group;
    u := 0;
    IF m IS NOT NULL THEN
      SELECT coalesce(sum(a.quantity), 0) INTO u FROM metering.usage_aggregates a
       WHERE a.org_id = p_org AND a.meter_id = m AND a.billing_period_start = period;
    END IF;
    pct := CASE
      WHEN m IS NULL OR r.limit_value IS NULL THEN 0
      WHEN u >= r.limit_value AND (r.limit_value > 0 OR u > 0) THEN 100
      WHEN r.limit_value > 0 AND u * 100 >= r.limit_value * 80 THEN 80
      ELSE 0 END;
    st := CASE WHEN pct = 100 AND r.mode = 'hard' THEN 'hard' WHEN pct >= 80 THEN 'soft' ELSE 'ok' END;
    SELECT q.last_threshold INTO prev FROM billing.quotas q
      WHERE q.org_id = p_org AND q.meter_group = r.meter_group AND q.period_start = period;
    INSERT INTO billing.quotas (org_id, meter_group, period_start, meter_id, limit_value, mode, used, state, last_threshold, updated_at)
      VALUES (p_org, r.meter_group, period, m, r.limit_value, r.mode, u, st, greatest(coalesce(prev, 0), pct), now())
    ON CONFLICT (org_id, meter_group, period_start) DO UPDATE
      SET meter_id = EXCLUDED.meter_id, limit_value = EXCLUDED.limit_value, mode = EXCLUDED.mode, used = EXCLUDED.used,
          state = EXCLUDED.state, last_threshold = greatest(billing.quotas.last_threshold, EXCLUDED.last_threshold),
          updated_at = now();
    meter_group := r.meter_group; period_start := period; meter_id := m; limit_value := r.limit_value;
    mode := r.mode; used := u; state := st;
    crossed := CASE WHEN pct > coalesce(prev, 0) THEN pct ELSE 0 END;
    RETURN NEXT;
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION billing.evaluate_quotas(uuid, timestamptz) TO nuzm_app, nuzm_worker;

-- Spending limits (org or project monthly caps) --------------------------------------------------------------------
CREATE TABLE billing.spending_limits (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('org','project')),
  project_id uuid,                               -- logical reference to tenancy.projects (no cross-schema FK)
  monthly_cap_minor bigint NOT NULL CHECK (monthly_cap_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  alert_thresholds int[] NOT NULL DEFAULT '{80,100}'
    CHECK (cardinality(alert_thresholds) <= 8 AND 1 <= ALL (alert_thresholds) AND 100 >= ALL (alert_thresholds)),
  -- four-eyes applies to approvals ABOVE this amount; NULL = always (the restrictive default). Org-scope row only.
  four_eyes_above_minor bigint CHECK (four_eyes_above_minor IS NULL OR four_eyes_above_minor >= 0),
  version int NOT NULL DEFAULT 1,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'org' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL)),
  CHECK (scope = 'org' OR four_eyes_above_minor IS NULL)
);
CREATE UNIQUE INDEX spending_limits_scope_idx
  ON billing.spending_limits (org_id, scope, coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid));
ALTER TABLE billing.spending_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.spending_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON billing.spending_limits
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON billing.spending_limits FOR SELECT
  USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT, UPDATE ON billing.spending_limits TO nuzm_app;
GRANT SELECT ON billing.spending_limits TO nuzm_worker, nuzm_readonly_reporting;

-- Spend approvals ---------------------------------------------------------------------------------------------------
CREATE TABLE billing.spend_approvals (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  requester_user_id uuid NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind IN ('quote','operation')),
  subject_id uuid NOT NULL,                      -- logical reference to commerce.quotes (S07b) or platform.operations
  project_id uuid,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired')),
  four_eyes boolean NOT NULL,
  expires_at timestamptz NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('pending','expired') AND decided_by IS NULL AND decided_at IS NULL)
      OR (status IN ('approved','denied') AND decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (NOT four_eyes OR decided_by IS NULL OR decided_by <> requester_user_id)
);
CREATE INDEX spend_approvals_org_idx ON billing.spend_approvals (org_id, created_at DESC, id);
CREATE INDEX spend_approvals_subject_idx ON billing.spend_approvals (org_id, subject_kind, subject_id);
-- One OPEN request per subject: a repeated request returns the existing one instead of piling up.
CREATE UNIQUE INDEX spend_approvals_open_idx ON billing.spend_approvals (org_id, subject_kind, subject_id) WHERE status = 'pending';

-- A decision is final: only pending → approved|denied|expired is allowed; amounts, subject and requester never change.
CREATE FUNCTION billing.spend_approval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'spend approval % is already %', OLD.id, OLD.status USING ERRCODE = 'check_violation', HINT = 'decided';
  END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.requester_user_id <> OLD.requester_user_id OR NEW.subject_kind <> OLD.subject_kind
     OR NEW.subject_id <> OLD.subject_id OR NEW.amount_minor <> OLD.amount_minor OR NEW.currency <> OLD.currency
     OR NEW.four_eyes <> OLD.four_eyes OR NEW.expires_at <> OLD.expires_at OR NEW.reason <> OLD.reason
     OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'spend approval request fields are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER spend_approval_guard BEFORE UPDATE ON billing.spend_approvals
  FOR EACH ROW EXECUTE FUNCTION billing.spend_approval_guard();
CREATE FUNCTION billing.spend_approval_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'spend approvals are never deleted' USING ERRCODE = 'check_violation'; END $$;
CREATE TRIGGER spend_approval_no_delete BEFORE DELETE ON billing.spend_approvals
  FOR EACH ROW EXECUTE FUNCTION billing.spend_approval_no_delete();
CREATE TRIGGER spend_approval_no_truncate BEFORE TRUNCATE ON billing.spend_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION billing.spend_approval_no_delete();

ALTER TABLE billing.spend_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.spend_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON billing.spend_approvals
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON billing.spend_approvals FOR SELECT
  USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT, UPDATE ON billing.spend_approvals TO nuzm_app;
GRANT SELECT ON billing.spend_approvals TO nuzm_worker, nuzm_readonly_reporting;
