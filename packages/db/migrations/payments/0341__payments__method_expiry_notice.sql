-- M03 S12b: card-expiry notices. One notice per method: the date it was sent is recorded on the method (the notification table hides other users' rows
-- from the producer, so it cannot be used to deduplicate). Only this column is added to what a method may change.
ALTER TABLE payments.payment_methods ADD COLUMN expiry_notified_at date;
CREATE OR REPLACE FUNCTION payments.method_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payment methods are never deleted (they are marked removed)' USING ERRCODE = 'check_violation'; END IF;
  IF (to_jsonb(NEW) - 'status' - 'is_default' - 'removed_at' - 'expiry_notified_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'is_default' - 'removed_at' - 'expiry_notified_at') THEN
    RAISE EXCEPTION 'a payment method is immutable except its status and default flag' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.status = 'removed' THEN RAISE EXCEPTION 'a removed payment method cannot change' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  RETURN NEW;
END $$;
GRANT UPDATE (expiry_notified_at) ON payments.payment_methods TO nuzm_app, nuzm_worker;
-- Cross-organization work list: active methods that expire within p_days (or already did) and have not been told about.
CREATE FUNCTION payments.methods_expiring(p_today date, p_days int, p_limit int) RETURNS TABLE (org_id uuid, method_id uuid, last4 text, exp_month int, exp_year int)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.org_id, m.id, m.last4::text, m.exp_month, m.exp_year FROM payments.payment_methods m
   WHERE m.status = 'active' AND m.expiry_notified_at IS NULL
     AND (make_date(m.exp_year, m.exp_month, 1) + interval '1 month' - interval '1 day')::date <= p_today + p_days
   ORDER BY m.created_at LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION payments.methods_expiring(date, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION payments.methods_expiring(date, int, int) TO nuzm_app, nuzm_worker;
