-- M01 forward fix (found while reviewing M02 scope checks): with NO scope GUC set, `current_setting(...) = 'admin'` and
-- `p_chain = nullif(...)::uuid` are NULL, so `NOT (NULL OR NULL)` is NULL and the guard did not raise. An unscoped caller
-- could therefore learn whether any chain verifies (a boolean, no content). Rewritten with coalesce so no scope = refused.
CREATE OR REPLACE FUNCTION audit.verify_chain(p_chain uuid)
RETURNS TABLE (ok boolean, checked bigint, first_bad_seq bigint, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r audit.audit_logs;
  expected_prev text := repeat('0', 64);
  expected_seq bigint := 1;
  n bigint := 0;
  head record;
BEGIN
  IF NOT coalesce(current_setting('app.platform_scope', true) = 'admin'
          OR p_chain = nullif(current_setting('app.org_id', true), '')::uuid, false) THEN
    RAISE EXCEPTION 'verify_chain: chain not in scope' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR r IN SELECT * FROM audit.audit_logs WHERE chain_key = p_chain ORDER BY chain_seq LOOP
    n := n + 1;
    IF r.chain_seq <> expected_seq THEN
      RETURN QUERY SELECT false, n, expected_seq, 'sequence gap (row missing or reordered)'; RETURN;
    END IF;
    IF r.prev_hash <> expected_prev THEN
      RETURN QUERY SELECT false, n, r.chain_seq, 'prev_hash does not match the previous row'; RETURN;
    END IF;
    IF r.hash <> audit.row_hash(r) THEN
      RETURN QUERY SELECT false, n, r.chain_seq, 'row content does not match its hash'; RETURN;
    END IF;
    expected_prev := r.hash;
    expected_seq := r.chain_seq + 1;
  END LOOP;
  SELECT last_seq, last_hash INTO head FROM audit.chain_heads WHERE chain_key = p_chain;
  IF FOUND AND (head.last_seq <> n OR head.last_hash <> expected_prev) THEN
    RETURN QUERY SELECT false, n, n + 1, 'chain tip does not match chain_heads (tail truncated?)'; RETURN;
  END IF;
  IF NOT FOUND AND n > 0 THEN
    RETURN QUERY SELECT false, n, 1::bigint, 'rows exist without a chain head'; RETURN;
  END IF;
  RETURN QUERY SELECT true, n, NULL::bigint, NULL::text;
END $$;
