-- M12 S57/S58: operations schema (docs/05: owner ops, created by M12). Platform-level tables (admin scope only, no org_id): incidents and their
-- timeline, alert rules/state, provider incidents, recovery (DR) exercises, SLO definitions, synthetic probe runs and the GA launch gates.
-- NOTE for the owner (manifest item): `ops.probe_runs` (results of the synthetic probes of S57) is not in docs/05's list for `ops`; it is added here.
-- Incident records must not hold raw personal data (M12 §9): free text is length-limited and the API refuses obvious personal data patterns.
CREATE SCHEMA IF NOT EXISTS ops;
GRANT USAGE ON SCHEMA ops TO nuzm_app, nuzm_worker, nuzm_readonly_reporting;

INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('admin:ops:read','platform','Read operational health, incidents, alerts, provider incidents and recovery exercises'),
  ('admin:ops:manage','platform','Open and update incidents, manage alerts, record recovery exercises');
INSERT INTO tenancy.role_permissions VALUES
  ('platform_admin','admin:ops:read'),('platform_admin','admin:ops:manage'),
  ('security','admin:ops:read'),('security','admin:ops:manage'),
  ('support','admin:ops:read'),('compliance_officer','admin:ops:read'),('finance','admin:ops:read');

CREATE FUNCTION ops.deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% on ops.% is not allowed: this table is append-only', TG_OP, TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege', HINT = 'immutable'; END $$;

CREATE TABLE ops.incidents (
  id uuid PRIMARY KEY,
  severity text NOT NULL CHECK (severity IN ('SEV1','SEV2','SEV3','SEV4')),
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','identified','monitoring','resolved','closed')),
  components text[] NOT NULL DEFAULT '{}' CHECK (cardinality(components) <= 30),
  summary text CHECK (summary IS NULL OR length(summary) <= 2000),
  breach_case_id uuid,                                   -- logical link to compliance.breach_cases (no cross-schema FK)
  opened_by uuid NOT NULL,
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 255),
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  CHECK ((status IN ('resolved','closed')) = (resolved_at IS NOT NULL)),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX incidents_open_idx ON ops.incidents (opened_at DESC) WHERE status NOT IN ('resolved','closed');
CREATE UNIQUE INDEX incidents_idem_idx ON ops.incidents (opened_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE ops.incident_updates (
  id uuid PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES ops.incidents(id),
  kind text NOT NULL CHECK (kind IN ('opened','note','status_change','severity_change','comms_draft','breach_link')),
  body text CHECK (body IS NULL OR length(body) <= 4000),
  status_to text CHECK (status_to IS NULL OR status_to IN ('open','investigating','identified','monitoring','resolved','closed')),
  severity_to text CHECK (severity_to IS NULL OR severity_to IN ('SEV1','SEV2','SEV3','SEV4')),
  author uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_updates_incident_idx ON ops.incident_updates (incident_id, created_at, id);
CREATE TRIGGER incident_updates_immutable BEFORE UPDATE OR DELETE ON ops.incident_updates FOR EACH ROW EXECUTE FUNCTION ops.deny_mutation();
CREATE TRIGGER incident_updates_no_truncate BEFORE TRUNCATE ON ops.incident_updates FOR EACH STATEMENT EXECUTE FUNCTION ops.deny_mutation();

CREATE TABLE ops.alerts (
  id uuid PRIMARY KEY,
  rule_key text NOT NULL UNIQUE CHECK (rule_key ~ '^[a-z][a-z0-9_.-]{2,80}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  owner_role text NOT NULL CHECK (owner_role ~ '^[a-z][a-z_]{2,40}$'),     -- a role, never a person
  runbook_url text NOT NULL CHECK (runbook_url ~ '^(docs/runbooks/[a-z0-9._-]+\.md|https://[^\s]+)$'),
  rule jsonb NOT NULL CHECK (jsonb_typeof(rule) = 'object' AND rule ? 'metric' AND rule ? 'op' AND rule ? 'threshold'),
  state text NOT NULL DEFAULT 'ok' CHECK (state IN ('ok','firing','acknowledged','silenced')),
  state_since timestamptz NOT NULL DEFAULT now(),
  silenced_until timestamptz,
  silenced_by uuid,
  acknowledged_by uuid,
  last_evaluated_at timestamptz,
  last_value numeric,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  CHECK ((state = 'silenced') = (silenced_until IS NOT NULL))
);

CREATE TABLE ops.provider_incidents (
  id uuid PRIMARY KEY,
  provider_account_id uuid,                              -- logical reference to cloud.provider_accounts
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z][a-z0-9_-]{1,40}$'),
  external_ref text NOT NULL CHECK (length(external_ref) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('investigating','identified','monitoring','resolved')),
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 300),
  started_at timestamptz NOT NULL,
  resolved_at timestamptz,
  related_incident_id uuid REFERENCES ops.incidents(id),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','feed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_key, external_ref),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);

CREATE TABLE ops.recovery_exercises (
  id uuid PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('control_plane_db','object_storage','hosting_site','managed_db','secrets_kms','regional_loss_tabletop')),
  started_at timestamptz NOT NULL,
  restored_at timestamptz NOT NULL,
  rpo_seconds int NOT NULL CHECK (rpo_seconds >= 0),
  rto_seconds int NOT NULL CHECK (rto_seconds >= 0),
  target_rpo_seconds int NOT NULL CHECK (target_rpo_seconds > 0),   -- D-30 proposal: 900
  target_rto_seconds int NOT NULL CHECK (target_rto_seconds > 0),   -- D-30 proposal: 14400
  evidence_refs text[] NOT NULL CHECK (cardinality(evidence_refs) BETWEEN 1 AND 20),
  result text NOT NULL CHECK (result IN ('pass','fail')),
  environment text NOT NULL CHECK (environment IN ('local','staging','production')),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  recorded_by uuid NOT NULL,
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (restored_at >= started_at),
  -- measured, not estimated: the recorded RTO is the difference of the two recorded timestamps
  CHECK (rto_seconds = round(extract(epoch FROM (restored_at - started_at)))::int),
  CHECK ((result = 'pass') = (rpo_seconds <= target_rpo_seconds AND rto_seconds <= target_rto_seconds))
);
CREATE UNIQUE INDEX recovery_exercises_idem_idx ON ops.recovery_exercises (recorded_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TRIGGER recovery_exercises_immutable BEFORE UPDATE OR DELETE ON ops.recovery_exercises FOR EACH ROW EXECUTE FUNCTION ops.deny_mutation();
CREATE TRIGGER recovery_exercises_no_truncate BEFORE TRUNCATE ON ops.recovery_exercises FOR EACH STATEMENT EXECUTE FUNCTION ops.deny_mutation();

CREATE TABLE ops.slo_definitions (
  id uuid PRIMARY KEY,
  slo_key text NOT NULL UNIQUE CHECK (slo_key ~ '^[a-z][a-z0-9_.-]{2,80}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  objective numeric NOT NULL,                            -- e.g. 99.9 (percent) or 300 (milliseconds), see unit
  unit text NOT NULL CHECK (unit IN ('percent','milliseconds','seconds')),
  window_days int NOT NULL CHECK (window_days BETWEEN 1 AND 365),
  sli jsonb NOT NULL DEFAULT '{}'::jsonb,
  basis text NOT NULL CHECK (length(basis) BETWEEN 3 AND 300),
  status text NOT NULL CHECK (status IN ('proposal','accepted')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ops.probe_runs (
  id uuid PRIMARY KEY,
  probe_key text NOT NULL CHECK (probe_key IN ('login','quote','provisioning_mock','payment_sandbox','dns_change')),
  ok boolean NOT NULL,
  duration_ms int NOT NULL CHECK (duration_ms >= 0),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  mode text NOT NULL CHECK (mode IN ('fixture','sandbox','live')),     -- fixture runs never count as availability evidence
  ran_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX probe_runs_key_time_idx ON ops.probe_runs (probe_key, ran_at DESC);

-- GA readiness gates (M12 §15): append-only VERSIONS. Version 1 is the seeded PENDING row. Any later version needs a human decider; the agent never records
-- PASS/GRANTED (the application refuses, and so does this CHECK for rows without a decider).
CREATE TABLE ops.launch_gates (
  id uuid PRIMARY KEY,
  gate_key text NOT NULL CHECK (gate_key ~ '^G-[0-9]{2}$'),
  version int NOT NULL CHECK (version >= 1),
  title text NOT NULL,
  owner text NOT NULL,
  source text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','pass','fail','blocked','not_verified','deferred')),
  evidence_ref text CHECK (evidence_ref IS NULL OR length(evidence_ref) BETWEEN 3 AND 300),
  decided_by uuid,
  decided_at timestamptz,
  note text CHECK (note IS NULL OR length(note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gate_key, version),
  CHECK (version = 1 OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status <> 'pass' OR (decided_by IS NOT NULL AND evidence_ref IS NOT NULL)),
  CHECK (version > 1 OR status = 'pending')
);
CREATE TRIGGER launch_gates_immutable BEFORE UPDATE OR DELETE ON ops.launch_gates FOR EACH ROW EXECUTE FUNCTION ops.deny_mutation();
CREATE TRIGGER launch_gates_no_truncate BEFORE TRUNCATE ON ops.launch_gates FOR EACH STATEMENT EXECUTE FUNCTION ops.deny_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['incidents','incident_updates','alerts','provider_incidents','recovery_exercises','slo_definitions','probe_runs','launch_gates'] LOOP
    EXECUTE format('ALTER TABLE ops.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE ops.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY platform_admin ON ops.%I
      USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin' OR current_setting('app.worker_scope', true) = 'claim')
      WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin' OR current_setting('app.worker_scope', true) = 'claim')$p$, t);
    EXECUTE format('GRANT SELECT ON ops.%I TO nuzm_readonly_reporting', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON ops.incidents, ops.alerts, ops.provider_incidents TO nuzm_app, nuzm_worker;
GRANT SELECT, INSERT ON ops.incident_updates, ops.recovery_exercises, ops.probe_runs, ops.launch_gates TO nuzm_app, nuzm_worker;
GRANT SELECT, INSERT, UPDATE ON ops.slo_definitions TO nuzm_app;

SELECT set_config('app.platform_scope', 'admin', true);   -- the seeds below pass the platform_admin policy even for a non-superuser owner
-- Seeds (PROPOSALS: D-30 accepted 2026-11-15 for 99.9 % / RPO 15 min / RTO 4 h; the rest are M12 §11 proposals, owner to confirm) ----------------------
INSERT INTO ops.slo_definitions (id, slo_key, title, objective, unit, window_days, sli, basis, status) VALUES
  (gen_random_uuid(),'api.availability','Control-plane API availability',99.9,'percent',30,'{"good":"non-5xx responses","total":"all responses"}','D-30 accepted 2026-11-15 (PRD §6)','accepted'),
  (gen_random_uuid(),'dr.rpo','Control-plane database recovery point objective',900,'seconds',90,'{"measured_by":"ops.recovery_exercises.rpo_seconds"}','D-30 accepted 2026-11-15: 15 minutes','accepted'),
  (gen_random_uuid(),'dr.rto','Control-plane database recovery time objective',14400,'seconds',90,'{"measured_by":"ops.recovery_exercises.rto_seconds"}','D-30 accepted 2026-11-15: 4 hours','accepted'),
  (gen_random_uuid(),'api.read_latency_p95','Read request latency, 95th percentile',300,'milliseconds',30,'{"percentile":95,"methods":["GET"]}','PROPOSAL: M12 §11 load targets (owner to confirm)','proposal'),
  (gen_random_uuid(),'api.write_latency_p95','Write request latency, 95th percentile',800,'milliseconds',30,'{"percentile":95,"methods":["POST","PUT","PATCH","DELETE"]}','PROPOSAL: M12 §11 load targets (owner to confirm)','proposal'),
  (gen_random_uuid(),'api.error_rate','Request error rate (maximum)',0.5,'percent',30,'{"errors":"5xx"}','PROPOSAL: M12 §11 load targets (owner to confirm)','proposal');

INSERT INTO ops.alerts (id, rule_key, title, severity, owner_role, runbook_url, rule) VALUES
  (gen_random_uuid(),'api.5xx_rate','API 5xx rate above 0.5 % over 5 minutes','critical','sre','docs/runbooks/incident-response.md','{"metric":"api.error_rate_5m","op":">","threshold":0.5}'),
  (gen_random_uuid(),'queue.lag','Outbox or operations queue lag above 5 minutes','warning','sre','docs/runbooks/queue-recovery.md','{"metric":"queue.max_lag_seconds","op":">","threshold":300}'),
  (gen_random_uuid(),'audit.chain_broken','Audit hash chain verification failed','critical','security','docs/runbooks/incident-response.md','{"metric":"audit.broken_chains","op":">","threshold":0}'),
  (gen_random_uuid(),'reconciliation.stale','Reconciliation has not run for 26 hours','warning','finance_ops','docs/runbooks/reconciliation-variance.md','{"metric":"reconciliation.hours_since_last_run","op":">","threshold":26}'),
  (gen_random_uuid(),'reconciliation.breaks','Open reconciliation breaks above zero','warning','finance_ops','docs/runbooks/reconciliation-variance.md','{"metric":"reconciliation.open_breaks","op":">","threshold":0}'),
  (gen_random_uuid(),'probe.failing','A synthetic probe failed twice in a row','critical','sre','docs/runbooks/incident-response.md','{"metric":"probe.consecutive_failures","op":">=","threshold":2}'),
  (gen_random_uuid(),'provider.incident_open','A provider incident is open','warning','sre','docs/runbooks/provider-outage.md','{"metric":"provider.open_incidents","op":">","threshold":0}'),
  (gen_random_uuid(),'zatca.backlog','Unsubmitted e-invoices older than 24 hours','critical','finance_ops','docs/runbooks/zatca-backlog.md','{"metric":"zatca.oldest_pending_hours","op":">","threshold":24}'),
  (gen_random_uuid(),'dr.exercise_overdue','No control-plane restore exercise in 190 days','warning','sre','docs/runbooks/dr-restore.md','{"metric":"dr.days_since_exercise","op":">","threshold":190}');

INSERT INTO ops.launch_gates (id, gate_key, version, title, owner, source, status) VALUES
  (gen_random_uuid(),'G-01',1,'HG-00-01 documentation approval','Owner','docs/07','pending'),
  (gen_random_uuid(),'G-02',1,'Gate Review M01 signed','Owner','docs/03 §5','pending'),
  (gen_random_uuid(),'G-03',1,'Gate Review M02 signed','Owner','docs/03 §5','pending'),
  (gen_random_uuid(),'G-04',1,'Gate Review M03 signed','Owner','docs/03 §5','pending'),
  (gen_random_uuid(),'G-05',1,'Gate Review M04 signed','Owner','docs/03 §5','pending'),
  (gen_random_uuid(),'G-06',1,'Gate Review M05 signed','Owner','docs/03 §5','pending'),
  (gen_random_uuid(),'G-07',1,'Gate Review M06 signed','Owner','docs/03 §5','pending'),
  (gen_random_uuid(),'G-08',1,'Gate Review M07 signed','Owner','docs/03 §5','pending'),
  (gen_random_uuid(),'G-09',1,'Gate Review M08 signed','Owner','docs/03 §5','pending'),
  (gen_random_uuid(),'G-10',1,'Gate Review M09 signed','Owner','docs/03 §5','pending'),
  (gen_random_uuid(),'G-11',1,'Gate Review M10 signed','Owner','docs/03 §5','pending'),
  (gen_random_uuid(),'G-12',1,'Gate Review M11 signed','Owner','docs/03 §5','pending'),
  (gen_random_uuid(),'G-13',1,'M12 Gate Review signed','Owner','M12 prompt','pending'),
  (gen_random_uuid(),'G-14',1,'HG-01-01 repo/CI · HG-01-02 IdP hosting','Owner/DevOps','docs/07','pending'),
  (gen_random_uuid(),'G-15',1,'HG-02-01 price book approved (D-23, D-25)','Finance','docs/07','pending'),
  (gen_random_uuid(),'G-16',1,'HG-03-01 VAT-registered entities (D-33)','Finance','docs/07','pending'),
  (gen_random_uuid(),'G-17',1,'HG-03-02 PSP production approval (D-10)','Finance','docs/07','pending'),
  (gen_random_uuid(),'G-18',1,'HG-03-03 ZATCA production CSID/onboarding (D-11)','Finance/Tax','docs/07','pending'),
  (gen_random_uuid(),'G-19',1,'HG-03-04 tax advisor sign-off (incl. D-24 reseller treatment)','Tax advisor','docs/07','pending'),
  (gen_random_uuid(),'G-20',1,'HG-04-01 counsel memo (D-14, D-16, D-17, D-34)','Legal','docs/07','pending'),
  (gen_random_uuid(),'G-21',1,'HG-04-02 NCA/CST applicability + filings','Legal/Security','docs/07','pending'),
  (gen_random_uuid(),'G-22',1,'HG-04-03 third-party assessments/certifications','Security','docs/07','pending'),
  (gen_random_uuid(),'G-23',1,'PDPL obligations validated (DPO, ROPA, transfers, DSR)','Legal','M04 register','pending'),
  (gen_random_uuid(),'G-24',1,'HG-05-01 Alibaba · HG-05-02 Huawei · HG-05-03 Contabo accounts + verified regions/capabilities','Owner','docs/07','pending'),
  (gen_random_uuid(),'G-25',1,'HG-05-04 provider quotas/spend caps','Owner','docs/07','pending'),
  (gen_random_uuid(),'G-26',1,'HG-06-01 CloudPanel licensing/nodes (D-20 outcome)','Owner','docs/07','pending'),
  (gen_random_uuid(),'G-27',1,'HG-07-01 registrar accounts · HG-07-02 .sa route (D-19)','Owner/Legal','docs/07','pending'),
  (gen_random_uuid(),'G-28',1,'HG-08-01 data/email providers contracted (D-05..D-09)','Owner','docs/07','pending'),
  (gen_random_uuid(),'G-29',1,'HG-09-01 model provider contracts (D-18)','Owner','docs/07','pending'),
  (gen_random_uuid(),'G-30',1,'HG-10-01 store accounts/signing/macOS (D-22) · HG-10-02 sandbox security review (D-21)','Owner/Security','docs/07','pending'),
  (gen_random_uuid(),'G-31',1,'HG-11-01 marketplace terms/payout route (D-26)','Legal','docs/07','pending'),
  (gen_random_uuid(),'G-32',1,'HG-12-01 independent pen test + retest (D-28)','Owner','docs/07','pending'),
  (gen_random_uuid(),'G-33',1,'HG-12-02 SSO tenants · D-27 scope','Owner','docs/07','pending'),
  (gen_random_uuid(),'G-34',1,'HG-12-03 training, runbook acceptance, on-call roster (D-29), go/no-go','Owner','docs/07','pending'),
  (gen_random_uuid(),'G-35',1,'Remaining OPEN decisions D-01…D-34 closed or explicitly deferred','Owner','docs/07','pending'),
  (gen_random_uuid(),'G-36',1,'blocked-register.md fully dispositioned','Owner','AC-M12-17','pending'),
  (gen_random_uuid(),'G-37',1,'No open critical/high defects (tracker export attached)','Owner','AC-M12-10/11','pending'),
  (gen_random_uuid(),'G-38',1,'DR and reconciliation evidence accepted','Owner/Finance','AC-M12-08/12/13','pending');
SELECT set_config('app.platform_scope', '', true);
