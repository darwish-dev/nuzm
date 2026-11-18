-- M11 S54 (owner PR to the invoicing module): the invoice-issuer model of a billing entity for reseller sub-organizations.
-- D-24 (issuer-of-record model) is OPEN and HG-03-04 (tax advisor sign-off) is PENDING, so the ONLY value the database accepts is 'disabled'. Enabling a model is a
-- deliberate later migration by a person after the decision is recorded: no code path and no configuration can switch one on (ADR/owner action).
ALTER TABLE invoicing.billing_entities ADD COLUMN issuer_model text NOT NULL DEFAULT 'disabled' CHECK (issuer_model = 'disabled');
COMMENT ON COLUMN invoicing.billing_entities.issuer_model IS 'platform_issues_wholesale | reseller_issues_own | disabled. Only disabled until D-24 is decided and HG-03-04 signed (M11).';
