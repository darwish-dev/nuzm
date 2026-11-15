# M03 — Payments, Invoicing, Tax & ZATCA

Read CLAUDE.md first. Apply it in full. This prompt never overrides docs/04, docs/05, docs/03 — on conflict stop and report.

| | |
|---|---|
| Sprints | S08–S12 (5 sprints) |
| Depends on | M01 **H**, M02 **H** |
| Produces | PSP abstraction + first adapter (sandbox), payment methods/intents, subscriptions, invoices/credit notes, VAT engine, ZATCA module (sandbox), dunning, `finrec` (RC-01..06), revenue reports, billing UIs |
| Gate | Gate Review per docs/03 §5; migration range `M03: 0300–0499` |
| Specs | docs/11 (authoritative design for this milestone), docs/09 §6, docs/12 |
| Response format | CLAUDE.md §10 |

## 1. Objective
Turn rated usage, subscriptions and quotes into legally structured invoices, collect payment through a Saudi-capable PSP behind an adapter, post every financial event through the ledger, produce ZATCA-compliant e-invoice documents against **sandbox/simulation only**, and reconcile payments, ledger, usage, provider costs, ZATCA submissions and wallet balances. Production PSP use and production ZATCA onboarding are human-gated and remain BLOCKED in this prompt.

## 2. Preconditions & mocked interfaces
| Item | State | Handling |
|---|---|---|
| M01, M02 gate reviews signed | required | Stop if absent |
| D-10 PSP choice | OPEN | Implement `PspAdapter` + `psp-mock` + one real-adapter skeleton for the owner's chosen PSP **only after D-10 answered**; until then only mock; real PSP = BLOCKED |
| D-11 ZATCA approach | OPEN | Build `EInvoiceAdapter` interface + `zatca-native` against pinned spec; `zatca-vendor` stub only if D-11 selects it |
| D-33/HG-03-01 billing entity data | OPEN | Seed entity with placeholder values flagged `PLACEHOLDER-NOT-REGISTERED`; issuing in non-sandbox mode refused |
| HG-03-02 PSP sandbox keys | PENDING | `psp-mock` + recorded fixtures; live sandbox calls only after owner provides keys in non-prod vault |
| HG-03-03 ZATCA onboarding | PENDING | Generate/validate XML, hash chain, QR, signing with **self-generated test keys**; no submission to ZATCA environments; submission mock server; mark `NOT VERIFIED vs ZATCA` |
| HG-03-04 tax advisor sign-off | PENDING | All [VERIFY] items in docs/11 listed in the report for the advisor |
| M04 `ResidencyPolicyService` | not built | Stub flagged; invoice archive `data_region` stored |
| M05 provider adapters (`fetchBilling`) | not built | RC-04 on fixtures; NOT VERIFIED live |

## 3. Requirement IDs closed
FR-PAY-01..FR-PAY-10, FR-ZAT-01..FR-ZAT-08 (FR-ZAT-06 onboarding and FR-ZAT-07 clearance/reporting: **implemented against sandbox; live closure BLOCKED by HG-03-03**), FR-UI-xx for UI-M03-01..21.

## 4. Automatable engineering tasks
**S08 — Invoicing core and tax.**
1. `invoicing` schema: `billing_entities`, `tax_profiles`, `tax_rates` (effective-dated, seeded from config with [VERIFY] flag), `invoices`, `invoice_lines`, `credit_notes`, `invoice_sequences` (gapless per entity+series, allocation under advisory lock).
2. Tax engine per docs/11 §4: rate resolution, b2b/b2c classification, rounding rules with property tests; `TaxEstimator` replaces M02 mock; quotes now show `taxEstimate.status="computed"`.
3. Invoice builder: sources = subscription charges + `metering.rated_usage` + order items + adjustments; immutable once `issued`; PDF rendering (Arabic + English, RTL-correct, QR placeholder region); invoice state machine; `invoice.issued` event; ledger recipe "invoice issued" via `LedgerPostingService`.
4. `GET/PUT /v1/billing/tax-profile`; buyer validation per spec rules (hedged, config).
**S09 — Payments.**
5. `payments` schema + `PspAdapter` (docs/09 §6): `psp-mock` (deterministic scenarios: success, decline, 3DS required, timeout-uncertain, duplicate webhook, out-of-order webhook, partial refund fail) and first real adapter skeleton per D-10 (sandbox only).
6. Payment methods (tokenized; hosted fields/redirect only — no PAN/CVV ever in our code, logs or DB; test asserts), intents/attempts state machine, 3DS `requires_action` flow, `POST /v1/webhooks/payments/{provider}` with signature check, replay window, `psp_events` dedupe, transactional processing (state + ledger + outbox).
7. Reconcile-before-retry for uncertain PSP results (poll PSP by merchant reference before creating a new attempt).
**S10 — Subscriptions, wallet, dunning, refunds.**
8. `billing.subscriptions` (items JSON column; plan version, period anchors, proration config), renewal worker (idempotent per period), trial, cancel at period end, plan change with proration (credit/charge lines).
9. Wallet top-up (`POST /v1/billing/wallet-topups`) and wallet consume/debit mode; policy flags per D-25 (VAT timing configurable).
10. Dunning state machine + policy config `spec/billing/dunning-policy.yaml` (retry schedule, notices, restrict/suspend actions emitting operations **requests** only — actual suspension executed by owning modules in M05+; no data deletion ever); `billing.dunning_cases`.
11. Refunds (`POST /v1/admin/billing/refunds`, idempotent, ≤ remaining captured), credit notes (draft→issued) with ledger recipes.
**S11 — ZATCA module (sandbox/simulation).**
12. Pin spec: `spec/zatca/<version>/` with owner-supplied official documents (if none supplied → BLOCKED item; proceed with interface + synthetic tests only); `spec/zatca/VERSION` + checksum CI guard.
13. Implement per docs/11 §5: document builders (standard, simplified, credit, debit), UBL XML generator, schema/Schematron validation harness (when official artifacts available), ICV/PIH chain, UUID, QR TLV, signing service with vault-ref keys, CSR generator, onboarding state machine (`zatca_onboarding`, `zatca_credentials_refs`), submission queue/worker with backoff and DLQ, archive store (WORM semantics; retention config), clearance gating (standard invoices not delivered until cleared) and reporting queue (simplified), manual retry endpoint.
14. Mock ZATCA server in `packages/testing` implementing only behaviours documented publicly **as the owner supplies them**; mark all outcomes `NOT VERIFIED vs ZATCA`.
15. If owner provides HG-03-03 sandbox access → run live sandbox compliance checks and record `LIVE-VERIFIED (sandbox)`; never production.
**S12 — Reconciliation, reports, UI.**
16. `finrec` schema + framework; implement RC-01..RC-06 (docs/11 §9) with matching keys, tolerance config (D-31), scheduled runs + `POST /v1/admin/billing/reconciliations`, break lifecycle and `…/{id}/resolutions` linked to approved adjustments (M02 endpoint).
17. Revenue reports (`GET /v1/admin/billing/revenue-reports`, CSV) with ledger-equality tests.
18. All screens §8; email/in-app notifications (invoice issued, payment failed, dunning notices, card expiring) ar/en templates.
19. Runbooks: PSP incident, refund procedure, ZATCA onboarding (human steps), ZATCA queue stuck, reconciliation break handling, invoice correction (credit note path), key rotation. Demo script; `docs/reports/M03-report.md` including **tax-advisor question list** (all [VERIFY] items) and PSP/ZATCA live-status table.

## 5. Human approvals & external gates
| ID | Item | Agent meanwhile | Default status |
|---|---|---|---|
| HG-03-01 | Billing entity registration data (legal names ar/en, VAT no., CR, address) | Placeholder entity; refuse non-sandbox issuance | PENDING |
| HG-03-02 | PSP merchant account, sandbox keys, production approval | `psp-mock`, fixtures; production BLOCKED | PENDING |
| HG-03-03 | ZATCA onboarding: Fatoora portal access, OTP for compliance CSID, device/EGS registration, wave eligibility; production CSID later | Test keys, mock server, synthetic goldens | PENDING / production BLOCKED |
| HG-03-04 | Tax advisor sign-off on invoice templates, VAT config, credit notes, wallet VAT timing, reseller treatment | Provide [VERIFY] list | PENDING |
| HG-02-01 | Approved price book / VAT-inclusive display | Draft config | PENDING |
| D-10, D-11, D-24, D-25, D-31, D-33, D-34 | docs/07 | Defaults in docs/11 as reversible | OPEN |
| HG-04-01 | Retention/DSR constraints on financial records | Retention config only | PENDING |

## 6. API specifications (docs/04 §2.3 — exact)
| Endpoint | Authz | Request → response | Errors / idempotency / async |
|---|---|---|---|
| POST/GET `/v1/billing/payment-methods` · DELETE `…/{id}` · POST `…/{id}/default` | owner, billing_admin | POST `{provider,setupToken|returnUrl}` → `{id,brand,last4,expMonth,expYear,status}` or `{redirectUrl}`; **no PAN fields accepted** (422 `pan_not_allowed`) | Idempotency-Key; 409 method in use by active subscription |
| POST/GET `/v1/billing/payments` · GET `…/{id}` | owner, billing_admin | POST `{invoiceId|quoteId|walletTopupId, paymentMethodId?, returnUrl}` → intent `{id,status,nextAction?}` | Idempotency-Key; 202 when `processing`; 409 invoice already paid; 422 amount mismatch |
| POST `/v1/billing/wallet-topups` | owner, billing_admin | `{amount:{amount,currency}, paymentMethodId?}` → payment intent + topup | min/max config; Idempotency-Key |
| POST/GET `/v1/billing/subscriptions` · GET/PATCH `…/{id}` · POST `…/{id}/cancellation` | owner, billing_admin; read: admin | `{planVersionId,paymentMethodId,quantity?}`; PATCH plan change preview/apply (`prorationMode`) | 402-style `payment_required` as 422 `payment_method_required`; ETag |
| GET `/v1/billing/invoices` · GET `…/{id}` · GET `…/{id}/pdf` · GET `…/{id}/xml` | billing:read | invoice with lines, tax breakdown, ZATCA status `{state,uuid,qr}`; xml = stored issued/cleared XML | 404 until issued; xml 409 if not applicable/not generated |
| GET `/v1/billing/credit-notes` · GET `…/{id}` | billing:read | linked invoice, reason | |
| GET/PUT `/v1/billing/tax-profile` | owner, billing_admin | `{legalName{ar,en},vatNumber?,crNumber?,address{…},buyerType}` | 422 validation (config rules); If-Match; audit |
| POST `/v1/webhooks/payments/{provider}` | provider (signature) | raw event → `200` after durable insert | 401 bad signature; duplicate → 200 no effect; replay window |
| POST `/v1/admin/billing/refunds` | finance (+ step-up) | `{paymentId,amount,reason}` | Idempotency-Key; 422 exceeds remaining; async 202 if PSP pending |
| GET `/v1/admin/billing/reconciliations` · POST `…` (run) · GET `…/{id}` · POST `…/{id}/resolutions` | finance, platform_admin (read: compliance_officer) | run `{types[],periodFrom,periodTo}` → 202 + operation; resolution `{itemId,action,adjustmentId?,note}` | 409 run in progress for same type/period |
| GET `/v1/admin/billing/zatca/onboarding` · POST `…` | finance + security (two-person for credential steps) | `{environment:sandbox|simulation|production, step:csr|compliance_csid|compliance_checks|production_csid}`; production step refused unless HG-03-03 evidence flag set by owner | 409 wrong state; 422 env not enabled |
| GET `/v1/admin/billing/zatca/submissions` · POST `…/{id}/retry` | finance | list/filter state; retry idempotent per document uuid | 409 not retryable (cleared/rejected) |
| GET `/v1/admin/billing/dunning` · PATCH `…/{id}` | finance | case state, manual hold/resume (reason) | |
| GET `/v1/admin/billing/revenue-reports` | finance, platform_admin | `?report=revenue|mrr|ar_aging|vat|margin|refunds|dunning|wallet&from&to&format=json|csv` | CSV streaming; RLS-bypass read via reporting role, audited |
Not specified in docs/04 (do not invent endpoints): billing entity and tax-rate administration — manage by seed/config migrations in M03; report as spec gap.

## 7. Database migrations (`0300–0499`)
| Schema | Tables / notes |
|---|---|
| `payments` | `psp_accounts`, `customers_psp`, `payment_methods` (token ref, brand, last4, exp, fingerprint; no PAN), `payment_intents`, `payment_attempts` (immutable), `refunds`, `psp_events` (unique `(psp,event_id)`), `payment_reconciliations` (**not created; RC-01 lives in `finrec`**, see spec issue) |
| `invoicing` | `billing_entities`, `tax_profiles`, `tax_rates`, `invoices` (immutable after issue; trigger), `invoice_lines`, `credit_notes`, `invoice_sequences`, `zatca_onboarding`, `zatca_credentials_refs` (vault refs only), `zatca_documents` (uuid, type, xml ref, hash, qr, icv, pih), `zatca_submissions` (append-only; state derived) |
| `finrec` | `reconciliation_runs`, `reconciliation_items`, `reconciliation_resolutions` |
| `billing` (extends) | `subscriptions`, `dunning_cases` |
RLS on org tables; entity/tax_rates/psp_accounts platform tables readable by `finance` role only. Indexes: `invoices(org_id, status, issued_at)`, `payment_attempts(psp_charge_id)`, `psp_events(processed_at)`, `zatca_submissions(state, next_attempt_at)`, `reconciliation_items(run_id, status)`. Archive: issued XML/PDF to object store with `data_region` (local dev store now). Reversal: dev `.down.sql`; prod forward-fix; invoices/ZATCA tables never dropped in prod profile. Seed: tax rates (flagged [VERIFY]), entity placeholder, dunning policy file.

## 8. UI screens
All ar (RTL)+en; invoices/PDF Arabic shaping verified; loading/empty/error/forbidden; axe clean; screenshots.
| ID | Portal | Route | Purpose / key states | Roles |
|---|---|---|---|---|
| UI-M03-01 | C A R | `/billing/payment-methods` | list, default, remove; expiring badge | owner, billing_admin |
| UI-M03-02 | C A R | `/billing/payment-methods/add` | PSP hosted fields/redirect; failure/3DS states; "we never see your card" notice | owner, billing_admin |
| UI-M03-03 | C A R | `/billing/subscriptions` | list, status, next renewal | billing:read |
| UI-M03-04 | C A R | `/billing/subscriptions/[id]` | change plan (proration preview), cancel (period end), dunning banner | owner, billing_admin |
| UI-M03-05 | C A R | `/billing/invoices` | list/filter/download; ZATCA status badge | billing:read |
| UI-M03-06 | C A R | `/billing/invoices/[id]` | detail, tax breakdown, QR, PDF/XML download, pay now | billing:read |
| UI-M03-07 | C A R | `/billing/credit-notes` | list/detail | billing:read |
| UI-M03-08 | C A R | `/billing/payments` | history, statuses, refund state | billing:read |
| UI-M03-09 | C A R | `/billing/wallet` | balance, top-up, consumption ledger | owner, billing_admin |
| UI-M03-10 | C A R | `/billing/tax-profile` | VAT/CR/address form, validation, B2B/B2C | owner, billing_admin |
| UI-M03-11 | C A R | `/billing/checkout/[quoteId]` | review quote → approve spend (if needed) → pay → status polling (202 operation) | developer+ (pay: billing roles) |
| UI-M03-12 | C A R | `/billing/payment-return` | PSP/3DS return handling: success/pending/failed | any |
| UI-M03-13 | X | `/billing/invoices` | cross-org invoice search, ZATCA state, reissue-via-credit-note guidance | finance |
| UI-M03-14 | X | `/billing/payments` | payments + raw PSP events (redacted), duplicate-event indicator | finance |
| UI-M03-15 | X | `/billing/refunds` | request refund (step-up), status | finance |
| UI-M03-16 | X | `/billing/reconciliations` | run list, schedule, filters by RC type | finance |
| UI-M03-17 | X | `/billing/reconciliations/[id]` | breaks table, assign, resolve with adjustment link | finance |
| UI-M03-18 | X | `/billing/zatca` | onboarding wizard (environment banner SANDBOX/SIMULATION/PRODUCTION, production locked), credentials status (vault refs only) | finance, security |
| UI-M03-19 | X | `/billing/zatca/submissions` | queue, errors, retry, DLQ, window-SLO gauge | finance |
| UI-M03-20 | X | `/billing/dunning` | cases, hold/resume | finance |
| UI-M03-21 | X | `/billing/revenue-reports` | report picker, charts, CSV export, ledger-equality check badge | finance, platform_admin |

## 9. Security, compliance & tenant-isolation requirements
- **PCI scope reduction:** tokens only; automated scan test for PAN patterns in logs/DB/fixtures; CSP restricting PSP frames; adapter returns only token/last4/brand.
- Webhooks: signature + timestamp window + dedupe; unknown provider → 404; replay returns 200 with no effect.
- Keys: ZATCA private keys and PSP secrets only as vault refs; signing service least privilege; no key in logs; test keys clearly distinct from production.
- Invoices immutable; corrections via credit/debit note; admin adjustments two-person approval; separation of duties (requester ≠ approver).
- Cross-tenant: invoices, payments, methods, subscriptions, tax profiles RLS-protected; reporting role access audited.
- Classification: tax profile & invoices = `financial`+`personal` (company contact), PSP tokens = `credentials`; retention per D-34 (financial records legal retention — verify with advisor).
- Audit events: `payment.intent_created|succeeded|failed`, `payment.method_added|removed`, `refund.requested|completed`, `invoice.issued|voided`, `creditnote.issued`, `subscription.created|changed|cancelled`, `dunning.state_changed`, `zatca.onboarding_step`, `zatca.submission_state`, `recon.run_completed|break_opened|resolved`, `taxprofile.updated`, `wallet.topup|consume`.
- Residency: invoice archives and ZATCA payloads stored with `data_region`; PSP/ZATCA transfers recorded for M04 transfer assessments (stub).

## 10. Metering & billing hooks
Consumes `metering.rated_usage` for invoice lines; emits no meters except `email.transactional_messages` is **not** emitted here (notification emails use platform channel, not metered). Quota/entitlement checks on `POST /v1/billing/subscriptions` (plan eligibility) via `EntitlementService`. Spend approvals (M02) gate `POST /v1/billing/payments` for quote checkout when `requiresApproval`. Period close job: `rating run → invoice build → issue → ledger → ZATCA queue` as one idempotent operation per (org, period, entity).

## 11. Automated tests
| Layer | Cases |
|---|---|
| Property | `invoice_total_equals_sum_of_lines_and_tax`, `rounding_stable_under_line_reorder`, `ledger_recipe_balanced_all_kinds`, `invoice_sequence_gapless_under_concurrency` (200 parallel issues) |
| Unit | tax rate resolution by date/buyer type; proration math; dunning transitions (all allowed/forbidden); state machines (payment, subscription, invoice, credit note, ZATCA); QR TLV encode/decode; hash-chain next-PIH; UBL XML golden files (synthetic marked NOT VERIFIED) |
| Integration | `webhook_duplicate_no_double_post`, `webhook_out_of_order`, `webhook_bad_signature_401`, `psp_timeout_reconciles_before_retry`, `3ds_flow`, `refund_exceeds_remaining_rejected`, `partial_refund_then_credit_note`, `renewal_idempotent_per_period`, `period_close_idempotent_rerun`, `zatca_retry_backoff_dlq`, `zatca_clearance_blocks_delivery`, `rating_to_invoice_to_ledger_totals_match` |
| Concurrency | capture vs refund race; two workers issuing same period; parallel top-ups; sequence allocation |
| Cross-tenant | invoices/payments/methods/subscriptions/tax-profile for every route; reporting role access audited |
| Contract | OpenAPI conformance; PSP adapter conformance kit (`psp-mock` + fixtures); EInvoiceAdapter conformance |
| Security | PAN-pattern scan; signature forgery; replay; key not in logs; CSV formula injection; authz on admin routes (support cannot refund) |
| Reconciliation | fixtures per RC-01..06 including seeded breaks (missing settlement, amount mismatch, orphan posting, usage double billing, cost > price, counter gap, wallet drift) detected 100%; zero false positives on clean fixtures |
| E2E (ar+en) | subscribe→usage→period close→invoice (PDF ar/en)→pay (mock PSP, 3DS)→refund→credit note→reconciliation clean; dunning path to restricted; customer cannot see other org's invoice |
| ZATCA sandbox (conditional) | only with HG-03-03 sandbox access: compliance checks pass; recorded `LIVE-VERIFIED (sandbox)` else `NOT VERIFIED` |

## 12. Deliverables
Modules `payments`, `invoicing` (+`zatca/`), `finrec`, billing extensions; adapters `psp-mock`, optional real-PSP sandbox adapter (post D-10), `zatca-native`; migrations 0300–0499; OpenAPI §6; `spec/zatca/` structure (+VERSION); fixtures packs (`packages/testing/fixtures/billing`); screens §8; notification templates ar/en; runbooks (PSP incident, refund, ZATCA onboarding human steps, ZATCA queue, reconciliation break handling, invoice correction, key rotation); demo `docs/runbooks/demo-m03.md`; `docs/reports/M03-report.md` with live-status table and advisor question list; gate review; spec-issue list.

## 13. Measurable acceptance criteria
**A. Automatable now (mocks/sandbox fixtures allowed; label evidence accordingly)**
| ID | Criterion | Evidence | Status |
|---|---|---|---|
| AC-M03-01 | All ledger recipes in docs/11 §3.1 implemented; 10,000 random sequences keep 100% transactions balanced | test output | PENDING |
| AC-M03-02 | Duplicate webhook ×100 and out-of-order delivery produce exactly 1 ledger effect per business event | test output | PENDING |
| AC-M03-03 | PSP timeout path: 0 duplicate charges in 1,000 injected-timeout runs (reconcile-before-retry) | test output | PENDING |
| AC-M03-04 | No PAN/CVV in DB, logs or fixtures (scanner 0 hits); adapter responses limited to token/last4/brand | scan log | PENDING |
| AC-M03-05 | Invoice totals: Σlines+tax = total with 0 minor-unit difference over 10,000 generated invoices; sequence gapless under 200 concurrent issues | test output | PENDING |
| AC-M03-06 | Period close is idempotent: rerun creates 0 new invoices/ledger rows | test | PENDING |
| AC-M03-07 | Invoice PDF renders Arabic + English correctly (visual snapshot approved by owner reviewer) | screenshots | PENDING |
| AC-M03-08 | UBL XML, hash chain, QR TLV generated and pass **local** validators/goldens for pinned spec version; labelled NOT VERIFIED vs ZATCA | test output | PENDING |
| AC-M03-09 | ZATCA queue: retry/backoff/DLQ behaviours pass; clearance gate blocks delivery of uncleared standard invoice | tests | PENDING |
| AC-M03-10 | Reconciliation RC-01..RC-06: all seeded breaks detected (100%), 0 false positives on clean fixtures, resolution links an approved adjustment | report | PENDING |
| AC-M03-11 | Revenue/VAT/AR reports totals equal ledger sums (0 diff) | test | PENDING |
| AC-M03-12 | Dunning state machine exhaustive tests pass; no automatic data deletion path exists (static check) | tests | PENDING |
| AC-M03-13 | Cross-tenant tests pass for 100% new routes; RLS coverage 100% new tenant tables | report | PENDING |
| AC-M03-14 | All 21 screens axe 0 serious/critical, ar+en screenshots | reports | PENDING |
**B. BLOCKED until HG evidence (never satisfiable by mocks)**
| ID | Criterion | Gate | Status |
|---|---|---|---|
| AC-M03-20 | Live PSP **sandbox** end-to-end (card add, charge, refund, webhook, settlement report) recorded as `LIVE-VERIFIED (sandbox)` | HG-03-02 + D-10 | BLOCKED |
| AC-M03-21 | PSP production approval and first controlled live transaction | HG-03-02 | BLOCKED |
| AC-M03-22 | ZATCA sandbox/simulation compliance checks pass with owner-provided credentials | HG-03-03 | BLOCKED |
| AC-M03-23 | ZATCA production CSID and production clearance/reporting | HG-03-03 | BLOCKED (owner action) |
| AC-M03-24 | Tax advisor sign-off on invoice templates, VAT config, credit notes, wallet VAT timing | HG-03-04 | BLOCKED |
| AC-M03-25 | Real billing entity registered data loaded | HG-03-01 | BLOCKED |
| AC-M03-26 | RC-04 against real provider bills | M05 + HG-05-xx | BLOCKED |

## 14. Handoff to next milestones
M04: residency/transfer inventory entries for PSP, ZATCA, invoice archive; DSR vs financial retention conflict list. M05: `commerce.orders` → payment/authorization flow, `finrec` RC-04 adapter hook (`fetchBilling`), dunning suspension requests contract. M07: domain order charge flow. M11: `billing_entities`/D-24 options, marketplace purchase checkout, publisher payable account (2600). M12: reconciliation + ZATCA queue SLO dashboards. List open decisions and live-status table.

## 15. Compliance hooks checklist
- [ ] Residency: invoice/ZATCA archives carry `data_region`; PSP & ZATCA flows recorded as cross-border/third-party processors for M04
- [ ] PII: tax profile and invoices classified; no personal data in PSP metadata beyond need
- [ ] Consent: billing-communication preferences stored; marketing excluded
- [ ] Audit: events in §9 implemented
- [ ] Retention: financial-record retention config (D-34) present; DSR deletion paths exclude legally retained invoices pending counsel (HG-04-01)

## Completion instruction
Do not mark this milestone DONE until every acceptance row is evidenced. Rows in section 13-B stay BLOCKED until the owner records the corresponding HG evidence; they must never be simulated, and the milestone may close "Done with BLOCKED items" only if the gate review lists them as non-critical-path for M04–M05. The agent may not mark any HG item as granted; only the owner records evidence. Report using CLAUDE.md §10.
