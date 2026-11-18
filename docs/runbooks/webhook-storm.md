# Runbook — webhook storm (duplicates, floods, out-of-order) (M12 S57)

Status: DRAFT 2026-11-18. NOT VERIFIED against any real provider (only the sandbox PSP, mock registrar and mock email adapters exist; D-10, HG-03-02, HG-07-01, HG-08-01 PENDING). Behaviours below are taken from `spec/openapi/openapi.yaml` and the payments runbook.

## Purpose
Keep money, state and suppression lists correct when a provider re-delivers the same event many times, delivers out of order, or when a flood of requests (genuine or hostile) hits a webhook endpoint.

## Receivers and their documented behaviour
| Endpoint | Authentication and dedupe |
|---|---|
| `POST /v1/webhooks/payments/{provider}` | Signature over the raw body, 5-minute replay window (401 otherwise); durable insert deduplicated by (provider, event id); a duplicate is 200 and changes nothing; processing transactional and idempotent: one ledger effect per business event |
| `POST /v1/webhooks/registrars/{provider}` | HMAC over the raw body, 5-minute replay window (409 outside it, 401 bad signature); duplicate event id answers 200 `{outcome: duplicate}` |
| `POST /v1/webhooks/email/{provider}` | Signature and replay window; duplicate provider event id is a no-op (one event, one suppression, one meter) |
| `POST /v1/webhooks/cloud/{provider}` | No adapter supports webhooks yet: every provider answers 404 and nothing is stored |

## Trigger / alert
Spike in webhook request rate or in 401/409 responses; a growing set of stored-but-unprocessed payment events; a provider notifying us of a retry storm; wallet or ledger drift reported by RC-01/RC-02/RC-06; a customer paid twice complaint.

## Severity guidance (proposal)
SEV1 if any duplicate monetary effect is observed (ledger or PSP) or the endpoint is down during a payment window; SEV2 for a flood causing latency or processing lag; SEV3 for out-of-order events handled correctly but needing finance review.

## Preconditions / access
Admin realm with MFA: finance (`admin:billing:read`) to read `GET /v1/admin/billing/payments/{id}/events`; platform admin and security for edge controls. Edge rate limiting or WAF configuration is not in this repository: to be confirmed with the infrastructure owner.

## Steps
1. **Classify the traffic.** Many 401: forged or mis-keyed requests (attack or a wrong secret after rotation). Many 200 duplicates: a provider retry storm. Many 409 on registrars: stale replays. Identify the source provider.
2. **Never relax verification.** Do not disable signature or replay checks to "get through" a backlog.
3. **Forged flood:** block or rate-limit at the edge (infrastructure owner); keep returning 401. Treat as a security event (`incident-response.md`, SEV by impact; security officer).
4. **Genuine duplicate storm:** the receivers already return 200 with no effect. Watch API and database load; scale or shed at the edge if needed. Ask the provider to slow retries (record the contact in the incident).
5. **Stored but unprocessed events** (payments): the sweeper `PaymentService.processPending()` re-runs them (scheduled with the S12 reconciliation, `BILLING_SCHEDULER_INTERVAL_SECONDS`). Check that the scheduler is running.
6. **Out-of-order events:** ignored by event time and state machine. A "succeeded" after a recorded failure is stored as failed event `succeeded_after_terminal_failure` for finance; it never reverses anything automatically. Finance decides with the PSP (`psp-incident.md`).
7. **Amount mismatch** between event and intent: not captured; finance reviews.
8. **After the storm:** run RC-01, RC-02 and RC-06 for the window (`POST /v1/admin/billing/reconciliations`) and confirm 0 duplicate effects (`reconciliation-variance.md`). For email, check the suppression list has one entry per address and reason (`suppression-handling.md`).

## Verification
One ledger transaction per business event (RC-02 clean); wallet projection equals the ledger (RC-06); no unprocessed stored events remain; suppression rows unique per organization, address hash and reason; endpoint latency normal. M12 target: duplicate or out-of-order events x50 produce 0 duplicate effects (chaos drill).

## Escalation
L2 on-call engineer; finance lead for any monetary doubt; security officer for forged traffic; provider contact (to be filled) for retry behaviour.

## Communication draft
Customer-facing only if an effect was visible (for example a double notice):
EN: "You may have received duplicate notifications about [payment/event] on [date]. Your balance and invoices are correct and you were not charged twice. Reference: [incident id]."
AR: "ربما وصلتكم إشعارات مكرّرة بشأن [الدفعة/الحدث] بتاريخ [التاريخ]. رصيدكم وفواتيركم صحيحة ولم يُخصم منكم أكثر من مرة. المرجع: [رقم الحادثة]."
Do not send this unless finance confirmed the statement with RC-01/RC-02 results.

## Records to keep
Incident timeline with request counts by status class and provider; event ids of anomalies (not payloads); RC-01/02/06 run ids and results; finance decisions on late-success events.

## Last exercised
NOT EXERCISED (drill pending, AC-M12-18). Planned drill: duplicate and out-of-order webhooks x50 for PSP, registrar and email on the mock adapters.
