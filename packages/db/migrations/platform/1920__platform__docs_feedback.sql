-- Documentation "Was this helpful?" ratings (owner request 2026-11-21). Tenant-less: the documentation is public, so there is no organization.
--  * No person is stored. client_hash = sha256(salt | client address | agent | UTC day): not reversible, not linkable across days. It lets one client change its
--    own vote on a page (one row per page, client and day) and lets the API rate limit.
--  * page is checked against the documentation's own address shape, so the table cannot be used to store arbitrary text.
CREATE TABLE platform.docs_feedback (
  id uuid PRIMARY KEY,
  page text NOT NULL CHECK (page ~ '^/docs(/(guides|reference)/[a-z0-9-]{1,60})?$'),
  locale text NOT NULL CHECK (locale IN ('ar', 'en')),
  score text NOT NULL CHECK (score IN ('good', 'okay', 'bad')),
  client_hash text NOT NULL CHECK (client_hash ~ '^[0-9a-f]{64}$'),
  day date NOT NULL DEFAULT ((now() AT TIME ZONE 'utc')::date),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page, client_hash, day)
);
CREATE INDEX docs_feedback_page_day_idx ON platform.docs_feedback (page, day);
GRANT SELECT, INSERT, UPDATE ON platform.docs_feedback TO nuzm_app;
GRANT SELECT ON platform.docs_feedback TO nuzm_readonly_reporting;
