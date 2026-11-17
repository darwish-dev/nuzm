# Runbook — Dunning (overdue invoices), M03 S10c

Audience: finance. Endpoints: `GET /v1/admin/billing/dunning` (finance, platform admin) and `PATCH /v1/admin/billing/dunning/{id}` (finance; MFA step-up; `{action: hold|resume, reason}`).
Policy: `spec/billing/dunning-policy.yaml` — **PROPOSED-NOT-APPROVED** (decision D-23). Change the file, review it like code, and restart; a malformed file stops the process at start-up rather than silently changing when customers are restricted.

## 1. What happens (days count from the day the case opened, UTC)
| Day | Stage / action | What the platform does |
|---|---|---|
| 0 | `overdue` | A charge failed (subscription `past_due`). Case opened by the first run after the failure; notice `billing.payment_failed` to the billing managers |
| 1, 3, 5 | retries | One payment retry with the stored method each (reconcile-before-retry: a charge that already happened is adopted, never repeated) |
| 3 | `reminder_1` | Notice |
| 7 | `reminder_2` | Notice |
| 14 | `restricted` | Subscription becomes `unpaid`; **new purchases are refused (402 `account_restricted`)**; existing services keep running; event `dunning.restrict_requested` |
| 21 | `suspended` | Event `dunning.suspend_requested` for the owning modules (M05+) to act on |
| 45 | `terminated_pending` | Event `dunning.review_requested`: **a human decides**. Billing never terminates or deletes anything, at any stage |
Any payment of the overdue invoice (by the customer, a retry, or the PSP webhook) closes the case (`closedReason = paid`), returns the subscription to `active`, lifts the restriction and notifies. A customer who cancels while overdue is cancelled immediately and the case closes (`subscription_cancelled`).

## 2. Hold and resume
Use a hold when the customer has promised payment or a bank transfer is in flight. A held case gets **no retries and no new stage**; the days keep counting, so resuming continues where the clock is (stages already due are applied one at a time on the next run). A hold needs a reason (1..500 characters) and is audited (`billing.dunning.held` / `resumed`). Repeating the same action changes nothing. A closed case cannot be changed (409).
There is no "lift the restriction" action: the restriction ends when the invoice is paid. If a restriction is wrong, fix the cause (payment, credit note, adjustment) rather than editing cases; the database refuses edits that move a case backwards.

## 3. Where the work runs
The periodic jobs (renewals, dunning, PSP event sweeper, refund sweeper) run in the API process when `BILLING_SCHEDULER_INTERVAL_SECONDS` > 0 (**off by default**; ADR-017, proposed). Only one instance ticks at a time (advisory lock). A tick that was missed or repeated is harmless: every step is idempotent, and a scheduler that was down for weeks produces every notice and request in order when it returns. **A production deployment without the interval set silently stops renewals and dunning.**

## 4. Support checklist
| Symptom | Check |
|---|---|
| Customer says they were not warned | `GET /v1/admin/billing/dunning?org=<id>&state=all`; notices are in-app notifications (`billing.dunning_*`), email only if the user enabled the email channel |
| Customer paid but is still restricted | The case closes on the next tick. Run one (or wait). `SELECT status FROM billing.subscriptions` must be `active` afterwards |
| Case never advances | Is it held? Is the scheduler running (`BILLING_SCHEDULER_INTERVAL_SECONDS`)? Is the policy file the expected one (`policyVersion` on the case)? |
| Someone asks to delete a customer's data for non-payment | Not possible and not automatic: only the owner-review request at D+45 exists. Legal notice periods before any deletion are for counsel (HG-04-01) |
