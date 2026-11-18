-- M12 S55: access-review campaigns (FR-ENT-04). Scope today: the members of ONE organization (API keys, admin roles and delegated access
-- arrive with their owners; delegated access with M11). Items and decisions are kept INSIDE the campaign row (items jsonb): docs/05 lists only
-- audit.access_reviews and a separate item table needs manifest approval (SCR-M12-04 / PA-07). Every decision is ALSO an append-only audit event
-- (access_review.decision), which is the insert-only history; the jsonb mirrors the latest state for the console.
CREATE TABLE audit.access_reviews (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,                              -- the organization whose access is reviewed
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object' AND scope ? 'kinds'),
  reviewers uuid[] NOT NULL CHECK (cardinality(reviewers) BETWEEN 1 AND 20),   -- platform staff user ids assigned to decide
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  items jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(items) = 'array'),
  created_by uuid NOT NULL,
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  version int NOT NULL DEFAULT 1,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX access_reviews_org_idx ON audit.access_reviews (org_id, created_at DESC);
CREATE UNIQUE INDEX access_reviews_idem_idx ON audit.access_reviews (created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE FUNCTION audit.access_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'access reviews are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.scope <> OLD.scope OR NEW.reviewers <> OLD.reviewers OR NEW.due_at <> OLD.due_at
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the scope, reviewers and due date of an access review are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.status = 'closed' THEN RAISE EXCEPTION 'a closed access review cannot change' USING ERRCODE = 'check_violation', HINT = 'closed'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER access_review_guard BEFORE UPDATE OR DELETE ON audit.access_reviews FOR EACH ROW EXECUTE FUNCTION audit.access_review_guard();
CREATE TRIGGER access_review_no_truncate BEFORE TRUNCATE ON audit.access_reviews FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();

ALTER TABLE audit.access_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.access_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_admin ON audit.access_reviews USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON audit.access_reviews TO nuzm_app;
GRANT UPDATE (status, items, closed_at, version) ON audit.access_reviews TO nuzm_app;
GRANT SELECT ON audit.access_reviews TO nuzm_readonly_reporting;
