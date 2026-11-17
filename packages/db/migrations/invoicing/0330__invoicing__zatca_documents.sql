-- M03 S11a: e-invoice documents (docs/11 §5, docs/05 `invoicing.zatca_documents`). SYNTHETIC profile only: every row is NOT VERIFIED vs ZATCA.
--  * One document per issued legal document and environment. The hash chain is per (billing entity, environment): icv = previous icv + 1 and
--    the document carries the previous hash (pih). The chain spans ORGANIZATIONS (the entity is the EGS unit), so the tip is read through a
--    SECURITY DEFINER function that exposes only (icv, hash), never another tenant's row.
--  * The body (xml_body, hashed) is immutable. Stamping (signature, QR, final XML) happens once, later, when credentials exist.
--  * Rows are never deleted or truncated. `production` exists as a value so the schema does not change later, and is refused by the application
--    until the owner records HG-03-03 evidence (never by this code).
CREATE TABLE invoicing.zatca_documents (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  entity_id uuid NOT NULL REFERENCES invoicing.billing_entities(id),
  environment text NOT NULL CHECK (environment IN ('sandbox','simulation','production')),
  source_type text NOT NULL CHECK (source_type IN ('invoice','credit_note')),
  source_id uuid NOT NULL,                                -- logical reference to invoicing.invoices / credit_notes
  document_type text NOT NULL CHECK (document_type IN ('invoice','credit_note','debit_note')),
  subtype text NOT NULL CHECK (subtype IN ('standard','simplified')),
  uuid uuid NOT NULL UNIQUE,
  icv bigint NOT NULL CHECK (icv >= 1),
  pih text NOT NULL CHECK (length(pih) BETWEEN 40 AND 120),
  invoice_hash text NOT NULL CHECK (length(invoice_hash) BETWEEN 40 AND 120),
  xml_body text NOT NULL,                                 -- the hashed document without QR and signature
  xml_final text,                                         -- body + QR + signature, set once at stamping
  signature text,
  public_key text,
  qr text,
  stamped_at timestamptz,
  archive_ref text,
  archive_sha256 text,
  archived_at timestamptz,
  data_region text NOT NULL DEFAULT 'sa-pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, environment, icv),
  UNIQUE (source_type, source_id, environment),
  CHECK ((xml_final IS NULL) = (stamped_at IS NULL)),
  CHECK ((xml_final IS NULL) = (signature IS NULL)),
  CHECK ((archive_ref IS NULL) = (archived_at IS NULL))
);
CREATE INDEX zatca_documents_org_idx ON invoicing.zatca_documents (org_id, created_at DESC, id);
CREATE INDEX zatca_documents_unstamped_idx ON invoicing.zatca_documents (created_at) WHERE xml_final IS NULL;

DO $$ DECLARE own text := current_user; BEGIN
  EXECUTE 'ALTER TABLE invoicing.zatca_documents ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE invoicing.zatca_documents FORCE ROW LEVEL SECURITY';
  EXECUTE format('CREATE POLICY definer_all ON invoicing.zatca_documents TO %I USING (true) WITH CHECK (true)', own);
END $$;
CREATE POLICY org_isolation ON invoicing.zatca_documents USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON invoicing.zatca_documents FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');

-- The chain tip of an entity/environment: (icv, hash) only. Callable by the runtime roles; exposes no tenant data.
CREATE FUNCTION invoicing.zatca_chain_tip(p_entity uuid, p_env text) RETURNS TABLE (icv bigint, invoice_hash text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.icv, d.invoice_hash FROM invoicing.zatca_documents d WHERE d.entity_id = p_entity AND d.environment = p_env ORDER BY d.icv DESC LIMIT 1
$$;
-- The whole chain (id-less, content-less): what the integrity check needs to prove icv continuity and pih = previous hash.
CREATE FUNCTION invoicing.zatca_chain(p_entity uuid, p_env text) RETURNS TABLE (icv bigint, pih text, invoice_hash text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.icv, d.pih, d.invoice_hash FROM invoicing.zatca_documents d WHERE d.entity_id = p_entity AND d.environment = p_env ORDER BY d.icv
$$;
REVOKE ALL ON FUNCTION invoicing.zatca_chain_tip(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION invoicing.zatca_chain(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invoicing.zatca_chain_tip(uuid, text) TO nuzm_app, nuzm_worker;
GRANT EXECUTE ON FUNCTION invoicing.zatca_chain(uuid, text) TO nuzm_app, nuzm_worker;

-- The chain is enforced by the database as well as the service: the next document continues the tip exactly.
CREATE FUNCTION invoicing.zatca_document_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE tip record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT d.icv, d.invoice_hash INTO tip FROM invoicing.zatca_documents d WHERE d.entity_id = NEW.entity_id AND d.environment = NEW.environment ORDER BY d.icv DESC LIMIT 1;
    IF tip IS NULL THEN
      IF NEW.icv <> 1 THEN RAISE EXCEPTION 'the first document of a chain has icv 1' USING ERRCODE = 'check_violation', HINT = 'chain'; END IF;
    ELSE
      IF NEW.icv <> tip.icv + 1 THEN RAISE EXCEPTION 'icv must continue the chain (expected %)', tip.icv + 1 USING ERRCODE = 'check_violation', HINT = 'chain'; END IF;
      IF NEW.pih <> tip.invoice_hash THEN RAISE EXCEPTION 'pih must be the previous document hash' USING ERRCODE = 'check_violation', HINT = 'chain'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'e-invoice documents are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  -- UPDATE: only stamping and archiving columns, each set once
  IF (to_jsonb(NEW) - 'xml_final' - 'signature' - 'public_key' - 'qr' - 'stamped_at' - 'archive_ref' - 'archive_sha256' - 'archived_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'xml_final' - 'signature' - 'public_key' - 'qr' - 'stamped_at' - 'archive_ref' - 'archive_sha256' - 'archived_at') THEN
    RAISE EXCEPTION 'an e-invoice document is immutable except stamping and archiving' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.xml_final IS NOT NULL AND (NEW.xml_final IS DISTINCT FROM OLD.xml_final OR NEW.signature IS DISTINCT FROM OLD.signature OR NEW.qr IS DISTINCT FROM OLD.qr OR NEW.public_key IS DISTINCT FROM OLD.public_key) THEN
    RAISE EXCEPTION 'a stamped document cannot be re-stamped' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.archive_ref IS NOT NULL AND (NEW.archive_ref IS DISTINCT FROM OLD.archive_ref OR NEW.archive_sha256 IS DISTINCT FROM OLD.archive_sha256) THEN
    RAISE EXCEPTION 'the archive link is set once' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zatca_document_guard BEFORE INSERT OR UPDATE OR DELETE ON invoicing.zatca_documents FOR EACH ROW EXECUTE FUNCTION invoicing.zatca_document_guard();
CREATE FUNCTION invoicing.zatca_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'e-invoice documents are never truncated' USING ERRCODE = 'check_violation', HINT = 'immutable'; END $$;
CREATE TRIGGER zatca_documents_no_truncate BEFORE TRUNCATE ON invoicing.zatca_documents FOR EACH STATEMENT EXECUTE FUNCTION invoicing.zatca_no_truncate();

GRANT SELECT, INSERT ON invoicing.zatca_documents TO nuzm_app, nuzm_worker;
GRANT SELECT ON invoicing.zatca_documents TO nuzm_readonly_reporting;
GRANT UPDATE (xml_final, signature, public_key, qr, stamped_at, archive_ref, archive_sha256, archived_at) ON invoicing.zatca_documents TO nuzm_app, nuzm_worker;
