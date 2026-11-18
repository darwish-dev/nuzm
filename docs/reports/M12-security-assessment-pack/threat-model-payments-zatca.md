# Threat model: payments, ledger, invoicing and ZATCA e-invoicing (M03)

> INTERNAL self-assessment, 2026-11-18. NOT independent (HG-12-01 / D-28 BLOCKED).
>
> **Evidence base is a mock PSP and a simulated e-invoicing server.** No real PSP (HG-03-02, D-10) and no ZATCA environment (HG-03-03, D-11) has been contacted; the e-invoice profile is synthetic and is `NOT VERIFIED vs ZATCA`. Production clearance is `BLOCKED (HG-03-03)`; tax sign-off is `BLOCKED (HG-03-04)`. See `docs/reports/M03-gate-review.md`.

## 1. Scope and assets

Modules: `payments` (methods, payments, refunds, wallet top-ups, webhooks), `billing` (ledger, quotas, spend, adjustments, dunning), `invoicing` (invoices, credit notes, tax, ZATCA pipeline), `finrec`. Migrations `0200-0205`, `0300-0341`, `0340`.

| Asset | Why it matters |
|---|---|
| Ledger (`billing.ledger_*`) | Financial truth; append-only |
| Payment state and PSP references | Double charge, free service |
| Cardholder data (must never exist here) | PCI scope reduction |
| ZATCA credentials (CSID token/secret), private signing key | Fraudulent invoices, regulatory exposure |
| ZATCA invoice chain (ICV, PIH) and archive | Legal record integrity |
| Tax profile and billing entity data | Compliance and PII |

## 2. Trust boundaries and actors

1. Browser to API for payment actions (org billing roles only: `payments.int.spec.ts:243`).
2. PSP to API via public webhook, authenticated only by signature over the raw body plus replay window (`payments/webhooks.controller.ts`).
3. API to PSP and API to e-invoicing service via adapter interfaces (ADR-011, ADR-014); results can be `uncertain`.
4. Finance staff to admin console (admin realm, MFA, step-up; separate approver for adjustments).
5. API to vault for ZATCA secrets (references only).
- Actors: customer attempting free service or card-data submission, attacker forging webhooks, finance insider, compromised support account, network attacker replaying events, a malicious or misbehaving PSP/ZATCA response, a DB-level attacker.

## 3. Threats and mitigations

| ID | STRIDE | Threat | Existing mitigation (verified to exist) | Status | Residual risk | Proposed test |
|---|---|---|---|---|---|---|
| PZ-01 | S/T | Forged PSP webhook marks an invoice paid | Signature over raw bytes (HMAC, constant-time compare) and a replay window; unknown provider 404; bad signature/replay answer 401 (`payments/internal/psp/mock-psp.ts`, `payment.service.ts` `handleWebhook`; test `payments.int.spec.ts:561`) | NOT VERIFIED (mock verifier only; the real PSP scheme is unknown) | Real provider scheme, header names and secret rotation untested | Forged/tampered/stale event suite with the real PSP sandbox key (HG-03-02) |
| PZ-02 | T | Duplicate or out-of-order webhooks double-post money | Unique `(psp, event_id)` with a duplicate counter (`migrations/payments/0310`, `0312`); 100 parallel deliveries give one ledger effect; business-fact dedupe; out-of-order and late-success cases (`payments.int.spec.ts:606-684`) | PASS (mock events) | Real delivery semantics | Webhook storm x50 per provider (AC-M12-07) |
| PZ-03 | T | Double charge after a timeout | Reconcile-before-retry; one new attempt only when the PSP has no record (`payments.int.spec.ts:434,461,773`) | PASS (mock) / NOT VERIFIED live | Real PSP lookup semantics | Lost-reply fault injection against sandbox |
| PZ-04 | I | Card data stored or logged (PCI scope) | Card-number/field detection (Luhn) rejects with 422 `pan_not_allowed` (`payments/internal/pan.ts`, `payments.int.spec.ts:161`); DB refuses card-like values (`:309`); webhook payload stored as a whitelist (`:700`); `pnpm scan:secrets` fails on Luhn-valid numbers in the repo | PASS | PSP tokenisation flow is the mock's; any real hosted-field integration must be re-reviewed | Fuzz all POST bodies for card-like strings |
| PZ-05 | T/R | Ledger tampering or unbalanced entries | Append-only triggers on ledger tables for everyone including owner; balanced-at-COMMIT constraint trigger; only `billing.post` (SECURITY DEFINER, `REVOKE ALL FROM PUBLIC`) writes; runtime roles cannot INSERT/UPDATE/DELETE directly (`migrations/billing/0200`; `billing/ledger.int.spec.ts:152,184,197,225`) | PASS | A DB superuser can disable triggers; backups/WORM not evidenced | Role-privilege audit in staging; periodic ledger hash/tie-out (RC jobs, S57) |
| PZ-05b | T | Race: overdraw or over-refund | 50 parallel consumes against 1000 give exactly 10 successes; concurrent refunds cannot exceed captured (`ledger.int.spec.ts:336`, `refunds-topups.int.spec.ts:338`) | PASS | - | Load test ledger >= 200 tx/s (AC-M12-06) |
| PZ-06 | E | Unauthorised refund or manual adjustment by insider | Refund is finance-only (`refunds-topups.int.spec.ts:241`); manual adjustments need a request and a different approver with `admin:billing:approve`, step-up, idempotency (`billing/admin-adjustments.controller.ts`) | PASS | Collusion of two finance users; thresholds for second approval not seen | Pen test of admin finance flows; separation-of-duty test |
| PZ-07 | E | Customer bypasses spend/quota controls | Spend and quota services with tests (`billing/quotas-spend.int.spec.ts`, `commerce.int.spec.ts`); metering emits only through the central pipeline | NOT VERIFIED (concurrency at scale untested) | Boundary races at quota edge | 20 parallel creates at the quota edge |
| PZ-08 | T | Invoice altered after issue | `invoice_guard` / `invoice_lines_immutable` / `credit_note_guard` triggers, no truncate; corrections are credit notes (`migrations/invoicing/0301`; `invoicing/invoice-state.spec.ts`, `invoices.int.spec.ts`) | PASS | Same DB-privileged caveat as PZ-05 | As PZ-05 |
| PZ-09 | T | Broken or forked ZATCA invoice chain (ICV/PIH), duplicate documents | Chain enforced in the database; ICV unique and consecutive under 20 concurrent generations; bodies, stamps and links immutable, never deleted (`migrations/invoicing/0330`; `invoicing/zatca.int.spec.ts:202,396`) | NOT VERIFIED vs ZATCA (synthetic profile; official C14N not implemented, see `zatca/hash-chain.ts` header) | Real acceptance rules unknown | Re-run against a ZATCA sandbox (HG-03-03) |
| PZ-10 | I/E | ZATCA credentials or private key leakage | Values in a vault by reference; dev file store refuses a production profile and never overwrites (`invoicing/internal/zatca/secrets.ts`); OTP and secrets not echoed in responses/logs (`zatca-queue.int.spec.ts:261`); CSR requester cannot approve (`:232`) | NOT VERIFIED for production | Production vault `BLOCKED (D-12)`; key custody and rotation unbuilt (`docs/runbooks/zatca-key-rotation.md`) | Key-handling review once the vault exists |
| PZ-11 | R | Duplicate or lost ZATCA submission | Lost answer reconciled by lookup, never resubmitted; rejected documents are final; dead letter after backoff; retries idempotent (`zatca-queue.int.spec.ts:473,543,555`) | NOT VERIFIED (simulated server) | Real error and rate-limit behaviour | Clock-skew-on-submit drill (M12 §11) |
| PZ-12 | S | Production submission attempted from a non-production setup | Simulation has its own chain; service off by default and refuses production (`zatca.int.spec.ts:270`); onboarding steps refuse other environments (`zatca-queue.int.spec.ts:205`); `pnpm zatca:guard` | PASS | A config change could enable it; HG-03-03 is the human gate | Config review at go-live; `zatca:guard` stays in CI |
| PZ-13 | I | Tax profile / buyer data exposure | Tax profile sealed (field encryption, `migrations/invoicing/0503`, `tax-profile-sealed.int.spec.ts`); RLS | NOT VERIFIED (classification of buyer name/VAT in admin invoice list flagged in the M03 gate review) | Admin list exposure pending M04 classification | Admin read-path review |
| PZ-14 | T | Rating/price manipulation | Price books versioned and immutable; money as integer minor units, no floats (`migrations/billing/0202`, `common/rating.ts`, `rating.spec.ts`) | PASS | Price-book approval is human (HG-02-01) | Fuzz rating with large/odd quantities |
| PZ-15 | D | Webhook flooding / queue exhaustion | Event stored first, processed after; `processPending` re-runs unprocessed events (`payments.int.spec.ts:739`); no explicit rate limit on webhook routes found | NOT VERIFIED | Unauthenticated, signature-checked CPU cost | Webhook storm test (runbook `webhook-storm.md` in flight) |
| PZ-16 | T | PDF rendering abuse via invoice fields | HTML-escaping of every dynamic field (`invoice-render.ts`, `invoice-render.spec.ts:97`) | NOT VERIFIED (renderer sandboxing: see control-plane CP-18) | Headless Chrome in-process | Injection corpus |

## 4. Residual risk

- **Highest:** everything external is simulated: PSP signature scheme, 3-D Secure, settlement, ZATCA clearance/reporting. A defect in the real integration cannot be seen yet.
- **Medium:** two-person rules rely on the same admin realm; DB-privilege assumptions depend on the (undecided) production role setup and backups.
- **Accepted (documented):** periodic billing jobs run in the API process and are off by default (ADR-017, Proposed); notices are in-app only.

## 5. Dependencies

HG-03-02 (PSP sandbox), HG-03-03 (ZATCA documents/OTP), HG-03-04 (tax advisor), D-10, D-11, D-12, HG-12-01.
