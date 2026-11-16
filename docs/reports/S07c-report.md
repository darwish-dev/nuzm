# S07c report — Billing UIs, demo and M02 closing (M02 sprint 3, part 3)

Status: implemented and verified (see §E). **Not committed.** Closes M02 engineering; the M02 gate review awaits the owner ([M02-report.md](M02-report.md), [M02-gate-review.md](M02-gate-review.md)).

## A. Repository findings and assumptions
- **Latent M01 defect found by the E2E and fixed:** the browser API client takes the active organization from the `nuzm_org` cookie, which only exists after creating or switching an organization. A member who never did either (an invited user) got 422 `X-Nuzm-Org header is required` on every mutation. `ActiveOrgCookie` (client component in the console layout) now keeps the cookie equal to the organization the server resolved.
- **Screens without an API are not built (UI-M02-14, UI-M02-16):** docs/04 has no platform-wide raw-events view for finance/support and no provider-cost import endpoint. No endpoint was invented.
- **Adjustments UI** can only reflect what the single documented endpoint offers: request a reversal and decide by request number; no list of requests and no manual-lines form (API only). Plans admin is read-only (the editor needs more than the S05 endpoints expose to a UI without a draft workflow); price book diff view and the producer-health gauge (no data source) are not built.
- CSV export is a console route handler (`/billing/usage/export`), not an API endpoint; every cell is formula-injection safe (unit-tested).
- The owner and billing-admin sessions in the E2E are marked MFA-recent through the database (the owner enrolled MFA in the customer test); the billing admin enrols through the real UI.

## B. Plan and changed files
- `apps/web`: `billing/*` pages (overview, plans, usage + `[meter]` + CSV export route, quotas, ledger, spending-limits, approvals, quotes/[id]), `BillingTabs`, `BillingPanels` (limit form with ETag/412, approvals request/decision, quote approval button, expiry countdown), `lib/billing.ts` (money input without floats, decimal trim, CSV escape), nav entry, `ActiveOrgCookie`.
- `apps/admin`: `billing/{ledger,price-books,plans,meters,adjustments}` pages, `BillingAdminTabs`, `BillingAdminPanels` (publish, create meter, adjustments), nav entry.
- `packages/ui`: `Meter`, `Bars` and their CSS; `packages/i18n`: ~190 new keys, identical in `ar` and `en` (tested).
- E2E: `03-billing.spec.ts` (new), billing section in `02-admin.spec.ts`, producer key and a second user in `playwright.config.ts`. Tests added to close acceptance scale: 10,000-run balance property, 1,000-duplicate replay.
- Docs: `runbooks/demo-m02.md`, this report, `M02-report.md`, `M02-gate-review.md`.

## C. Implemented screens
Customer (ar RTL + en): UI-M02-01 overview, -02 plans, -03 usage explorer (+CSV), -04 meter drill-down (late-event note for `usage:events:read`), -05 statement with running balance, -06 spending limits (ETag; 412 and below-spend messages), -07 approvals (request; approve/deny; four-eyes message), -08 quotas (meters, restricted notice), -09 quote detail (provisional tax, residency note, countdown, approval callout). Admin: UI-M02-10 ledger accounts + transactions with postings, -11 price books (items; publish button), -12 plans (read-only), -13 meters (list + create), -15 adjustments (reversal request, decision). Every screen has loading/empty/error/forbidden handling through the shared `view()` helper.

## D. Migrations and rollback
None.

## E. Tests run (actual)
- `pnpm test:e2e`: **6 passed** (customer, admin incl. billing administration, billing; each in Arabic and English), each screen checked by axe (WCAG 2.0/2.1 A and AA, 0 violations) with direction/language assertions and a stored screenshot (`docs/reports/screenshots/{ar,en}/billing-*.png`, `admin-billing-*.png`).
- Unit: `lib/billing.spec.ts` (money input, decimals, CSV escape) in the web suite.
- `pnpm verify:full` → **EXIT=0** in one run (read from the run's own log line). Lint, typecheck, build (18/18, 19/19, 11/11 turbo tasks); **168 unit tests** (api 82, web 38, i18n 9, db 9, ui 7, domain 6, admin 5, worker 5, sdk 4, telemetry 3); browser E2E **6 passed**; spec lint clean, spec drift OK (83 operations), `sdk:check` up to date, `scan:secrets` 784 files / 0 hits, `db check` OK; integration on real PostgreSQL **432** (db 43, platform 32, worker 8, api 349).

## F. Security, tenant isolation, billing, residency verification
UI calls only the documented API with the caller's session; no money arithmetic in the browser except display ratios; money input is parsed with string arithmetic. The decision and publish actions rely on the API's step-up. The CSV export never emits a cell that a spreadsheet could execute. Residency: usage rows show the data region (placeholder tag); quotes state "not evaluated".

## G. Human gates and live checks still needed
HG-02-01 (approved price book v1) BLOCKED; D-23/D-25 OPEN; brand tokens still placeholders (D-32 assets owed); keyboard-only walkthrough and a screen-reader pass are not done (axe only).

## H. Acceptance (S07c rows)
UI-M02-01..09, -10, -13: PASS (E2E, axe, screenshots in both locales). -11, -12, -15: PARTIAL (see A). -14, -16: NOT DONE (no endpoint). Details in [M02-report §H](M02-report.md).

## I. Handoff
M03 supplies the real tax engine, invoices, payments and the list/approval endpoints for adjustments if the owner approves them; M05+ register quote pricers and screens that create orders; the owner decides the open items in the M02 report.
