-- DEV ONLY. Production is forward-fix.
UPDATE cloud.providers SET key = 'cloudpanel', adapter_id = 'cloudpanel-node' WHERE key = 'hestia';
