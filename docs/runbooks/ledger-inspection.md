# Runbook: ledger inspection

Scope: `billing.ledger_accounts`, `ledger_transactions`, `ledger_postings` (append-only), wallet projection `wallet_balances`.
Status: written against S05/S06; the read paths are covered by `ledger.int.spec.ts` and `billing.int.spec.ts`.

## Principles
- Only `billing.post()` writes the ledger. There is no UPDATE/DELETE path, even for the table owner. Never try to "fix" a row.
- A wrong entry is corrected by a **reversing entry** that references the original (see `reversing-adjustment.md`).
- Amounts are integer minor units + ISO currency. Do not convert or round in queries.

## Inspect through the API (preferred)
- Customer view: `GET /v1/billing/ledger`, `GET /v1/billing/balance` (permission `billing:read`).
- Finance/admin: `GET /v1/admin/billing/ledger-accounts`, `GET /v1/admin/billing/ledger-transactions` (permission `admin:billing:read`; every read is audited).

## Inspect in SQL (break-glass or reporting role only; see `break-glass-draft.md`)
```sql
-- is every transaction balanced per currency? (must return no rows)
SELECT transaction_id, currency,
       sum(CASE direction WHEN 'debit' THEN amount_minor ELSE -amount_minor END) AS net
  FROM billing.ledger_postings GROUP BY 1,2 HAVING sum(CASE direction WHEN 'debit' THEN amount_minor ELSE -amount_minor END) <> 0;

-- wallet projection vs ledger (must return no rows; the projection is rebuildable). Wallet liability = account 2100.
SELECT w.org_id, w.currency, w.balance_minor AS projected, l.ledger_minor
  FROM billing.wallet_balances w
  LEFT JOIN (
    SELECT a.org_id, a.currency,
           sum(CASE WHEN p.direction = 'credit' THEN p.amount_minor ELSE -p.amount_minor END) AS ledger_minor
      FROM billing.ledger_accounts a JOIN billing.ledger_postings p ON p.account_id = a.id
     WHERE a.code = '2100' GROUP BY 1,2) l USING (org_id, currency)
 WHERE l.ledger_minor IS DISTINCT FROM w.balance_minor;
```
A returned row means the projector lagged or failed: follow `rebuild-projections.md`; do **not** edit the projection by hand.

## Idempotency keys
Each transaction has a unique `(org_id, idempotency_key)`. A replayed request returns the original transaction (`duplicate`). Provider-cost accruals use `cost:<account>:<lineRef>`.
