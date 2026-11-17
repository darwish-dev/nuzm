# Runbook — Subscription lifecycle (M03 S10b)

Audience: finance and support. Customer API: `/v1/billing/subscriptions` (`billing:read` to read, `billing:manage` to change). There is no admin endpoint for subscriptions yet.
PSP in this repository: the deterministic sandbox PSP only (D-10 / HG-03-02 open). Real subscriptions cannot be paid in production until a real PSP adapter exists.

## 1. How a plan gets a price (read this first)
Plans carry **no price** in the database (docs/05). A subscription takes the fee from the **price book**, from a *flat* price item for the meter `plan.<planKey>_months` (a `-` in the plan key becomes `_`; example: plan `starter` → meter `plan.starter_months`, basis `subscription`). The fee is **frozen on the subscription** when it is created or when its plan changes: later price-book changes never silently re-price a running subscription.
To make a plan subscribable: create the meter (`POST /v1/admin/meters`, basis `subscription`), add a flat price for it to a price-book version (draft by one person, published by another, four-eyes). A plan with no such price answers 422 "no price is configured" (a price is never invented). The seeded book is a DRAFT-NOT-APPROVED placeholder (HG-02-01); production profiles refuse it.

## 2. States
`trialing → active → past_due → (active | unpaid) → cancelled`. `unpaid` and the dunning actions that lead to it belong to S10c. `paused` is not implemented (flag-gated in docs/11; owner decision).
- **active**: the paid period is running; the plan is assigned.
- **past_due**: a charge was declined, needs 3-D Secure, or the first payment failed. The invoice is open. The plan stays if it was already assigned; a first-payment failure never assigns it.
- **cancelled**: terminal. The organization is back on the default plan; a new subscription may be created.

## 3. What happens each period
`SubscriptionService.runDue` (scheduler, S10c) renews every period that has ended, one period at a time (up to 24 in a run when the scheduler was down):
1. In one transaction: the period moves forward (compare-and-set on the old end date) **and** the invoice intent is recorded.
2. The invoice is issued (idempotent by `subscription:<id>:<periodStart>`), then paid with the subscription's payment method.
3. Paid → `active`. Declined / needs action → `past_due`. "Processing" → unchanged until the PSP answers.
A crash at any point is repaired by the next run: the intent is still recorded, the invoice is found by its key, an open payment is reconciled with the PSP. **Never run a manual SQL update on `billing.subscriptions`** to "fix" a period; the database refuses illegal transitions and backwards periods anyway.

## 4. Plan or quantity change
`PATCH /v1/billing/subscriptions/{id}` with `If-Match`. `preview: true` first (no If-Match needed): it shows days left, unused credit of the old terms, charge for the new terms, and the net.
- Net > 0: invoiced and paid now (`subscription:<id>:change:<version>`).
- Net < 0: stored as a credit and **applied to the next renewal** (the line's net is reduced; invoice lines are never negative).
- `prorationMode: none`: switches now with no charge or credit. During a trial a change is always free.
A credit bigger than the next renewal covers it entirely: that period has no invoice and the remainder is kept.

## 5. Cancel
`POST …/cancellation`: the plan stays until the paid period ends; then the subscription is cancelled, the default plan is assigned, nothing more is invoiced. Repeating the call changes nothing. There is no "undo cancellation" yet.

## 6. Support checklist
| Symptom | Check |
|---|---|
| Customer says they were not charged | `SELECT status, period_start, period_end, pending_invoice, last_invoice_id FROM billing.subscriptions WHERE org_id = …`. `pending_invoice` not null = the scheduler has not finished; run it. |
| Customer cannot remove a card | A live subscription uses it (409). Change the subscription's method first. |
| `past_due` and the customer paid the invoice | The next `runDue` settles it (`past_due → active`); nothing to do manually. |
| Double invoice suspected | Invoices carry `source_key = subscription:<id>:<periodStart>` and the database refuses a second one. |
