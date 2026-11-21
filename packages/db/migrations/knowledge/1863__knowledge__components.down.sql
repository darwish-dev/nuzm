-- DEV/STAGING ONLY. Production is forward-fix: components and relationships are derived evidence. Documented reversal of 1863 (SCR-K-04).
DROP TRIGGER IF EXISTS worker_derived_guard ON knowledge.resource_relationships;
DROP TRIGGER IF EXISTS worker_derived_guard ON knowledge.resource_components;
REVOKE INSERT ON knowledge.resource_components, knowledge.resource_relationships FROM nuzm_worker;
DROP POLICY IF EXISTS worker_knowledge ON knowledge.resource_relationships;
DROP POLICY IF EXISTS worker_knowledge ON knowledge.resource_components;
DROP INDEX IF EXISTS knowledge.resource_relationships_natural_idx;
DROP INDEX IF EXISTS knowledge.resource_components_natural_idx;
