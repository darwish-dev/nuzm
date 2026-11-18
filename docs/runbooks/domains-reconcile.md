# Runbook — domain orders waiting on the registrar (`needs_reconcile`, `provider_pending`)

Owner: platform operations. Applies to `domains.order.register|renewal|transfer_in` operations. Vendor behaviour referenced here is **NOT VERIFIED** (HG-07-01).

## What the states mean
| Order state | Meaning | Who moves it |
|---|---|---|
| `authorized` | Funds reserved in the ledger; the operation has not reached the registrar (or is backing off after a retryable refusal). | `DomainOrderService.drain()` re-runs due operations with the SAME token. |
| `needs_reconcile` | A registrar call timed out or errored ambiguously: the effect at the registrar is **unknown**. Nothing is retried blindly. | The reconciler (`sweep()`), a webhook, or `POST /v1/admin/domains/{id}/reconciliations`. |
| `provider_pending` | The registrar accepted the order but the registry has not finished (registration `REQ`, transfer in flight). | Registrar webhook (`domain.registered`, `domain.transfer_completed`) or the sweep (polls `findByToken`/`inspect`). |
| `succeeded` / `failed` | Final. `failed` released the reservation (reversing ledger entry). | — |

## Decision table the reconciler follows
1. `findByToken` answers **present + active** → finalize (exactly one ledger *record*, one meter event, one provider-cost record; replays do nothing).
2. Present but still pending → stay `provider_pending`; look again later.
3. **Provably absent** (`succeeded` with `data: null`) → retry the provider call **once** with the same token. A second uncertain answer parks the order as `absent_exhausted` for a human (no third call).
4. Lookup itself failed → `unclear`; nothing changes; try again.

## Steps for an operator
1. Admin console → Domains → Orders → "Waiting on the registrar only". Each row shows the last order state.
2. **Force reconcile** (needs `admin:domains:manage`, MFA step-up): runs the table above for that domain and syncs the domain row with the registrar. The result list is shown (`finalized`, `pending`, `retried`, `absent_exhausted`, `unclear`, `state_synced`, `dns_*`).
3. `absent_exhausted` or an order stuck > 15 minutes with the registrar reachable: open the registrar's own order list, search by the **domain name** (Openprovider also by the `nuzm:<token>` order comment). Then either:
   * the domain exists at the registrar under our account → run the forced reconcile again (it will find it), or
   * it does not exist and the customer still wants it → ask them to re-order; the reservation of the failed order has already been released only if the order is `failed`. **Never** edit `domain_orders`/ledger rows by hand.
4. Record the outcome in the incident ticket. Audit events: `domain.order.needs_reconcile`, `domain.order.reconciled`, `domain.order.succeeded|failed`.

## Checks
* No duplicate registration: `SELECT name, count(*) FROM domains.domains WHERE state <> 'failed' GROUP BY 1 HAVING count(*) > 1` returns nothing (unique index).
* One ledger *record* per order: `SELECT source_event_id, count(*) FROM billing.ledger_transactions WHERE source_event_id LIKE 'domain-order:%:record' GROUP BY 1 HAVING count(*) > 1` returns nothing.
