-- DEV/STAGING ONLY. Production uses forward fixes: quotes, orders and authorizations are financial records.
DROP TABLE IF EXISTS commerce.authorizations;
DROP TABLE IF EXISTS commerce.order_items;
DROP TABLE IF EXISTS commerce.orders;
DROP TABLE IF EXISTS commerce.quote_items;
DROP TABLE IF EXISTS commerce.quotes;
DROP FUNCTION IF EXISTS commerce.order_guard();
DROP FUNCTION IF EXISTS commerce.deny_record_mutation();
DROP FUNCTION IF EXISTS commerce.deny_quote_mutation();
DELETE FROM tenancy.role_permissions WHERE permission IN ('quote:create','quote:read');
DELETE FROM tenancy.permissions WHERE name IN ('quote:create','quote:read');
DROP SCHEMA IF EXISTS commerce;
