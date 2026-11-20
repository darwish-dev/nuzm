-- DEV/STAGING ONLY. Production is forward-fix: versions, files, manifests, analysis results, quality scores, usage events and generation evidence are evidence
-- and are not dropped. Documented reversal of 1860 (ADR-065 / SCR-K-01).
DROP VIEW IF EXISTS knowledge.v_published_templates;
DROP TABLE IF EXISTS knowledge.generation_evaluations;
DROP TABLE IF EXISTS knowledge.generation_resource_links;
DROP TABLE IF EXISTS knowledge.generation_plans;
DROP TABLE IF EXISTS knowledge.template_defaults;
DROP TABLE IF EXISTS knowledge.theme_variants;
DROP TABLE IF EXISTS knowledge.theme_tokens;
DROP TABLE IF EXISTS knowledge.usage_events;
DROP TABLE IF EXISTS knowledge.quality_scores;
DROP TABLE IF EXISTS knowledge.analysis_results;
DROP TABLE IF EXISTS knowledge.processing_jobs;
DROP TABLE IF EXISTS knowledge.resource_search_documents;
DROP TABLE IF EXISTS knowledge.resource_relationships;
DROP TABLE IF EXISTS knowledge.resource_dependencies;
DROP TABLE IF EXISTS knowledge.resource_components;
DROP TABLE IF EXISTS knowledge.resource_manifests;
DROP TABLE IF EXISTS knowledge.resource_permissions;
DROP TABLE IF EXISTS knowledge.resource_files;
DROP TABLE IF EXISTS knowledge.resource_versions;
DROP FUNCTION IF EXISTS knowledge.resource_version_guard();
DROP TABLE IF EXISTS knowledge.resources;
DROP FUNCTION IF EXISTS knowledge.resource_guard();
DROP TABLE IF EXISTS knowledge.uploads;
DROP FUNCTION IF EXISTS knowledge.append_only();
DELETE FROM tenancy.role_permissions WHERE permission IN ('admin:ai_knowledge:read','admin:ai_knowledge:manage','admin:ai_knowledge:publish');
DELETE FROM tenancy.permissions WHERE name IN ('admin:ai_knowledge:read','admin:ai_knowledge:manage','admin:ai_knowledge:publish');
DROP SCHEMA IF EXISTS knowledge;
