-- DEV/STAGING ONLY. Production is forward-fix (the columns hold derived records of the customer's own copies). Documented reversal of 1867 (SCR-K-09).
DROP VIEW IF EXISTS knowledge.v_template_context_permissions;
DROP INDEX IF EXISTS knowledge.generation_resource_links_project_idx;
ALTER TABLE knowledge.generation_resource_links DROP COLUMN IF EXISTS baseline, DROP COLUMN IF EXISTS project_id;
