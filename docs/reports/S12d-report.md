# S12d report — Admin finance screens (M03 sprint 12, fourth part)

Status: implemented; unit tests, lint, typecheck, spec drift and both console builds pass. **The browser E2E for these screens has NOT been run** (see §E), so no screen below is marked PASS on browser evidence. **Not committed.** Remaining for M03: the M03 report (CLAUDE.md §10 A–I, tax-advisor [VERIFY] list, PSP/ZATCA live-status table), the demo script and the M03 gate review.

## A. Repository findings and assumptions
- **UI-M03-13 and UI-M03-14 are not built: BLOCKED (spec gap, owner decision).** docs/04 and `spec/openapi` define no admin operation to search invoices across organizations or to list payments with their raw PSP events. Per CLAUDE.md §2 no endpoint was invented. Proposal for the owner: `GET /v1/admin/billing/invoices` (filters org, status, e-invoice state, number, date; cursor), `GET /v1/admin/billing/invoices/{id}`, `GET /v1/admin/billing/payments` and `…/{id}/events` (redacted PSP events, duplicate-event flag). Permission `admin:billing:read`, platform scope with audited reads.
- **UI-M03-15 is PARTIAL.** The request form exists (POST is specified). A list of refunds and their status needs `GET /v1/admin/billing/refunds` (+ `…/{id}`), which docs/04 does not define (open since S10a). The screen shows the result of each request right after it is sent and says the list is unavailable.
- **Refund form:** the amount is parsed to integer minor units by string arithmetic (`toMinor`); one `Idempotency-Key` per distinct request (renewed only after a successful submit) so a double click or a retry replays the same refund.
- **Reconciliation "schedule":** the API exposes no schedule configuration. The screen states that scheduled runs happen daily through the billing scheduler and shows the trigger (manual/scheduled) per run. A run-now form posts to the specified operation; runs execute asynchronously.
- **E-invoicing onboarding** shows only the environments the API reports (sandbox/simulation, from `ZATCA_MODE`); a SIMULATION or SANDBOX banner says nothing is sent to or verified with ZATCA; **PRODUCTION is shown as locked** (HG-03-03). Credentials appear as kind, serial and expiry only. The one-time password is typed into a field marked `autocomplete="off"`, sent once with an approval, never with a rejection, and cleared; it is not stored or logged by the page.
- **Reporting-window gauge (UI-M03-19):** the API returns remaining seconds and the 50 % / 100 % flags, not the window length, so the gauge is the share of open simplified invoices still in the first half of their window (plus counts of attention and missed), not a countdown. Computed over the rows of the current page.
- **Reports:** columns and totals are labelled from translations (`af.rp.col.*`, `af.rp.tot.*`) and fall back to the API label; the API's explanatory notes are shown in English with `lang="en"`. The chart draws the first money column (BigInt scaling, exact figure printed beside every bar). Every ledger-tied figure shows a "Matches the ledger" / "Does NOT match the ledger" badge from `matchesLedger`/`reconciles`. CSV is streamed through a route handler with the staff session.
- **Permissions:** tabs and buttons follow `admin:billing:read|manage`, `admin:zatca:manage|approve`, `admin:reports:read`; the API remains the authority (403 → forbidden panel).

## B. Plan and changed files
- No migration, no spec change, no SDK change (no new API operations).
- `apps/admin/lib/finance.ts` (+`finance.spec.ts`): pure helpers (`toMinor`, ranges, onboarding step order, tones, window summary, report cell/bars/basis points).
- `apps/admin/lib/server.ts` (`apiDownload`), `components/BillingAdminTabs.tsx` (6 tabs), `components/BillingAdminPanels.tsx` (shared action hook exported, passes response data), `components/FinancePanels.tsx` (+`FinancePanels.spec.tsx`).
- Pages under `apps/admin/app/[locale]/(console)/billing/`: `refunds`, `reconciliations` (+`[id]`), `zatca` (+`submissions`), `dunning`, `revenue-reports` (+`export` route).
- `packages/i18n/src/messages.ts`: 306 Arabic/English keys.
- `e2e/tests/05-admin-finance.spec.ts` (written, **not run**), `e2e/playwright.config.ts` (`ZATCA_MODE=simulation` for the test API).

## C. Implemented screens
| UI | Screen | Status |
|---|---|---|
| UI-M03-13 | Invoices (cross-organization search) | **BLOCKED (spec gap: no admin invoice list API; owner decision)** |
| UI-M03-14 | Payments and redacted PSP events | **BLOCKED (spec gap: no admin payment/event list API; owner decision)** |
| UI-M03-15 | Request refund (step-up) | **PARTIAL** (form built; status list needs `GET /v1/admin/billing/refunds`); browser **NOT VERIFIED** |
| UI-M03-16 | Reconciliation runs, run now, filters | Implemented; browser **NOT VERIFIED** |
| UI-M03-17 | Run detail: breaks, assign, accept, link adjustment | Implemented; browser **NOT VERIFIED** |
| UI-M03-18 | E-invoicing onboarding (SIMULATION banner, production locked, credentials by reference) | Implemented; browser **NOT VERIFIED**; all results SIMULATED, **NOT VERIFIED vs ZATCA** |
| UI-M03-19 | Submission queue, retry, window gauge | Implemented; browser **NOT VERIFIED**; the e2e test could only check the empty queue (a generated document needs the hash-chain pipeline) |
| UI-M03-20 | Dunning cases, hold/resume | Implemented; browser **NOT VERIFIED** |
| UI-M03-21 | Reports, chart, CSV, ledger-match badge | Implemented; browser **NOT VERIFIED** |

Every screen uses `view()` for loading/empty/error/forbidden, Arabic RTL and English, labelled controls, and `useStaffAction` (MFA step-up aware). Screenshots and axe results for these screens do not exist yet.

## D. Migrations and rollback
None.

## E. Tests run with actual results
- `pnpm --filter @nuzm/admin exec vitest run` → **3 files, 41 tests passed** (new: 24 helper tests; 14 component tests covering refund validation and payload with idempotency key, reconciliation run payload, break actions visibility and payloads, OTP only on the compliance-certificate step and never on a rejection, dunning reason and payload).
- `pnpm --filter @nuzm/i18n test` → 9 passed (key and placeholder parity for the 306 new keys).
- `pnpm lint` → exit 0 (eslint and prettier). `pnpm typecheck` → passed. `pnpm spec:drift` → "117 implemented route(s) all declared".
- `next build` of web and admin → succeeded; all new routes listed.
- **Browser E2E (`e2e/tests/05-admin-finance.spec.ts`) and `pnpm verify:full`: NOT RUN.** The end-to-end ports (3000, 3001, 4000, 4010) and the local Postgres on 54329 were held by another session's development stack, whose admin server was stopped by mistake during this work (see the session note below). On the owner's instruction E2E was skipped for now. The spec is written but unproven: expect selector and data-setup fixes on its first run. It also depends on `04-payments` having run first.
- Session note: the integration suite (651 tests) was last run before S12d and was not rerun; S12d changes no API, database or spec.

## F. Security, tenant isolation, billing, residency
- No new API surface; the generated cross-tenant suite is unaffected. All data comes from the admin-realm API with the staff session; cookies of the customer realm are never forwarded (`FORWARD` allow-list).
- Money is shown from API strings with `formatMinor`; the only parsing is the refund amount to integer minor units (`toMinor`, string arithmetic). The refund is idempotent and its ledger effect is made once by the API.
- The one-time ZATCA password is never rendered back, stored in state after use, or sent on a rejection (unit-tested). Credentials are references only.
- CSV is produced by the API (formula-looking cells neutralised) and streamed with `nosniff` and `no-store`.

## G. Human gates and live checks still needed
- Owner decisions: the three missing admin read APIs (invoices, payments + events, refunds list); D-23 dunning timings; D-31 reconciliation tolerances/SLA; HG-03-03 (ZATCA official specification) before any e-invoicing result can be called verified; HG-03-04 tax advisor.
- Browser verification of all S12d screens (E2E, axe, screenshots in Arabic and English).
- Arabic copy review by a native speaker.

## H. Acceptance checklist
See §C. No S12d row is PASS on browser evidence. UI-M03-13/14 BLOCKED; UI-M03-15 PARTIAL; UI-M03-16..21 implemented and unit/build verified, browser NOT VERIFIED.

## I. Next steps and open decisions
- Run `pnpm verify:full` with the ports free, fix the E2E spec as needed, add the screenshots, then update §C/§E.
- Then the M03 report, demo script and gate review. UI-M03-13/14/15 stay open in the gate review until the owner decides the admin read APIs.
