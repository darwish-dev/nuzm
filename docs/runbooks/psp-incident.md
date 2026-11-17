# Runbook: payments, PSP incidents and uncertain results

Status: written against S09 (sandbox PSP `psp-mock` only; no real PSP exists until D-10 and HG-03-02), exercised in `payments.int.spec.ts`. **Nothing here has been verified against a real PSP.**

## What the platform never does
It never receives, stores, logs or forwards a card number, CVV or expiry. Payment methods come from a token the PSP's hosted fields produce; only token, brand, last4, expiry and a fingerprint are stored, and the database rejects anything card-shaped in those columns. A request that carries card data in any field or value is refused with 422 `pan_not_allowed` before anything else happens. The repository scanner fails the build on a Luhn-valid card number in any file, and a test scans every payments, invoicing, ledger, outbox and audit row.

## Reading a payment
`GET /v1/billing/payments/{id}` on an unfinished payment asks the PSP first, so the customer sees the truth even before the webhook arrives. States: `requires_action` (3-D Secure redirect in `nextAction`), `processing` (outcome unknown or pending), `succeeded`, `failed` (with `failureCode`), then refund states (S10).

## Uncertain results (timeout, dropped connection)
The charge may exist. The platform never retries blindly:
1. The attempt is recorded as `uncertain` and the payment stays `processing`.
2. Any new request to pay the same invoice, and any read of the payment, first asks the PSP about the merchant reference (`nuzm_pi_<id>`). A charge that exists is adopted (`succeeded`), never repeated.
3. Only if the PSP has NO record of the reference is one new attempt made (new attempt idempotency key).
Tested: 1,000 injected timeouts → 0 duplicate charges.

## Webhooks
`POST /v1/webhooks/payments/{provider}`: signature over the raw body and a 5-minute replay window (401 otherwise), durable insert deduplicated by (provider, event id), then transactional processing. Duplicates are 200 and change nothing. Out-of-order events are ignored by event time and by the state machine; a "succeeded" arriving after a recorded failure is stored as a failed event `succeeded_after_terminal_failure` for finance and never reverses anything automatically. An amount that does not match the intent is not captured. Events that were stored but not processed are re-run by `PaymentService.processPending()` (the worker/sweeper entry point, scheduled with the S12 reconciliation).
Event rows hold a whitelist of fields only (never the raw body) and are reachable only through the `psp_webhook` database scope.

## When a capture is half done
Capture is finalized in one transaction (state, audit, outbox event); the invoice application and the ledger posting follow with idempotent keys. If the process died in between, `completeCapture` (called on any read/reconcile of a succeeded payment) finishes it exactly once. RC-01/RC-02 (S12) report any succeeded payment without a ledger link.

## Not yet
Refunds and wallet top-ups (S10), settlement reports and RC-01 (S12), payment of quotes (M05), a real PSP adapter (D-10 + HG-03-02), production keys in the vault (D-12).
