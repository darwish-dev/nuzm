# M11 — Automation, Marketplace, Agency & Reseller Programs

> Read CLAUDE.md first. Apply it in full. This prompt never overrides docs/04, docs/05, docs/03 — on conflict stop and report.
> Response format: CLAUDE.md §10. Status words: PASS / FAIL / BLOCKED / NOT VERIFIED only.

| Field | Value |
|---|---|
| Sprints | S51–S54 (4) |
| Depends on (docs/03) | **H:** M01, M02, M03, M09 · **S:** M04, M10 · **—:** M05, M06, M07, M08 |
| Produces | Workflow engine, outbound webhooks, connector framework, marketplace (listings, purchases, entitlements, installations), agency program (delegated access), reseller program (sub-organizations, price rules, statements), agency/reseller portals, moderation tooling |
| Gate | Retries idempotent; unauthorized connectors blocked; purchased templates install only for entitled tenants; agencies cannot cross client boundaries; reseller issuer model only as approved (D-24). |

## 1. Objective
Add visual automation, a template marketplace and two partner programs without weakening tenant isolation or financial integrity. Delegation (agency) and wholesale (reseller) are separate models: agencies get scoped, time-boxed **access**; resellers get **commercial** structure (sub-organizations, price rules, statements). Marketplace purchases flow through M03 invoicing; publisher revenue is **accounted, not paid out** until D-26/HG-11-01.

## 2. Preconditions & mocked interfaces
| Dependency | Needed real for | Mock allowed meanwhile |
|---|---|---|
| M03 invoicing/payments/`billing_entities` | S53 purchases, S54 reseller invoicing | Test PSP sandbox (M03) |
| M09 `builder.projects`, `/v1/deployments`, `/v1/ai/runs` | Installing site/app templates; AI/deploy workflow actions | Fixture projects |
| M10 | Marketplace app templates (soft) | Website templates only |
| M04 consent/residency/DSR | Connector data flows (soft) | Interface stub returning "allowed in-Kingdom only" |
| D-24 issuer-of-record model | S54 reseller invoicing | Config flag `reseller.issuer_model` default `disabled` |
| D-26 / HG-11-01 payouts & publisher terms | Any publisher payout | **No payout code path enabled**; accounting only |
| Third-party connector OAuth app registrations | Any named third-party connector | Only first-party connectors in scope (see S52) |

## 3. Requirement IDs closed
FR-AUT-01..04 workflows/connectors (local mapping: 01 workflow definition & versioning, 02 triggers/actions/retries/DLQ, 03 connectors & OAuth/scoped tokens, 04 outbound webhooks/abuse prevention) · FR-MKT-01..05 (01 listings/versions, 02 moderation, 03 purchases, 04 entitlements, 05 installations/revenue accounting) · FR-PRG-01..06 (01 agencies, 02 delegated access, 03 acting-as validation, 04 resellers/sub-orgs, 05 price rules, 06 statements/issuer model). *docs/01 §5 gives the ranges but not per-ID text — confirm mapping.*

## 4. Automatable engineering tasks
**S51 — Workflow engine.** 1. Workflow definition = JSON DAG validated against schema; versions immutable (`workflow_versions`), `workflows.active_version`. 2. Triggers: schedule (cron, UTC + org TZ), inbound webhook (per-workflow secret URL + signature), platform event (outbox topics allow-listed: e.g. `invoice.issued`, `ai.run.completed`, `site.deployed`, `domain.registered`), manual. 3. Actions v1: HTTP request (via egress proxy), Nuzm API call (scoped token), send email (M08 `/v1/email/messages`), start AI run, create deployment, delay, condition, bounded loop (≤100 iterations), transform using a **restricted, side-effect-free expression language (no eval, no arbitrary code)**. 4. Execution on `platform.operations`: per-step idempotency key `sha256(executionId|stepId|attempt-group)`, at-least-once delivery with exactly-once *effect* for idempotent actions; actions declared non-idempotent get **no automatic retry** unless user supplies an idempotency key mapping. 5. Retry policy (exponential backoff, jitter, max attempts default 5), dead-letter (`dead_letters`) with manual replay, cancellation, execution logs with secret redaction. 6. Metering `automation.executions` / `automation.steps`, quota checks, per-org concurrency limits.
**S52 — Connectors & webhooks.** 1. Connector framework: `connectors` (type, scopes, rate limit, status), `connector_authorizations` (vault refs only). 2. In-scope connector types: first-party Nuzm connector, generic HTTP, generic OAuth2 client (authorization-code + PKCE; endpoints supplied by tenant), email. Named third-party connectors are **out of scope** unless owner adds them with PROPOSED-HG-11-02 (OAuth app registrations). 3. Scoped tokens: connector tokens limited to declared scopes; workflow may use only connectors authorized in its org; unauthorized → `403 connector_not_authorized`, step fails closed. 4. Per-connector and per-org rate limits (token bucket) + circuit breaker. 5. Abuse prevention: SSRF defence (deny RFC1918/link-local/metadata/loopback, DNS-rebinding re-resolution check, redirect re-validation, response size cap 5 MB, timeout 30 s), loop/recursion detection (workflow triggering itself), anomaly rules (execution spikes, high 4xx rate) → auto-pause + notification + admin case. 6. Outbound webhooks `/v1/webhook-endpoints`: HMAC-SHA256 over `timestamp.body`, timestamp tolerance 5 min, secret rotation with overlap, retries (exponential up to 24 h), DLQ, delivery log (`webhook_deliveries`), per-endpoint event filter.
**S53 — Marketplace.** 1. `publisher_accounts` (org-linked; publisher verification is a human/ops step), `listings` (type: website-template, app-template, workflow-template), `listing_versions` (immutable artifact refs, SBOM, semantic version). 2. Moderation (`moderation_cases`): automated scans (malware/secret/dependency/PII/license) then human decision via `/v1/admin/marketplace/listings/{id}/moderation`; versions not purchasable until `approved`. 3. Purchase: `POST /v1/quotes` (`kind` per docs/04 — marketplace quote kind to be confirmed; see report) → order → invoice through M03; idempotent; webhook-safe. 4. Entitlements: `marketplace.entitlements_mkt` (buyer org, listing, version range, licence type, status) exposed to billing entitlement resolver through a read view; refund/chargeback → entitlement revoked per policy (proposal: install already performed stays, further installs blocked). 5. Installation: copies listing version into buyer org as `builder.projects`/`workflows` (new ids, buyer's `org_id`, residency check), records `installations`; install requires active entitlement **and** same org as purchaser (or purchaser-granted seats if licence allows). 6. **Revenue accounting:** on invoice paid, post publisher-share accrual (liability account `publisher_payable`) through billing posting service; **no payout flow**; report in statements. Payout toggle absent/disabled (D-26).
**S54 — Programs & portals.** 1. Agency: `agencies` (org type `agency`), `agency_clients` (link requires client-org acceptance; client can revoke any time), `delegated_access` (scopes ⊆ client's grantable scopes, `expires_at` mandatory, default 90 days, max 365), consolidated billing opt-in. 2. Acting-as: `X-Nuzm-Acting-Org` validated per request against active grant; effective permissions = intersection(agency member role, grant scopes); all audit events record both `actorOrg` and `actingOrg`; impersonation of client *users* is not allowed. 3. Reseller: `resellers` (org type `reseller`), `reseller_sub_orgs`, price rules in `billing.reseller_price_rules` (via billing owner PR: markup % / fixed per plan or meter, effective dating, versioned), rating applies rule at charge time, `statements` (wholesale cost, retail, margin, tax). 4. Invoice issuer model: implement strategies behind `reseller.issuer_model` (`platform_issues_wholesale` | `reseller_issues_own` | `disabled`); extend `invoicing.billing_entities` via M03 owner PR; **only the model approved in D-24 may be enabled; the other returns `BLOCKED` and cannot be switched on by the agent**. 5. Portals (apps/web `(agency)`, `(reseller)`), admin oversight screens. 6. Spec change requests to submit before S54 (docs/04 lacks them): SCR-M11-01 revoke delegated access (e.g. `DELETE /v1/agencies/{id}/delegated-access/{grantId}`), SCR-M11-02 webhook delivery/DLQ read & replay, SCR-M11-03 listing detail `GET`, SCR-M11-04 workflow/connector disable. **Do not implement endpoints not in docs/04 until approved**; revocation is safety-critical so SCR-M11-01 is a pre-S54 blocker.

## 5. Human approvals & external gates
| ID | Need | Agent does meanwhile | Default |
|---|---|---|---|
| D-24 | Reseller invoice-issuer model | Build strategies; enable none | OPEN |
| HG-03-04 | Tax advisor sign-off on reseller/credit-note/marketplace invoice treatment | Prepare scenario pack (wholesale, retail, refund, marketplace) | PENDING |
| D-26 / HG-11-01 | Marketplace terms, publisher agreement, payout legal route | Accounting only; payout code absent | OPEN / PENDING |
| HG-04-01 | Counsel: marketplace content liability, PDPL role when workflows process personal data | Draft data-flow notes; consent hooks | PENDING |
| D-33 | Billing legal entities | Config placeholders | OPEN |
| PROPOSED-HG-11-02 | OAuth app registrations for any named third-party connector | Only first-party connectors implemented | not in docs/07 — add if scope expands |
| Publisher verification procedure | Ops/legal process to verify publishers | Provide admin screen + checklist | PENDING (human) |
| SCR-M11-01..04 | Owner approval of spec additions | Prepare SCR documents | PENDING |

## 6. API specifications (docs/04 §2.11 — exact; plus reuse of §2.1/2.2/2.3 endpoints)
Common: org from token; `Idempotency-Key` required on all POSTs; problem+json; ETag on PATCH. Permission names proposals.
| Method & path | Portals | AuthZ | Key fields | Errors | Async/Idem |
|---|---|---|---|---|---|
| POST/GET `/v1/workflows` · GET/PATCH `/v1/workflows/{id}` | C A R | `automation:write/read` | `{name, definition, triggers[]}`; PATCH changes name/status only (definition via versions) | 422 schema/cycle | PATCH ETag |
| POST `/v1/workflows/{id}/versions` | C A R | `automation:write` | `{definition, notes}` immutable; validation report | 422 unauthorized connector referenced | idempotent |
| POST/GET `/v1/workflows/{id}/executions` | C A R | `automation:run` | `{versionId?, input, dedupeKey}`; replaces v3 `/execute` | 409 duplicate `dedupeKey` returns original; 429 quota | 202 + operation |
| GET `/v1/workflow-executions/{id}` | C A R | `automation:read` | steps, attempts, redacted logs, DLQ state | 404 cross-tenant | — |
| POST/GET `/v1/connectors` · POST `/v1/connectors/{id}/authorization` | C A R | `connector:manage` | `{type, scopes, rateLimit}`; authorization starts OAuth (PKCE) or stores vault-ref credential | 422 raw-secret in body rejected | idempotent |
| POST/GET `/v1/webhook-endpoints` | C A R | `webhook:manage` | `{url, events[], secretRotation}`; url validated (https, no private ranges); secret shown once | 422 SSRF-denied | idempotent |
| POST/GET `/v1/marketplace/listings` · POST `…/{id}/versions` | C A R | publisher role | `{type, title(ar,en), price quote template, licence, artifactRef}`; version → moderation `pending` | 403 not a verified publisher | idempotent |
| POST `/v1/marketplace/purchases` · GET `…/{id}` | C A R | `marketplace:buy` | `{listingId, versionId?, quoteId}` → `{purchaseId, invoiceId, entitlementId, status}` | 409 already entitled, 402 payment, 422 residency | 202; idempotent |
| POST/GET `/v1/marketplace/installations` | C A R | `marketplace:install` + entitlement | `{listingVersionId, workspaceId}` → new project/workflow | 403 `not_entitled`, 422 residency | 202 |
| POST `/v1/admin/marketplace/listings/{id}/moderation` | X | `admin:marketplace` | `{decision: approve|reject|suspend, reasonCode, notes}` | 409 stale | idempotent |
| POST/GET `/v1/agencies` | A | org admin | create agency profile for current agency-type org | 409 | idempotent |
| POST/GET `/v1/agencies/{id}/clients` | A | `agency:manage` | invite/link client org → `pending_acceptance` | 409 | idempotent |
| GET/POST `/v1/agencies/{id}/delegated-access` | A (and client admin approves) | `agency:manage` / client `org:admin` | `{clientOrgId, scopes[], expiresAt}`; client acceptance required | 422 scopes exceed grantable, expiry missing | idempotent |
| POST/GET `/v1/resellers` | R | org admin | reseller profile | 409 | idempotent |
| GET/POST `/v1/resellers/{id}/sub-organizations` | R | `reseller:manage` | create/link sub-org with price book assignment | 409 | idempotent |
| GET/PUT `/v1/resellers/{id}/price-rules` | R | `reseller:pricing` | versioned rule set; effective date ≥ now+1 day; floor ≥ wholesale cost (validated) | 422 below-cost | PUT ETag |
| GET `/v1/resellers/{id}/statements` | R | `reseller:finance` | period, wholesale, retail, margin, tax; CSV | — | — |
Reused: `/v1/quotes`, `/v1/billing/invoices`, `/v1/billing/entitlements`, `/v1/operations/{id}`, `/v1/audit-logs`, `GET /v1/me` (acting-org context), `PATCH /v1/admin/organizations/{id}`.

## 7. Database migrations (owners per docs/05)
| Schema.table | Key columns / rules |
|---|---|
| `automation.workflows` | `name, status, active_version_id, owner_user_id, last_run_at`; RLS |
| `automation.workflow_versions` | `workflow_id, version, definition jsonb, definition_hash, validated_at`; immutable (no UPDATE grant) |
| `automation.executions` | `workflow_id, version_id, trigger, dedupe_key, status, started_at, finished_at, operation_id`; unique `(org_id, workflow_id, dedupe_key)` |
| `automation.execution_steps` | `execution_id, step_key, attempt, status, idempotency_key, input_ref, output_ref, error`; unique `(execution_id, step_key, attempt)` |
| `automation.connectors` / `connector_authorizations` | `type, scopes text[], rate_limit jsonb, status` / `connector_id, vault_ref, expires_at, authorized_by` |
| `automation.dead_letters` | `execution_id, step_key, reason, payload_ref, replayed_at` |
| `automation.webhook_endpoints` / `webhook_deliveries` | `url, events[], secret_vault_ref, status` / `event_id, attempt, status_code, next_attempt_at`; unique `(endpoint_id, event_id)` |
| `marketplace.publisher_accounts` | `org_id, status(unverified|verified|suspended), verified_by, verified_at` |
| `marketplace.listings` / `listing_versions` | type, status; version artifact_ref, sbom_ref, moderation_status, semver; unique `(listing_id, version)` |
| `marketplace.purchases` | `buyer_org_id, listing_version_id, quote_id, invoice_id, status`; unique `(buyer_org_id, quote_id)` |
| `marketplace.entitlements_mkt` | `buyer_org_id, listing_id, version_range, licence, status, revoked_at`; view `marketplace.v_entitlements` for billing resolver |
| `marketplace.installations` | `buyer_org_id, entitlement_id, target_type, target_id`; unique per (entitlement, workspace) per licence |
| `marketplace.moderation_cases` | `listing_version_id, scan_results jsonb, decision, decided_by` |
| `programs.agencies` / `agency_clients` | agency org, status; `agency_id, client_org_id, status(pending|active|revoked), accepted_by` |
| `programs.delegated_access` | `agency_id, client_org_id, scopes text[], expires_at not null, status, granted_by, revoked_at`; check `expires_at <= granted_at + 365d` |
| `programs.resellers` / `reseller_sub_orgs` | reseller org; `sub_org_id, price_book_ref, status` |
| `billing.reseller_price_rules` (owner PR) | `reseller_id, scope(plan|meter), markup jsonb, effective_from, version`; append-versioned |
| `invoicing.billing_entities` (owner PR) | add `issuer_model` enum default `disabled` |
Append-only: `workflow_versions` (no update), `webhook_deliveries` (insert-only per attempt). Seed: allow-listed event topics, scan rule set. Reversal: `.down.sql` dev/staging only; production forward-fix. `programs.delegated_access` RLS evaluates **both** `org_id` (agency) and client link; policy tests mandatory.

## 8. UI screens (AR-RTL + EN; loading/empty/error/forbidden states)
| ID | Portal | Route | Purpose | Roles |
|---|---|---|---|---|
| UI-M11-01 | C A R | `/automation/workflows` | List, status, last run | automation:read |
| UI-M11-02 | C A R | `/automation/workflows/[id]/edit` | Visual canvas editor, validation, version publish | automation:write |
| UI-M11-03 | C A R | `/automation/executions/[id]` | Execution timeline, retries, redacted logs, replay from DLQ (SCR dependent) | automation:read |
| UI-M11-04 | C A R | `/automation/connectors` | Connectors, scopes, authorization status | connector:manage |
| UI-M11-05 | C A R | `/settings/webhooks` | Endpoints, secret rotation, test event; deliveries view (SCR-M11-02 dependent) | webhook:manage |
| UI-M11-06 | C A R | `/marketplace` | Browse/search/filter listings | any |
| UI-M11-07 | C A R | `/marketplace/listings/[id]` | Detail, versions, price+VAT, buy | marketplace:buy |
| UI-M11-08 | C A R | `/marketplace/purchases` | Purchases, invoices, installations, install action | marketplace:install |
| UI-M11-09 | C A R | `/marketplace/publisher` | Publisher dashboard: listings, versions, moderation status, revenue accrual statement | publisher |
| UI-M11-10 | A | `/agency` | Agency dashboard: clients, health, usage | agency:manage |
| UI-M11-11 | A | `/agency/clients` | Invite/link clients, status | agency:manage |
| UI-M11-12 | A | `/agency/clients/[clientId]/access` | Delegated scopes, expiry, revoke (SCR-M11-01) | agency:manage |
| UI-M11-13 | A | `/agency/acting/[clientId]` | Acting-as banner + switcher; every page shows client context | agency member |
| UI-M11-14 | A | `/agency/billing` | Consolidated billing opt-in view | agency:finance |
| UI-M11-15 | R | `/reseller` | Reseller dashboard | reseller:manage |
| UI-M11-16 | R | `/reseller/sub-organizations` | Create/link sub-orgs, plans | reseller:manage |
| UI-M11-17 | R | `/reseller/pricing` | Price rules editor with margin preview and below-cost block | reseller:pricing |
| UI-M11-18 | R | `/reseller/statements` | Statements, CSV export, issuer-model banner (shows disabled/BLOCKED state) | reseller:finance |
| UI-M11-19 | C | `/settings/partners` | Client side: pending agency requests, grants, revoke | org:admin |
| UI-M11-20 | X | `/marketplace/moderation` | Moderation queue, scan results, decision | admin:marketplace |
| UI-M11-21 | X | `/programs` | Agencies/resellers oversight, suspensions | admin:org |
| UI-M11-22 | X | `/automation/abuse` | Paused workflows, anomaly cases, DLQ monitor | admin:ops |

## 9. Security, compliance & tenant isolation
- **Agency boundary:** deny-by-default; every request with `X-Nuzm-Acting-Org` re-validated (active, unexpired, scope ⊇ required permission, client link active); header ignored/rejected on endpoints not marked delegable; no cross-client data in shared caches (cache key includes acting org); rate limits per agency *and* per client.
- **Reseller isolation:** reseller sees sub-org billing/usage aggregates and metadata only, **not** sub-org customer content, unless a separate delegated grant exists.
- **Workflow safety:** no code execution; SSRF controls (S52); secrets only vault refs and never in definitions/logs; org egress allow/deny lists; per-org kill switch (feature flag + admin pause).
- **Webhook signing/replay:** see S52; inbound workflow webhooks verify signature + timestamp window + dedupe by event id.
- **Marketplace:** artifacts scanned; listings cannot ship platform secrets; entitlement check server-side at install; installs create *copies* owned by buyer (no shared mutable state with publisher); publisher cannot read buyer data.
- **Residency/PII:** workflows touching personal data inherit `data_region` of the org; connector authorization records transfer assessment reference when target host is outside approved regions (M04 `transfer_assessments`); consent hook for marketing-type actions.
- **Audit events:** `workflow.version.created`, `workflow.execution.started|failed`, `connector.authorized|revoked`, `webhook.endpoint.created`, `listing.version.submitted|moderated`, `purchase.completed`, `entitlement.granted|revoked`, `installation.created`, `agency.client.linked`, `delegation.granted|revoked|used`, `reseller.price_rule.changed`, `reseller.sub_org.created`.
- PII classification: webhook payloads and execution inputs classified `customer-content` (may include `personal`); retention default per D-34.

## 10. Metering & billing hooks
| Meter / flow | Emit point | Limits |
|---|---|---|
| `automation.executions` | execution start (id `executionId`) | plan quota, concurrency cap |
| `automation.steps` | each completed step attempt that is billable (id `executionId:stepKey:attempt`) | plan quota |
| `ai.tokens_*` / `ai.credits_consumed` | when a workflow starts an AI run (via gateway) | budget caps (M09) |
| Marketplace purchase | invoice line via M03; ledger entries incl. `publisher_payable` accrual | — |
| Reseller rating | rating step applies `reseller_price_rules` to sub-org usage; statements reconcile wholesale vs retail | below-cost block |

## 11. Automated tests
- **Idempotent retries:** kill worker mid-step (chaos) → resume yields single effect; same `dedupeKey` twice → one execution; duplicate outbox event → one execution; non-idempotent HTTP action never auto-retried; replay from DLQ idempotent.
- **Connectors:** unauthorized connector in workflow version → `422` at publish and `403` at runtime (fail closed); revoked authorization stops running executions at next step; token scope escalation attempt rejected; rate limit and circuit breaker triggers.
- **SSRF/abuse:** 40+ URL payloads (decimal/octal IPs, IPv6, redirects, DNS rebinding, `localhost`, metadata IPs) all denied; oversized response; infinite loop workflow; self-trigger recursion; spike anomaly auto-pause.
- **Webhooks:** signature verify (valid, tampered, expired timestamp, replay), secret rotation overlap, retry schedule, DLQ.
- **Marketplace:** purchase duplicate callback → one entitlement; concurrent double purchase → one; install by non-entitled org (any listing/version) → 403; install by entitled org lands only in that org; refund → entitlement revoked, further installs blocked; unapproved version not listed/purchasable; moderation stale decision.
- **Agency boundary (exhaustive):** matrix = every route family in docs/04 × {no link, pending link, active grant, expired, revoked, wrong scope, scope ⊂ but action outside, spoofed header with other client id, grant of client A used on client B} → expected deny except valid case; property-based test with random org/resource pairs; audit shows actor+acting org; client-user impersonation attempt denied.
- **Reseller:** price rule below cost rejected; effective-date versioning; statement totals equal ledger postings (variance 0); issuer model `disabled` blocks invoice creation for sub-orgs; unapproved model cannot be enabled via API/config (test).
- **Cross-tenant:** all §6 resources with org B token → 404/403 as specified.
- **Contract/E2E:** OpenAPI conformance; Playwright flows: build workflow → run → inspect; buy → install; agency invite → grant → act → revoke; reseller price edit → statement.
- **Load (proposal):** 1,000 concurrent executions queued, 100 executions/s start rate, p95 trigger→first step ≤ 5 s; webhook delivery 500/s.

## 12. Deliverables
Source, migrations, `spec/` updates (OpenAPI, ownership, events, error codes `connector_not_authorized`, `not_entitled`, `delegation_expired`), SCR documents (SCR-M11-01..04), UI §8, runbooks (`workflow-abuse.md`, `marketplace-moderation.md`, `delegation-incident.md`, `reseller-statements.md`), threat model for delegation, demo script, `docs/reports/M11-report.md`.

## 13. Measurable acceptance criteria
| ID | Criterion | Evidence | Status |
|---|---|---|---|
| AC-M11-01 | Retry/kill/duplicate test matrix: 0 duplicate effects for idempotent actions in ≥200 randomized fault runs | test output | PENDING |
| AC-M11-02 | Unauthorized or revoked connector: 100 % of attempts blocked (fixtures ≥30) | test output | PENDING |
| AC-M11-03 | SSRF payload suite ≥40 payloads, 0 reaching internal targets | suite output | PENDING |
| AC-M11-04 | Purchased template installs only for entitled org: 0 successes in ≥50 non-entitled/cross-tenant attempts | test output | PENDING |
| AC-M11-05 | Duplicate purchase callbacks produce exactly 1 entitlement and 1 invoice | test output | PENDING |
| AC-M11-06 | Agency boundary matrix: 0 cross-client leaks; 100 % of cells behave as expected; revoked/expired grant effective ≤ 60 s (cache TTL ≤ 60 s) | test output | PENDING (needs SCR-M11-01 approved) |
| AC-M11-07 | Publisher accrual postings balance (ledger imbalance 0) and equal purchase invoices × share rule | ledger query | PENDING |
| AC-M11-08 | No payout path exists/enabled (code search + config test) | test output | PENDING |
| AC-M11-09 | Reseller statement totals = ledger postings (variance 0); below-cost rules rejected | test output | PENDING |
| AC-M11-10 | Reseller invoicing with the D-24-approved model on test data | invoice fixtures + tax sign-off | BLOCKED-until-evidence (D-24, HG-03-04) |
| AC-M11-11 | Marketplace/workflow legal terms published | documents | BLOCKED-until-evidence (HG-11-01, HG-04-01) |
| AC-M11-12 | Webhook signature/replay/DLQ tests all pass | test output | PENDING |
| AC-M11-13 | All §8 screens: AR-RTL + EN screenshots, 4 states, axe 0 critical | report | PENDING |
| AC-M11-14 | `automation.*` metering reconciles to execution logs (variance 0) | reconciliation output | PENDING |

## 14. Handoff
→ M12: delegated-access, marketplace and workflow surfaces enter pen-test scope; reseller/marketplace statements enter billing-close reconciliation (RC-05/RC-06); open items to carry: D-24, D-26, HG-11-01, SCR outcomes, publisher verification process.

## 15. Compliance hooks checklist
- [ ] Workflow/connector data flows carry `data_region`; cross-border targets reference a `transfer_assessment`
- [ ] Consent checked for marketing/notification actions
- [ ] Execution inputs/outputs retention + DSR erasure covered
- [ ] Audit events (§9) queryable by actor org and acting org
- [ ] Marketplace content takedown process documented (human-owned)
- [ ] Reseller/agency data-sharing notices drafted for counsel (HG-04-01)

## Completion instruction
Do not mark this milestone DONE until every acceptance row is evidenced. Mark missing legal, tax, issuer-model, publisher-terms or third-party approvals as BLOCKED rather than simulating success. The agent must not mark any HG/D item GRANTED/decided, must not enable a reseller issuer model or any payout path, and must not implement endpoints outside docs/04 before an SCR is approved.
