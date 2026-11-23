-- S-K6 (SCR-K-09): the customer's project remembers WHAT its template copy wrote, and the context a model may receive can be checked against the template's AI-processing permission.
-- Expand only: two nullable columns on an append-only tenant table, one index, one view. Nothing is backfilled (copies made before this migration have no baseline and say so).

-- 1. The copy's record: which project it went into, and the baseline (path -> sha256 of exactly the files that were written). Written once with the row; the table stays append-only.
ALTER TABLE knowledge.generation_resource_links
  ADD COLUMN project_id uuid,                                                       -- logical reference to builder.projects (the project the copy was made into)
  ADD COLUMN baseline jsonb CHECK (baseline IS NULL OR jsonb_typeof(baseline) = 'object');
CREATE INDEX generation_resource_links_project_idx ON knowledge.generation_resource_links (org_id, project_id, created_at DESC) WHERE project_id IS NOT NULL;

-- 2. The AI-processing permission of an ELIGIBLE template version, by version id (same eligibility as v_published_templates; nothing else about the resource).
CREATE VIEW knowledge.v_template_context_permissions WITH (security_barrier = true) AS
  SELECT v.id AS version_id, p.ai_processing
    FROM knowledge.resources r
    JOIN knowledge.resource_versions v ON v.resource_id = r.id AND v.state = 'ACTIVE'
    JOIN knowledge.resource_permissions p ON p.resource_id = r.id
   WHERE r.deleted_at IS NULL
     AND v.license_verdict = 'ALLOWED' AND p.license_verdict = 'ALLOWED'
     AND (
       (r.org_id IS NULL AND r.visibility = 'PLATFORM_PUBLISHED' AND r.status = 'ACTIVE' AND p.reuse_scope <> 'NONE')
       OR (r.org_id IS NOT NULL AND r.org_id = nullif(current_setting('app.org_id', true), '')::uuid)
     );
GRANT SELECT ON knowledge.v_template_context_permissions TO nuzm_app;
