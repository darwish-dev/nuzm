-- DEV ONLY. Production is forward-fix: install records are evidence of what ran on a customer's server and are never dropped there.
DROP TABLE IF EXISTS compute.panel_installs;
DROP TABLE IF EXISTS compute.panel_image_approvals;
ALTER TABLE compute.images DROP COLUMN IF EXISTS cloud_init;
ALTER TABLE compute.instances DROP CONSTRAINT IF EXISTS instances_hold_has_reason;
ALTER TABLE compute.instances DROP COLUMN IF EXISTS held_at, DROP COLUMN IF EXISTS hold_reason, DROP COLUMN IF EXISTS panel_kind;
ALTER TABLE compute.instances DROP CONSTRAINT IF EXISTS instances_status_check;
ALTER TABLE compute.instances ADD CONSTRAINT instances_status_check CHECK (status IN ('provisioning','running','stopped','failed','deleting','deleted','unknown'));
