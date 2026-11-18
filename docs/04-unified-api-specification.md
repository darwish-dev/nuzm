# Nuzm — Unified API Specification (v1, draft)

This document is the **authoritative endpoint catalogue** until bootstrap converts it to `spec/openapi/*.yaml`; after that the OpenAPI files win and CI fails on drift. Milestone prompts may restate endpoints but must not rename, add or remove them; conflicts → this document wins.

## 1. Conventions
| Topic | Rule |
|---|---|
| Base | `/v1`, JSON, UTF-8. Breaking change → `/v2`. |
| Naming | plural kebab-case nouns; actions are **sub-resources that create something** (`/backups`, `/restores`, `/renewals`, `/approvals`, `/executions`), not verbs. The one exception: `/{id}/actions` on compute for power operations (`start|stop|reboot|resize|snapshot`), kept for provider symmetry. |
| JSON | camelCase fields; ids are UUIDv7 strings; timestamps RFC 3339 UTC; money `{ "amount": "12345", "currency": "SAR" }` with `amount` an integer string in minor units. |
| Org context | Taken from token/API key. Body or query never selects the tenant. Path `{orgId}` is allowed only on `/organizations/{orgId}/…` and is verified against the token. Agencies/resellers act through `X-Nuzm-Acting-Org` validated against delegated access. |
| Auth | Session cookie (portals) or `Authorization: Bearer` (OIDC token or scoped API key). Admin API requires admin realm token + MFA. |
| Idempotency | `Idempotency-Key` header **required** on every POST that creates or charges; replay returns original response. |
| Async | Long work returns `202` + `Operation` (`/v1/operations/{id}`); resource shows `status` and `operationId`. |
| Concurrency | `ETag`/`If-Match` on PATCH and PUT. |
| Pagination | `?limit=1..200&cursor=…` → `{ items, nextCursor }`. |
| Filtering | `?filter[field]=` and `?sort=-createdAt`. Location filters (all offer-like lists): `country` (ISO-3166 alpha-2), `region` (provider region code), `geoGroup` (`EU`, `GCC`, `MENA`). |
| Errors | RFC 9457 `application/problem+json` with `type`, `code`, `traceId`, field `errors[]`. Stable `code` registry in `spec/openapi/errors.yaml`. |
| Rate limit | `RateLimit-*` headers; 429 + `Retry-After`. |
| Webhooks (inbound) | `/v1/webhooks/{category}/{provider}`; signature verified, replay window, dedupe on provider event id, always `2xx` quickly after durable record. |
| Webhooks (outbound) | `/v1/webhook-endpoints` (M11); HMAC-SHA256 signature; retries with backoff + DLQ. |
| Residency | Responses for regional resources include `dataRegion` and `providerRegionId`. |
| SCIM exception | `/scim/v2/*` is served outside `/v1` because RFC 7644 clients expect that base; it is the only exception. |
| Compatibility | Provider-neutral fields only; provider specifics live under `providerDetails` (admin and read-only). |

Portal column: **C** customer, **A** agency, **R** reseller, **X** admin. Status column: milestone that implements.

## 2. Catalogue

### 2.1 Platform & IAM (M01)
| Method & path | Portal | Purpose |
|---|---|---|
| GET `/v1/me` | C A R X | Current principal, orgs, effective permissions |
| GET `/v1/auth/oidc/login` · GET `/v1/auth/oidc/callback` · POST `/v1/auth/logout` | all | OIDC flow, session lifecycle |
| POST `/v1/auth/mfa/factors` · POST `/v1/auth/mfa/factors/{id}/verification` · DELETE `/v1/auth/mfa/factors/{id}` · POST `/v1/auth/mfa/recovery-codes` | all | MFA enrol/verify/recover |
| GET `/v1/auth/sessions` · DELETE `/v1/auth/sessions/{id}` | C A R X | Session management |
| POST/GET `/v1/api-keys` · DELETE `/v1/api-keys/{id}` | C A R | Scoped API keys (scopes, expiry, IP allow-list) |
| POST/GET `/v1/organizations` · GET/PATCH `/v1/organizations/{orgId}` | C A R | Org CRUD (`type`: `customer|agency|reseller`) |
| GET `/v1/organizations/{orgId}/members` · PATCH/DELETE `…/members/{userId}` | C A R | Members and role changes |
| POST/GET `/v1/invitations` · POST `/v1/invitations/{id}/acceptance` · DELETE `/v1/invitations/{id}` | C A R | Invitations |
| GET `/v1/roles` · GET `/v1/permissions` | C A R X | Role/permission catalogue |
| POST/GET `/v1/workspaces` · GET/PATCH/DELETE `/v1/workspaces/{id}` | C A R | Workspaces |
| POST/GET `/v1/projects` · GET/PATCH/DELETE `/v1/projects/{id}` | C A R | Projects |
| POST/GET `/v1/projects/{id}/environments` · PATCH/DELETE `…/{envId}` | C A R | Environments |
| GET `/v1/audit-logs` | C A R | Org-scoped audit (filter by actor/resource/action/time) |
| GET `/v1/notifications` · PATCH `/v1/notifications/{id}` | C A R X | In-app notifications |
| GET `/v1/operations` · GET `/v1/operations/{id}` · POST `/v1/operations/{id}/cancellation` | C A R X | Durable operations (used by every module) |
| GET `/v1/resources` | C A R | Unified read-only inventory across kinds (compute, site, domain, database, bucket, mailbox…), populated by owning modules via events |
| GET `/v1/admin/audit-logs` | X | Cross-org audit (same store as `/v1/audit-logs`, privileged scope) |
| GET/POST `/v1/admin/organizations` · PATCH `…/{id}` (suspend/reinstate) | X | Admin org management |
| GET `/v1/admin/users` · POST `/v1/admin/users/{id}/impersonation` | X | Support impersonation (time-boxed, audited, consent flagged) |
| GET/PUT `/v1/admin/feature-flags` | X | Flags |

### 2.2 Ledger, plans, usage (M02)
| Method & path | Portal | Purpose |
|---|---|---|
| GET `/v1/billing/plans` · GET `/v1/billing/plans/{id}` | C A R | Public plan catalogue (price-book resolved for caller) |
| GET `/v1/billing/entitlements` | C A R | Effective entitlements/quotas for org |
| GET `/v1/billing/ledger` | C A R | Customer-visible statement (read-only projection of postings) |
| GET `/v1/billing/balance` | C A R | Balance, credits, committed spend |
| GET/PUT `/v1/billing/spending-limits` | C A R | Org/project monthly caps and alert thresholds |
| POST/GET `/v1/billing/spend-approvals` · POST `/v1/billing/spend-approvals/{id}/decision` | C A R | Approval requests/decisions for authorizations above limit |
| GET `/v1/usage` · GET `/v1/usage/summary` | C A R | Aggregated usage by meter/project/resource/period |
| GET `/v1/usage/events` | X (all orgs); C A R only for own org and only with permission `usage:events:read` (owner, admin, billing_admin) | Raw metering events |
| GET `/v1/quotas` | C A R | Current quotas and consumption |
| POST `/v1/quotes` · GET `/v1/quotes/{id}` | C A R | **One quote endpoint for all kinds** (`compute|hosting|domain|database|storage|email|ai-credit|plan|marketplace`), immutable once issued, TTL, includes tax estimate and residency evaluation |
| GET `/v1/admin/billing/ledger-accounts` · GET `/v1/admin/billing/ledger-transactions` | X | Ledger inspection |
| GET/POST `/v1/admin/billing/price-books` · POST `…/{id}/versions` | X | Price books and versions |
| GET/POST `/v1/admin/billing/plans` · PATCH `…/{id}` | X | Plan management |
| POST `/v1/admin/billing/adjustments` | X | Manual adjustments (two-person approval, reversing entries only) |
| GET `/v1/admin/meters` · POST `/v1/admin/meters` | X | Meter catalogue |

Ingestion of metering events is an **internal** interface (`MeteringIngestService`, not public HTTP) except `POST /v1/internal/metering/events` for node agents/sandbox runners using service credentials.

### 2.3 Payments, invoicing, tax, ZATCA (M03)
| Method & path | Portal | Purpose |
|---|---|---|
| POST/GET `/v1/billing/payment-methods` · DELETE `…/{id}` · POST `…/{id}/default` | C A R | Tokenized methods only; no PAN in Nuzm |
| POST/GET `/v1/billing/payments` · GET `…/{id}` | C A R | Payment intents/attempts |
| POST `/v1/billing/wallet-topups` | C A R | Prepaid credit |
| POST/GET `/v1/billing/subscriptions` · GET/PATCH `…/{id}` · POST `…/{id}/cancellation` | C A R | Subscriptions |
| GET `/v1/billing/invoices` · GET `…/{id}` · GET `…/{id}/pdf` · GET `…/{id}/xml` | C A R | Invoices (XML = ZATCA UBL where applicable) |
| GET `/v1/billing/credit-notes` · GET `…/{id}` | C A R | Credit notes |
| GET/PUT `/v1/billing/tax-profile` | C A R | VAT number, address, buyer data needed for invoicing |
| POST `/v1/webhooks/payments/{provider}` | provider | PSP callbacks |
| POST `/v1/admin/billing/refunds` · GET `…` | X | Refunds (idempotent create; GET = read-only list with status, added in M03 S12d) |
| GET `/v1/admin/billing/invoices` | X | Cross-organization invoice search with e-invoice state (read-only, audited; added in M03 S12d, owner-approved 2026-11-18) |
| GET `/v1/admin/billing/payments` · GET `…/{id}/events` | X | Cross-organization payment list and redacted PSP events with the resend counter (read-only, audited; added in M03 S12d, owner-approved 2026-11-18) |
| GET `/v1/admin/billing/reconciliations` · POST `…` (run) · GET `…/{id}` · POST `…/{id}/resolutions` | X | **All** financial reconciliation (payments vs PSP, ledger vs invoices, provider cost vs bills, usage vs invoice). Replaces v3 `GET /v1/billing/reconciliation`. |
| GET `/v1/admin/billing/zatca/onboarding` · POST `…` · GET `/v1/admin/billing/zatca/submissions` · POST `…/{id}/retry` | X | ZATCA lifecycle |
| GET `/v1/admin/billing/dunning` · PATCH `…/{id}` | X | Dunning cases |
| GET `/v1/admin/billing/revenue-reports` | X | Reports (export CSV) |

### 2.4 Compliance (M04)
| Method & path | Portal | Purpose |
|---|---|---|
| POST/GET `/v1/compliance/consents` · DELETE `…/{id}` | C A R | Consent records and withdrawal |
| POST/GET `/v1/compliance/data-subject-requests` · GET `…/{id}` | C A R | Access, correction, deletion, portability requests |
| GET/PUT `/v1/compliance/residency-policy` | C A R | Org residency policy (allowed regions per data class) |
| GET `/v1/compliance/data-exports` · POST `…` | C A R | Org data export (portability) |
| GET/POST `/v1/admin/compliance/ropa` · GET/POST `…/controls` · GET/POST `…/evidence` | X | Record of processing, control register, evidence |
| GET/PUT `/v1/admin/compliance/retention-policies` · POST `…/legal-holds` | X | Retention and holds |
| GET/POST `/v1/admin/compliance/transfer-assessments` | X | Cross-border transfer assessments |
| GET/POST `/v1/admin/compliance/regulatory-validations` | X | Validation register (HG-linked, status evidenced by humans) |
| POST/GET `/v1/admin/compliance/breach-cases` | X | Incident/breach notification workflow |

### 2.5 Cloud framework & compute (M05)
| Method & path | Portal | Purpose |
|---|---|---|
| GET `/v1/offers` | C A R | **Single offer listing** (purchasable, priced, verified offers; `GET /v1/hosting/plans` is the *plan-definition catalogue* — quotas/features — and `/v1/offers?kind=hosting` is what can actually be bought now). Params: `kind` (`compute|hosting|database|storage|email`), `country`, `region`, `geoGroup`, `provider`, `minVcpu`, `minMemoryMb`… Only verified inventory returned. |
| POST `/v1/compute/instances` | C A R | Create from `quoteId` (async, `202`) |
| GET `/v1/compute/instances` · GET `…/{id}` · DELETE `…/{id}` | C A R | List/inspect/delete |
| POST `/v1/compute/instances/{id}/actions` | C A R | `{ "type": "start|stop|reboot|resize|snapshot", … }` — only types in the instance's capability set |
| GET `/v1/compute/instances/{id}/metrics` | C A R | Monitoring where provider supports |
| GET/POST `/v1/admin/providers` · GET `/v1/admin/providers/{id}` | X | Provider registry |
| GET/POST `/v1/admin/provider-accounts` · GET/PATCH `…/{id}` · POST `…/{id}/verification` | X | Accounts, credential vault refs, health |
| GET `/v1/admin/provider-accounts/{id}/capabilities` · POST `…/catalog-syncs` · GET `…/regions` · GET `…/plans` | X | Verified capability matrix and catalog |
| GET `/v1/admin/provider-jobs/{id}` | X | Status of a verification / catalog-sync job (the `operationId` of the 202 answers; platform jobs live in `cloud.provider_jobs`, SI-M05-6) |
| GET `/v1/admin/provider-costs` | X | Provider cost records (`metering.provider_cost_records`) in the provider currency (integer minor units) with totals per currency; keyset cursor; permission `admin:provider:read` (M05 S23, UI-M05-14) |
| GET `/v1/admin/live-verification`, POST `/v1/admin/live-verification/runs` | X | Human-triggered live-verification jobs with gate state and labels (NOT RUN / NOT VERIFIED / LIVE-VERIFIED / FAIL); the POST only RECORDS an owner-run result (append-only; LIVE-VERIFIED needs gate evidence + evidence ids + zero residue); no route starts a run (M05 S23, UI-M05-15) |
| GET `/v1/admin/offers?orgId=` | X | Offers as evaluated for one organization (provider identity, provider region id, provider cost, failing conditions with `includeIneligible=true`): the routing dry-run data (M05 S17) |
| GET/POST `/v1/admin/routing-rules` | X | Explicit/automatic routing configuration |
| GET `/v1/admin/resources` · POST `/v1/admin/resources/{id}/reconciliations` | X | Inventory and forced reconcile |
| POST `/v1/webhooks/cloud/{provider}` | provider | Provider events (where supported) |

### 2.6 Hosting (M06)
GET `/v1/hosting/plans` · POST/GET `/v1/hosting/sites` · GET/PATCH/DELETE `/v1/hosting/sites/{id}` · POST/GET `/v1/hosting/sites/{id}/backups` · POST `/v1/hosting/sites/{id}/restores` · POST/GET `/v1/hosting/sites/{id}/domains` · POST/GET `/v1/hosting/sites/{id}/ssl-certificates` · POST/GET `/v1/hosting/sites/{id}/databases` (binding to M08 databases) · GET `/v1/hosting/sites/{id}/usage` — **C A R**.
Admin: GET/POST `/v1/admin/hosting/nodes` · PATCH `…/{id}` (drain/maintenance) · GET `/v1/admin/hosting/nodes/{id}/capacity` · POST `/v1/admin/hosting/abuse-cases`.

### 2.7 Domains & DNS (M07)
GET `/v1/domains/search` · POST `/v1/domains` (order from `quoteId`) · GET `/v1/domains` · GET/PATCH `/v1/domains/{id}` (contacts, nameservers, lock, auto-renew) · POST `/v1/domains/{id}/renewals` · POST/GET `/v1/domains/transfers` · GET `/v1/domains/{id}/eligibility` · GET/POST `/v1/dns/zones` · GET `/v1/dns/zones/{id}` · GET/PATCH `/v1/dns/zones/{id}/records` (PATCH = atomic change-set `{create[],update[],delete[]}`) — **C A R**.
Admin: GET/POST `/v1/admin/registrars` · POST `…/{id}/verification` · POST `/v1/admin/domains/{id}/reconciliations`. Inbound: POST `/v1/webhooks/registrars/{provider}`.

### 2.8 Managed data & email (M08)
| Method & path | Purpose |
|---|---|
| POST/GET `/v1/databases` · GET/PATCH/DELETE `/v1/databases/{id}` | `engine`: `postgresql|mysql|redis` (Redis is a database kind, not a separate API) |
| POST/GET `/v1/databases/{id}/backups` · POST `/v1/databases/{id}/restores` · POST `/v1/databases/{id}/credential-rotations` | Backup, restore (to new instance by default), rotation |
| POST/GET `/v1/storage/buckets` · GET/PATCH/DELETE `…/{id}` · GET/PUT `…/{id}/access-policy` · POST `…/{id}/signed-urls` · GET/PUT `…/{id}/lifecycle` | Object storage |
| POST/GET `/v1/email/domains` · POST `/v1/email/domains/{id}/verification` | Sending/mailbox domain DNS (SPF/DKIM/DMARC/MX) |
| POST/GET `/v1/email/mailboxes` · PATCH/DELETE `…/{id}` · POST/GET `/v1/email/aliases` | Business email |
| POST/GET `/v1/email/sender-identities` | Transactional senders |
| POST `/v1/email/messages` · GET `/v1/email/messages/{id}` · GET `/v1/email/events` | Transactional send (replaces v3 `/v1/email/send`) |
| GET/POST `/v1/email/templates` · GET/POST `/v1/email/suppressions` | Templates and suppression list |
| POST `/v1/webhooks/email/{provider}` | Bounce/complaint/delivery events |
Admin: GET/POST `/v1/admin/data-providers` (provider selection config per D-05..D-09).

### 2.9 AI core & builder (M09, extended M10)
| Method & path | Purpose |
|---|---|
| POST/GET `/v1/ai/sessions` · GET `/v1/ai/sessions/{id}/messages` · POST `…/messages` | Conversational sessions |
| POST `/v1/ai/runs` | `kind`: `website|webapp|mobile|edit|chat|test-fix`; one endpoint for all (replaces v3 `/v1/ai/apps/generate`) |
| GET `/v1/ai/runs/{id}` · GET `/v1/ai/runs/{id}/events` (SSE) · POST `/v1/ai/runs/{id}/cancellation` · POST `/v1/ai/runs/{id}/approvals` | Run control and human approval (replaces `/approve`) |
| GET `/v1/ai/models` · GET `/v1/ai/credits` · GET/PUT `/v1/ai/budgets` | Models allowed by residency policy, credits, caps |
| POST/GET `/v1/builder/projects` | `type`: `website|webapp|mobile`. Replaces v3 `/builder/sites` and `/mobile/projects` |
| GET/PATCH/DELETE `/v1/builder/projects/{id}` · GET `…/files` · GET `…/files/content?path=` · POST `…/changes` (safe diff set) · GET `…/versions` · POST `…/versions/{vid}/restoration` | Project, files, version control |
| POST/GET `/v1/builder/projects/{id}/previews` | Responsive preview |
| GET/POST `/v1/builder/projects/{id}/forms` · GET `…/form-submissions` · GET/POST `…/cms-collections` | Forms and basic CMS (website type) |
| POST `/v1/builder/projects/{id}/sandboxes` · GET/DELETE `…/{sid}` · WS `…/{sid}/terminal` | Isolated sandbox (M10) |
| POST/GET `/v1/builder/projects/{id}/test-runs` · POST/GET `/v1/builder/projects/{id}/exports` · GET/POST `/v1/builder/projects/{id}/git/…` | Tests, export, Git (M10) |
| POST `/v1/deployments` · GET `/v1/deployments` · GET `…/{id}` · GET `…/{id}/logs` · POST `…/{id}/rollback` | **Single publish/deploy endpoint** for websites and web apps (replaces `/builder/sites/{id}/publish`); target = hosting site or compute instance |
Admin: GET/POST `/v1/admin/ai/model-providers` · GET `/v1/admin/ai/runs` (read-only for support).

### 2.10 Mobile (M10)
POST/GET `/v1/mobile/builds` · GET `/v1/mobile/builds/{id}` · GET `…/artifacts` · POST/GET `/v1/mobile/signing-credentials` (vault references only) · POST/GET `/v1/mobile/releases` (store-submission **preparation** records; submission needs explicit account approval step). Project creation is `/v1/builder/projects` with `type=mobile`.

### 2.11 Automation, marketplace, programs (M11)
POST/GET `/v1/workflows` · GET/PATCH `/v1/workflows/{id}` · POST `/v1/workflows/{id}/versions` · POST/GET `/v1/workflows/{id}/executions` (replaces `/execute`) · GET `/v1/workflow-executions/{id}` · POST/GET `/v1/connectors` · POST `/v1/connectors/{id}/authorization` · POST/GET `/v1/webhook-endpoints`.
POST/GET `/v1/marketplace/listings` · POST `…/{id}/versions` · POST `/v1/marketplace/purchases` · GET `/v1/marketplace/purchases/{id}` · POST/GET `/v1/marketplace/installations`. Admin: POST `/v1/admin/marketplace/listings/{id}/moderation`.
POST/GET `/v1/agencies` · POST/GET `/v1/agencies/{id}/clients` · GET/POST `/v1/agencies/{id}/delegated-access` · POST/GET `/v1/resellers` · GET/POST `/v1/resellers/{id}/sub-organizations` · GET/PUT `/v1/resellers/{id}/price-rules` · GET `/v1/resellers/{id}/statements`.

### 2.12 Enterprise & operations (M12)
POST/GET `/v1/organizations/{orgId}/sso-connections` · `/scim/v2/*` (SCIM 2.0, token-authenticated) · GET/POST `/v1/admin/access-reviews` · POST `…/{id}/decisions` · GET `/v1/admin/operations/health` · GET/POST `/v1/admin/incidents` · PATCH `…/{id}` · GET/POST `/v1/admin/alerts` · GET `/v1/admin/provider-incidents` · GET/POST `/v1/admin/recovery-exercises` · GET/PUT `/v1/admin/policy-versions` · GET/PUT `/v1/admin/audit-retention`.

## 3. v3 → v4 endpoint mapping (renames and removals)
| v3 | v4 |
|---|---|
| `GET /v1/cloud/offers`, `?country=SA`, `?region=EU` | `GET /v1/offers?kind=compute&country=SA` / `&geoGroup=EU` |
| `POST /v1/cloud/quotes`, `POST /v1/domains/quotes` | `POST /v1/quotes` (`kind`) |
| `POST /v1/cloud/resources` | removed; typed create endpoints + read-only `GET /v1/resources` |
| `POST /v1/compute/instances`, `GET …/{id}` | unchanged |
| `POST /v1/hosting/sites/{id}/restore` | `POST …/restores` |
| `POST /v1/domains/orders` | `POST /v1/domains` with `quoteId` |
| `POST /v1/domains/{id}/renew` | `POST /v1/domains/{id}/renewals` |
| `POST /v1/email/send` | `POST /v1/email/messages` |
| `POST /v1/ai/apps/generate` | `POST /v1/ai/runs` (`kind=webapp`) |
| `POST /v1/ai/runs/{id}/approve` | `POST …/approvals` |
| `POST /v1/builder/sites`, `…/{id}/publish` | `POST /v1/builder/projects` (`type=website`), `POST /v1/deployments` |
| `POST /v1/mobile/projects` | `POST /v1/builder/projects` (`type=mobile`) |
| `POST /v1/workflows/{id}/execute` | `POST …/executions` |
| `GET /v1/admin/audit`, `security.audit_logs` | `GET /v1/admin/audit-logs`, single `audit.audit_logs` |
| `GET /v1/billing/reconciliation` | `GET /v1/admin/billing/reconciliations` |
| `GET /v1/billing/ledger` | unchanged (customer projection) |

### 2.13 Proposed additions (PA-xx) — NOT yet part of the contract
Raised during milestone drafting. Nothing below may be implemented until the owner approves it and it is merged into §2 (milestone prompts mark dependent screens/criteria as BLOCKED until then).
| ID | Proposed endpoint | Why | Raised by |
|---|---|---|---|
| PA-01 | DELETE `/v1/agencies/{id}/delegated-access/{grantId}` · POST `/v1/agencies/{id}/clients/{clientId}/revocation` | Safety-critical revocation of delegated access (SCR-M11-01) | M11 |
| PA-02 | GET `/v1/webhook-endpoints/{id}/deliveries` · POST `…/deliveries/{did}/replay` | Delivery log, DLQ replay (SCR-M11-02) | M11 |
| PA-03 | GET `/v1/marketplace/listings/{id}` · GET `…/versions` | Listing detail (SCR-M11-03) | M11 |
| PA-04 | POST `/v1/organizations/{orgId}/scim-tokens` · DELETE `…/{id}` | SCIM token issuance/rotation (SCR-M12-01) | M12 |
| PA-05 | Extend PATCH `/v1/organizations/{orgId}` with `securityPolicy{mfaRequired,sessionMaxAge,ipAllowList,ssoEnforced}` | Org security policy (SCR-M12-02) | M12 |
| PA-06 | GET/PUT `/v1/admin/launch-gates` · GET/PUT `/v1/admin/slo-definitions` | GA readiness board (SCR-M12-03) | M12 |
| PA-07 | GET `/v1/admin/access-reviews/{id}/items` · POST `…/items/{iid}/decision` | Review items (SCR-M12-04) | M12 |
| PA-08 | POST `/v1/admin/sandboxes/{id}/termination` | Force-kill sandboxes | M10 |
| PA-09 | Exact Git sub-paths under `/v1/builder/projects/{id}/git/` (branches, commits, diffs, checkpoints) — to be enumerated | `…` in §2.9 is not a contract (SCR-M10-01) | M10 |
| PA-10 | GET/PUT `/v1/admin/organizations/{id}/entitlement-overrides` | Per-org entitlement overrides | M02 |
| PA-11 | GET/POST `/v1/admin/billing/billing-entities` · GET/POST `/v1/admin/billing/tax-rates` | Issuer entities and VAT rate management | M03 |
| PA-12 | POST/DELETE `/v1/admin/users/{id}/platform-roles` · POST `/v1/admin/users/{id}/mfa-reset` | Platform role assignment, admin MFA reset | M01 |
| PA-13 | GET `/v1/admin/compliance/data-subject-requests` · POST `/v1/admin/compliance/breach-cases/{id}/transitions` | Admin DSR queue, breach state transitions | M04 |
| PA-14 | GET `/v1/admin/hosting/abuse-cases` · PATCH `/v1/admin/hosting/sites/{id}` (suspend, per-site quota override) | Abuse-case listing, site suspension and quotas | M06 |
| PA-15 | POST `/v1/databases/{id}/credential-reveals` · POST `/v1/storage/buckets/{id}/credential-reveals` | One-time, audited secret reveal | M08 |
| PA-16 | POST `/v1/ai/credit-purchases` (from an `ai-credit` quote) | Buying AI credits has no order endpoint | M09 |
| PA-17 | GET `/v1/audit-logs/integrity` (own org chain status + last signed checkpoint) | Integrity badge on the audit screen (UI-M01-17); the verifier exists, the endpoint is not exposed | M01 |
| PA-18 | GET/PUT `/v1/notifications/preferences` (per kind and channel) | Notification preferences screen (UI-M01-18); service and table exist, the endpoint is not exposed | M01 |
| PA-19 | POST `/v1/email/mailboxes/{id}/credential-reveals` (one-time reveal of the password reset link / one-time secret) · GET/POST `/v1/admin/email/deliverability` (rolling bounce and complaint rates per organization, throttle state, time-boxed override) | The mailbox setup secret must be shown once and audited; UI-M08-17 needs the admin deliverability view and override. The services exist (`MailboxService.revealSetup`, `MessageService.rates/setThrottleOverride`) and are tested; no HTTP route is exposed | M08 |
| PA-20 | GET `/v1/admin/data/instances` (fleet view: databases, restore-verification status, metadata only) | UI-M08-16; support sees metadata only, never tenant content | M08 |
| PA-21 | POST `/v1/databases/{id}/restores/{restoreId}/approvals` (second-person approval of an in-place restore) | M08 §4 S33 asks for an "approval step"; docs/04 has no approval endpoint for restores. Interim control: `confirmInPlace` + typed database name + recent MFA + automatic pre-restore backup | M08 |
| PA-M11-04 | PATCH `/v1/connectors/{id}` (disable) · DELETE `/v1/connectors/{id}/authorization` (revoke) · POST `/v1/admin/workflows/{id}/pauses` (kill switch) | Connector revoke/disable and the admin workflow kill switch (SCR-M11-04); service-level today | M11 |
| PA-M11-05 | GET `/v1/admin/marketplace/moderation-queue` · GET/POST `/v1/admin/marketplace/publishers` · POST `…/publishers/{id}/verification` · GET `/v1/admin/automation/anomaly-cases` · GET `/v1/admin/automation/dead-letters` · GET `/v1/admin/programs/agencies|resellers` | Admin reads and publisher verification (SCR-M11-05); UI-M11-20/21/22 are BLOCKED without them | M11 |
| PA-M11-06 | GET `/v1/marketplace/purchases` · GET `/v1/marketplace/entitlements` · GET `/v1/marketplace/publisher/statements` | Purchases list and publisher accrual statement (SCR-M11-06) | M11 |
| PA-M11-07 | PATCH `/v1/agencies/{id}` (consolidated billing opt-in) · GET `/v1/agencies/{id}/billing` | Consolidated billing view, UI-M11-14 (SCR-M11-07) | M11 |
| PA-M11-08 | POST `/v1/resellers/{id}/sub-organizations` with `create` semantics · DELETE `…/{subId}` | Sub-organization creation and removal; ownership of a created organization is an open decision (SCR-M11-08) | M11 |
