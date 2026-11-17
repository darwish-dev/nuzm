# S10b report — Subscriptions, proration, renewal engine (M03 sprint 10, second part)

Status: implemented and verified against real PostgreSQL and the sandbox PSP (see §E). **Not committed.** S10c (dunning, scheduler, wallet-debit mode, notifications) is next.

## A. Repository findings and assumptions
- **Sprint split.** docs/06 S10 became S10a (refunds, top-ups, committed `3f64b52`), S10b (this report: subscriptions) and S10c (dunning policy and cases, the scheduler that runs renewals, wallet-debit orchestration, notices).
- **Plans carry no price (spec gap, decision made, owner to confirm).** docs/05 has no plan-fee column or table, and the price book prices *meters*. I did not invent a table. A plan's recurring fee is a **flat price item for the meter `plan.<planKey>_months`** (basis `subscription`, `-` → `_`) in the price book, frozen on the subscription when it is created or its plan changes. A plan without that price cannot be subscribed to (422). Proposal for the owner: an explicit plan-fee reference on `plan_versions`.
- **Trial config.** docs define a `trialing` state but no trial setting. `SUBSCRIPTION_TRIAL_DAYS` (default 0 = no trial, max 90), once per organization. Per-plan trials need an owner decision.
- **Proration mode.** docs/04 names `prorationMode` without values. Implemented: `prorate` (default) and `none` (switch now, no charge or credit). "Change at the next renewal" is not implemented.
- **Negative proration is a credit, not a negative line.** Invoice lines and the ledger recipes are non-negative by design, so a downgrade's unused value is stored (`pending_credit_minor`) and reduces the next renewal's line. A credit larger than the renewal covers it fully (that period has no invoice).
- **First-payment failure** leaves the subscription `past_due` with the invoice open and the plan **not** assigned (no access without payment); paying that invoice (any route) lets the next run set it `active` and assign the plan. A cleaner `incomplete` status would need a spec change.
- **Where the code lives.** The table is in the `billing` schema (docs/05). `SubscriptionService` is in the billing module and reaches invoicing, payments and payment methods only through ports wired in a small `subscriptions` module (billing never imports those modules: no import cycle). The renewal's charges are attributed in the audit log to the user who subscribed (merchant-initiated on their mandate).
- **`paused`** (flag-gated in docs/11) and **`unpaid`** transitions are not driven by anything yet (`unpaid` belongs to dunning, S10c).
- **Scheduler is still not wired** (see S10a report): `runDue` exists and is tested; who calls it periodically is the first S10c decision, because the worker cannot import API services.

## B. Plan and changed files
- Migration `billing/0321__billing__subscriptions` (+down); `spec/openapi/openapi.yaml` (+5 operations → **106**), SDK regenerated; `spec/db/ownership.yaml` unchanged (`subscriptions` was already listed).
- Code: `billing/internal/{subscription.service,subscription-period,proration}.ts`, `entitlement.service.ts` (`assignDefaultPlan`), `invoicing/internal/invoice.service.ts` (`issueSubscriptionCharge`, idempotent on the source key), `payments/internal/method.service.ts` (`assertUsable`, usage guard), `subscriptions/{module,controller,index}.ts`, `app.module.ts`.
- Tests: `subscription-period.spec.ts` (periods and proration, two 10,000-run properties), `subscription.spec.ts` (amounts), `subscriptions/subscriptions.int.spec.ts` (22 integration tests), `cross-tenant.int.spec.ts` (subscription fixture and valid PATCH body).
- Docs: `docs/runbooks/subscription-lifecycle.md`.

## C. Implemented features, API
| Area | What exists |
|---|---|
| Subscribe | `POST /v1/billing/subscriptions {planVersionId, paymentMethodId, quantity?}`: fee read from the price book and frozen; first period invoiced and paid at once (or a trial); `payment_method_required` 422; one live subscription per organization (409) |
| Read | `GET …`, `GET …/{id}` (ETag = version) |
| Change | `PATCH …/{id}` `{planVersionId?, quantity?, paymentMethodId?, prorationMode?, preview?}`; preview needs no If-Match; apply needs it (428/412); net > 0 invoiced and paid now, net < 0 credited at next renewal |
| Cancel | `POST …/{id}/cancellation`: at period end, idempotent, then default plan |
| Renewal engine | `runDue` / `renew`: period advance + invoice intent in one transaction (compare-and-set), idempotent invoice by `subscription:<id>:<periodStart>`, reconcile-before-retry payment, catch-up of up to 24 missed periods, `past_due → active` when the invoice gets paid |
| Entitlements | plan assigned when the first charge succeeds (or a trial starts); default plan after cancellation |
| Payment methods | a method used by a live subscription cannot be removed (409, the docs/04 rule) |
| Events/audit | outbox `subscription.created/renewed/activated/past_due/cancelled`; audit for create, change, cancellation request, renewal, activation, recovery, cancellation |

## D. Migrations and rollback
`billing/0321`: `billing.subscriptions` with priced `items` snapshot, `pending_invoice`, `version` (bumped by trigger for ETag), unique live subscription per organization, state-machine trigger (cancelled terminal, periods forward-only, identity frozen), never deleted/truncated, org RLS + platform read, column-level UPDATE grants. Dev-only `.down.sql` exercised (rollback → migrate → `db check` OK); production is forward-fix.

## E. Tests run (actual)
`pnpm verify:full` → **EXIT=0** in one run:
- lint, typecheck (19/19), build (11/11), `spec:lint` clean, `spec:drift` OK (**106** operations), `sdk:check` up to date, `scan:secrets` 871 files / 8 rules / 0 hits.
- Unit: api **268** (+10), web 38, i18n 9, db 9, ui 7, domain 6, admin 5, worker 5, sdk 4, telemetry 3. Browser E2E: **6 passed**.
- `db check` OK; integration: db 43, platform 32, worker 8, **api 488** (+29: 22 subscriptions, 7 from the generated cross-tenant suite) = **571**.
- Highlights: 5 concurrent renewals of one period → exactly 1 invoice and 1 charge (0 duplicate charges); a crash after advancing the period (invoice not issued) and a crash between issuing and paying are both repaired by the next run with exactly 1 invoice and 1 payment; 4 missed periods billed in order; anchor 31 → Feb 28 → Mar 31; upgrade/downgrade/quantity/`none` proration with exact figures; credit covers a whole renewal; declined first payment and declined renewal → `past_due`, recovery by paying the invoice; trial free, converting at its end, offered once; cancel idempotent and ending on the default plan; method-in-use 409; database guards (illegal transition, backwards period, identity, one live subscription, delete/truncate).

## F. Security, tenant isolation, billing, residency verification
- RLS forced on `subscriptions` (org isolation + platform read); a foreign or unknown id is 404 **before** any body validation (generated cross-tenant suite, session and API key).
- Money: integer minor units, exact decimal fee × quantity with the item's rounding rule, proration in bigint with half-up on each side; periods are pure UTC date arithmetic (properties, 10,000 runs each).
- No price is ever invented; production refuses the placeholder price book.
- Idempotency: invoice by source key, payment reconcile-before-retry (S09), period advance by compare-and-set; `POST` create uses `Idempotency-Key`.
- Residency: not evaluated (M04).

## G. Human gates and live checks still needed
D-10 / HG-03-02 (no real PSP: recurring charging and 3-D Secure behaviour **NOT VERIFIED**), HG-02-01 (approved plan fees; the seeded book is a placeholder), HG-03-04 (tax advisor: proration invoices, prorated VAT, credit treatment), HG-04-01. Nothing was sent to a live PSP.

## H. Acceptance (S10b rows)
| Row | Status |
|---|---|
| Subscription lifecycle: subscribe, renew, trial, cancel at period end | PASS (sandbox PSP) |
| Renewal idempotent per period (concurrency and crash repair) | PASS |
| Plan change with proration (charge / credit) | PASS |
| `past_due` recovery | PASS (by invoice payment); dunning retries are S10c |
| Payment method in use → 409 | PASS |
| Renewal worker scheduled in the worker process | NOT DONE (`runDue` exists; scheduling decision is S10c) |
| `paused` state, per-plan trial, change-at-next-renewal | NOT DONE (owner decisions) |
| Customer notifications (renewal, failure) | NOT DONE (S10c) |
| Live PSP recurring charge | BLOCKED (D-10 / HG-03-02) |

## I. Handoff and open decisions
- **S10c:** `spec/billing/dunning-policy.yaml` and `billing.dunning_cases` (state machine none → reminder_1 → reminder_2 → restricted → suspended → terminated_pending; retry schedule D+1/3/5; emits operation *requests* only, no data deletion; recovery on payment), the scheduler that runs `runDue`, `PaymentService.processPending` and `RefundService.processPending`, wallet-debit orchestration (rated usage paid from the wallet), notifications (ar/en).
- **Owner:** where plan fees live (explicit column vs the meter convention), trial policy, `paused`, `incomplete` status, refund list endpoint and top-up refunds (from S10a).
