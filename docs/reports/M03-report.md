# M03 Milestone Report — Payments, Invoicing, Tax & ZATCA

Format: CLAUDE.md §10. Sprint reports: [S08a](S08a-report.md) · [S08b](S08b-report.md) · [S09](S09-report.md) · [S10a](S10a-report.md) · [S10b](S10b-report.md) · [S10c](S10c-report.md) · [S11a](S11a-report.md) · [S11b](S11b-report.md) · [S12a](S12a-report.md) · [S12b](S12b-report.md) · [S12c](S12c-report.md) · [S12d](S12d-report.md). Gate review: [M03-gate-review.md](M03-gate-review.md). Demo: [demo-m03.md](../runbooks/demo-m03.md).

Status: **NOT SIGNED. Prepared 2026-11-17, updated 2026-11-18 after S12d was verified (`pnpm verify:full` exit 0), for the owner's gate review.** Everything runs on the **sandbox PSP and a SIMULATED, synthetic-profile e-invoicing pipeline**. No row that needs a real PSP, ZATCA, a tax advisor or a registered billing entity is PASS: those are BLOCKED or NOT VERIFIED (§G, §H). No BLOCKED row was converted to PASS using a mock.

## A. Repository findings and assumptions
- Approved documentation (HG-00-01) governs; M01 and M02 are signed with deferrals ([M01](M01-deferrals.md), [M02](M02-deferrals.md)). Local-only git (D-01), one team sequential (D-02).
- **Conflicts and gaps recorded (never silently reconciled):**
  1. docs/04 had **no admin endpoint to search invoices across organizations, list payments with PSP events, or list refunds**. S12d added four read-only operations (spec first, migration 0312 for the duplicate-event counter) so UI-M03-13/14/15 could be built; **owner approval of these additions is pending** (CLAUDE.md §2). Details in [S12d §A](S12d-report.md).
  2. docs/04 has **no operation that pays a quote** → checkout (UI-M03-11) reviews the quote only.
  3. No credit-note PDF operation (customer screens have no PDF link for credit notes). No billing-entity / tax-rate administration endpoints (managed by migrations, as the M03 prompt says).
  4. The M03 prompt lists `payments.payment_reconciliations`; RC-01 lives in `finrec` (as the prompt itself notes). Reconciliation runs are their own resource instead of `platform.operations` records.
  5. The ledger has no meter-group dimension on invoice revenue postings → "revenue by meter group" cannot be produced (the report says so).
  6. docs/04 money shape (`{amount, currency}`) vs implemented integer-string `…Minor` + `currency` (open since M02).
  7. Wallet: only **VAT at consumption** is built (`WALLET_VAT_TIMING=topup` is refused at start-up); wallet-debit orchestration (rated usage → wallet) is NOT built (D-25 / HG-03-04); top-up payments cannot be refunded yet (owner decision).
- **No official ZATCA documents were supplied.** The e-invoicing profile is **synthetic** (`spec/zatca/synthetic-profile.yaml`, version UNPINNED); every ZATCA-facing result is labelled `NOT VERIFIED vs ZATCA`. A generator-hash guard (`pnpm zatca:guard`) fails CI if the generator changes without a changelog note.
- **No real PSP.** D-10 is open: `psp-mock` (deterministic scenarios) is the only adapter; no real-adapter skeleton was written (the prompt allows it only after D-10).
- **Billing entity is a placeholder** (`PLACEHOLDER-NOT-REGISTERED`, HG-03-01); issuing outside the sandbox is refused.
- Defaults chosen and recorded as reversible: dunning timings (`spec/billing/dunning-policy.yaml`, PROPOSED-NOT-APPROVED, D-23), reconciliation tolerances (D-31 proposal: 0 minor units for RC-01/02/05/06, finance-set bps for RC-03/04), subscription trial days, wallet min/max, ZATCA backoff, scheduler placement ([ADR-017](../adr/ADR-017-billing-scheduler-runs-in-the-api-process.md), PROPOSED).

## B. Plan and changed files
| Sprint | Content | Commit |
|---|---|---|
| S08a | tax engine (config rates, `[VERIFY]` flags), tax profiles, gapless invoice sequences | `f8c3425` |
| S08b | invoices, credit notes, period close (idempotent), ledger recipes, PDF ar/en | `c1facbc` |
| S09 | payment methods (no PAN), intents/attempts, webhooks, `psp-mock`, capture, reconcile-before-retry | `f352eb1` |
| S10a | refunds, wallet top-ups | `3f64b52` |
| S10b | subscriptions, proration, renewal engine | `54792ba` |
| S10c | dunning, billing scheduler, notices | `46358b3` |
| S11a | e-invoice document pipeline (UBL, hash chain, QR, signing, archive) | `f580351` |
| S11b | onboarding, submission queue, delivery gating | `0549ab6` |
| S12a | reconciliation RC-01..RC-06 | `c4f054d` |
| S12b | revenue/finance reports, invoice and card-expiry notices, runbooks | `da7f35f` |
| S12c | customer billing screens UI-M03-01..12 | `24a48b5` |
| S12d | admin finance screens UI-M03-13..21, four admin read APIs, E2E | `d201e20`, `28bed5a`, `c62b419`, `f8d681c`, test fixes `95c32bd` `a2e6367` `3629202` |

Migrations `0300–0302, 0310–0312, 0320–0322, 0330–0331, 0340–0341` (all inside `0300–0499`). Modules `invoicing` (+`zatca/`), `payments` (+`psp/`), `finrec`, billing extensions (`subscriptions`, dunning, wallet), `common/billing-managers`. Specs `spec/zatca/`, `spec/billing/dunning-policy.yaml`. Runbooks listed in §C.

## C. Implemented features, API and UI screens
- **Tax and invoices:** effective-dated tax rates from configuration, B2B/B2C classification, half-up per-line rounding with `Σ lines + tax = total` (0 minor-unit difference), gapless sequences per entity and series, immutable issued invoices, credit notes, PDF in Arabic and English, idempotent period close (`source_key`), payment application.
- **Payments:** tokenized payment methods only (no PAN/CVV field exists), intents/attempts, 3-D Secure `requires_action`, webhooks (signature, replay window, `psp_events` dedupe, one ledger effect per business event), reconcile-before-retry for uncertain results, idempotent refunds ≤ remaining captured, wallet top-ups.
- **Subscriptions and dunning:** subscribe/renew/trial/cancel at period end, plan change with proration preview, renewal idempotent per period; dunning state machine (requests only, **no deletion path**), manual hold/resume, in-process scheduler (off by default).
- **E-invoicing (SIMULATED):** standard/simplified/credit documents, UBL XML, ICV/PIH hash chain (database-enforced), QR TLV, ECDSA signing with vault references (dev vault only), CSR, two-person onboarding, submission queue with backoff and dead letters, clearance gating of standard invoices, reporting window clock, archive (local WORM store). Production environment is refused.
- **Reconciliation and reports:** RC-01..RC-06 with seeded-break detection and tolerances, break lifecycle linked to approved adjustments, SLA alert; eight finance reports (JSON/CSV, ledger-tied, audited).
- **Notifications (ar/en, in-app):** invoice issued, payment failed, dunning notices, card expiring. Email delivery is the dev logger (NOT VERIFIED).
- **API:** 121 operations (83 at M02 close; +38), spec ↔ code two-way drift check, SDK regenerated.
- **UI:** customer UI-M03-01..12 (UI-M03-11 partial) and admin UI-M03-13..21 (UI-M03-19 verified with an empty queue only). Arabic RTL + English, loading/empty/error/forbidden states.
- **Runbooks:** `psp-incident`, `refund-procedure`, `subscription-lifecycle`, `dunning`, `zatca-onboarding`, `zatca-queue-stuck`, `zatca-key-rotation` (states **NOT IMPLEMENTED**), `reconciliation-break-handling`, `invoice-correction`, `tax-and-invoice-numbering`. Demo: [demo-m03.md](../runbooks/demo-m03.md).

## D. Migrations and rollback
Thirteen forward migrations (0312 added in S12d: duplicate-event counters on `payments.psp_events`), each with a dev/staging-only `.down.sql`; production is forward-fix. Invoice, credit-note, payment, refund, ledger, ZATCA and reconciliation tables are append-only or immutable by trigger and are **never dropped** by down scripts in a production profile. Tenant-less tables (entities, tax rates, PSP accounts, reconciliation, ZATCA onboarding) are listed in `db/ownership.yaml` `tenant_less`; `pnpm --filter @nuzm/db exec tsx src/cli.ts check` enforces RLS or listing. Reviewer action: read the down scripts and `refund-procedure` / `invoice-correction` before sign-off.

## E. Tests run with actual results
`pnpm verify:full` → **exit 0** on 2026-11-18 at S12d (commit `3629202`): lint, typecheck, unit, build, spec lint/drift, SDK check, secret scan, ZATCA guard, 19/19 turbo test tasks including the browser E2E, `db:migrate`, `db:test-rls`, integration. Two earlier attempts the same day failed on test defects (a UTC-day helper in `reports.int.spec.ts`, random fixture ids in a new test) that were fixed, not skipped — see [S12d §A](S12d-report.md).
| Layer | Result |
|---|---|
| API unit | 301 passed |
| Integration (real PostgreSQL) | db 43, platform 32, worker 8, api **580**: 663 passed |
| Web unit | 49 passed |
| Admin unit | **46** passed |
| i18n | 9 passed (key and placeholder parity, 770 M03 keys across S12c/S12d) |
| Browser E2E | **10 passed** (01 customer, 02 admin, 03 billing, 04 payments, **05 admin finance**; ar and en; axe WCAG A/AA clean on every screen) |
| Lint / typecheck / spec drift | exit 0 / passed / "121 implemented route(s) all declared (121 declared)"; `sdk:check` up to date; `db check OK` |

Highlights by acceptance row are in §H. Screenshots: `docs/reports/screenshots/{ar,en}/` (S12d screens are `adminfin-*.png`).

## F. Security, tenant isolation, billing, residency
- **Tenant isolation:** forced RLS on every org table; the cross-tenant suite is generated from the OpenAPI spec and fails when a new org-scoped route has no fixture (404 for a foreign organization, by session and by API key); `db check` requires `org_id` + RLS or a `tenant_less` entry.
- **PCI scope reduction:** tokens only; tests assert no card-number/CVC field exists in the web pages and a repository scanner finds no PAN pattern; log redaction beyond the request path is not separately scanned. This is not a PCI certification (SAQ-A-style scope to be confirmed with the PSP/QSA).
- **Money:** integer minor units; only the `billing` posting service writes the ledger; ledger and audit are append-only (corrections are reversing entries); financial flow quote → authorize → record → reconcile; idempotency keys on side-effecting POSTs; webhooks deduped by provider event id.
- **Secrets:** ZATCA keys only as vault references (dev vault, refuses a production profile); the one-time password is used once and never stored or logged.
- **Residency:** invoice and ZATCA archives carry `data_region` (placeholder `sa-pending`); `ResidencyPolicyService` is M04, so PSP/ZATCA transfers are recorded as stubs, **not evaluated**.
- **Audit:** every mutation audited, including admin reads of finance reports.

## G. Human gates and live checks still needed
### PSP / ZATCA live-status table
| Area | Status | What exists | What is needed |
|---|---|---|---|
| Real PSP adapter | **BLOCKED (D-10)** | `psp-mock` only | Owner picks the PSP; sandbox keys in the non-prod vault |
| PSP sandbox end-to-end (add card, charge, refund, webhook, settlement) | **BLOCKED (HG-03-02)** | mock scenarios incl. timeout, duplicate and out-of-order webhooks | live sandbox run → `LIVE-VERIFIED (sandbox)` |
| PSP production approval and first live transaction | **BLOCKED (HG-03-02)** | none | owner action |
| 3-D Secure, recurring charges, refunds on a real PSP | **NOT VERIFIED** | mock behaviour | live sandbox |
| Hosted card field / redirect | **BLOCKED (D-10)** | sandbox test-card picker, no card fields | PSP hosted fields |
| Official ZATCA specification pinned | **BLOCKED (HG-03-03)** | synthetic profile, UNPINNED | owner supplies documents |
| UBL XML, hash canonicalization, QR fields, signature, CSR attributes | **NOT VERIFIED vs ZATCA** | generators + local structural validator | official XSD/Schematron, sample goldens |
| Onboarding (compliance/production CSID, EGS, OTP) | **BLOCKED (HG-03-03)** | two-person state machine against our simulated server | Fatoora portal access, OTP, registration |
| Clearance / reporting with ZATCA | **BLOCKED (HG-03-03)** | simulated server of our own contract | sandbox access |
| ZATCA production | **BLOCKED (HG-03-03, owner action)**; refused by the platform | none | owner decision and evidence |
| Real billing entity data | **BLOCKED (HG-03-01)** | placeholder, issuing refused outside sandbox | registered legal names, VAT, CR, address |
| Tax advisor sign-off | **BLOCKED (HG-03-04)** | question list below | advisor |
| RC-01 against a real settlement report | **NOT VERIFIED (D-10)**; RC-04 provider bills **BLOCKED (M05)**; RC-05 on simulated data **NOT VERIFIED** | fixtures | live data |
| Email delivery of notices | **NOT VERIFIED (D-08/M08)** | dev logger | mailer |
| Invoice PDF Arabic/English visual approval | **NOT VERIFIED** (owner reviewer) | samples in [`samples/`](samples/) | reviewer sign-off |

### Tax-advisor question list (all [VERIFY] items, HG-03-04)
1. **VAT rate and scope:** is 15 % standard for all Nuzm services; which supplies are exempt, zero-rated or export (non-resident buyers, foreign-currency display)? Is `TAX_DEFAULT_SCOPE=domestic` right?
2. **Buyer classification and tax profile:** B2B (VAT-registered) vs B2C rules; required address components; format of VAT number (`^3\d{13}3$` assumed), CR number (10 digits), postal code (5 digits), building number (4 digits).
3. **Rounding:** per-line half-up with document total = Σ lines, 0 tolerance. Does ZATCA require another rule?
4. **Price display:** tax-exclusive price books and inclusive/exclusive display (D-23, HG-02-01).
5. **Invoice template:** mandatory fields and wording (Arabic and English), series format, gapless numbering rules, the "sandbox / not a real tax document" marking.
6. **Credit notes:** line mapping to the original invoice, reason codes, treatment when refunding, partial credit, and credit notes without refund.
7. **Proration:** VAT on prorated plan changes; invoicing of credits; trial periods.
8. **Prepaid credit (wallet), D-25:** VAT at top-up vs at consumption; whether an advance-payment tax document is needed; expiry and refundability; **counsel:** does holding prepaid credits trigger SAMA licensing?
9. **Dunning and bad debt:** legal notice before restriction/suspension; bad-debt VAT adjustment (HG-04-01).
10. **Marketplace and resellers (D-24, D-26):** commission vs gross revenue account; who is the issuer of record for reseller sub-organizations.
11. **E-invoicing:** failure policy when clearance is unavailable (block standard invoices, queue simplified); the simplified reporting window length; debit-note use; exemption and zero-rating codes.
12. **Retention and archive (D-34):** retention period for financial records (6 years assumed), in-Kingdom WORM archive, and the conflict with data-subject deletion (HG-04-01).
13. **PCI scope:** confirm SAQ-A-style scope with the PSP and a QSA.
14. **Reports:** VAT report rate scope, credit-note treatment, and calendars (D-31).

### Other human gates
HG-03-01, HG-03-02, HG-03-03, HG-03-04, HG-02-01 (approved price book), HG-04-01 (retention constraints), D-10, D-11, D-23, D-24, D-25, D-31, D-33, D-34, ADR-017 acceptance. The agent has not marked any HG as granted.

## H. Acceptance checklist
| ID | Status | Evidence / notes |
|---|---|---|
| AC-M03-01 recipes; 10,000 random sequences balanced | **PARTIAL** | Built and property-tested (`recipes.spec.ts`): credit grant, wallet consume, usage charge (wallet), provider-cost accrual, reversal/adjustment (M02, 10,000 runs), **invoice issued, credit note, payment captured, refund (10,000 runs each)**, wallet top-up (unit-tested). **Not built:** deferred-revenue invoice and its monthly release, PSP settlement/fee (5200), provider bill paid, FX difference, wallet-debit orchestration |
| AC-M03-02 duplicate webhook ×100 and out-of-order → exactly 1 ledger effect | **PASS** (sandbox PSP) | `payments.int.spec.ts` ([S09](S09-report.md)) |
| AC-M03-03 0 duplicate charges in 1,000 injected timeouts | **PASS** (sandbox PSP) | S09; the refund path too (S10a) |
| AC-M03-04 no PAN/CVV in DB, logs, fixtures | **PASS** (database, request path, repository scanner) | S09; log redaction beyond the request path not separately scanned |
| AC-M03-05 invoice totals over 10,000; sequence gapless under 200 concurrent | **PASS** | S08a engine + allocator, S08b invoice level |
| AC-M03-06 period close idempotent | **PASS** | S08b |
| AC-M03-07 Arabic + English PDF visually approved | **NOT VERIFIED** | samples delivered and automated checks pass; owner reviewer approval pending |
| AC-M03-08 UBL XML, hash chain, QR pass local validators/goldens for the pinned spec | **NOT VERIFIED vs ZATCA** | chain (database-enforced), TLV and structural validator PASS on the **synthetic** profile; no pinned spec, no official goldens (BLOCKED HG-03-03) |
| AC-M03-09 queue retry/backoff/DLQ; clearance gate blocks delivery | **PASS** (simulated server) | S11b; credit-note PDF is not gated yet |
| AC-M03-10 RC-01..06: seeded breaks 100 %, 0 false positives, resolution links approved adjustment | **PASS** | S12a; RC-04 bills skipped, RC-01/RC-05 on sandbox/simulated data |
| AC-M03-11 revenue/VAT/AR reports equal ledger sums | **PASS** | S12b |
| AC-M03-12 dunning exhaustive tests; no automatic data deletion path | **PARTIAL** | transition tests and database guards PASS; day 0→45 test asserts zero deletion/termination requests; **no static source scan** for deletion paths exists |
| AC-M03-13 cross-tenant for 100 % new routes; RLS coverage 100 % new tenant tables | **PASS** | generated suite (fails on a missing fixture) + `db check`, green in the S12c full run |
| AC-M03-14 all 21 screens axe 0 serious/critical, ar+en screenshots | **PARTIAL** | UI-M03-01..10 and 12: E2E, axe clean, screenshots (S12c). UI-M03-13..18, 20, 21: E2E in ar and en, axe clean, screenshots (S12d). **Gaps:** UI-M03-11 reviews the quote only (no pay-quote API); UI-M03-19 verified with an empty queue only (no generated e-invoice in the E2E profile). All data is sandbox / simulated |
| AC-M03-20 live PSP sandbox end-to-end | **BLOCKED** (D-10, HG-03-02) | |
| AC-M03-21 PSP production approval, first live transaction | **BLOCKED** (HG-03-02) | |
| AC-M03-22 ZATCA sandbox/simulation compliance checks with owner credentials | **BLOCKED** (HG-03-03) | only our simulated server was exercised |
| AC-M03-23 ZATCA production CSID and clearance/reporting | **BLOCKED** (HG-03-03, owner action) | |
| AC-M03-24 tax advisor sign-off | **BLOCKED** (HG-03-04) | list in §G |
| AC-M03-25 real billing entity loaded | **BLOCKED** (HG-03-01) | |
| AC-M03-26 RC-04 against real provider bills | **BLOCKED** (M05) | |

**Milestone state:** not DONE. Critical-path rows still open: AC-M03-01 (recipes), -07 (visual approval), -08 (spec pinning), -12 (static check), -14 (UI-M03-11 payment and UI-M03-19 with data). BLOCKED rows are non-critical for M04–M05 only if the owner lists them as such in the gate review.

### Commands run (exact) and results
| Command | Exit | Note |
|---|---|---|
| `pnpm verify:full` | 0 | 2026-11-18 on `3629202`; numbers in §E |
| `pnpm test:e2e` / `pnpm --filter @nuzm/e2e exec playwright test` | 0 (final) | 10 passed; earlier S12d iterations failed on test setup (staff needed the finance role, shared ar/en database assumptions, strict locators) and were fixed |
| `pnpm --filter @nuzm/api exec vitest run --config vitest.integration.config.mts src/modules/payments/admin-reads.int.spec.ts` | 0 | 8 passed (3 consecutive runs) |
| `pnpm lint` · `pnpm typecheck` · `pnpm spec:lint` · `pnpm spec:drift` · `pnpm sdk:check` | 0 | after S12d |

### Spec issues found / change requests
1. Admin read APIs for invoices, payments + PSP events, and refunds (UI-M03-13/14/15): **added in S12d, owner approval pending**; invoice and payment detail endpoints not added.
2. An operation to pay a quote; a credit-note PDF operation.
3. Billing entity and tax-rate administration endpoints (PA-11) if runtime management is wanted.
4. Ledger dimension for meter group on revenue postings (revenue-by-meter-group report).
5. Reconciliation runs as `platform.operations` or as their own resource (own resource implemented).
6. Wallet-debit orchestration and top-up refunds (owner decisions); a static no-deletion check for dunning.
7. Credential renewal and key rotation for ZATCA (runbook says NOT IMPLEMENTED).

## I. Next-milestone handoff and open decisions
- **M04:** residency/transfer inventory entries for the PSP, ZATCA and the invoice archive (currently `sa-pending` stubs); DSR vs financial-retention conflict list; retention config (D-34).
- **M05:** `commerce.orders` → payment/authorization flow; RC-04 `fetchBilling` hook; consumers of dunning restrict/suspend/review requests (billing emits requests only).
- **M07/M11:** domain-order charge flow; `billing_entities`/D-24 options, marketplace checkout and publisher payable account (2600).
- **M12:** reconciliation and ZATCA queue SLO dashboards; production placement of the billing scheduler (ADR-017).
- **Open decisions:** D-10, D-11, D-23, D-24, D-25, D-31, D-33, D-34, HG-02-01, HG-03-01..04, approval of the S12d admin read APIs and migration 0312, quote payment, ADR-017.
