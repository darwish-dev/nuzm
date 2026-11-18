-- DEV ONLY. Production is forward-fix: contact data is personal data and is removed by retention/DSR handlers, never by dropping the table.
DROP TABLE IF EXISTS domains.domain_transfers;
DROP TABLE IF EXISTS domains.domain_contacts;
