# M01 — Bootstrap, IAM, Tenancy & Portal Shells

Read CLAUDE.md first. Apply it in full. This prompt never overrides docs/04, docs/05, docs/03 — on conflict stop and report.

| | |
|---|---|
| Sprints | S01–S04 (4 sprints) |
| Depends on | None (first milestone). Needs HG-00-01 approval before S01. |
| Produces | Auth/org context, RBAC, `platform.*` mechanisms, audit, notifications, portal shells, design system, i18n/RTL (consumed by all milestones) |
| Gate | Gate Review per docs/03 §5; migration range `M01: 0001–0199` (ordinal range recorded in `spec/db/ownership.yaml`) |
| Response format | CLAUDE.md §10 |

## 1. Objective
Create the greenfield repository (docs/08), then deliver multi-tenant identity and tenancy: OIDC login, sessions, MFA, scoped API keys, organizations (types `customer|agency|reseller`), workspaces/projects/environments, invitations, RBAC, RLS everywhere, durable operations/outbox/idempotency/feature flags/notifications, a hash-chained audit trail, and the two portal shells (`apps/web`, `apps/admin`) with the design system and Arabic RTL + English. No billing, provider or AI features.

## 2. Preconditions & mocked interfaces
| Item | State | Handling |
|---|---|---|
| HG-00-01 approval note in `docs/reports/` | required | Stop if absent |
| D-01 git host/CI, D-02, D-30, D-32 answered | required before S01 | If D-01 open: GitHub Actions as reversible default, recorded |
| D-03 durable ops engine | S02 | Default Postgres outbox + BullMQ; record ADR-007 |
| D-04 IdP | S02 | Default Keycloak in docker-compose (dev); if open, abstract behind OIDC config; record assumption |
| D-12 secrets | S02 | Dev vault stub (file-backed, dev-only, marked non-production); production vault BLOCKED until D-12 |
| D-13 observability | S04 | OTel instrumentation; backend choice reversible |
| ResidencyPolicyService (M04) | not built | Interface `ResidencyPolicy` with allow-all stub flagged `NOT VERIFIED — M04` |
| Billing/plans (M02) | not built | Do not add any plan/billing column to `tenancy.organizations`; org plan linkage arrives in M02 via `billing` tables |

## 3. Requirement IDs closed
FR-IAM-01, FR-IAM-02, FR-IAM-03, FR-IAM-04, FR-IAM-05, FR-IAM-06, FR-IAM-07, FR-IAM-08, FR-PLT-01, FR-PLT-02, FR-PLT-03, FR-PLT-04, FR-PLT-05, plus FR-UI-xx for screens in §8 (UI-M01-01..29).

## 4. Automatable engineering tasks
**S01 — Bootstrap (execute docs/08 §1 steps 1–13; do not duplicate here).**
1. Produce all bootstrap artifacts; record real command output; fix CLAUDE.md "Commands".
2. Seed ADR-001..016 (Proposed), `spec/` skeleton (OpenAPI with *planned* operations for all of docs/04, ownership manifest, milestones.yaml, events schemas), report templates.
3. Establish `packages/testing` with: tenant fixture factory (orgs A/B/C of each type), RLS harness, API contract harness, Playwright setup with `ar` and `en` projects.
4. Design-system skeleton (`packages/ui`): tokens (colour, spacing, typography incl. Arabic font stack), logical-property CSS, RTL toggle, components list in §8.1.

**S02 — Identity and platform mechanisms.**
5. `platform` module: `operations` + `operation_steps` state machine (`pending → running → waiting_provider → succeeded|failed|cancelled|needs_reconcile`), lease/heartbeat, retry policy, cancellation; `outbox` + relay; `idempotency_keys` (request-hash conflict → 422 `idempotency_key_reuse`); `feature_flags` (global + org scope, cached); `notifications`; `webhook_events_inbound` (generic dedupe table used later).
6. `identity` module: OIDC authorization-code + PKCE against configured IdP; session issue/rotate/revoke (opaque, httpOnly, SameSite, idle + absolute timeouts as config proposals 30 min/12 h D-30); `GET /v1/auth/sessions`, revocation; token validation for bearer use.
7. MFA: TOTP factor enrol/verify; recovery codes (single-use, hashed, shown once); step-up requirement for sensitive actions (API key creation, role change, impersonation); admin realm MFA mandatory. WebAuthn: DEFERRED unless owner approves (record in change-log).
8. API keys: prefix + secret hash (argon2id), scopes (permission subset), expiry, optional IP allow-list, last-used; creation shows secret once; rotation.
9. Rate limiting + brute-force lockout on auth endpoints; audit events for all auth outcomes.

**S03 — Tenancy and RBAC.**
10. `tenancy` module: organizations (types), memberships, invitations (token hashed, expiry 7 d proposal, single use), roles/permissions catalogue (§9.2), workspaces, projects, environments; deletion = soft with retention hook (M04).
11. `PolicyService`: deny-by-default; permission check API used by all controllers via decorator `@RequirePermission`; resource-level checks verify `org_id` match; acting-org header for agency/reseller validated against `programs.delegated_access` (**not available until M11 → returns 403 and is covered by a test with a stubbed delegation table flagged NOT VERIFIED — M11**).
12. RLS: `SET LOCAL app.org_id` interceptor, `nuzm_app`/`nuzm_worker` roles per docs/05 §1.9; CI harness enumerating tables (docs/05 rule 3); explicit list of tenant-less tables (`identity.users`, `identity.credentials_refs`, reference tables, `tenancy.permissions`).
13. Cross-tenant test suite generated per endpoint from the OpenAPI spec (every `{id}` route is called with another org's id → expects 404 (not 403) for resource existence-hiding; policy documented).

**S04 — Audit, notifications, portals.**
14. `audit` module: `audit_logs` append-only with per-org hash chain (`prev_hash`, `hash` over canonical JSON), periodic `audit_checkpoints` signed with a service key (vault ref); verifier job; `GET /v1/audit-logs`, `GET /v1/admin/audit-logs`. Event taxonomy `<domain>.<resource>.<action>`; mandatory fields: actor (user/api-key/system/impersonator), acting org, target org, resource, action, outcome, trace id, IP/UA hash, before/after summary (PII-minimised).
15. Notifications: in-app + email via mail catcher (dev) through a `NotificationChannel` interface; preferences per user.
16. Portals: `apps/web` route groups `(customer)`, `(agency)`, `(reseller)`; `apps/admin` separate app/realm; org switcher, nav gated by permissions and org type, error/empty/forbidden templates, i18n (`ar` RTL default per D-32, `en`), formatting (Hijri display optional flag; Gregorian default), accessibility tooling (axe in CI).
17. Generate `packages/sdk` from OpenAPI; portals use only the SDK.
18. Admin: orgs list/suspend/reinstate, users list, support impersonation (time-boxed ≤ 30 min, reason required, banner, audit, org-owner notification flag), feature flags, audit viewer, operations monitor.
19. Observability: OTel traces/metrics/logs, `traceparent` propagation, problem+json with `traceId`.
20. Runbooks: local setup, rotating dev secrets, restoring DB from dump, break-glass procedure draft. Demo script and `docs/reports/M01-report.md`.

## 5. Human approvals & external gates
| ID | Item | Agent meanwhile | Default status |
|---|---|---|---|
| HG-00-01 | Documentation approval | No product code | PENDING |
| HG-01-01 | Repo/CI access | Work locally; CI definition committed; run result BLOCKED | PENDING |
| HG-01-02 | IdP hosting/domain | Use dev Keycloak; production issuer BLOCKED | PENDING |
| D-01, D-02, D-03, D-04, D-12, D-13, D-30, D-32 | See docs/07 | Proposed defaults recorded as reversible assumptions | OPEN |
| — | Production vault + KMS | Dev stub only | BLOCKED (D-12) |

## 6. API specifications (docs/04 §2.1 — exact; no renames)
Common: org context from token; `Idempotency-Key` required on every POST creating resources; errors problem+json; roles named per §9.2.
| Endpoint | Authz | Key request → response | Errors / notes |
|---|---|---|---|
| GET `/v1/me` | any authenticated | → principal, memberships (org id, type, role), effective permissions, feature flags | 401 |
| GET `/v1/auth/oidc/login` | public | redirect with state+PKCE | 400 invalid `returnTo` allow-list |
| GET `/v1/auth/oidc/callback` | public | code → session cookie | 400 state mismatch, 403 IdP user disabled |
| POST `/v1/auth/logout` | session | revoke current session | idempotent |
| POST `/v1/auth/mfa/factors` | session | `{type:"totp"}` → provisioning URI (once) | 409 factor pending |
| POST `/v1/auth/mfa/factors/{id}/verification` | session | `{code}` → factor active | 422 bad code, 429 |
| DELETE `/v1/auth/mfa/factors/{id}` | session + step-up | removes factor | 409 last factor when org policy requires MFA |
| POST `/v1/auth/mfa/recovery-codes` | session + step-up | → 10 codes once; invalidates previous | |
| GET `/v1/auth/sessions` · DELETE `/v1/auth/sessions/{id}` | own sessions | list/revoke | |
| POST/GET `/v1/api-keys` · DELETE `/v1/api-keys/{id}` | `apikey:manage` (owner/admin/developer own) | create `{name,scopes[],expiresAt?,ipAllowList?}` → secret once | 422 scope exceeds creator permissions |
| POST/GET `/v1/organizations` · GET/PATCH `/v1/organizations/{orgId}` | create: any user; PATCH: owner/admin | `{name,type,country,defaultLocale}`; ETag/If-Match on PATCH | 409 duplicate slug; 412 |
| GET `/v1/organizations/{orgId}/members` · PATCH/DELETE `…/members/{userId}` | `member:read`/`member:manage` | role change requires step-up | 409 cannot remove last owner |
| POST/GET `/v1/invitations` · POST `/v1/invitations/{id}/acceptance` · DELETE `/v1/invitations/{id}` | `member:invite` | `{email,role}`; acceptance by token | 410 expired, 409 already member |
| GET `/v1/roles` · GET `/v1/permissions` | any authenticated | catalogue | |
| POST/GET `/v1/workspaces` · GET/PATCH/DELETE `/v1/workspaces/{id}` | `workspace:*` | `{name,slug}` | 404 cross-tenant |
| POST/GET `/v1/projects` · GET/PATCH/DELETE `/v1/projects/{id}` | `project:*` | `{workspaceId,name,defaultRegionPolicy?}` | |
| POST/GET `/v1/projects/{id}/environments` · PATCH/DELETE `…/{envId}` | `project:*` | `{name,kind:dev|staging|prod}` | |
| GET `/v1/audit-logs` | `audit:read` (owner/admin/billing_admin limited to billing domain) | filters actor/resource/action/time, cursor | |
| GET `/v1/notifications` · PATCH `/v1/notifications/{id}` | own | mark read | |
| GET `/v1/operations` · GET `/v1/operations/{id}` · POST `/v1/operations/{id}/cancellation` | `operation:read` / `operation:cancel` | state, steps, `traceId`, result link | 409 non-cancellable state |
| GET `/v1/resources` | `resource:read` | empty list until owners emit `resource.state_changed`; schema fixed now | |
| GET `/v1/admin/audit-logs` | platform: `security`, `compliance_officer`, `platform_admin` | cross-org filters | access itself audited |
| GET/POST `/v1/admin/organizations` · PATCH `…/{id}` | `platform_admin`, `support` (read) | suspend/reinstate with reason | |
| GET `/v1/admin/users` · POST `/v1/admin/users/{id}/impersonation` | `support` w/ approval flag, `platform_admin` | `{reason,ttlMinutes≤30}` | 403 if target is platform user |
| GET/PUT `/v1/admin/feature-flags` | `platform_admin` | flag, scope, value | |
Async behaviour: only `operations` are async-capable now; no M01 endpoint returns 202 except `POST /v1/operations/{id}/cancellation` (202 if worker must act).

## 7. Database migrations (ranges `0001–0199`)
| Schema | Tables | Notes |
|---|---|---|
| `platform` | `operations`, `operation_steps`, `outbox`, `idempotency_keys`, `feature_flags`, `notifications`, `webhook_events_inbound`, `resources_index` | `outbox(id, org_id, topic, payload, created_at, published_at)` index on unpublished; `idempotency_keys(org_id, key, request_hash, response, expires_at)` unique `(org_id,key,method,path)`; `operations(org_id, kind, status, lease_until, attempt, input, result, trace_id, parent_id)` |
| `identity` | `users`, `credentials_refs`, `sessions`, `mfa_factors`, `recovery_codes`, `api_keys` (+ `sso_connections`,`scim_tokens` reserved for M12 — **not created now**) | `users` tenant-less (global); secrets only as hashes/refs; `api_keys.secret_hash` argon2id |
| `tenancy` | `organizations`, `memberships`, `invitations`, `roles`, `permissions`, `role_permissions`, `workspaces`, `projects`, `environments` | `organizations` has RLS keyed on `id`; memberships RLS on `org_id`; seed `roles`/`permissions` (reference data) |
| `audit` | `audit_logs`, `audit_checkpoints` | Append-only (revoke UPDATE/DELETE + trigger); partition monthly; index `(org_id, occurred_at desc)`; `retention_policies`/`legal_holds`/`access_reviews` NOT created here (M04/M12) |
Roles/grants migration: `nuzm_migrator`, `nuzm_app`, `nuzm_worker`, `nuzm_readonly_reporting`, `nuzm_admin_breakglass` (docs/05 §1.9). RLS policy migration template + CI generator. Reversal: each migration ships `.down.sql` for dev/staging; production = forward fix; first-release rollback = restore snapshot (documented). Seed: roles/permissions reference data; dev seed orgs A/B/C.

## 8. UI screens
All screens: `ar` (RTL) + `en`, loading/empty/error/forbidden states, keyboard accessible, axe clean, screenshot test in both locales. Portal key: C customer, A agency, R reseller, X admin.
### 8.1 Design-system components (UI-M01-00)
Button, Input, Select, Checkbox/Radio, Table (sortable/cursor pagination), Dialog, Drawer, Toast, Tabs, Breadcrumb, Badge/Status, Empty/Error/Forbidden/Skeleton templates, Form with problem+json mapping, DateTime (Gregorian; locale numerals), CopyField (secret-once), ConfirmDestructive, OrgSwitcher, CommandMenu. Tokens documented in Storybook-equivalent (tool per ADR).
### 8.2 Screens
| ID | Portal | Route | Purpose / key states | Roles |
|---|---|---|---|---|
| UI-M01-01 | C A R | `/login` | OIDC start, error banner, locale switch | public |
| UI-M01-02 | C A R | `/auth/callback` | transient; callback failures (state mismatch, disabled) | public |
| UI-M01-03 | C A R | `/account/security/mfa` | enrol TOTP (QR + manual key), verify, remove; empty = not enrolled | any |
| UI-M01-04 | C A R | `/auth/mfa-challenge` | challenge/step-up modal; rate-limit state | any |
| UI-M01-05 | C A R | `/account/security/recovery-codes` | generate/show-once/download; warns invalidation | any |
| UI-M01-06 | C A R | `/orgs/new` | create org (type, country, language); first-run wizard | any |
| UI-M01-07 | C A R | `/` | dashboard home: org summary, pending tasks, recent audit, ops in progress | member |
| UI-M01-08 | C A R | `/settings/organization` | profile, MFA-required toggle, ETag conflict state | owner, admin |
| UI-M01-09 | C A R | `/settings/members` | list, role change (step-up), remove; last-owner guard | owner, admin |
| UI-M01-10 | C A R | `/settings/invitations` | invite, resend, revoke; states pending/expired | owner, admin |
| UI-M01-11 | C A R | `/invitations/[token]` | accept; expired/used states | invitee |
| UI-M01-12 | C A R | `/workspaces` | list/create/rename/delete | admin+, developer read |
| UI-M01-13 | C A R | `/projects` | list/filter/create | developer+ |
| UI-M01-14 | C A R | `/projects/[id]/environments` | environments CRUD | developer+ |
| UI-M01-15 | C A R | `/settings/api-keys` | create (secret once), scopes picker, revoke, last used | owner, admin, developer |
| UI-M01-16 | C A R | `/account/sessions` | active sessions, revoke | any |
| UI-M01-17 | C A R | `/audit-logs` | filterable log, export CSV (≤ limit), integrity badge | owner, admin |
| UI-M01-18 | C A R | `/notifications` | list, mark read, preferences | any |
| UI-M01-19 | C A R | `/operations` | list + detail drawer (steps, trace id), cancel | developer+ |
| UI-M01-20 | C A R | `/resources` | unified inventory (empty-state until M05+) | viewer+ |
| UI-M01-21 | A | `/agency` | shell placeholder; shown only for `type=agency`; "available in M11" | owner, admin |
| UI-M01-22 | R | `/reseller` | shell placeholder; `type=reseller` | owner, admin |
| UI-M01-23 | X | `/login` | admin realm login + mandatory MFA | platform roles |
| UI-M01-24 | X | `/organizations` | search, status, suspend/reinstate w/ reason | platform_admin, support (read) |
| UI-M01-25 | X | `/users` | search, sessions, MFA status, impersonation start (reason, TTL) | support, platform_admin |
| UI-M01-26 | X | `/feature-flags` | list/edit scopes; audit on change | platform_admin |
| UI-M01-27 | X | `/audit-logs` | cross-org viewer, chain verification result | security, compliance_officer, platform_admin |
| UI-M01-28 | X | `/operations` | all-org operation monitor, stuck-operation filters | platform_admin, support |
| UI-M01-29 | X | `/roles` | role/permission matrix viewer (read-only) | platform_admin, security |

## 9. Security, compliance & tenant-isolation requirements
9.1 **Isolation:** RLS forced on all `org_id` tables; admin console uses separate DB role + audited break-glass; existence hiding (404) across tenants; org ids never accepted from body; API-key scopes ⊆ creator permissions at creation and at use.
9.2 **Role catalogue (reference data, `tenancy.roles`; permission strings `domain:action`)**
| Role | Scope | Intent |
|---|---|---|
| `owner` | org | everything incl. org deletion, billing, role grants; ≥1 per org |
| `admin` | org | manage members, projects, keys; no org deletion/ownership transfer |
| `billing_admin` | org | billing/usage/invoices/payment methods (permissions seeded now, used from M02); no resource mutation |
| `developer` | org/workspace | create/manage projects, resources, API keys (own), operations |
| `viewer` | org | read-only |
| `platform_admin` | platform | admin console full except break-glass data access |
| `support` | platform | read orgs/users, impersonation (approval flag), no financial adjustment |
| `finance` | platform | ledger/billing admin (seeded; used M02+) |
| `compliance_officer` | platform | audit/compliance read (M04+) |
| `security` | platform | audit, sessions, key revocation, incident actions |
Separation of duties matrix documented and tested (e.g., `support` cannot grant roles; `finance` cannot impersonate).
9.3 **Session/MFA:** secure cookie flags, CSRF protection, session fixation tests, idle/absolute timeout, MFA required for platform roles and for owners when org flag set, step-up for sensitive actions.
9.4 **PII classification (feeds M04):** `identity.users.email/name` = `personal`; IP = `personal` (store truncated/hashed in audit); API key hashes = `credentials`. Classification annotated in `spec/db/ownership.yaml`.
9.5 **Audit events (minimum):** `auth.login.success|failure`, `auth.mfa.enrolled|removed|challenge_failed`, `auth.session.revoked`, `apikey.created|revoked|used_denied`, `org.created|updated|suspended`, `member.invited|accepted|role_changed|removed`, `project.*`, `workspace.*`, `environment.*`, `admin.impersonation.started|ended`, `flag.changed`, `operation.cancelled`, `audit.chain_verified|broken`.
9.6 **Residency hooks:** `ResidencyPolicy` interface called by project/environment creation with `data_region` default `sa-pending` placeholder; real enforcement M04 — NOT VERIFIED.
9.7 Secrets/log hygiene tests; dependency/secret scanning in CI; CSP, HSTS, security headers on both Next.js apps.

## 10. Metering & billing hooks
No meters emitted in M01. Add `metering` emit helper stub signature in `packages/domain` (no-op, flagged) only if M02 handoff needs it — otherwise none. `billing_admin` permissions seeded but unused. Quota checks: none.

## 11. Automated tests
| Layer | Cases (names) |
|---|---|
| Unit | `idempotency_conflict_on_changed_body`, `operation_state_machine_forbidden_transitions`, `audit_hash_chain_detects_tamper`, `policy_deny_by_default`, `api_key_scope_subset`, `recovery_code_single_use` |
| Integration | `oidc_login_pkce_flow`, `session_idle_and_absolute_timeout`, `mfa_enroll_verify_recover`, `invitation_expiry_single_use`, `last_owner_protection`, `outbox_relay_at_least_once`, `operation_lease_expiry_reclaim` |
| RLS/tenant | generated: every table with `org_id` has forced policy; every `{id}` route returns 404 for foreign org (orgs A/B/C, all three org types); worker role cannot read without explicit org switch; API key of org A on org B → 404 |
| Contract | OpenAPI ↔ handlers drift (negative test), problem+json shape, error code registry |
| Concurrency | duplicate `Idempotency-Key` parallel POST ×50 → one effect; concurrent member role change with ETag → one 412; concurrent invitation accept |
| Failure | IdP down (503 handling, no session leak), DB failover during outbox relay, mail catcher down (notification retry) |
| Security | brute-force lockout, CSRF, session fixation, open-redirect on `returnTo`, header scan, secret scan, impersonation expiry, admin realm token rejected on web API and vice versa |
| E2E (Playwright, ar+en) | login+MFA, create org, invite+accept, create workspace/project/env, create/revoke API key (secret once), audit log shows events and integrity badge, admin suspend org (customer blocked), impersonation banner + audit |
| A11y/UI | axe on all §8 screens; RTL screenshot diff; keyboard-only navigation of login/members |
| Load (smoke) | 200 rps `/v1/me` p95 < 300 ms on CI-size env (record, not gate) |

## 12. Deliverables
Repository skeleton + `docs/reports/S01-bootstrap-report.md`; modules `platform`, `identity`, `tenancy`, `audit`; generated SDK; both portal shells with all §8 screens; OpenAPI (M01 operations promoted from planned→implemented); `spec/db/ownership.yaml` updated; migrations 0001–0199 with reversal notes; runbooks (`local-setup`, `rotate-dev-secrets`, `restore-from-dump`, `break-glass-draft`); `.env.example`; demo script `docs/runbooks/demo-m01.md` (login → MFA → org → invite → project → API key → audit → admin impersonation); `docs/reports/M01-report.md` (CLAUDE.md §10 format); gate review document.

## 13. Measurable acceptance criteria
| ID | Criterion | Evidence | Status |
|---|---|---|---|
| AC-M01-01 (B1) | `pnpm install --frozen-lockfile` succeeds from clean clone | log | PENDING |
| AC-M01-02 (B2) | `pnpm verify` exits 0 | log | PENDING |
| AC-M01-03 (B3) | compose up healthy; `pnpm db:migrate` from empty exits 0 | log | PENDING |
| AC-M01-04 (B4) | `/healthz` 200; web+admin shells render in `ar` RTL and `en` | logs, screenshots | PENDING |
| AC-M01-05 (B5) | `spec:drift` fails on undocumented endpoint (negative test captured) | log | PENDING |
| AC-M01-06 (B6) | boundary lint fails on deliberate cross-module import (captured, reverted) | log | PENDING |
| AC-M01-07 (B7) | ADR-001..016 exist, status Proposed | files | PENDING |
| AC-M01-08 (B8) | CI definition committed; first run recorded | run link | BLOCKED until HG-01-01 if no CI access |
| AC-M01-09 (B9) | secret scanner clean | log | PENDING |
| AC-M01-10 | 0 cross-tenant leaks: RLS coverage test passes for 100% of tenant tables and generated cross-tenant route tests pass for 100% of `{id}` routes | test report | PENDING |
| AC-M01-11 | Duplicate `Idempotency-Key` ×50 parallel → exactly 1 resource, 49 replays | test output | PENDING |
| AC-M01-12 | Audit chain verifier detects a single altered row in fixture; no UPDATE/DELETE permitted for `nuzm_app` | tests | PENDING |
| AC-M01-13 | MFA enrol/verify/recover e2e passes; admin realm cannot log in without MFA | e2e | PENDING |
| AC-M01-14 | All 29 screens in §8 pass axe (0 serious/critical) and have ar+en screenshots | reports | PENDING |
| AC-M01-15 | Every mutating endpoint writes ≥1 audit event (automated coverage check = 100%) | test | PENDING |
| AC-M01-16 | OpenAPI for M01 endpoints validated by Spectral with 0 errors; SDK generated and used by portals | log | PENDING |
| AC-M01-17 | Operation lease reclaim: killed worker's operation resumes ≤ 2× lease interval | integration test | PENDING |
| AC-M01-18 | Production vault, production IdP issuer | owner evidence | BLOCKED (D-12/HG-01-02), not satisfiable by mocks |

## 14. Handoff to next milestones
M02: `platform` helpers, outbox, `PolicyService`, billing roles seeded, admin shell for finance screens, SDK, design system. M04: classification annotations, audit retention stubs, `ResidencyPolicy` interface. M05: `platform.operations` and `resources_index`. List open decisions D-xx still OPEN and any assumptions made.

## 15. Compliance hooks checklist
- [ ] Residency: `data_region` default and `ResidencyPolicy` interface present (stub flagged)
- [ ] PII: fields classified; audit stores hashed/truncated IP; no PII in logs
- [ ] Consent: privacy notice/terms acceptance recorded at signup (`identity.users.terms_accepted_at`, version) — storage only; consent engine in M04
- [ ] Audit: taxonomy §9.5 implemented; retention policy placeholders documented for M04/M12
- [ ] Retention: org/project deletion = soft delete with `deleted_at`, hard-delete job disabled until M04

## Completion instruction
Do not mark this milestone DONE until every acceptance row is evidenced. Mark missing approvals, credentials or decisions as BLOCKED, never simulate them. The agent may not mark any HG item as granted; only the owner records evidence. Report using CLAUDE.md §10.
