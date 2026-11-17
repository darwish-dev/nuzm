# S12c report — Customer billing screens (M03 sprint 12, third part)

Status: implemented and verified (`pnpm verify:full` exit 0, see §E). **Not committed.** Remaining for M03: **S12d** the admin console screens (UI-M03-13..21), the M03 report, demo script and gate review.

## A. Repository findings and assumptions
- **Everything on these screens is the sandbox payment provider.** There is no real PSP (D-10/HG-03-02), so cards are added by choosing a **sandbox test card** (success / decline / 3-D Secure / timeout). The add-card form has **no text input at all** (a test asserts zero `<input>`/`<textarea>`); no card number, expiry or CVC exists anywhere in our pages. The picker is shown only when `PSP_SANDBOX_UI` is `true`, or when it is unset and the web app is not in production. A real provider's hosted field (iframe/redirect) replaces it later; nothing else on the screens changes.
- **UI-M03-11 (checkout) is PARTIAL.** The screen reviews a quote (lines, total, expiry, approval state) but **does not pay it**: the API has no operation that turns a quote into a payment. The page says so. Paying invoices and wallet top-ups, the two paths the API supports, are complete.
- **No credit-note PDF.** The API and spec have no credit-note PDF operation, so the screen has no PDF link (never a dead link). Invoice PDF (ar/en) and XML downloads exist and stream through server route handlers with the caller's session (`apiDownload`).
- **QR on the invoice** is generated in the page from the stored e-invoice QR TLV; e-invoicing is simulated (HG-03-03), so the page shows "E-invoicing runs in a simulated environment and is not verified with ZATCA" wherever an e-invoice status is shown.
- **Success text after paying an invoice is not durable:** it lives in the pay form, which disappears when the refreshed page shows the invoice as paid. The lasting result is the Paid status. (Found by the e2e test: Arabic caught the message, English did not.) Kept as is; the test asserts the lasting result.
- **The return page remembers the last payment** of the browser tab (`sessionStorage`, key `nuzm.lastPayment`) when the bank sends the customer back without a `paymentId`.
- **Subscribing** lands on the subscription detail screen (not the list). Plans without a price are refused with a message, never an invented price.
- **Wallet top-up bounds** come from `WALLET_TOPUP_MIN_MINOR` / `WALLET_TOPUP_MAX_MINOR` (defaults 1000 / 10000000 minor units), checked on the screen and again by the API.
- **E2E data.** The e2e test seeds a non-placeholder price book (copying the placeholder book's prices plus `plan.starter_months` = 30.00) because rating uses the newest non-placeholder book; without the copy, an earlier e2e quote returned 422. The e2e web server sets `PSP_SANDBOX_UI=true` because `next start` runs with `NODE_ENV=production`.

## B. Plan and changed files
- `apps/web/lib/payments.ts` (+`payments.spec.ts`), `apps/web/lib/server.ts` (`apiDownload`).
- `apps/web/components/PaymentsPanels.tsx` (+`PaymentsPanels.spec.tsx`), `BillingTabs.tsx` (7 new tabs).
- Pages under `apps/web/app/[locale]/(console)/billing/`: `payment-methods` (+`add`), `subscriptions` (+`[id]`), `invoices` (+`[id]`, `[id]/pdf`, `[id]/xml`), `credit-notes` (+`[id]`), `payments`, `wallet`, `tax-profile`, `checkout/[quoteId]`, `payment-return`.
- `packages/i18n/src/messages.ts`: 245 Arabic/English keys (key and placeholder parity tested).
- `e2e/tests/04-payments.spec.ts`, `e2e/playwright.config.ts` (`PSP_SANDBOX_UI`).
- No migration, no spec change (no new API operations), no SDK change.

## C. Implemented screens
| UI | Screen | Status |
|---|---|---|
| UI-M03-01 | Payment methods: default, remove, expiring/expired badge | PASS (e2e + unit) |
| UI-M03-02 | Add a payment method (sandbox test card, no card fields) | PASS (e2e + unit); real hosted field **BLOCKED (D-10/HG-03-02)** |
| UI-M03-03 | Subscriptions list, subscribe | PASS (e2e) |
| UI-M03-04 | Subscription detail: change plan with preview, cancel at period end, dunning banner | PASS for cancel (e2e); change-plan preview/apply covered by unit tests only (the e2e catalogue has one priced plan) |
| UI-M03-05 | Invoices list with status filter | PASS (e2e) |
| UI-M03-06 | Invoice detail: lines, tax breakdown, ZATCA status, QR, PDF ar/en, XML, pay now | PASS (e2e: open → pay → paid; PDF 200 `application/pdf`); QR/XML shown only when an e-invoice exists, **NOT VERIFIED vs ZATCA** |
| UI-M03-07 | Credit notes list and detail | PASS for the list/empty state (e2e); detail not exercised in e2e (no credit note in the fixture); no PDF (see A) |
| UI-M03-08 | Payments list | PASS (e2e) |
| UI-M03-09 | Wallet: balance, top-up, activity | PASS (e2e: range refusal, top-up, balance) |
| UI-M03-10 | Tax profile (B2B/B2C), invalid VAT refused | PASS (e2e) |
| UI-M03-11 | Checkout review of a quote | **PARTIAL** (review only, see A) |
| UI-M03-12 | Payment return page (missing / success; polling for processing) | PASS (e2e for missing and success; processing/failed/action by unit tests) |

Every screen has loading/empty/error/forbidden handling through `view()`, Arabic RTL and English, keyboard-reachable controls, and every POST sends an `Idempotency-Key`. Mutations needing step-up use the existing MFA-aware action hook.

## D. Migrations and rollback
None.

## E. Tests run with actual results
- `pnpm verify:full` → **EXIT=0** (lint, typecheck, unit, build, spec lint/drift, SDK check, secret scan, ZATCA guard, 19/19 turbo test tasks incl. browser E2E, DB migrate + RLS tests, integration).
- Unit: web 49 passed (new: 6 helper tests, component tests), i18n 9, API 301, admin 5, worker 5, domain 6, db 9, ui 7.
- Integration: db 43, platform 32, worker 8, api 568 (all passed).
- Browser E2E: **8 passed** (`ar` and `en`; customer, admin, billing and the new payments test), axe WCAG A/AA clean on every new screen, 16 new screenshots per locale in `docs/reports/screenshots/{ar,en}/payments-*.png`.
- Earlier in the session the e2e failed three times for reasons now fixed: a stale web build (new routes 404), the seeded price book hiding the placeholder prices from an earlier quote, and the sandbox picker hidden under `NODE_ENV=production`; plus test-side issues (plan order, post-subscribe redirect, status text matching a filter `<option>`, invoice series format, remembered payment on the return page).
- Environment note: port 3001 was held by an unrelated project's API (it respawns); with the owner's approval it was stopped before each e2e run. Nothing of this repository was affected.

## F. Security, tenant isolation, billing, residency
- No card data enters our pages (asserted). Tokens only; `setupToken` is a sandbox token.
- All data comes from the customer-realm API with the caller's session; org context is verified server side. The download handlers forward only customer-realm cookies and pass API errors through as plain text. No new API surface, so the generated cross-tenant suite is unchanged and green.
- No money arithmetic in the browser except parsing the top-up amount into integer minor units (`toMinor`) and range checks; all amounts are shown from API strings with `formatMinor`.
- No new personal-data field is stored by the web app; the tax profile goes to the existing API (classified in S09).

## G. Human gates and live checks still needed
- HG-03-02/D-10: real PSP selection; hosted card field; 3-D Secure with a real issuer: **BLOCKED**, nothing live-verified.
- HG-03-03: ZATCA specifications/sandbox: the e-invoice status, QR and XML on invoice screens are **NOT VERIFIED**.
- HG-03-04: tax-advisor review of the tax breakdown and wallet VAT timing (D-25).
- Arabic copy on these screens needs a native-speaker review.

## H. Acceptance checklist
See the table in §C. Rows PASS with evidence: `e2e/tests/04-payments.spec.ts`, `apps/web/components/PaymentsPanels.spec.tsx`, `apps/web/lib/payments.spec.ts`, screenshots above. UI-M03-11 PARTIAL; UI-M03-02 real provider field BLOCKED; ZATCA-dependent display NOT VERIFIED.

## I. Next-milestone handoff and open decisions
- **S12d:** admin screens UI-M03-13..21 (finance invoices/payments/refunds/reconciliations with detail/ZATCA wizard/submissions/dunning/revenue reports), then the M03 report (CLAUDE.md §10 A–I, tax-advisor [VERIFY] list, PSP/ZATCA live-status table), demo script and gate review.
- **Open API gaps found here:** an operation to pay a quote (UI-M03-11); a credit-note PDF; a refund list endpoint and top-up refunds (from S10).
- Decisions still open: D-10, D-23 (dunning timings), D-25 (wallet VAT timing), D-31 (reconciliation tolerances), ADR-017 acceptance.
