# S10c report — Dunning, billing scheduler, notices (M03 sprint 10, last part)

Status: implemented and verified against real PostgreSQL and the sandbox PSP (see §E). **Not committed.** With S10c the S10 scope is done except the items listed as NOT DONE / BLOCKED in §H. S11 (ZATCA module, sandbox/simulation only) is next.

## A. Repository findings and assumptions
- **Policy timings are the docs/11 proposal, not an approved policy.** `spec/billing/dunning-policy.yaml` is marked `PROPOSED-NOT-APPROVED` (decision D-23, finance approval pending): retries D+1/3/5, notices D+3/D+7, restrict D+14, suspend D+21. The owner-review day (D+45) is **my proposal** (docs/11 gives none). Legal notice periods before any deletion are for counsel (HG-04-01).
- **Billing emits requests only.** Restriction, suspension and owner review are outbox events (`dunning.restrict_requested`, `dunning.suspend_requested`, `dunning.review_requested`) for the owning modules (M05+). The M03 prompt says "operation requests": there are no operation handlers or kinds yet (S02), so I used the outbox, which is what `platform.operations` consumers will read later. Nothing is ever deleted, and the policy file cannot add an action (validated).
- **Purchase restriction is enforced** where billing owns the surface: creating an order (`OrderService.createFromQuote`) is refused with 402 `account_restricted` while an open case is at `restricted` or beyond. Quotes, payments, top-ups and everything already bought keep working. Restricting compute/hosting itself is for the owning modules (M05+).
- **`unpaid`** is now driven: restriction makes the subscription `unpaid`; paying the invoice returns it to `active` (and a customer who cancels while overdue is cancelled at once, because no paid period is left to keep).
- **Case opening time.** The case opens at the first run after the failure (the subscription has no "became past_due at" column), so a scheduler outage delays day 0 rather than shortening the customer's time.
- **Scheduler placement decided as a proposal (ADR-017, status PROPOSED/OPEN):** the periodic jobs run inside the API process (`BILLING_SCHEDULER_INTERVAL_SECONDS`, off by default, advisory lock), because the worker cannot import API services. The clean long-term shape (a shared `packages/billing` run by the worker) is recorded as the alternative.
- **Wallet-debit orchestration is NOT built (blocked on D-25 / HG-03-04).** VAT at consumption means every wallet debit is a taxable supply that needs a tax document, and paying rated usage from the wallet must be excluded from the period-close invoice to avoid billing it twice. Building a half-version before the tax advisor decides would create legal documents on an unconfirmed basis. The recipes (`walletConsume`, `usageChargeWallet`) exist since M02.
- **Notifications:** in-app by default (email only if the user enabled it, existing preference model), kinds `billing.payment_failed`, `billing.dunning_reminder`, `billing.dunning_restricted`, `billing.dunning_suspended`, `billing.dunning_review`, `billing.payment_recovered`, with Arabic and English texts in `packages/i18n` (key parity tested). Recipients are the organization's billing managers (`billing:manage`). Notices are best-effort after the case change commits; the case and its outbox request are the durable record.

## B. Plan and changed files
- Migration `billing/0322__billing__dunning_cases` (+down). Spec: `spec/billing/dunning-policy.yaml`; `openapi.yaml` +2 operations (**108**), `Subscription.dunningStage`; `errors.yaml` + `errors.ts` (`account_restricted` 402); SDK regenerated.
- Code: `billing/internal/{dunning-policy,dunning.service}.ts`, `billing/admin-dunning.controller.ts`, `subscription.service.ts` (`markUnpaid`, `retryPayment`, `cancelNow`, `delinquent`, `settle` for `unpaid`, `dunningStage`), `commerce` (order guard), `subscriptions/billing-scheduler.ts` + module hooks, `packages/i18n/src/messages.ts`.
- Docs: `docs/adr/ADR-017-billing-scheduler-runs-in-the-api-process.md`, `docs/runbooks/dunning.md`; `.env.example` (`BILLING_SCHEDULER_INTERVAL_SECONDS`, `DUNNING_POLICY_PATH`, `SUBSCRIPTION_TRIAL_DAYS`, wallet settings that S10a had not listed).
- Tests: `dunning-policy.spec.ts` (3), `subscriptions/dunning.int.spec.ts` (12), `subscriptions.int.spec.ts` (guard assertion), cross-tenant suite unchanged and green.

## C. Implemented features, API
| Area | What exists |
|---|---|
| Policy | versioned YAML, validated at load (closed stage list, ascending days, retries before restriction, no extra keys), bad file stops start-up |
| Dunning run | opens one case per overdue subscription; retries on the policy days (reconcile-before-retry; a missed day is consumed, not queued); stages advance one at a time, each atomically with its outbox request; repair step if a run stopped between the restricted stage and `unpaid` |
| Recovery | any payment closes the case (`paid`), reactivates the subscription, lifts the restriction, notifies, audits; cancellation while overdue closes it (`subscription_cancelled`) |
| Finance API | `GET /v1/admin/billing/dunning` (filters org, stage, state), `PATCH …/{id}` `{action: hold|resume, reason}` (step-up, audited, idempotent, 409 when closed) |
| Customer API | `Subscription.dunningStage` (for the UI-M03-04 banner) |
| Restriction | 402 `account_restricted` on new orders at `restricted` or beyond |
| Scheduler | `BillingScheduler.tick`: subscriptions → dunning → PSP event sweeper → refund sweeper; per-step failure isolation; advisory lock; `start/stop` hooked to the app lifecycle |

## D. Migrations and rollback
`billing/0322`: `billing.dunning_cases` (one open case per subscription, stage forward-only by trigger, identity frozen, closed immutable, retries only grow, a hold needs a reason, never deleted or truncated, org RLS + platform read, column-level UPDATE grants). Dev-only `.down.sql` exercised (rollback → migrate → `db check` OK); production is forward-fix.

## E. Tests run (actual)
`pnpm verify:full` → **EXIT=0** in one run (earlier attempts in this sprint failed on my own mistakes and were fixed: a lint rule that forbids importing another module's internals in a test, a null type in a test, and a wrong expectation in the policy unit test):
- lint, typecheck (19/19), build (11/11), `spec:lint` clean, `spec:drift` OK (**108** operations), `sdk:check` up to date, `scan:secrets` 1,403 files / 8 rules / 0 hits.
- Unit: api **271** (+3), web 38, i18n 9, db 9, ui 7, domain 6, admin 5, worker 5, sdk 4, telemetry 3. Browser E2E: **6 passed**.
- `db check` OK; integration: db 43, platform 32, worker 8, **api 502** (+14) = **585**.
- Highlights: the full timeline (day 0 → 45) with the exact stage, retry count, subscription status and outbox request at each step, and **zero** deletion/termination requests and the invoice and subscription still intact at day 45; a scheduler that was down for 21 days produces all four stages once, in order; 4 concurrent runs → one open case; recovery from `restricted` re-enables purchases; a successful retry closes the case; cancel-while-overdue; hold/resume (days keep counting) with audit; support cannot read or hold; DB guards; the scheduler's lock (a second instance skips while the first holds it) and failure isolation (a failing step does not stop the others).

## F. Security, tenant isolation, billing, residency verification
- RLS forced on `dunning_cases`; admin routes need the admin realm and a platform permission, `PATCH` needs step-up and `admin:billing:manage`; finance only (support is refused).
- No destructive path exists: the stage list is closed in code and in the migration, the policy cannot add actions, and billing emits requests only.
- Idempotency throughout: one open case (unique index), stage change by compare-and-set, retries reconcile-before-retry, scheduler steps repeatable.
- Residency: not evaluated (M04).

## G. Human gates and live checks still needed
D-23 (finance approval of the dunning timings), HG-04-01 (legal notice and retention before any deletion), D-10 / HG-03-02 (no real PSP: retries and 3-D Secure on a real PSP **NOT VERIFIED**), HG-03-04 and D-25 (wallet VAT timing). ADR-017 awaits the owner.

## H. Acceptance (S10c rows, with the S10 rows still open)
| Row | Status |
|---|---|
| Dunning state machine and policy config; requests only, no deletion | PASS |
| Retries, notices, restrict, suspend request, owner-review request | PASS (sandbox PSP; consumers of the requests arrive in M05+) |
| Manual hold/resume (finance), audit | PASS |
| Recovery on payment; recovery audit | PASS |
| Renewal and dunning scheduled periodically | PASS in-process (ADR-017 proposed; off by default; a production profile must enable it) |
| Notifications ar/en (in-app) | PASS for texts and delivery; rendering in the UI is S12 |
| Email notices | NOT VERIFIED (mailer is the dev logger until M08/D-08) |
| Wallet-debit orchestration (rated usage → wallet) | BLOCKED (D-25 / HG-03-04) |
| Refund list endpoint and top-up refunds (S10a) | BLOCKED (owner decision) |
| Live PSP dunning behaviour | BLOCKED (D-10 / HG-03-02) |

## I. Handoff and open decisions
- **S11 (ZATCA, sandbox/simulation):** `spec/zatca/<version>/` needs the owner-supplied official documents; if none, S11 proceeds with the interface and synthetic tests only and records the pin as BLOCKED.
- **Owner:** approve or change the dunning timings (D-23); accept ADR-017 or choose the shared-package route; wallet VAT timing (D-25); refund listing endpoint, top-up refunds, plan-fee storage, trial and `paused` policy (S10a/S10b items).
