-- DEV ONLY. Production is forward-fix.
DROP FUNCTION IF EXISTS payments.methods_expiring(date, int, int);
ALTER TABLE payments.payment_methods DROP COLUMN IF EXISTS expiry_notified_at;
CREATE OR REPLACE FUNCTION payments.method_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payment methods are never deleted (they are marked removed)' USING ERRCODE = 'check_violation'; END IF;
  IF (to_jsonb(NEW) - 'status' - 'is_default' - 'removed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'is_default' - 'removed_at') THEN
    RAISE EXCEPTION 'a payment method is immutable except its status and default flag' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.status = 'removed' THEN RAISE EXCEPTION 'a removed payment method cannot change' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  RETURN NEW;
END $$;
