-- DEV ONLY. Production is forward-fix (delivery logs are evidence and are never dropped).
DROP TABLE IF EXISTS automation.webhook_deliveries, automation.webhook_endpoints, automation.connector_authorizations, automation.connectors CASCADE;
DROP FUNCTION IF EXISTS automation.endpoint_guard(), automation.connector_guard();
