-- S-K7 customer templates (ADR-065 point 11, SCR-K-01 §3, SCR-K-08): what a customer may read of the platform library, and the one road by which a template's files can be copied.
--  * `v_published_templates` (S-K1) is the ONLY surface through which a customer sees a platform resource. Its design summary was never filled (it read a key S-K4 does not write):
--    it now carries a SAFE summary of the Design DNA (modes, traits, role colours, font families, base unit: no file paths, no evidence) plus capability NAMES, a component COUNT
--    and the SPDX licence for attribution. Still no file content, no object key, no manifest excerpt, no path.
--  * `v_template_copy_files` is the road for `from-template`: the stored text files of ONE version, visible only while the request's transaction names that version
--    (`app.template_copy_version`, set by the service after it re-checked eligibility) AND the version is still ACTIVE, ALLOWED, published and reuse-permitted. Without the setting the
--    view is empty; with a version that is not eligible it is empty. Object keys are for the server, never returned to a customer.
--  * A customer's recommendation and copy events are `usage_events` of its own organization (RLS org_isolation); the platform sees them for analytics, nobody else does.
CREATE OR REPLACE VIEW knowledge.v_published_templates WITH (security_barrier = true) AS
  SELECT r.id AS resource_id, v.id AS version_id, v.seq AS version_seq, v.semver, r.org_id, r.name, r.description, r.resource_type, r.platform, r.frameworks,
         r.languages, r.category, r.tags, p.reuse_scope, p.component_reuse, p.starter_eligible, p.architecture_reference, p.license_verdict,
         (SELECT jsonb_build_object(
                   'modes', d.p -> 'modes',
                   'traits', d.p -> 'traits',
                   'roles', coalesce((SELECT jsonb_agg(jsonb_build_object('role', x ->> 'role', 'hex', x ->> 'hex')) FROM jsonb_array_elements(d.p -> 'palette' -> 0 -> 'roles') x), '[]'::jsonb),
                   'families', coalesce((SELECT jsonb_agg(f ->> 'value') FROM (SELECT f FROM jsonb_array_elements(d.p -> 'typography' -> 'families') f LIMIT 4) y), '[]'::jsonb),
                   'baseUnit', d.p -> 'spacing' -> 'baseUnit')
            FROM (SELECT (a.result -> 'projects') -> coalesce((a.result ->> 'primary')::int, 0) AS p
                    FROM knowledge.analysis_results a WHERE a.version_id = v.id AND a.analyzer = 'design-dna' ORDER BY a.created_at DESC LIMIT 1) d
           WHERE d.p IS NOT NULL) AS design_dna,
         (SELECT coalesce(jsonb_agg(tv.preview_key ORDER BY tv.name) FILTER (WHERE tv.preview_key IS NOT NULL), '[]'::jsonb)
            FROM knowledge.theme_variants tv WHERE tv.version_id = v.id) AS preview_keys,
         (SELECT count(*)::int FROM knowledge.resource_components rc WHERE rc.version_id = v.id) AS component_count,
         p.license_spdx,
         (SELECT coalesce(jsonb_agg(jsonb_build_object('name', sub.n)), '[]'::jsonb)
            FROM (SELECT c ->> 'name' AS n FROM knowledge.resource_manifests m, jsonb_array_elements(m.manifest -> 'capabilities') c
                   WHERE m.version_id = v.id AND m.schema_version = (SELECT max(m2.schema_version) FROM knowledge.resource_manifests m2 WHERE m2.version_id = v.id)
                     AND jsonb_typeof(m.manifest -> 'capabilities') = 'array' LIMIT 40) sub
           WHERE sub.n IS NOT NULL) AS capabilities
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

CREATE VIEW knowledge.v_template_copy_files WITH (security_barrier = true) AS
  SELECT r.id AS resource_id, v.id AS version_id, f.path, f.sha256, f.bytes, f.language, f.is_binary, f.object_key
    FROM knowledge.resources r
    JOIN knowledge.resource_versions v ON v.resource_id = r.id AND v.state = 'ACTIVE'
    JOIN knowledge.resource_permissions p ON p.resource_id = r.id
    JOIN knowledge.resource_files f ON f.version_id = v.id
   WHERE r.deleted_at IS NULL AND r.org_id IS NULL AND r.visibility = 'PLATFORM_PUBLISHED' AND r.status = 'ACTIVE'
     AND v.license_verdict = 'ALLOWED' AND p.license_verdict = 'ALLOWED' AND p.reuse_scope <> 'NONE'
     AND f.object_key IS NOT NULL AND NOT f.is_binary
     AND current_setting('app.template_copy_version', true) = v.id::text;
GRANT SELECT ON knowledge.v_template_copy_files TO nuzm_app;
