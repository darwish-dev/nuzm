-- DEV/STAGING ONLY. Production is forward-fix (the views expose derived metadata; nothing is stored). Documented reversal of 1866 (SCR-K-08): the S-K1 definition of the published view.
DROP VIEW IF EXISTS knowledge.v_template_copy_files;
DROP VIEW IF EXISTS knowledge.v_published_templates;
CREATE VIEW knowledge.v_published_templates WITH (security_barrier = true) AS
  SELECT r.id AS resource_id, v.id AS version_id, v.seq AS version_seq, v.semver, r.org_id, r.name, r.description, r.resource_type, r.platform, r.frameworks,
         r.languages, r.category, r.tags, p.reuse_scope, p.component_reuse, p.starter_eligible, p.architecture_reference, p.license_verdict,
         (SELECT m.manifest -> 'designDna' FROM knowledge.resource_manifests m WHERE m.version_id = v.id ORDER BY m.created_at DESC LIMIT 1) AS design_dna,
         (SELECT coalesce(jsonb_agg(tv.preview_key ORDER BY tv.name) FILTER (WHERE tv.preview_key IS NOT NULL), '[]'::jsonb)
            FROM knowledge.theme_variants tv WHERE tv.version_id = v.id) AS preview_keys
    FROM knowledge.resources r
    JOIN knowledge.resource_versions v ON v.resource_id = r.id AND v.state = 'ACTIVE'
    JOIN knowledge.resource_permissions p ON p.resource_id = r.id
   WHERE r.deleted_at IS NULL
     AND v.license_verdict = 'ALLOWED' AND p.license_verdict = 'ALLOWED'
     AND (
       (r.org_id IS NULL AND r.visibility = 'PLATFORM_PUBLISHED' AND r.status = 'ACTIVE' AND p.reuse_scope <> 'NONE')
       OR (r.org_id IS NOT NULL AND r.org_id = nullif(current_setting('app.org_id', true), '')::uuid)
     );
GRANT SELECT ON knowledge.v_published_templates TO nuzm_app, nuzm_worker, nuzm_readonly_reporting;
