# Runbook: rebuild projections (wallet balances, usage aggregates)

Projections are derived data. The ledger and the raw usage events are the truth; a projection can always be rebuilt.

## Wallet balances
- Maintained by the worker consumer for the outbox topic `ledger.posted` (calls `billing.refresh_wallet(org)`).
- Symptoms of drift: `wallet_balances` differs from the ledger sum (see `ledger-inspection.md`), or the outbox backlog for `ledger.posted` is growing.
- Fix: check worker health and the outbox backlog first. To rebuild one organization, run `SELECT billing.refresh_wallet('<org-uuid>');` in that organization's context. It recomputes from postings under a row lock, so it is safe to run repeatedly and while traffic continues.
- Verify with the drift query in `ledger-inspection.md`.

## Usage aggregates
See `metering-replay.md` (`metering.aggregate` / `verify_aggregates`).

## Never
Do not truncate or hand-edit a projection table, and do not rebuild from a backup of the projection. Rebuild from events/postings.
