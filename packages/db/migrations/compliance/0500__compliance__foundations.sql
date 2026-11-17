-- M04 S13a: compliance foundations (docs/10, docs/05 `compliance`, M04 §4 tasks 1-3).
--  * data_classes: the classification catalogue (tenant-less reference data, seeded here; read-only to runtime roles). Values are PROPOSALS (D-14).
--  * consents: APPEND-ONLY consent history. A withdrawal is a new row (state 'withdrawn', pointing at the grant it ends); the current state of a
--    (organization, subject, purpose) is its row with the highest `seq`. `seq` is allocated under an advisory lock by the service, so the order
--    is total even for concurrent grants and withdrawals. subject_ref is an OPAQUE id (never an email or a name).
--  * Purposes are NOT a table: they are catalogued in spec/compliance/purposes.yaml (docs/05 §4 note); purpose_id is validated by the service.
CREATE SCHEMA IF NOT EXISTS compliance;
GRANT USAGE ON SCHEMA compliance TO nuzm_app, nuzm_worker, nuzm_readonly_reporting;

INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('privacy:consent:self','org','Grant, withdraw and read the caller''s own consents'),
  ('privacy:consent:manage','org','Record and withdraw consents of the organization and of its end users; read every consent of the organization');
INSERT INTO tenancy.role_permissions VALUES
  ('owner','privacy:consent:self'),('admin','privacy:consent:self'),('billing_admin','privacy:consent:self'),('developer','privacy:consent:self'),('viewer','privacy:consent:self'),
  ('owner','privacy:consent:manage'),('admin','privacy:consent:manage');

CREATE TABLE compliance.data_classes (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z-]{2,30}$'),
  label_ar text NOT NULL,
  label_en text NOT NULL,
  default_policy jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- PROPOSAL values (D-14, HG-04-01): counsel decides the real handling per class.
INSERT INTO compliance.data_classes (key, label_ar, label_en, default_policy) VALUES
  ('public','عام','Public','{"status":"PROPOSAL","atRestEncryption":false,"fieldEncryption":false,"logValues":true,"residencyDefault":"unrestricted"}'),
  ('internal','داخلي','Internal','{"status":"PROPOSAL","atRestEncryption":true,"fieldEncryption":false,"logValues":true,"residencyDefault":"in_kingdom_only"}'),
  ('customer-content','محتوى العميل','Customer content','{"status":"PROPOSAL","atRestEncryption":true,"fieldEncryption":false,"logValues":false,"residencyDefault":"in_kingdom_only"}'),
  ('personal','بيانات شخصية','Personal data','{"status":"PROPOSAL","atRestEncryption":true,"fieldEncryption":false,"logValues":false,"residencyDefault":"in_kingdom_only"}'),
  ('financial','بيانات مالية','Financial data','{"status":"PROPOSAL","atRestEncryption":true,"fieldEncryption":false,"logValues":false,"residencyDefault":"in_kingdom_only"}'),
  ('credentials','بيانات اعتماد','Credentials','{"status":"PROPOSAL","atRestEncryption":true,"fieldEncryption":true,"logValues":false,"residencyDefault":"in_kingdom_only"}');
GRANT SELECT ON compliance.data_classes TO nuzm_app, nuzm_worker, nuzm_readonly_reporting;

CREATE TABLE compliance.consents (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  subject_ref text NOT NULL CHECK (subject_ref ~ '^[A-Za-z0-9:_.-]{1,128}$'),
  purpose_id text NOT NULL CHECK (purpose_id ~ '^[a-z][a-z0-9_]{2,60}$'),
  state text NOT NULL CHECK (state IN ('granted','withdrawn')),
  seq bigint NOT NULL CHECK (seq >= 1),
  text_version text NOT NULL CHECK (length(text_version) BETWEEN 1 AND 40),
  locale text NOT NULL CHECK (locale IN ('ar','en')),
  source text NOT NULL CHECK (source IN ('api','ui')),
  withdraws_id uuid REFERENCES compliance.consents(id),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, subject_ref, purpose_id, seq),
  CHECK ((state = 'withdrawn') = (withdraws_id IS NOT NULL))
);
CREATE INDEX consents_list_idx ON compliance.consents (org_id, created_at DESC, id);

CREATE FUNCTION compliance.consents_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'consent history is append-only' USING ERRCODE = 'check_violation', HINT = 'immutable';
END $$;
CREATE TRIGGER consents_immutable BEFORE UPDATE OR DELETE ON compliance.consents FOR EACH ROW EXECUTE FUNCTION compliance.consents_append_only();
CREATE TRIGGER consents_no_truncate BEFORE TRUNCATE ON compliance.consents FOR EACH STATEMENT EXECUTE FUNCTION compliance.consents_append_only();

ALTER TABLE compliance.consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance.consents FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON compliance.consents USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON compliance.consents FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON compliance.consents TO nuzm_app, nuzm_worker;
GRANT SELECT ON compliance.consents TO nuzm_readonly_reporting;
