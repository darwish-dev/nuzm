-- DEV/STAGING ONLY. Production is forward-fix (resources and reconciliation history are operational records).
ALTER TABLE cloud.provider_jobs DROP COLUMN IF EXISTS subject_id;
DELETE FROM cloud.provider_jobs WHERE kind = 'reconcile';
ALTER TABLE cloud.provider_jobs DROP CONSTRAINT IF EXISTS provider_jobs_kind_check;
ALTER TABLE cloud.provider_jobs ADD CONSTRAINT provider_jobs_kind_check CHECK (kind IN ('verification','catalog_sync'));
DROP TABLE IF EXISTS cloud.resource_reconciliations;
DROP TABLE IF EXISTS cloud.resources;
DROP FUNCTION IF EXISTS cloud.resource_guard();
DROP TABLE IF EXISTS cloud.routing_rules;
