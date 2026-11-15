# Nuzm — Payments, Subscriptions, Invoicing, Tax, ZATCA & Financial Reconciliation Track (draft)

Owner milestones: **M02** (ledger, plans, entitlements, quotes, spend control) and **M03** (payments, subscriptions, invoicing, tax, ZATCA, `finrec`). Related: `12-metering-spec.md`, `09-provider-adapter-interfaces.md §6`, `05-database-ownership-and-migrations.md`.

**Disclaimer.** Statements about ZATCA, VAT, PDPL, SAMA/PSP or tax law below are working assumptions taken from publicly known rules. Each is marked **[VERIFY]** and must be validated against the current official text with the tax advisor / counsel (HG-03-04). The agent must not treat any [VERIFY] item as settled, and must pin the spec version it implements. Not legal or tax advice.

## 1. Module architecture
```
metering (rated usage) ─┐
subscriptions/plans ────┼─► billing.InvoicingTrigger ─► invoicing (invoice, lines, tax) ─► issue
quotes/orders ──────────┘                                   │                              │
                                                            ▼                              ▼
                                         billing.LedgerPostingService ◄── payments (PSP)   zatca (stamp, submit)
                                                            ▲                              │
                                                            └────────── finrec (RC-01..06) ◄┘
```
| Module | Schema | Responsibility | Never does |
|---|---|---|---|
| billing (M02/M03) | `billing` | Ledger postings, plans/price books, entitlements, subscriptions, dunning cases, spend control | Talks to PSP or ZATCA |
| payments (M03) | `payments` | PSP abstraction, tokenized methods, intents/attempts, refunds, PSP event intake | Writes ledger rows directly (calls posting API) |
| invoicing (M03) | `invoicing` | Billing entities, tax profiles/rates, invoices, credit notes, sequences, ZATCA documents/submissions | Computes prices (uses rated usage + price items) |
| finrec (M03) | `finrec` | Reconciliation runs/items/resolutions for RC-01..06 | Mutates source data (proposes adjustments via `POST /v1/admin/billing/adjustments`) |
`zatca` code lives in `packages/adapters/zatca-*` (`EInvoiceAdapter`) and `invoicing` module `zatca/` sub-module, isolated per ADR-014 so spec changes do not ripple.

## 2. State machines
**Payment intent** (`payments.payment_intents.status`): `requires_method → requires_action → processing → succeeded | failed | cancelled`; `succeeded → partially_refunded → refunded`. Transitions only from PSP-verified events or poll-after-timeout (reconcile before retry). Attempts are immutable rows.
**Subscription**: `trialing → active → past_due → (active | unpaid) → cancelled`; `active → paused` (if enabled by flag) ; `cancel_at_period_end` flag. Proration config per plan version.
**Invoice**: `draft → open(issued) → paid | void | uncollectible`; `issued` is immutable (legal document); corrections only via credit note / debit note. `open → partially_paid → paid`.
**Credit note**: `draft → issued → applied|refunded`; must reference original invoice id and ZATCA reference.
**ZATCA submission** (`invoicing.zatca_submissions`, append-only event rows; current state derived): `generated → stamped → queued → submitted → (cleared | reported | rejected | error)`; `error → queued` (retry with backoff) up to N; `rejected` requires human review (no auto-resubmit of altered content: a rejected issued document is corrected via credit note + new invoice per advisor guidance [VERIFY]).
**Dunning case**: `none → reminder_1 → reminder_2 → restricted(new purchases blocked) → suspended(services suspended per policy) → terminated_pending(owner review)`; any successful payment returns to `none` and posts recovery audit. Timings are configuration (proposal D+3, D+7, D+14, D+21; D-23 finance to approve). Destructive termination always requires human approval.

## 3. Ledger: chart of accounts (seed data, `billing.ledger_accounts`)
Platform-level accounts (`org_id` null) and per-org sub-accounts (`org_id` set, same code with sub-ledger). Currency per account; base currency SAR.
| Code | Name | Type | Scope |
|---|---|---|---|
| 1100 | PSP clearing (funds in transit) | asset | platform, per psp_account |
| 1200 | Accounts receivable | asset | per org |
| 1300 | Provider prepayments | asset | platform, per provider_account |
| 1400 | VAT input (recoverable) | asset | platform |
| 2100 | Customer wallet / prepaid credits | liability | per org |
| 2200 | Deferred revenue | liability | per org |
| 2300 | VAT output payable | liability | platform |
| 2400 | Provider payables (accrued cost) | liability | platform, per provider_account |
| 2500 | Unapplied customer payments | liability | per org |
| 2600 | Publisher payables (marketplace; M11, payout subject to D-26) | liability | per publisher |
| 4100 | Usage revenue | revenue | platform (dimension: meter group) |
| 4200 | Subscription revenue | revenue | platform |
| 4300 | Domain & registration revenue | revenue | platform |
| 4400 | Marketplace commission revenue | revenue | platform |
| 4900 | Discounts & promotional credits (contra) | contra-revenue | platform |
| 5100 | Provider cost of revenue | expense | platform, per provider_account |
| 5200 | PSP fees | expense | platform |
| 5300 | Bad debt | expense | platform |
| 5400 | FX gain/loss | expense | platform |
Dimensions on postings (`dimensions jsonb`): `meter_id`, `resource_id`, `project_id`, `invoice_id`, `payment_id`, `provider_account_id`, `billing_entity_id`.

### 3.1 Posting recipes (each is one balanced `ledger_transaction`, idempotent on `(org_id, idempotency_key)`; key = business event id)
| Event | Debit | Credit |
|---|---|---|
| Invoice issued (net N, VAT V) | 1200 AR (N+V) | 4xxx revenue (N), 2300 VAT payable (V) |
| Invoice with prepaid-service billing in advance | 1200 AR (N+V) | 2200 Deferred (N), 2300 (V); release monthly: 2200 → 4200 |
| Payment captured (amount P, PSP fee F known later) | 1100 PSP clearing (P) | 1200 AR (applied) / 2500 (unapplied excess) |
| PSP settlement received (reconciliation) | bank (outside ledger scope; record as 1100 clearing cleared via `finrec` item) / 5200 PSP fees (F) | 1100 |
| Refund | 1200 AR or 2500 (R) | 1100 PSP clearing (R) |
| Credit note (net N, VAT V) | 4xxx or 4900 (N), 2300 (V) | 1200 AR (N+V) |
| Usage charge (rated usage billed on invoice) | via invoice recipe; **rated usage itself posts nothing** until invoiced, except wallet-debit mode: 2100 wallet (X) → 4100 (X) + VAT recipe |
| Wallet top-up | 1100 PSP clearing (T) | 2100 wallet (T) *(VAT treatment of prepaid credits: [VERIFY] with tax advisor D-25; recipe configurable: VAT at top-up vs at consumption)* |
| Wallet consume | 2100 wallet | 4100 revenue + 2300 VAT (if VAT-at-consumption) |
| Provider cost accrual (from `provider_cost_records`) | 5100 provider cost (C) | 2400 provider payables (C) |
| Provider bill paid (manual/HG) | 2400 | 1300 or bank |
| Promotional credit grant | 4900 | 2100 |
| Adjustment (admin, two-person) | per approved lines | reversing entry referencing original; never edit |
| FX difference (if provider cost currency ≠ SAR) | 5400 / 2400 | 2400 / 5400 (rate source+timestamp recorded; D-23) |
Invariants (tested as properties): Σdebits = Σcredits per transaction per currency; no UPDATE/DELETE; account balances derivable only from postings; wallet balance projection = Σ(2100 postings) (RC-06).

## 4. Tax engine (`invoicing.tax_rates`, config not code)
- `tax_rates(id, code, rate_bps, scope(domestic|export|exempt|zero), valid_from, valid_to, jurisdiction)`; resolution by seller entity + buyer tax profile + service type + date. Saudi standard VAT rate is understood to be 15% **[VERIFY]**; stored as seed data effective-dated, never hardcoded in logic. Exemptions/zero-rating (e.g., exports of services) are **configuration decisions for the tax advisor (HG-03-04)**; default for unknown cases = standard rate + flagged for review.
- Buyer classification: `b2b` (VAT-registered buyer with tax number → standard tax invoice) vs `b2c` (simplified). Non-resident/foreign buyers: treatment per advisor.
- **Prices:** price books hold tax-exclusive amounts; display mode (inclusive/exclusive) is a decision (D-23). Rounding: compute tax per line at currency minor-unit precision using half-up (banker's alternative via config) and document-level total = Σ line amounts; mismatch tolerance 0 minor units; final rule pinned to ZATCA rounding guidance **[VERIFY]**.
- Currency: invoices in SAR; foreign-currency display only informational unless advisor approves otherwise **[VERIFY]**.
- Tax profile (`GET/PUT /v1/billing/tax-profile`): legal name (ar/en), VAT number, CR number, address components required by the e-invoice spec **[VERIFY]**, B2B/B2C flag. Validation rules for VAT number format come from ZATCA spec **[VERIFY]**.

## 5. ZATCA e-invoicing (Fatoora Phase 2 integration — working breakdown, all **[VERIFY]** against the current published specification)
| Component | Description | Notes |
|---|---|---|
| Document types | Standard tax invoice (B2B), simplified tax invoice (B2C), credit note, debit note | Document subtype codes pinned in config from spec version |
| UBL XML | Generate UBL 2.1 XML with ZATCA-required extensions/fields from `invoices`+`lines`; Arabic/English names | XSD/Schematron validation locally against the pinned spec files (committed under `spec/zatca/<version>/`) |
| Invoice counter + hash chain | Per-EGS-unit invoice counter value (ICV) and previous invoice hash (PIH), UUID per document | `invoicing.invoice_sequences` with serializable allocation + advisory lock; gap detection test |
| QR code | TLV-encoded fields (seller, VAT no., timestamp, totals, VAT; additional fields for simplified incl. hash/signature/public key) as base64 | Golden-file tests against sample documents supplied by ZATCA developer portal |
| Cryptographic stamp | ECDSA signing of invoice hash using the CSID private key; key material **only** as vault refs; HSM/KMS if D-12 allows | Signing service isolated; no key export |
| Onboarding | Generate CSR → obtain compliance CSID (needs OTP from Fatoora portal, human: HG-03-03) → run mandatory compliance invoice checks → obtain production CSID; renewal/expiry tracking | State machine `invoicing.zatca_onboarding`; agent can build and run against sandbox/simulation only after owner provides HG-03-03 test OTP/credentials |
| Clearance vs reporting | Standard invoices: submitted for clearance before delivery to buyer (synchronous gating); simplified: reported to ZATCA within the published time window | Window length is configuration **[VERIFY]**; queue SLO alarm at 50% of window |
| Queue & retry | `zatca_submissions` rows, worker with exponential backoff, dead-letter to admin screen, manual retry (`POST /v1/admin/billing/zatca/submissions/{id}/retry`) | Idempotent on `document uuid` |
| Archive | Store original issued XML, cleared XML, QR, response payloads, hash; retention per tax law (commonly cited as 6 years) **[VERIFY, D-34]**; WORM-style storage, in-Kingdom (D-14/D-15) | |
| Credit/debit notes | Reference original invoice and reason code; same pipeline | |
| Environments | `sandbox` (developer portal), `simulation`, `production` as separate onboarding records and base URLs in config; production flag requires HG-03-03 evidence + owner toggle; agent never toggles | |
| Spec pinning | `spec/zatca/VERSION` + checksum of spec docs; CI fails if XML generator changes without version bump note | |
| Failure policy | If clearance unavailable: block issuing standard invoice (do not deliver) and alert; simplified: queue and report within window | Policy to be confirmed by tax advisor |

### 5.1 D-11 build vs vendor
| Criterion | Native (`zatca-native`) | Licensed provider (`zatca-vendor`) |
|---|---|---|
| Control/data residency | Full | Depends on vendor hosting terms |
| Time to compliance | Longer; spec tracking is ours | Shorter if vendor certified (verify claims) |
| Cost | Engineering + maintenance | Per-document fees |
| Risk | Spec drift, crypto errors | Vendor lock-in/availability |
| Recommendation | Both implement `EInvoiceAdapter`; M03 builds `zatca-native` against sandbox with the adapter boundary so `zatca-vendor` can replace it. Final choice is the owner's (D-11); no production reliance on either before HG-03-03/04. |

## 6. Billing entities and reseller model (D-24)
`invoicing.billing_entities` = seller legal entities (name ar/en, VAT no., CR no., address, ZATCA onboarding ref, invoice series). M03 ships one platform entity (HG-03-01 data). Options for resellers, decided before M11 design freeze:
| Option | Description | Impact |
|---|---|---|
| O1 (proposed default) | Nuzm invoices the reseller wholesale; reseller invoices sub-orgs outside Nuzm (or via a reseller tool in M11) | Simple tax; reseller needs own e-invoicing |
| O2 | Nuzm issues invoices to sub-orgs on behalf of reseller (agent/commission model) | Requires advisor approval; per-reseller billing entity + ZATCA onboarding |
| O3 | Each reseller registered as separate `billing_entity` in Nuzm with delegated onboarding | Highest complexity |
M03 schema supports O1–O3 (entity per invoice, `issuer_entity_id`) without implementing O2/O3 workflows.

## 7. Payments
- `PspAdapter` (doc 09 §6) with sandbox mode; first adapter chosen via D-10. **No PAN/CVV ever touches Nuzm** (hosted fields/redirect/tokenization only → SAQ-A style scope **[VERIFY with PSP/PCI QSA]**). Store only PSP token, brand, last4, expiry, fingerprint.
- Methods are those the chosen PSP supports and Nuzm verifies in sandbox (mada, cards, Apple Pay, others) — none assumed.
- Webhooks: signature verify → insert into `payments.psp_events` unique `(psp, event_id)` → async processor (transactional with state change + ledger posting + outbox). Duplicate events: no effect (tested).
- 3-D Secure/auth challenges via `requires_action`. Refunds idempotent by `refund_request_id`; partial refunds ≤ remaining captured.
- Wallet top-ups and subscription renewals use stored method with merchant-initiated semantics if PSP supports; otherwise customer-initiated.
- SAMA/financial-regulation scope: Nuzm holds no customer funds beyond prepaid platform credits; whether prepaid credits trigger licensing is a legal question (D-25, counsel) **[VERIFY]**.

## 8. Dunning policy (config `spec/billing/dunning-policy.yaml`)
Policy is versioned configuration (`spec/billing/dunning-policy.yaml`; docs/05 defines no `dunning_policies` table, only `billing.dunning_cases`). Retries: payment retry schedule (proposal D+1, D+3, D+5) → email/notification templates (ar/en) → restrict new purchases → suspend compute/hosting (grace configurable; billing only emits suspension *requests*, owning modules act) → owner approval for deletion. Never delete data automatically in M03. Legal notice periods/retention before deletion are decisions for counsel (HG-04-01). All steps audited and metered as messages.

## 9. Reconciliation (`finrec`)
Run types, matching keys, tolerance (D-31 numeric thresholds; proposal 0 minor units for RC-01/02/05/06, finance-set % for RC-03/04). Runs are scheduled (daily proposal) and on-demand (`POST /v1/admin/billing/reconciliations`); results immutable; resolutions are separate rows linking an approved adjustment.
| Type | Compares | Match key | Breaks examples |
|---|---|---|---|
| RC-01 | Payments (`payment_attempts`) vs PSP settlement/payout reports (`listSettlements`) | `psp_charge_id` | Missing settlement, amount/fee mismatch, unknown PSP charge |
| RC-02 | Ledger AR/revenue/VAT postings vs invoices & credit notes | `invoice_id` + posting dimensions | Invoice without posting, posting without invoice, VAT total mismatch |
| RC-03 | Rated usage (`metering.rated_usage`) vs invoice lines | `(org_id, period, meter_id, resource_id)` | Unbilled usage, double-billed usage |
| RC-04 | `metering.provider_cost_records` / ledger 2400 vs provider invoices/bills (adapter `fetchBilling`) | `(provider_account_id, bill_period, provider_line_ref)` | Unexpected provider charge (orphan resource), cost > price (negative margin) |
| RC-05 | `zatca_submissions` outcomes vs issued invoices | `document_uuid`/invoice id | Invoice never reported/cleared, rejected, counter gap |
| RC-06 | Wallet balance projection vs Σ ledger 2100 postings vs top-ups/consumption events | `org_id` | Projection drift |
Resolution workflow: break → `open` → assign → propose adjustment (two-person approval, reversing entries only) → `resolved` with link; unresolved breaks older than SLA (proposal 5 business days) raise alert. RC-04 depends on provider adapters (M05); until then it runs on fixtures and is **NOT VERIFIED** live.

## 10. Revenue and finance reports (`GET /v1/admin/billing/revenue-reports`, CSV export)
Revenue by period/product/meter group/entity; MRR/ARR from subscriptions; AR aging; VAT summary (output tax by period, by rate scope); gross margin (price vs `provider_cost_records`); refunds/credit notes; dunning funnel; wallet liability. Reports derive from ledger (single source); a test asserts report totals equal ledger sums.

## 11. Security
Tokens only; webhook signature + replay window; ZATCA keys in vault, signing service least privilege; invoice/PII fields classified `financial`/`personal` (M04); admin adjustments two-person approval + audit; invoices immutable; RLS on all org tables; report access role `finance`; separation of duties (the person requesting an adjustment cannot approve).

## 12. Test strategy and fixtures
- Property tests: ledger balance, rounding (Σ lines = total), idempotent recipes.
- Golden files: UBL XML, QR TLV, hash chain (from ZATCA-published samples when owner supplies them under HG-03-03; otherwise synthetic and marked NOT VERIFIED vs ZATCA).
- PSP contract tests against sandbox fixtures; webhook duplicate/out-of-order/replay tests; concurrency on payment capture vs refund.
- State-machine tests exhaustive over allowed/forbidden transitions.
- E2E: subscribe → usage → invoice → pay → refund → credit note → reconcile.
- Fixture packs under `packages/testing/fixtures/billing/*` (customers b2b/b2c, VAT scenarios, usage sets, PSP events, settlement files, provider bills).

## 13. Human gates and open decisions
HG-03-01 (billing entity registration data), HG-03-02 (PSP merchant/sandbox/prod), HG-03-03 (ZATCA onboarding), HG-03-04 (tax advisor sign-off), HG-02-01 (pricing/VAT display), D-10, D-11, D-23, D-24, D-25, D-31, D-33, D-34. Everything marked **[VERIFY]** above is added to HG-03-04's checklist.
