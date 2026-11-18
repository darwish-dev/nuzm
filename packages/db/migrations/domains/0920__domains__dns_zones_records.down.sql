-- DEV ONLY. Production is forward-fix: zones and records are customer configuration and are never dropped there.
DROP TABLE IF EXISTS domains.dns_records;
DROP TABLE IF EXISTS domains.dns_zones;
