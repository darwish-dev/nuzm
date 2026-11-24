-- The hosting panel provider row is HestiaCP (owner request 2026-11-24, ADR-067): the seeded `cloudpanel` row is renamed. Same id, so nothing that references it changes.
UPDATE cloud.providers SET key = 'hestia', adapter_id = 'hestia-api' WHERE key = 'cloudpanel';
