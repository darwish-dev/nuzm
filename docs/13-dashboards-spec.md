# Nuzm — Dashboards Specification (draft)

Applies to every milestone with UI. Screen IDs `UI-Mxx-nn` are defined inside the owning milestone prompt; the index at the end is generated from them (owner tooling). On conflict, docs/04 (API) and docs/05 (data) win; this document wins over milestone prompts for cross-cutting UX rules.

## 1. Portals and applications
| Portal | App / deployment | Route prefix | Auth realm | Network | First milestone |
|---|---|---|---|---|---|
| Customer Console | `apps/web` route group `(customer)` | `/…` | customer realm (D-04) | public | M01 |
| Agency Portal | `apps/web` route group `(agency)` | `/agency/…` | same realm; org `type=agency` + delegated access | public | M11 (shell M01) |
| Reseller Portal | `apps/web` route group `(reseller)` | `/reseller/…` | same realm; org `type=reseller` | public | M11 (shell M01) |
| Admin Console | `apps/admin` (separate deployment) | `/…` (root-relative in that app) | **separate admin realm**, MFA mandatory | restricted (VPN/IP allow-list; D-xx infra) | M01 |
Shared packages: `packages/ui`, `packages/i18n`, `packages/sdk` (generated from OpenAPI; no hand-written fetch to undocumented endpoints). Agency/Reseller screens reuse customer components in read/act-on-behalf mode via `X-Nuzm-Acting-Org`; the UI always shows an "acting for <org>" banner.

## 2. Information architecture
### 2.1 Customer Console (sidebar sections; milestone that adds each)
| Section | Entries (API basis) | Added by |
|---|---|---|
| Overview | Home (resources, spend, alerts), notifications (`/v1/notifications`) | M01 |
| Projects | Workspaces, projects, environments | M01 |
| Team & Access | Members, invitations, roles, API keys, sessions/MFA | M01 |
| Audit | Audit logs | M01 |
| Billing | Plans, usage, quotas, spending limits/approvals, ledger (M02); payment methods, subscriptions, invoices, credit notes, tax profile (M03) | M02/M03 |
| Compliance | Consents, data-subject requests, residency policy, data exports | M04 |
| Compute | Offers, instances, actions, metrics | M05 |
| Hosting | Plans, sites, backups/restores, domains, SSL, usage | M06 |
| Domains | Search, domains, DNS, transfers | M07 |
| Data | Databases (incl. Redis), buckets | M08 |
| Email | Domains, mailboxes, senders, templates, messages, suppressions | M08 |
| Builder & AI | Projects, runs, versions, deployments, usage/credits/budgets | M09 (+M10 app/mobile) |
| Automation | Workflows, connectors, webhook endpoints | M11 |
| Marketplace | Browse, purchases, installations; publisher listings | M11 |
| Enterprise | SSO connections, SCIM tokens (org settings) | M12 |
### 2.2 Agency Portal (M11)
Clients (`/v1/agencies/{id}/clients`), Delegated access, Client workspaces (acting-as views of customer sections), Consolidated billing & client usage, Agency audit.
### 2.3 Reseller Portal (M11)
Sub-organizations, Price rules, Statements (`/v1/resellers/{id}/statements`), Sub-org usage/billing view, Reseller audit. Merchant/invoice-issuer treatment pending D-24 — UI wording must not state tax treatment until decided.
### 2.4 Admin Console
| Section | Entries | Added by |
|---|---|---|
| Platform | Organizations, users, impersonation, feature flags, audit (cross-org) | M01 |
| Billing & Finance | Ledger accounts/transactions, price books, plans, adjustments, meters (M02); refunds, reconciliations, dunning, ZATCA onboarding/submissions, revenue reports (M03) | M02/M03 |
| Compliance | ROPA, controls, evidence, retention/holds, transfer assessments, regulatory validations, breach cases | M04 |
| Providers & Compute | Providers, accounts, capabilities, routing rules, resources, reconciliations | M05 |
| Hosting | Nodes, capacity, abuse cases | M06 |
| Domains | Registrars, orders, reconciliation | M07 |
| Data & Email | Data providers, fleet, deliverability | M08 |
| AI | Model providers, run oversight, quality | M09/M10 |
| Marketplace | Moderation | M11 |
| Operations | Health, incidents, alerts, provider incidents, recovery exercises, access reviews, policy versions, audit retention | M12 |

## 3. Roles and visibility
Org roles (defined by M01): `owner`, `admin`, `billing_admin`, `developer`, `viewer`. Platform roles (admin realm): `platform_admin`, `support`, `finance`, `compliance_officer`, `security`. Permission model remains deny-by-default via `PolicyService`; the matrix below is the **default seed**, enforced server-side, UI hides/disables accordingly.
| Section | owner | admin | billing_admin | developer | viewer |
|---|---|---|---|---|---|
| Overview, notifications | R | R | R | R | R |
| Projects/workspaces | W | W | R | W | R |
| Team & roles, invitations | W | W | — | R | — |
| API keys | W | W | — | W (own) | — |
| Audit logs | R | R | R (billing events) | — | — |
| Billing: usage/ledger/invoices | R | R | W | R (usage) | R (usage) |
| Billing: payment methods, subscriptions, spend limits, approvals | W | R | W | — | — |
| Compliance (consents, DSR, residency) | W | W | R | — | — |
| Compute / Hosting / Domains / Data / Email | W | W | R (quotes/approvals) | W | R |
| Builder & AI (use) | W | W | R (credits) | W | R |
| AI budgets | W | W | W | — | R |
| Automation / Marketplace purchases | W | W | W (purchases) | W (workflows) | R |
| Enterprise SSO/SCIM | W | W | — | — | — |
Platform roles → admin sections: `platform_admin` all except finance writes; `support` read orgs/resources/operations (metadata only), impersonation with consent; `finance` Billing & Finance W, Providers R; `compliance_officer` Compliance W, Audit R; `security` Audit R, Operations W, AI providers/kill switch W.
Org-type gating: `customer` sees Customer sections; `agency` additionally Agency Portal; `reseller` additionally Reseller Portal. **Context switcher** (top bar) lists own org, delegated client orgs, sub-orgs; switching sets acting org via header, refreshes permissions from `GET /v1/me`, and never persists across sessions without re-validation.

## 4. Design system (`packages/ui`)
- Tokens: color (semantic: surface, text, border, accent, success/warn/danger/info), spacing 4-pt scale, radius, elevation, motion durations, z-index. Dark mode: **decision D-32** (default: light only at launch; tokens structured to allow dark).
- **RTL:** CSS logical properties only (`margin-inline-start`, `inset-inline-end`, `text-align: start`); lint rule forbids physical `left/right` in app CSS; icons with direction semantics mirror (chevrons, back arrows), media/play do not; charts keep time axis direction per locale decision; code, numbers, URLs, emails render LTR via `dir="ltr"` islands.
- Typography: Arabic-capable family set with fallback stack, tested Arabic and Latin line-heights (Arabic ≥1.6 body proposal); no letter-spacing on Arabic; font files self-hosted (no third-party font CDNs — PDPL).
- Density: comfortable default, compact for data tables; min touch target 44 px.
- Components required before M02 UI: shell/nav, table (sort/filter/cursor pagination), form kit with inline validation from problem+json `errors[]`, modal/confirm, toast, operation-status, cost-disclosure, empty/error/forbidden panels, date/number/currency formatters, copy-secret field, diff viewer, code view.

## 5. i18n and formatting
- Locales `ar` and `en`; default per D-32 (proposal `ar` for Saudi market, user-selectable, persisted per user, `Accept-Language` fallback). All strings via `packages/i18n` catalogs; no concatenated sentences; ICU plurals (Arabic has 6 forms); pseudo-locale + missing-key CI check.
- Dates: store UTC; display Gregorian by default with optional Hijri secondary label (D-32 decision; no UI assumption beyond proposal); timezone default Asia/Riyadh with user override.
- Numbers: digits style (Western 0–9 vs Arabic-Indic) is user preference; **financial tables and invoices default to Western digits** (proposal, D-32) for consistency with exported documents.
- Money: API gives `{amount:"12345", currency:"SAR"}` integer minor units; formatter divides by currency exponent from a currency table (SAR 2), never floating division of raw strings without decimal library; show currency code or symbol per locale (official symbol font support to be verified); VAT-inclusive vs exclusive labels explicit (D-23).
- RTL/LTR mixed content test fixtures (Arabic text containing English names, URLs, numbers).

## 6. Standard states (every screen and data region)
| State | Requirement |
|---|---|
| Loading | skeleton ≤ 200 ms delay; no layout shift; announce via `aria-busy` |
| Empty | explanation + primary action + docs link; distinguishes "no data" from "filtered out" |
| Error | problem+json `title`, `code`, **traceId** copy button, retry; never raw stack/provider message |
| Forbidden | 403 explains missing role/entitlement/residency policy and who can grant; no data leak in the message |
| Offline | banner; queued writes not allowed for financial/destructive actions |
| Partial failure | per-widget error isolation; overview never blank due to one failing API |
| Stale | "last updated" + refresh; optimistic updates only for reversible actions |

## 7. Async operation UX pattern
1. Mutation returns `202` + `operationId` → toast "Started" with link; persistent entry in **Operations drawer** (`/v1/operations`).
2. Progress from operation state: `pending/running/waiting_provider` (with provider name), `needs_reconcile` shown as **"Verifying with provider — no action needed; do not retry"** (retry buttons disabled), `succeeded`, `failed` (error code + traceId + safe next step), `cancelled`.
3. Resource pages display `status` and link `operationId`; poll with backoff (2 s→30 s) or SSE where defined; cancel via `POST /v1/operations/{id}/cancellation` when allowed.
4. Never show "success" before the operation is terminal; never auto-retry billable operations from the UI.

## 8. Cost-disclosure UX (quote → approval → confirm)
Flow: configure → `POST /v1/quotes` → **Quote panel** (itemized, recurring vs one-time, tax estimate, currency, expiry countdown, residency/region badge, capability caveats) → if above limit: **spend approval** request (`/v1/billing/spend-approvals`) with approver visibility → explicit confirm button labeled with total ("Pay SAR 123.45") → operation. Expired quote forces re-quote; price change between quote and confirm is impossible (quotes immutable). Destructive actions (delete, in-place restore, make bucket public, rotate credentials, publish) require typed confirmation or equivalent explicit step and show what will happen.

## 9. Accessibility (WCAG 2.1 AA)
Keyboard operability for all flows (including editor and drag/drop alternatives), visible focus, landmarks, labels, `aria-live` for operation updates, contrast ≥4.5:1, reduced-motion, no color-only status, error summaries, screen-reader tested flows (VoiceOver + NVDA smoke per milestone). CI: axe on every screen in `ar` and `en` — 0 serious/critical.

## 10. Frontend testing pyramid
| Layer | Tooling class | Rule |
|---|---|---|
| Unit/component | component test runner + testing-library style | formatters, forms, states; RTL variants |
| Contract | generated SDK vs OpenAPI; mock server from spec | no UI call to undocumented endpoint |
| E2E per screen | Playwright-style browser tests | every `UI-Mxx-nn` has ≥1 happy-path and ≥1 forbidden/error test in `ar` and `en` |
| Visual regression | screenshot diffs | LTR and RTL baselines; failing diff blocks merge unless approved |
| Accessibility | axe in e2e | thresholds §9 |
| RTL snapshot | DOM/CSS audit | 0 physical-direction CSS; mirrored icons list verified |
| Cross-tenant UI | login as org A, deep-link org B ids | always 404/403, no data flash |
Evidence (screenshots, reports) stored under `docs/reports/Mxx-evidence/`.

## 11. Performance budgets (proposals, tied to D-30)
LCP ≤ 2.5 s p75 on mid-tier mobile 4G profile; INP ≤ 200 ms; CLS ≤ 0.1; initial JS ≤ 200 KB gzip per route (editor/builder ≤ 500 KB lazy-loaded); list screens render 100 rows ≤ 100 ms after data; API-driven tables use cursor pagination only. Budgets checked in CI; regressions >10% fail.

## 12. Frontend security
Cookie session `HttpOnly; Secure; SameSite=Lax` (+CSRF token on state-changing requests from portals); strict CSP (no inline script without nonce, `frame-ancestors 'none'` except builder preview embedding rules), `Referrer-Policy`, `Permissions-Policy`; no tokens in localStorage; no secrets in client bundles (CI scan); one-time secrets shown once with copy control and cleared from memory/DOM on dismiss; sanitize all rendered rich content; clickjacking protection on admin; dependency/license scan; admin app served only from restricted network, separate cookie domain from customer app; preview origin separate registrable domain (M09).

## 13. Admin safeguards
Persistent **impersonation banner** (who/why/expiry; read-only by default; consent flag); impersonation needs reason + ticket id, ≤ 30 min (proposal), fully audited; **two-person approval** for ledger adjustments, enabling providers, ZATCA actions, kill switch release, audit-retention change; dangerous-action confirmation (type resource name + reason); masked PII by default with reveal-with-reason (audited); no tenant content access without break-glass; session timeout 15 min idle (proposal); MFA step-up for sensitive actions; all admin mutations carry audit event and show audit link.

## 14. Analytics and telemetry under PDPL
First-party, privacy-preserving product telemetry only; no third-party analytics, session replay, ad pixels or font/CDN calls without counsel approval (HG-04-01). Event payloads exclude PII/content; IDs pseudonymous; IP truncated; non-essential analytics gated by consent recorded via `/v1/compliance/consents`; retention per D-34; telemetry honors DSR export/erase; client error reporting scrubs inputs; cookie banner only for non-essential cookies, with equal-prominence reject option; marketing/analytics preferences in Compliance section. Legal basis and DPO ownership per D-16.

## 15. Definition of done for a screen
Registered in screen index with ID · route and role gating · all §6 states · ar+en with RTL screenshot · a11y pass · e2e (happy, forbidden, error) · SDK-only API usage · loading/perf budget met · telemetry events reviewed for PII · cost-disclosure/async patterns used where applicable.

## Screen index
<!-- SCREEN-INDEX:BEGIN -->
_Generated from `docs/milestones/*.md` §8 — 215 screens. Portal counts: A=8, C=37, C A R=90, R=5, X=75. Regenerate with the bootstrap script `scripts/gen-screen-index` once it exists; until then this table is hand-generated._

| ID | Milestone | Portal | Route | Purpose |
|---|---|---|---|---|
| UI-M01-01 | M01 | C A R | `/login` | OIDC start, error banner, locale switch |
| UI-M01-02 | M01 | C A R | `/auth/callback` | transient; callback failures (state mismatch, disabled) |
| UI-M01-03 | M01 | C A R | `/account/security/mfa` | enrol TOTP (QR + manual key), verify, remove; empty = not enrolled |
| UI-M01-04 | M01 | C A R | `/auth/mfa-challenge` | challenge/step-up modal; rate-limit state |
| UI-M01-05 | M01 | C A R | `/account/security/recovery-codes` | generate/show-once/download; warns invalidation |
| UI-M01-06 | M01 | C A R | `/orgs/new` | create org (type, country, language); first-run wizard |
| UI-M01-07 | M01 | C A R | `/` | dashboard home: org summary, pending tasks, recent audit, ops in progress |
| UI-M01-08 | M01 | C A R | `/settings/organization` | profile, MFA-required toggle, ETag conflict state |
| UI-M01-09 | M01 | C A R | `/settings/members` | list, role change (step-up), remove; last-owner guard |
| UI-M01-10 | M01 | C A R | `/settings/invitations` | invite, resend, revoke; states pending/expired |
| UI-M01-11 | M01 | C A R | `/invitations/[token]` | accept; expired/used states |
| UI-M01-12 | M01 | C A R | `/workspaces` | list/create/rename/delete |
| UI-M01-13 | M01 | C A R | `/projects` | list/filter/create |
| UI-M01-14 | M01 | C A R | `/projects/[id]/environments` | environments CRUD |
| UI-M01-15 | M01 | C A R | `/settings/api-keys` | create (secret once), scopes picker, revoke, last used |
| UI-M01-16 | M01 | C A R | `/account/sessions` | active sessions, revoke |
| UI-M01-17 | M01 | C A R | `/audit-logs` | filterable log, export CSV (≤ limit), integrity badge |
| UI-M01-18 | M01 | C A R | `/notifications` | list, mark read, preferences |
| UI-M01-19 | M01 | C A R | `/operations` | list + detail drawer (steps, trace id), cancel |
| UI-M01-20 | M01 | C A R | `/resources` | unified inventory (empty-state until M05+) |
| UI-M01-21 | M01 | A | `/agency` | shell placeholder; shown only for `type=agency`; "available in M11" |
| UI-M01-22 | M01 | R | `/reseller` | shell placeholder; `type=reseller` |
| UI-M01-23 | M01 | X | `/login` | admin realm login + mandatory MFA |
| UI-M01-24 | M01 | X | `/organizations` | search, status, suspend/reinstate w/ reason |
| UI-M01-25 | M01 | X | `/users` | search, sessions, MFA status, impersonation start (reason, TTL) |
| UI-M01-26 | M01 | X | `/feature-flags` | list/edit scopes; audit on change |
| UI-M01-27 | M01 | X | `/audit-logs` | cross-org viewer, chain verification result |
| UI-M01-28 | M01 | X | `/operations` | all-org operation monitor, stuck-operation filters |
| UI-M01-29 | M01 | X | `/roles` | role/permission matrix viewer (read-only) |
| UI-M02-01 | M02 | C A R | `/billing` | overview: balance, month-to-date usage, spend vs cap, alerts |
| UI-M02-02 | M02 | C A R | `/billing/plans` | plan catalogue, current plan/entitlements (change plan → M03) |
| UI-M02-03 | M02 | C A R | `/billing/usage` | usage explorer: filters meter/project/resource, chart+table, export CSV; "data region" column |
| UI-M02-04 | M02 | C A R | `/billing/usage/[meter]` | drilldown per resource; late-event note |
| UI-M02-05 | M02 | C A R | `/billing/ledger` | statement with running balance; filters |
| UI-M02-06 | M02 | C A R | `/billing/spending-limits` | caps/thresholds editor; conflict (412) state |
| UI-M02-07 | M02 | C A R | `/billing/approvals` | pending/decided approvals; approve/deny dialog (step-up) |
| UI-M02-08 | M02 | C A R | `/billing/quotas` | quota gauges, restricted banner |
| UI-M02-09 | M02 | C A R | `/billing/quotes/[id]` | quote detail (provisional tax/residency badges, expiry countdown, approval-needed callout) |
| UI-M02-10 | M02 | X | `/billing/ledger` | accounts tree + transactions explorer + posting detail |
| UI-M02-11 | M02 | X | `/billing/price-books` | books, versions, diff view, publish with 2nd approver |
| UI-M02-12 | M02 | X | `/billing/plans` | plans/versions/entitlements editor |
| UI-M02-13 | M02 | X | `/billing/meters` | meter catalogue, producer health (completeness gauge) |
| UI-M02-14 | M02 | X | `/billing/usage-events` | raw event search, replay (staging diff) |
| UI-M02-15 | M02 | X | `/billing/adjustments` | request/approve reversing adjustments |
| UI-M02-16 | M02 | X | `/billing/provider-costs` | import CSV + evidence, margin view |
| UI-M03-01 | M03 | C A R | `/billing/payment-methods` | list, default, remove; expiring badge |
| UI-M03-02 | M03 | C A R | `/billing/payment-methods/add` | PSP hosted fields/redirect; failure/3DS states; "we never see your card" notice |
| UI-M03-03 | M03 | C A R | `/billing/subscriptions` | list, status, next renewal |
| UI-M03-04 | M03 | C A R | `/billing/subscriptions/[id]` | change plan (proration preview), cancel (period end), dunning banner |
| UI-M03-05 | M03 | C A R | `/billing/invoices` | list/filter/download; ZATCA status badge |
| UI-M03-06 | M03 | C A R | `/billing/invoices/[id]` | detail, tax breakdown, QR, PDF/XML download, pay now |
| UI-M03-07 | M03 | C A R | `/billing/credit-notes` | list/detail |
| UI-M03-08 | M03 | C A R | `/billing/payments` | history, statuses, refund state |
| UI-M03-09 | M03 | C A R | `/billing/wallet` | balance, top-up, consumption ledger |
| UI-M03-10 | M03 | C A R | `/billing/tax-profile` | VAT/CR/address form, validation, B2B/B2C |
| UI-M03-11 | M03 | C A R | `/billing/checkout/[quoteId]` | review quote → approve spend (if needed) → pay → status polling (202 operation) |
| UI-M03-12 | M03 | C A R | `/billing/payment-return` | PSP/3DS return handling: success/pending/failed |
| UI-M03-13 | M03 | X | `/billing/invoices` | cross-org invoice search, ZATCA state, reissue-via-credit-note guidance |
| UI-M03-14 | M03 | X | `/billing/payments` | payments + raw PSP events (redacted), duplicate-event indicator |
| UI-M03-15 | M03 | X | `/billing/refunds` | request refund (step-up), status |
| UI-M03-16 | M03 | X | `/billing/reconciliations` | run list, schedule, filters by RC type |
| UI-M03-17 | M03 | X | `/billing/reconciliations/[id]` | breaks table, assign, resolve with adjustment link |
| UI-M03-18 | M03 | X | `/billing/zatca` | onboarding wizard (environment banner SANDBOX/SIMULATION/PRODUCTION, production locked), credentials status (vault refs only) |
| UI-M03-19 | M03 | X | `/billing/zatca/submissions` | queue, errors, retry, DLQ, window-SLO gauge |
| UI-M03-20 | M03 | X | `/billing/dunning` | cases, hold/resume |
| UI-M03-21 | M03 | X | `/billing/revenue-reports` | report picker, charts, CSV export, ledger-equality check badge |
| UI-M04-01 | M04 | C A R | `/privacy/consents` | View/grant/withdraw consents |
| UI-M04-02 | M04 | C A R | `/privacy/requests` | DSR list with SLA countdown |
| UI-M04-03 | M04 | C A R | `/privacy/requests/new` | Create DSR (type, subject, details) |
| UI-M04-04 | M04 | C A R | `/privacy/requests/[id]` | DSR detail, tasks, outcome |
| UI-M04-05 | M04 | C A R | `/settings/data-residency` | View/edit residency policy (tighten only), exceptions list |
| UI-M04-06 | M04 | C A R | `/privacy/exports` | Request/download data export |
| UI-M04-07 | M04 | X | `/compliance/ropa` | ROPA list/edit |
| UI-M04-08 | M04 | X | `/compliance/data-classes` | Classification catalogue and coverage report |
| UI-M04-09 | M04 | X | `/compliance/controls` | Control catalog, mappings, status ("mapped", never "compliant") |
| UI-M04-10 | M04 | X | `/compliance/evidence` | Evidence list, add manual evidence, collector runs |
| UI-M04-11 | M04 | X | `/compliance/retention` | Retention policies, legal holds (dual approval) |
| UI-M04-12 | M04 | X | `/compliance/transfer-assessments` | Assessment workflow |
| UI-M04-13 | M04 | X | `/compliance/validations` | Regulatory validation register |
| UI-M04-14 | M04 | X | `/compliance/breach-cases` | Breach list + detail + timeline + evidence pack |
| UI-M04-15 | M04 | X | `/compliance/dsr-queue` | Cross-org DSR queue and task handling (assumption A-M04-1) |
| UI-M04-16 | M04 | X | `/compliance/residency` | Platform floor policy, matrix viewer, evaluate-simulator |
| UI-M05-01 | M05 | C A R | `/compute/offers` | Browse verified offers with country/geoGroup/spec filters |
| UI-M05-02 | M05 | C A R | `/compute/instances/new` | Wizard: offer → image → keys → quote review (cost, tax, residency result) → confirm |
| UI-M05-03 | M05 | C A R | `/compute/instances` | Instance list |
| UI-M05-04 | M05 | C A R | `/compute/instances/[id]` | Overview, capabilities-based action menu, operation timeline |
| UI-M05-05 | M05 | C A R | `/compute/instances/[id]/metrics` | Metrics (if supported) |
| UI-M05-06 | M05 | C A R | `/compute/instances/[id]/snapshots` | Snapshots (if supported) |
| UI-M05-07 | M05 | C A R | `/billing/spend-approvals` (M02 screen extended) | Approve provisioning above limit |
| UI-M05-08 | M05 | X | `/providers` | Provider registry & health |
| UI-M05-09 | M05 | X | `/providers/accounts` | Accounts list, add (vault ref), run verification |
| UI-M05-10 | M05 | X | `/providers/accounts/[id]` | Capability matrix, regions with verified evidence, catalog sync, plans |
| UI-M05-11 | M05 | X | `/providers/routing` | Routing rules editor + dry-run simulator |
| UI-M05-12 | M05 | X | `/cloud/resources` | Inventory across orgs, drift/orphan filters, force reconcile |
| UI-M05-13 | M05 | X | `/cloud/operations` | Operations monitor (stuck, needs_reconcile) |
| UI-M05-14 | M05 | X | `/finance/provider-costs` | Provider cost records, RC-04 results, margin view |
| UI-M05-15 | M05 | X | `/providers/live-verification` | LV job status, evidence index, LIVE-VERIFIED/NOT VERIFIED labels (owner triggers) |
| UI-M05-16 | M05 | A | `/agency/clients/[clientId]/compute` | Read view of client's compute (delegation per M11; hidden until M11 flag) |
| UI-M06-01 | M06 | C A R | `/hosting/plans` | Plans comparison |
| UI-M06-02 | M06 | C A R | `/hosting/sites/new` | Create-site wizard (plan, runtime, domain, quote review incl. residency/tax) |
| UI-M06-03 | M06 | C A R | `/hosting/sites` | Site list |
| UI-M06-04 | M06 | C A R | `/hosting/sites/[id]` | Overview, operation timeline, quotas gauges |
| UI-M06-05 | M06 | C A R | `/hosting/sites/[id]/domains` | Bind domains, verification instructions |
| UI-M06-06 | M06 | C A R | `/hosting/sites/[id]/ssl` | Certificates, renew, custom upload |
| UI-M06-07 | M06 | C A R | `/hosting/sites/[id]/databases` | Database bindings |
| UI-M06-08 | M06 | C A R | `/hosting/sites/[id]/backups` | Backup list, create, restore (confirm dialog) |
| UI-M06-09 | M06 | C A R | `/hosting/sites/[id]/usage` | Usage vs quota charts |
| UI-M06-10 | M06 | C A R | `/hosting/sites/[id]/settings` | Runtime settings, delete (type-name confirm) |
| UI-M06-11 | M06 | X | `/hosting/nodes` | Node list/health/agent state |
| UI-M06-12 | M06 | X | `/hosting/nodes/[id]` | Capacity by dimension, allocations, drain/maintenance controls |
| UI-M06-13 | M06 | X | `/hosting/sites` | Cross-org site search (audited), suspend/resume |
| UI-M06-14 | M06 | X | `/hosting/abuse` | Abuse case queue, evidence, actions, appeals |
| UI-M06-15 | M06 | X | `/hosting/agents` | Agent enrolment, cert rotation, command audit log viewer |
| UI-M06-16 | M06 | A | `/agency/clients/[clientId]/hosting/sites` | Read/manage client sites (delegation, M11 flag) |
| UI-M07-01 | M07 | C | `/domains` | Domain list (status, expiry, auto-renew, renewal risk) |
| UI-M07-02 | M07 | C | `/domains/search` | Search with price, premium, eligibility badges |
| UI-M07-03 | M07 | C | `/domains/checkout` | Quote → spend approval → confirm (cost disclosure, tax, contacts) |
| UI-M07-04 | M07 | C | `/domains/[id]` | Overview, nameservers, lock, auto-renew, operation status |
| UI-M07-05 | M07 | C | `/domains/[id]/dns` | Records table, add/edit, diff + apply change-set, ETag conflict resolution |
| UI-M07-06 | M07 | C | `/domains/[id]/contacts` | Contacts form per TLD requirements, privacy availability, consent notice |
| UI-M07-07 | M07 | C | `/domains/transfers` | Transfer list and start transfer (auth code input, write-only) |
| UI-M07-08 | M07 | C | `/domains/[id]/hosting` | Link domain to hosting site, proposed records preview, SSL status |
| UI-M07-09 | M07 | X | `/domains/registrars` | Registrar accounts, health, capability matrix, verify |
| UI-M07-10 | M07 | X | `/domains/orders` | Orders queue, needs_reconcile, force reconcile |
| UI-M07-11 | M07 | X | `/domains/reconciliation` | RC-04 cost reconciliation runs & variances |
| UI-M07-12 | M07 | X | `/domains/[id]` | Support lookup (metadata only; contacts masked unless break-glass) |
| UI-M08-01 | M08 | C | `/databases` | List, status, region |
| UI-M08-02 | M08 | C | `/databases/new` | Engine/plan/region offers (verified only), quote→approval→confirm |
| UI-M08-03 | M08 | C | `/databases/[id]` | Overview, endpoint, TLS notes, bindings, metrics |
| UI-M08-04 | M08 | C | `/databases/[id]/backups` | Backups, restores (to-new default), verification history |
| UI-M08-05 | M08 | C | `/databases/[id]/settings` | Backup policy, rotation, delete (type-name confirm) |
| UI-M08-06 | M08 | C | `/storage/buckets` | Buckets list, usage vs quota |
| UI-M08-07 | M08 | C | `/storage/buckets/[id]` | Policy editor, lifecycle, signed-URL tool, credentials guidance |
| UI-M08-08 | M08 | C | `/email/domains` | Domains and verification |
| UI-M08-09 | M08 | C | `/email/domains/[id]` | Required records, one-click apply (M07), re-check |
| UI-M08-10 | M08 | C | `/email/mailboxes` | Mailboxes/aliases, quotas |
| UI-M08-11 | M08 | C | `/email/senders` | Sender identities |
| UI-M08-12 | M08 | C | `/email/templates` | Template editor with RTL preview, versions |
| UI-M08-13 | M08 | C | `/email/messages` | Message log, events timeline, filters |
| UI-M08-14 | M08 | C | `/email/suppressions` | Suppression list, manual add/remove (audited) |
| UI-M08-15 | M08 | X | `/data/providers` | Provider selection config, probes, flags, evidence links |
| UI-M08-16 | M08 | X | `/data/instances` | Fleet view, restore verification status |
| UI-M08-17 | M08 | X | `/email/deliverability` | Bounce/complaint rates, throttles, overrides |
| UI-M09-01 | M09 | C | `/builder/projects` | Project list/cards, status, last deploy |
| UI-M09-02 | M09 | C | `/builder/new` | Wizard: describe business, language, template, budget cap |
| UI-M09-03 | M09 | C | `/builder/projects/[id]` | **Builder workspace**: chat panel, canvas (responsive preview), property inspector, code/diff tab, run timeline |
| UI-M09-04 | M09 | C | `/builder/projects/[id]/versions` | Version history, compare, restore |
| UI-M09-05 | M09 | C | `/builder/projects/[id]/seo` | SEO settings & score report |
| UI-M09-06 | M09 | C | `/builder/projects/[id]/forms` | Forms, submissions (masked for viewer), spam stats |
| UI-M09-07 | M09 | C | `/builder/projects/[id]/cms` | Collections/items editor |
| UI-M09-08 | M09 | C | `/builder/projects/[id]/deployments` | Deploy (target site, domain), approvals, logs, rollback |
| UI-M09-09 | M09 | C | `/builder/runs/[id]` | Run detail: events, approvals, cost |
| UI-M09-10 | M09 | C | `/ai/usage` | Credits balance, usage by project/model, top-up (quote→approve) |
| UI-M09-11 | M09 | C | `/ai/budgets` | Org/project caps, alert thresholds |
| UI-M09-12 | M09 | X | `/ai/model-providers` | Providers, regions, data terms attestation, rate cards, kill switch |
| UI-M09-13 | M09 | X | `/ai/runs` | Run oversight (metadata, cost, failures); content access only via break-glass with consent |
| UI-M09-14 | M09 | X | `/ai/quality` | Evaluation reports and trend vs thresholds |
| UI-M10-01 | M10 | C A R | `/builder/projects/new/app` | App-generation wizard: prompt → requirements review → budget → start |
| UI-M10-02 | M10 | C A R | `/builder/projects/[id]` | Project overview: versions, runs, deployments |
| UI-M10-03 | M10 | C A R | `/builder/projects/[id]/ide` | Browser IDE: tree, editor, preview, run panel; sandbox starting/quota-exceeded/offline states |
| UI-M10-04 | M10 | C A R | `/builder/projects/[id]/sandboxes/[sid]/terminal` | Full-screen terminal; session-ended, egress-denied notices |
| UI-M10-05 | M10 | C A R | `/builder/projects/[id]/changes` | Git diff, commit/checkpoint list, restore |
| UI-M10-06 | M10 | C A R | `/builder/projects/[id]/runs/[runId]` | Agent run viewer: steps, redacted tool calls, live budget meter, approve/reject |
| UI-M10-07 | M10 | C A R | `/approvals` | Pending approvals inbox across runs/deployments/releases |
| UI-M10-08 | M10 | C A R | `/builder/projects/[id]/tests` | Test runs, failures, re-run, "ask AI to fix" (creates `test-fix` run) |
| UI-M10-09 | M10 | C A R | `/builder/projects/[id]/deployments` | Deployments list/detail/logs, health gate, rollback confirm |
| UI-M10-10 | M10 | C A R | `/builder/projects/[id]/exports` | Request/download export, checksum, SBOM |
| UI-M10-11 | M10 | C A R | `/builder/projects/[id]/settings/budget` | Run/org budgets, approval policy, alerts |
| UI-M10-12 | M10 | C A R | `/mobile/new` | Mobile project wizard (type=mobile) |
| UI-M10-13 | M10 | C A R | `/mobile/[id]/preview` | Preview with explicit "preview ≠ device" notice |
| UI-M10-14 | M10 | C A R | `/mobile/[id]/builds` | Build list, artifacts, logs, minutes used; iOS-unavailable state |
| UI-M10-15 | M10 | C A R | `/mobile/[id]/signing` | Signing credential references (no secret display), authorize/revoke |
| UI-M10-16 | M10 | C A R | `/mobile/[id]/releases` | Release records list |
| UI-M10-17 | M10 | C A R | `/mobile/[id]/releases/new` | Release-preparation wizard + owner-approval step; no approval promises |
| UI-M10-18 | M10 | X | `/ai/runs` | Run oversight (read-only), budget-breach and denied-approval flags |
| UI-M10-19 | M10 | X | `/sandboxes` | Sandbox fleet oversight: nodes, usage, quota breaches (read via `/v1/admin/resources`); **force-kill action requires an SCR (no endpoint in docs/04) → hidden until approved** |
| UI-M11-01 | M11 | C A R | `/automation/workflows` | List, status, last run |
| UI-M11-02 | M11 | C A R | `/automation/workflows/[id]/edit` | Visual canvas editor, validation, version publish |
| UI-M11-03 | M11 | C A R | `/automation/executions/[id]` | Execution timeline, retries, redacted logs, replay from DLQ (SCR dependent) |
| UI-M11-04 | M11 | C A R | `/automation/connectors` | Connectors, scopes, authorization status |
| UI-M11-05 | M11 | C A R | `/settings/webhooks` | Endpoints, secret rotation, test event; deliveries view (SCR-M11-02 dependent) |
| UI-M11-06 | M11 | C A R | `/marketplace` | Browse/search/filter listings |
| UI-M11-07 | M11 | C A R | `/marketplace/listings/[id]` | Detail, versions, price+VAT, buy |
| UI-M11-08 | M11 | C A R | `/marketplace/purchases` | Purchases, invoices, installations, install action |
| UI-M11-09 | M11 | C A R | `/marketplace/publisher` | Publisher dashboard: listings, versions, moderation status, revenue accrual statement |
| UI-M11-10 | M11 | A | `/agency` | Agency dashboard: clients, health, usage |
| UI-M11-11 | M11 | A | `/agency/clients` | Invite/link clients, status |
| UI-M11-12 | M11 | A | `/agency/clients/[clientId]/access` | Delegated scopes, expiry, revoke (SCR-M11-01) |
| UI-M11-13 | M11 | A | `/agency/acting/[clientId]` | Acting-as banner + switcher; every page shows client context |
| UI-M11-14 | M11 | A | `/agency/billing` | Consolidated billing opt-in view |
| UI-M11-15 | M11 | R | `/reseller` | Reseller dashboard |
| UI-M11-16 | M11 | R | `/reseller/sub-organizations` | Create/link sub-orgs, plans |
| UI-M11-17 | M11 | R | `/reseller/pricing` | Price rules editor with margin preview and below-cost block |
| UI-M11-18 | M11 | R | `/reseller/statements` | Statements, CSV export, issuer-model banner (shows disabled/BLOCKED state) |
| UI-M11-19 | M11 | C | `/settings/partners` | Client side: pending agency requests, grants, revoke |
| UI-M11-20 | M11 | X | `/marketplace/moderation` | Moderation queue, scan results, decision |
| UI-M11-21 | M11 | X | `/programs` | Agencies/resellers oversight, suspensions |
| UI-M11-22 | M11 | X | `/automation/abuse` | Paused workflows, anomaly cases, DLQ monitor |
| UI-M12-01 | M12 | C | `/settings/security/sso` | SSO connections, domain proof, test login, enforcement toggle |
| UI-M12-02 | M12 | C | `/settings/security/scim` | SCIM status/token rotation (**depends on SCR-M12-01**) |
| UI-M12-03 | M12 | C | `/settings/security/policy` | MFA/session/IP policy (**SCR-M12-02**) |
| UI-M12-04 | M12 | X | `/operations/health` | Health, queue lag, reconciler status, SLO burn |
| UI-M12-05 | M12 | X | `/incidents` | Incident list/create |
| UI-M12-06 | M12 | X | `/incidents/[id]` | Timeline, comms drafts, breach-case link |
| UI-M12-07 | M12 | X | `/alerts` | Rules, ack/silence |
| UI-M12-08 | M12 | X | `/provider-incidents` | Provider incident feed |
| UI-M12-09 | M12 | X | `/recovery-exercises` | DR exercise records and evidence |
| UI-M12-10 | M12 | X | `/access-reviews` | Campaign list/create |
| UI-M12-11 | M12 | X | `/access-reviews/[id]` | Review items & decisions (**SCR-M12-04**) |
| UI-M12-12 | M12 | X | `/policies` | Policy versions |
| UI-M12-13 | M12 | X | `/audit` | Audit explorer, hash-chain status, export |
| UI-M12-14 | M12 | X | `/audit/retention` | Retention + legal hold view |
| UI-M12-15 | M12 | X | `/billing/reconciliations` | RC-01..RC-06 / TR-01..TR-04 dashboard (extends M03 screen), run/resolve |
| UI-M12-16 | M12 | X | `/launch` | GA readiness board from §15 (**SCR-M12-03**; read-only until approved) |
| UI-M12-17 | M12 | X | `/support/handbook` | Embedded runbook index, escalation matrix |
<!-- SCREEN-INDEX:END -->
