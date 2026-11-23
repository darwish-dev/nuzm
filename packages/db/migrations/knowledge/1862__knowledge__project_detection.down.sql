-- DEV/STAGING ONLY. Production is forward-fix: manifests and analysis results are evidence. Documented reversal of 1862 (SCR-K-03).
DROP TRIGGER IF EXISTS worker_derived_guard ON knowledge.analysis_results;
DROP TRIGGER IF EXISTS worker_derived_guard ON knowledge.resource_manifests;
DROP FUNCTION IF EXISTS knowledge.worker_derived_guard();
REVOKE INSERT ON knowledge.resource_manifests, knowledge.analysis_results FROM nuzm_worker;
DROP POLICY IF EXISTS worker_knowledge ON knowledge.analysis_results;
DROP POLICY IF EXISTS worker_knowledge ON knowledge.resource_manifests;
ALTER TABLE knowledge.analysis_results DROP CONSTRAINT IF EXISTS analysis_results_size;
ALTER TABLE knowledge.resource_manifests DROP CONSTRAINT IF EXISTS resource_manifests_size;
