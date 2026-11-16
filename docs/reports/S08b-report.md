# S08b report — Invoices, credit notes, period close, ledger recipes, PDF (M03 sprint 1, part 2)

Status: implemented and verified against real PostgreSQL (see §E). **Not committed.** M03 continues with S09 (payments: PSP adapter + mock, methods, intents, webhooks), S10 (subscriptions, wallet, dunning, refunds), S11 (ZATCA, sandbox/simulation only), S12 (reconciliation, reports, UIs).

## A. Repository findings and assumptions
- **Drafts are not stored:** the builder produces lines in memory and persists only issued invoices (`GET` shows issued documents, 404 otherwise); `draft → open` exists in the state machine for later manual flows.
- **No HTTP trigger for period close or credit notes:** docs/04 defines none; both are services (called by the renewal/period worker in S10 and by refunds). Not invented.
- **Tax scope baseline:** invoices and quotes use `TAX_DEFAULT_SCOPE=domestic` (services supplied in the Kingdom) so a configured baseline is not re-flagged on every document; a buyer outside the Kingdom or an unconfigured scope still sets `taxReview` ([VERIFY], HG-03-04).
- **Revenue accounts:** usage and ai-credit orders → 4100, plan orders → 4200, domain orders → 4300, marketplace orders → 4400 (marketplace commission versus gross is an advisor/D-26 question).
- **PDF engine:** headless Chrome/Chromium (`CHROME_PATH`), so Arabic shaping and right-to-left layout are the browser's job. Production needs it as a sandboxed sidecar with bundled Arabic fonts (M12). 503 when no browser exists.
- **API labels live in the API:** the server-rendered document catalog (`doc-labels.ts`) is API-local because the API's strict module resolution cannot compile the bundler-resolved `@nuzm/i18n` sources; a test keeps both languages in step.
- **Timezone defect found and fixed:** PostgreSQL `date` columns come back from the driver as local-midnight `Date`s, so `toISOString()` shows the previous day on a server ahead of UTC (Riyadh). All date columns now go through `common/dates.ts`; the quota report derived its period the same wrong way and was fixed.

## B. Plan and changed files
- Migration `invoicing/0301` (+ `.down.sql`, dev only): `invoices`, `invoice_lines`, `credit_notes` with immutability, state-machine and over-credit triggers, forced RLS, column-level grants.
- `billing/internal/recipes.ts`: `invoiceIssued`, `creditNote` (the M03 stubs for these two replaced).
- `apps/api/src/modules/invoicing`: `invoice.service.ts` (builder, period close, issue, ledger link, reads, PDF), `credit-note.service.ts`, `invoice-state.ts`, `invoice-render.ts` + `doc-labels.ts`, `pdf.renderer.ts`, two controllers.
- Spec: 6 operations (`listInvoices`, `getInvoice`, `getInvoicePdf`, `getInvoiceXml`, `listCreditNotes`, `getCreditNote`), 91 in total; SDK regenerated. Samples: `docs/reports/samples/invoice-{ar,en}.{pdf,png}`. Runbook `invoice-correction.md`. `.env.example`: `TAX_DEFAULT_SCOPE`.

## C. Implemented features and API
Period close (rating → lines → tax → gapless number → immutable rows → audit + `invoice.issued` event → ledger), idempotent per (org, period, entity); invoice and credit-note state machines (code table = database trigger, tested pair by pair); credit notes (per-line remaining, exact remaining tax, race-safe); read API with filters/cursor, Arabic or English PDF from the immutable snapshot, XML 409 until S11; sandbox watermark, QR placeholder area, bilingual party names.

## D. Migrations and rollback
`invoicing/0301`; dev-only down script. Production is forward-fix: invoices and credit notes are legal documents and are never dropped.

## E. Tests run (actual)
- Unit: invoice/credit-note state machines (all pairs), HTML renderer (RTL/LTR, escaping, watermark, totals, bdi runs, label parity), recipe properties incl. **10,000 generated invoices and credit notes balanced** and "invoice + full credit note cancel on every account".
- Integration (real PostgreSQL): `invoices.int.spec.ts` **25** tests; the full API integration suite **17 files, 398 passed**. Highlights: `rating_to_invoice_to_ledger_totals_match`; **AC-M03-06** rerun creates nothing; 8 parallel closes → one invoice, numbering without a gap; ledger link repaired without double posting; every illegal status transition refused by the database; no role can edit/delete/truncate; credit notes sum exactly to the invoice and net to zero in the ledger; 10 parallel credits cannot exceed the invoice; real Arabic and English PDFs rendered through Chrome.
- `pnpm verify:full` → **EXIT=0** in one run (read from the run's own log line). Lint, typecheck, build (18/18, 19/19, 11/11 turbo tasks); **259 unit tests** (api 173, web 38, i18n 9, db 9, ui 7, domain 6, admin 5, worker 5, sdk 4, telemetry 3); browser E2E **6 passed**; spec lint clean, spec drift OK (91 operations), `sdk:check` up to date, `scan:secrets` 816 files / 0 hits, `db check` OK; integration on real PostgreSQL **481** (db 43, platform 32, worker 8, api 398).
- An earlier full run failed only because the two 10,000-run property tests (about 2 s alone) exceeded vitest's default 5 s while the whole pipeline ran in parallel; the API unit config now has a 60 s test timeout.

## F. Security, tenant isolation, billing, residency verification
RLS forced on all three tables; cross-tenant generated tests cover `{id}`, `/pdf`, `/xml` and credit-note routes (404 for a foreign organization, session and API key); only billing readers can read; documents render from snapshots with every dynamic value HTML-escaped. `data_region` is the placeholder `sa-pending` on every document (M04). No payment data is stored here.

## G. Human gates and live checks still needed
**AC-M03-07 (owner reviewer approves the Arabic + English PDF snapshots) is PENDING:** the samples are in `docs/reports/samples/`. HG-03-01 (real entity), HG-03-04 (tax advisor: invoice template wording, rounding, credit-note treatment, marketplace revenue account) PENDING. Production issuing stays refused.

## H. Acceptance (S08b rows)
| Row | Status |
|---|---|
| AC-M03-05 invoice totals Σlines+tax = total over 10,000 generated; sequence gapless under 200 concurrent issues | PASS (engine + allocator in S08a, invoice-level check and 8-way concurrent close here) |
| AC-M03-06 period close idempotent | PASS |
| AC-M03-01 all docs/11 §3.1 recipes; 10,000 random sequences balanced | PARTIAL: invoice issued and credit note done and property-tested; payment captured, refund, wallet top-up arrive in S09/S10 |
| AC-M03-07 PDF Arabic + English approved by the owner reviewer | PENDING (samples delivered; automated checks pass) |
| AC-M03-13 cross-tenant for new routes | PASS for S08 routes |

## I. Handoff
S09: `payments` schema, `PspAdapter` + `psp-mock`, payment methods (no PAN), intents/attempts, webhooks (signature, replay window, dedupe), reconcile-before-retry; payment application to invoices (`paid_minor`, status moves) and the `payment captured` recipe. Open: advisor answers; HG-03-01; whether credit notes need a PDF endpoint in docs/04.
