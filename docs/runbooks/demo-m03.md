# Demo: M03 (card → subscription → invoice → pay → wallet → refund → reconciliation → e-invoicing → reports)

Local, **sandbox only**. The payment provider is the mock (`psp-mock`, deterministic scenarios), e-invoicing is a **SIMULATION on a synthetic profile (NOT VERIFIED vs ZATCA)**, the billing entity is a placeholder, and the plan fee below is an example. Nothing here reaches a real PSP or ZATCA.

## 0. Start
```bash
pnpm services:start && pnpm db:migrate
```
Run the API with e-invoicing in simulation and, optionally, the periodic jobs (renewals, dunning, scheduled reconciliations) every 30 seconds:
```bash
ZATCA_MODE=simulation BILLING_SCHEDULER_INTERVAL_SECONDS=30 pnpm --filter @nuzm/api dev:stack   # API :4000 + dev identity provider
pnpm --filter @nuzm/web dev      # customer console :3000
pnpm --filter @nuzm/admin dev    # admin console :3001
```
Ports 3000, 3001, 4000 and 4010 must be free. Staff sign in at `http://127.0.0.1:3001/ar` (or `/en`) through the dev identity provider and enrol MFA; customers at `http://127.0.0.1:3000/ar`.

## 1. A price for the Starter plan (example data)
The seeded book is a placeholder, so no plan has a price. Give Starter a 30.00 SAR monthly fee in a published, non-placeholder book (the E2E does the same; a real book goes through the admin console with a second person publishing):
```sql
INSERT INTO metering.meters (id, unit, aggregation_window, basis) VALUES ('plan.starter_months','subscription_month','day','subscription') ON CONFLICT DO NOTHING;
-- then insert a price book + version + price item for 'plan.starter_months' = 3000 (flat) and publish it; see e2e/tests/04-payments.spec.ts seedStarterPrice()
```

## 2. Customer: card, tax profile, subscription
1. **Billing → Payment methods → Add**: choose a **sandbox test card** ("always succeeds"). There is no card-number field anywhere; the page says so.
2. **Billing → Tax profile**: set a B2B profile (VAT number `300000000000003`, CR `1010000000`, a Saudi address). An invalid VAT number is refused with a message.
3. **Billing → Subscriptions**: pick **Starter**, subscribe. The first period is invoiced and paid with the saved card; the detail screen shows the plan and **Cancel at period end** (try it).
4. **Billing → Invoices**: the first invoice is paid. Open it: lines, tax breakdown, status, **PDF (Arabic / English)**. Switch the language (top bar) and compare the PDFs. The e-invoice block says it is simulated.

## 3. Pay an open invoice, 3-D Secure, declines
1. Add a second sandbox card, "requires 3-D Secure", make it default, and pay an open invoice: the page shows "your bank needs you to confirm" and the payment return page polls to the result.
2. A "declined" card shows the decline code and leaves the invoice open.
3. **Billing → Payments** lists every attempt with its status.

## 4. Wallet
**Billing → Wallet**: an amount outside the allowed range is refused on the screen; a valid top-up with the success card credits the balance (ledger: PSP clearing → customer wallet, once). VAT on prepaid credit is applied at consumption (policy D-25, awaiting the advisor).

## 5. Dunning (optional, needs the scheduler)
Subscribe with a card that later declines, or let a renewal fail: **Billing → Subscriptions → detail** shows the "payment overdue" banner; the admin console **Dunning** page lists the case, and a finance user can **hold** it with a reason and **resume** it. Billing only emits restrict/suspend *requests*; nothing is deleted, ever.

## 6. Admin console (finance)
Sign in as staff with the finance or platform-admin role (MFA, recent verification for changes).
1. **Billing → Invoices**: search across organizations by number prefix, status, e-invoice state or date; the correction guidance explains that a wrong invoice is fixed by a credit note, never edited. **Billing → Payments**: filter by organization, invoice or status, open a payment to see its **redacted PSP events** and the "resent N times, repeats ignored" indicator (a provider can resend an event; it has one effect).
2. **Billing → Refunds**: paste a succeeded invoice payment id (or follow "Request a refund" from a payment), amount `1.00`, a reason → the refund is created once (a repeat replays the same refund) and appears in the **refund history** below the form.
3. **Billing → Reconciliation**: run RC-01..RC-06 for the current month (they run asynchronously; with the scheduler on they complete within a minute). Open a run: breaks, **Take it**, **Accept variance** (note required), **Link adjustment** (an approved adjustment id from the two-person adjustments flow). Reconciliation never edits the ledger.
4. **Billing → E-invoicing**: the **SIMULATION** banner and the locked-production notice; request the CSR step; a **different** staff user approves it (the requester cannot). Credentials show serial and expiry only, never a secret.
5. **Billing → Submissions**: the queue, dead letters with **Retry**, and the reporting-window gauge (empty until e-invoices are generated: set `ZATCA_GENERATE_FROM` to a date to start generating for new invoices).
6. **Billing → Reports**: pick a report (revenue, MRR/ARR, receivables aging, VAT, margin, refunds, dunning, wallet), a period, read the chart and the **ledger check** badge, and **Download CSV**.

## What this demo does not show
A real PSP or ZATCA (BLOCKED: D-10, HG-03-02, HG-03-03), a registered billing entity (HG-03-01), tax-advisor approved wording (HG-03-04), paying a quote at checkout (no API), wallet-debit billing of rated usage (D-25), ZATCA credential renewal and key rotation (NOT IMPLEMENTED), email delivery (dev logger), RC-04 against real provider bills (M05). The three admin read APIs behind the invoice, payment and refund screens were added in S12d without a prior docs/04 entry and await the owner's approval.
