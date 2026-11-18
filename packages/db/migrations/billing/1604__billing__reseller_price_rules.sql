-- M11 S54 (owner PR to the billing module): reseller price rules. APPEND-VERSIONED: a PUT of the rule set inserts a NEW set of rows with the next `rule_set_version`; nothing is updated or
-- deleted, so a statement can always be reproduced from the rule set that was in force. A rule is effective from `effective_from` (set >= now + 1 day by the service).
-- markup: {"type":"percent","bps":1500} (15 %) or {"type":"fixed","amountMinor":"250","currency":"SAR"} per unit of the rated price.
CREATE TABLE billing.reseller_price_rules (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,                                  -- the RESELLER organization
  reseller_id uuid NOT NULL,                             -- logical reference to programs.resellers
  scope text NOT NULL CHECK (scope IN ('plan','meter')),
  scope_key text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 120),   -- plan key or meter id
  markup jsonb NOT NULL,
  effective_from timestamptz NOT NULL,
  rule_set_version int NOT NULL CHECK (rule_set_version >= 1),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reseller_id, rule_set_version, scope, scope_key)
);
CREATE INDEX reseller_price_rules_idx ON billing.reseller_price_rules (reseller_id, rule_set_version DESC);
CREATE TRIGGER reseller_price_rules_append_only BEFORE UPDATE OR DELETE ON billing.reseller_price_rules FOR EACH ROW EXECUTE FUNCTION automation.immutable_row();
ALTER TABLE billing.reseller_price_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.reseller_price_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON billing.reseller_price_rules USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON billing.reseller_price_rules FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON billing.reseller_price_rules TO nuzm_app, nuzm_worker;
GRANT SELECT ON billing.reseller_price_rules TO nuzm_readonly_reporting;
