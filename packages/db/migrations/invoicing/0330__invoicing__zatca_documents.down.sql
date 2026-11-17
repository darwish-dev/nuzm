-- DEV ONLY. Production is forward-fix (e-invoice documents are legal records and are never dropped).
DROP TABLE IF EXISTS invoicing.zatca_documents;
DROP FUNCTION IF EXISTS invoicing.zatca_chain_tip(uuid, text);
DROP FUNCTION IF EXISTS invoicing.zatca_chain(uuid, text);
DROP FUNCTION IF EXISTS invoicing.zatca_document_guard();
DROP FUNCTION IF EXISTS invoicing.zatca_no_truncate();
