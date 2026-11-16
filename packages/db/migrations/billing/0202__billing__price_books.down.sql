-- Dev/staging reversal only (price books are reference data; production is forward-fix).
DELETE FROM tenancy.role_permissions WHERE permission IN ('admin:billing:publish','admin:meters:manage');
DELETE FROM tenancy.permissions WHERE name IN ('admin:billing:publish','admin:meters:manage');
DROP TABLE IF EXISTS billing.price_items, billing.price_book_versions, billing.price_books CASCADE;
DROP FUNCTION IF EXISTS billing.price_version_immutable(), billing.price_item_frozen();
