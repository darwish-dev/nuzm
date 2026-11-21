-- DEV/STAGING ONLY. Production is forward-fix: search documents are derived and engine setting revisions are audit evidence. Documented reversal of 1865 (SCR-K-07).
DROP TABLE IF EXISTS knowledge.engine_setting_revisions;
DROP TABLE IF EXISTS knowledge.engine_settings;
DROP TRIGGER IF EXISTS worker_derived_guard ON knowledge.resource_search_documents;
REVOKE INSERT ON knowledge.resource_search_documents FROM nuzm_worker;
DROP POLICY IF EXISTS worker_knowledge ON knowledge.resource_search_documents;
