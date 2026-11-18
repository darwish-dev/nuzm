# Threat model: control plane (API, identity, tenancy, audit, secrets, admin plane)

> INTERNAL self-assessment, 2026-11-18. NOT independent (HG-12-01 / D-28 BLOCKED). Statuses per [README](README.md): `PASS` = control and a covering test located, suites not re-run here; `NOT VERIFIED` = no evidence seen or mock/fixture only.

## 1. Scope and assets

In scope: `apps/api` modules as of this branch (identity, access, tenancy, audit, admin, platform, plus the cross-cutting `common/*` code), `packages/platform` (Db helper, idempotency, operations, outbox), `packages/db` (migrations, RLS checks), the two Next.js consoles (`apps/web`, `apps/admin`) as clients.

| Asset | Why it matters |
|---|---|
| Customer data in tenant tables (`org_id` + RLS) | Core isolation promise |
| Sessions, API keys, MFA factors, recovery codes | Account takeover |
| Audit chain (`audit.audit_logs`) | Evidence integrity |
| Ledger and invoices | Money (see `threat-model-payments-zatca.md`) |
| Vault references and field-encryption keys | Secret custody (D-12 open) |
| Admin-realm capability (impersonation, org suspension, flags) | Platform-wide impact |

## 2. Trust boundaries

1. Internet to consoles/API. Browsers reach the API only through the consoles' same-origin `/v1` rewrite (`apps/web/next.config.mjs`), so no CORS is enabled.
2. API process to PostgreSQL. Runtime roles `nuzm_app` / `nuzm_worker` are least-privilege and NOLOGIN in migrations (`packages/db/migrations/platform/0001__platform__roles_and_schema.sql`); org context is a transaction-local GUC set by `Db.withOrg` (`packages/platform/src/db.ts`).
3. Web realm to admin realm: separate cookies, separate session realm, admin routes declare `@RealmOnly('admin')` plus a platform permission (`apps/api/src/modules/access/access.guard.ts`, `identity/session.guard.ts`).
4. API to external parties: IdP (OIDC discovery/JWKS, `identity/internal/oidc.ts`), PSP/registrar/cloud/email webhooks (public, signature-authenticated), provider adapters.
5. Producers with a service key (`/v1/internal/metering/events`, `metering/internal-metering.controller.ts`).

## 3. Actors

Anonymous internet user; authenticated customer (viewer to owner, `tenancy.role_permissions`); customer of another org (cross-tenant attacker); API-key holder; platform staff (support, finance, compliance, security, platform_admin); compromised staff account; malicious or compromised IdP; malicious webhook sender; insider with DB access; supply-chain attacker (npm).

## 4. Threats and mitigations (STRIDE)

| ID | STRIDE | Threat | Existing mitigation (verified to exist) | Status | Residual risk | Proposed test |
|---|---|---|---|---|---|---|
| CP-01 | E/I | Cross-tenant read or write by guessing ids | RLS enabled and forced on every `org_id` table, checked by `packages/db/src/checks.ts`; policies in `migrations/tenancy/0004`, `migrations/platform/0002`; existence-hiding 404 in `AccessGuard`; generated suite `apps/api/src/modules/tenancy/cross-tenant.int.spec.ts`; RLS tests `packages/db/src/tenancy-rls.int.spec.ts`, `platform-rls.int.spec.ts` | PASS | Tenant-less tables and `withoutScope`/`withAuthScope` paths bypass org RLS by design; each is a review item. Fixture coverage depends on seeded ids | Full-spec sweep with 2xx-must-be-explained rule (`tenant-isolation-sweep.md`) |
| CP-02 | E | Org context taken from request input | Org comes from a verified membership or API key (`AccessGuard`); `X-Nuzm-Org` only selects among the caller's memberships; path `orgId` mismatch for API keys = 404 | PASS (`tenancy.int.spec.ts:116`) | Low | Fuzz `X-Nuzm-Org` vs `{orgId}` mismatch on every org route |
| CP-03 | S | Session theft or fixation | Opaque tokens, only SHA-256 stored (`identity/internal/session.service.ts`); cookie `httpOnly`, `sameSite=lax`, `secure` in production (`credentials.controller.ts`, `config.ts`); fixation defence and idle/absolute timeouts tested (`identity.int.spec.ts:166-230`) | PASS | `Secure` is production-only and unverified on a deployed host; no `__Host-` prefix | TLS/cookie check on staging (BLOCKED) |
| CP-04 | T | CSRF on cookie-authenticated mutations | Double-submit CSRF token checked for unsafe methods (`session.guard.ts`); logout test needs the token (`identity.int.spec.ts:200`) | PASS | Cookie-auth GETs that cause effects would bypass: none known, not enumerated | Sweep: every non-GET with session cookie and no CSRF header must be 403 |
| CP-05 | S | Credential stuffing / brute force | Per-IP sliding-window limiter and per-account lockout (`common/rate-limit.ts`, `credentials.service.ts`); tests `credentials.int.spec.ts:163,199`, `mfa.int.spec.ts:97` | NOT VERIFIED | Limiter is in-memory (single instance only, noted in its header) and keyed by `req.ip`; no `trustProxy` found, so behind the console rewrite all users may share one key | Load test through the console origin with distinct `X-Forwarded-For` values |
| CP-06 | S | Account enumeration | Wrong password, unknown email, platform user answer identically; reset always 202 (`credentials.int.spec.ts:134,218`); dummy hash keeps timing equal (`password.ts`) | PASS | Registration returns 409 on a duplicate email by design | Timing test on login |
| CP-07 | E | Admin realm abuse by a staff account | Admin routes refuse API keys and web-realm sessions; MFA mandatory and step-up (`session.guard.ts`, `mfa.int.spec.ts:222`); per-role permissions (`admin.int.spec.ts:100`); staff cannot hold a password (`migrations/identity/1700`, `credentials.int.spec.ts:151`) | PASS | Production IdP and MFA policy are undecided (ADR-008 partially decided, D-04) | Pen test of admin console (vendor) |
| CP-08 | E/R | Support impersonation misuse | Reason and ttl 1-30 min, approval ref unless platform_admin, audited in platform and target-org chains before the session exists, owner notice, credential/MFA/API-key changes refused while impersonating, DB CHECK caps at 30 min (`admin/internal/impersonation.service.ts`, `admin.int.spec.ts:286-466`) | PASS | Two-person rule is not enforced by code for platform_admin | Add test: impersonation of org owner is visible in the org audit feed |
| CP-09 | R/T | Audit tampering or silent gaps | Append-only triggers, in-DB hash chain, `audit.verify_chain` (`migrations/audit/0007`); fail-closed, atomic with the mutation (`audit-atomic.int.spec.ts`, `audit.int.spec.ts:94`); secret-shaped keys scrubbed (`audit/internal/db-audit.sink.ts`, `audit.int.spec.ts:156`); table-owner/superuser can still bypass triggers | PASS | A DB superuser or migrator can rewrite history; daily verification job and signed export are S55 work (not seen) | Tamper test run as migrator; verification job (AC-M12-05) |
| CP-10 | T | Replay/double-submit of side-effecting POSTs | `Idempotency-Key` interceptor, key scoped per org, request hash (`common/idempotency.ts`, `idempotency.int.spec.ts:70-102`) | PASS | Endpoints not marked `@Idempotent()` are outside this guard | Sweep: list POSTs without the decorator and justify |
| CP-11 | I | Secrets in code, logs, audit | `pnpm scan:secrets` (0 hits on 2026-11-18, see `internal-scans.md`); vault references only; dev stores refuse production (`common/secrets.ts`); field encryption AES-256-GCM bound to column+row, fails closed (`common/field-crypto.ts`, `field-crypto.spec.ts`) | NOT VERIFIED for production | Real vault/KMS is `BLOCKED (D-12)`; scanner is minimal (regex rules), not a dedicated tool | Run a dedicated secret scanner over full git history (tool selection open) |
| CP-12 | T/I | SQL injection | Parameterised `pg` queries; the few template interpolations are constant fragments or allow-listed column names (`cloud/internal/resource-store.ts:56`, `tenancy/internal/workspace.service.ts:451`) | PASS (by inspection) | Hand-written SQL everywhere; no automated SAST yet | SAST rule for template-literal SQL; DAST |
| CP-13 | T | Mass assignment / unvalidated input | Controllers read named fields; no runtime schema library (`apps/api/package.json` has none); OpenAPI is checked for route drift, not enforced on requests | NOT VERIFIED | Hand-written validation is inconsistent by nature | Property-based fuzz of every POST/PATCH body from the OpenAPI schemas |
| CP-14 | D | Resource exhaustion (large bodies, slow auth hashing) | scrypt cost bounded on verify (`password.ts`, N 2^10..2^20); per-IP limits on auth; no explicit body size limit found | NOT VERIFIED | `bodyLimit` left at Fastify default; DoS is out of pen-test scope | Request-size and concurrency test on staging |
| CP-15 | S | Webhook forgery | Public routes verify signature over raw body plus replay window (`payments/webhooks.controller.ts`); same pattern for cloud/registrar/email routes | NOT VERIFIED (only the mock PSP verifier exists; real provider schemes unseen) | Per-provider verification must be re-tested with real test keys (HG-03-02, HG-05-xx) | Duplicate / forged / stale webhook x50 drill (AC-M12-07) |
| CP-16 | E | Supply-chain compromise | Lockfile + `pnpm install --frozen-lockfile`; `pnpm audit --prod --audit-level=high` in CI (CI never run: D-01, no remote) | NOT VERIFIED | One moderate advisory open in prod deps (see `internal-scans.md`); no SBOM; no signed images (no images exist) | Generate SBOM; wire CI once a remote exists |
| CP-17 | I | XSS in consoles | React escaping by default; CSP with `frame-ancestors 'none'`, `object-src 'none'`, HSTS, nosniff in both consoles; no `dangerouslySetInnerHTML` outside a test file | NOT VERIFIED | `script-src 'unsafe-inline'` weakens CSP (nonce migration pending); not browser-tested for bypasses | DAST on staging; CSP nonce work |
| CP-18 | T/I | Untrusted HTML rendered to PDF by headless Chrome (`invoicing/internal/pdf.renderer.ts`) | Every dynamic value HTML-escaped (`invoice-render.ts`, test `invoice-render.spec.ts:97`); `execFile` with argv, throwaway profile, timeout, no network use claimed | NOT VERIFIED | Renderer runs inside the API host unsandboxed in dev; the file itself says production needs a sandboxed sidecar | Inject `<img src=file://…>` / SSRF payloads through every printed field |
| CP-19 | E | SSRF via fetched URLs (OIDC discovery now; SSO metadata URL later) | Discovery host is operator configuration, timeouts 5 s (`oidc.ts`) | NOT VERIFIED | Tenant-supplied metadata URLs (S55) need an egress policy; see SSO model | SSRF corpus against any tenant-supplied URL |
| CP-20 | R | Unaudited mutation | Audit in the same transaction for audited services; `platform-scope.spec.ts` restricts who may use platform scope | NOT VERIFIED (coverage per route) | No automated check that every mutating route emits an audit event | Sweep: every mutating op in the spec must produce an audit row (extend sweep) |

## 5. Residual risk summary

- Highest: unverified deployed posture (TLS, headers, cookie `Secure`, proxy/IP handling) because no environment exists; production secret custody (D-12); in-process rate limiting.
- Medium: hand-rolled validation without runtime schema enforcement; PDF rendering and any future tenant-supplied URL fetches; CSP `unsafe-inline`.
- Accepted-by-design, to be confirmed by the owner: staff impersonation exists and is audited; break-glass role is NOLOGIN and not exercised (`docs/runbooks/break-glass-draft.md` is a draft, BLOCKED on D-12 and legal review).

## 6. Proposed tests (add to the tracker if they find anything)

1. Tenant sweep (`tenant-isolation-sweep.md`).
2. Method/content-type fuzz on all 284 operations in `spec/openapi/openapi.yaml`.
3. CSRF matrix: every unsafe operation without the CSRF header.
4. Rate-limit behaviour through the console rewrite (CP-05).
5. Audit coverage: every mutating operation creates an audit row (CP-20).
