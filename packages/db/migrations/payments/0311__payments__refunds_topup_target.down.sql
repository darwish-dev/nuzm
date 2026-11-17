-- DEV ONLY. Production is forward-fix (refunds are financial records and are never dropped).
DROP TABLE IF EXISTS payments.refunds;
DROP FUNCTION IF EXISTS payments.refund_guard();
DROP FUNCTION IF EXISTS payments.refund_no_truncate();
DROP INDEX IF EXISTS payments.payment_intents_topup_idx;
ALTER TABLE payments.payment_intents DROP CONSTRAINT IF EXISTS payment_intents_target_chk;
ALTER TABLE payments.payment_intents DROP COLUMN IF EXISTS wallet_topup_id;
DELETE FROM payments.payment_intents WHERE invoice_id IS NULL;
ALTER TABLE payments.payment_intents ALTER COLUMN invoice_id SET NOT NULL;
