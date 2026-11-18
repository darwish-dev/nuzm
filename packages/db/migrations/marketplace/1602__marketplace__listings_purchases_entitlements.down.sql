-- DEV ONLY. Production is forward-fix: purchases, entitlements and accruals are financial evidence and are never dropped.
DROP VIEW IF EXISTS marketplace.v_entitlements;
DROP TABLE IF EXISTS marketplace.publisher_accruals, marketplace.installations, marketplace.entitlements_mkt, marketplace.purchases, marketplace.moderation_cases,
  marketplace.listing_versions, marketplace.listings, marketplace.publisher_accounts CASCADE;
DROP FUNCTION IF EXISTS marketplace.installation_guard(), marketplace.purchase_guard(), marketplace.version_guard(), marketplace.touch();
DELETE FROM tenancy.role_permissions WHERE permission IN ('marketplace:read','marketplace:buy','marketplace:install','marketplace:publish','admin:marketplace');
DELETE FROM tenancy.permissions WHERE name IN ('marketplace:read','marketplace:buy','marketplace:install','marketplace:publish','admin:marketplace');
