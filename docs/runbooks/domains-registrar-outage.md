# Runbook — registrar outage (5xx, 429 storm, maintenance)

Vendor behaviour is **NOT VERIFIED**; the signals below are what our adapters classify from the vendors' documented error codes/messages (`docs/adapters/*.md`).

## Signals
* Search answers `unknown`/503, orders sit in `authorized` with backoff, `registrar.account` health `unhealthy` after a probe, or the account circuit breaker is **open** (`circuit_open`; 5 consecutive uncertain/outage results; half-opens after 30 s).
* Openprovider: codes 4005/340/10/17/3005/3006 and `maintenance: true` are outages; 50/4007/10005 are rate limits (4007 blocks identical create calls for 5 minutes: do **not** hammer).
* ResellerClub documents no codes: classification is by message text (`Unable to connect…`, `Too many requests…`) — an assumption.

## What the platform does by itself
* Search never reports an unknown answer as available; blocked/unknown names are not purchasable.
* A refused call (breaker open, local rate limit) was **never sent**: its failure is definitive, funds are released, the customer may retry.
* A timeout after a call was sent is `uncertain` → `needs_reconcile` (see `domains-reconcile.md`). Nothing is retried blindly; renewals are guarded by the expiry baseline so a replay cannot renew twice.

## Operator steps
1. Confirm on the registrar's status page / support channel (outside this system). Do not disable safeguards.
2. If the outage is long, disable selling for that account: Admin → Domains → Registrars. (No enable/disable endpoint exists beyond verification; set `domains.registrar_accounts.enabled=false` through a reviewed change.) With the only account disabled, quotes answer `422 unsupported_capability`; existing domains keep working.
3. When the registrar is back: **Verify account** (read-only probe) to refresh the capability matrix and health, then run the reconciliation sweep so parked orders finish.
4. Drill (M12): inject `outage`/`rate_limit` faults with the mock registrar and confirm the orders end terminal within 15 minutes (`domains-orders.int.spec.ts`, AC-M07-03 test).
