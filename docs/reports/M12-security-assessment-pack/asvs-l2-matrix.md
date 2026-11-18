# OWASP ASVS 4.0.3 Level 2: internal self-assessment matrix

> INTERNAL self-assessment, 2026-11-18. NOT independent (HG-12-01 / D-28 BLOCKED). Self-assessed matrices are known to be optimistic; this one is deliberately conservative.

Scope: the repository at branch `claude/m12-hardening-4cc95e` (M01-M08 code, M06/M08 against mocks). M09-M11 are in flight and S55 enterprise code is not present; those surfaces are not assessed here (see the threat models). No deployed environment exists, so anything about TLS, server configuration, backups and monitoring is `BLOCKED`.

## How to read

| Status | Rule used in this matrix |
|---|---|
| PASS | The control is implemented in a file the author read **and** a named automated test or an inspectable file backs it. The test suite was **not re-run** for this document. |
| NOT VERIFIED | Implemented or plausible, but no evidence was seen, evidence is mock-only, or a deviation exists. The reason is stated. |
| BLOCKED | Needs a human decision, an external party or an environment that does not exist yet. The gate is named. |
| N/A | Not applicable; the reason is stated. |

Requirements are grouped by ASVS section where listing every item would add nothing; the ASVS 4.0.3 ids in the first column are the ones the row covers. The text is a paraphrase, not the standard's wording. Path shorthand: `[api]` = `apps/api/src`, `[mod]` = `apps/api/src/modules`, `[db]` = `packages/db`, `[plat]` = `packages/platform/src`.

Deviations worth reading first: 2.1.7 (no breached-password check), 3.4.4 (no `__Host-` cookie prefix), 5.1.3/13.2.2 (no runtime schema validation), 6.3.2 (UUIDv7 ids), 8.3.1 (backup token in query string), 14.4.3 (CSP keeps `unsafe-inline` scripts), 14.5.4 (proxy/IP trust unconfigured).

## V1 Architecture, design and threat modelling

| ASVS ref | Requirement (short) | Status | Evidence or reason |
|---|---|---|---|
| 1.1.1 | Secure SDLC used | NOT VERIFIED | CLAUDE.md §3-§7 define a process; no external attestation, CI never run (D-01) |
| 1.1.2 | Threat modelling for every design change | NOT VERIFIED | This pack is the first set of threat models and is internal and partly provisional |
| 1.1.3 | Security constraints in user stories | PASS | Each milestone prompt has a "Security, compliance & tenant isolation" section, e.g. `docs/milestones/M12_enterprise_hardening_launch.md` §9 |
| 1.1.4 | Trust boundaries and data flows documented | PASS | `docs/02-system-architecture.md` §3, §10; threat models in this pack |
| 1.1.5 | High-level architecture documented | PASS | `docs/02-system-architecture.md`, `docs/adr/` (all ADRs still `Proposed`) |
| 1.1.6 | Centralised, vetted security controls | PASS | Single global guard `[mod]/access/access.guard.ts`; `[api]/common/*` |
| 1.1.7 | Secure coding checklist for developers | NOT VERIFIED | CLAUDE.md §4/§7 rules exist; no checklist artefact reviewed |
| 1.2.1 | Unique low-privilege OS accounts per component | BLOCKED (no deployment; D-15) | No Dockerfile/IaC in repo |
| 1.2.2 | Inter-component communication authenticated | NOT VERIFIED | DB uses per-role credentials (`[db]/migrations/platform/0001__platform__roles_and_schema.sql`); transport security undefined until deployed |
| 1.2.3 | One vetted authentication mechanism | PASS | `[mod]/identity/session.guard.ts` + `[mod]/access/access.guard.ts` |
| 1.2.4 | All authentication paths and identity APIs equally strong | NOT VERIFIED | OIDC+MFA for staff, password for customers, API keys for machines; no side-by-side review |
| 1.4.1 | Access checks at trusted enforcement points | PASS | `AccessGuard` global; deny by default (`[mod]/tenancy/tenancy.int.spec.ts:275`) |
| 1.4.4 | Single well-vetted access-control mechanism | PASS | `permissionCovers` in `[mod]/identity/internal/api-key.service.ts`, `[mod]/access/policy.service.ts` |
| 1.4.5 | Attribute/feature-based access control | PASS | Permission strings `org:*`, `admin:*`; per-route `@RequirePermission` |
| 1.5.1 | Input and output requirements defined | PASS | `spec/openapi/openapi.yaml`, `docs/04` conventions |
| 1.5.2 | Untrusted serialised data not deserialised unsafely | PASS | JSON only; no `eval`/`new Function` found in `apps` or `packages` (grep) |
| 1.5.3 | Input validation enforced server-side | NOT VERIFIED | Hand-written per-service validation; no schema library in `apps/api/package.json` |
| 1.5.4 | Output encoding near the interpreter | NOT VERIFIED | React escaping and HTML escape helper `[mod]/invoicing/internal/invoice-render.ts`; no systematic review |
| 1.6.1 | Explicit key-management policy | BLOCKED (D-12 / ADR-016) | Vault/KMS undecided; `docs/runbooks/field-encryption.md` covers field keys only |
| 1.6.2 | Crypto consumers protect key material | PASS | Vault references only (`[api]/common/secrets.ts`); field keys referenced by id (`[api]/common/field-crypto.ts`) |
| 1.6.3 | All keys and passwords replaceable | PASS | Key ids and rotation test `[api]/common/field-crypto.spec.ts:53`; API-key rotation `[mod]/identity/api-key.int.spec.ts:101` |
| 1.6.4 | Client-side secrets not trusted | PASS | Server-side sessions, hashes only stored (`[mod]/identity/identity.int.spec.ts:73`) |
| 1.7.1 | Common log format | NOT VERIFIED | Nest `Logger` plus OpenTelemetry; no format spec reviewed |
| 1.7.2 | Logs sent to a central system | BLOCKED (S57, no log infrastructure) | OTLP exporter exists only when an endpoint is set (`[api]/app.setup.ts`) |
| 1.8.1 | Sensitive data identified and classified | PASS | `[db]/src/classification.ts` (`pnpm compliance:classification-coverage`), `[db]/src/classification.spec.ts` |
| 1.8.2 | Protections for classified data at rest and in transit | NOT VERIFIED | Field encryption exists; disk/transport protection undefined (see V6, V9) |
| 1.9.1 | Communications encrypted between components | BLOCKED (no deployment) | - |
| 1.9.2 | Components use verified TLS | BLOCKED (no deployment) | - |
| 1.10.1 | Source control with integrity | NOT VERIFIED | Local git only (D-01); no commit signing evidence |
| 1.11.1 | Business logic flows understood and documented | PASS | `docs/11-payments-billing-zatca-track.md`, milestone prompts |
| 1.11.2 | High-value flows are sequence- and race-safe | PASS | Idempotency (`[api]/common/idempotency.int.spec.ts:89`), ledger (`[mod]/billing/ledger.int.spec.ts:336`) |
| 1.11.3 | High-value flows resistant to tampering/replay | PASS | `[mod]/payments/payments.int.spec.ts:606`, `[mod]/billing/ledger.int.spec.ts:106` |
| 1.12.1 | Uploads stored outside web root / isolated | N/A | No upload endpoint in `apps/api` (no multipart dependency); tenant site content is the hosting product (see V12) |
| 1.12.2 | Uploaded content served safely | N/A | As above |
| 1.14.1 | Segregation of components by security level | NOT VERIFIED | Separate DB roles and admin realm exist; no network segregation to review |
| 1.14.2 | Signatures/trusted sources for binaries and dependencies | NOT VERIFIED | Lockfile only (`pnpm-lock.yaml`); no signature verification step |
| 1.14.3 | Build pipeline warns of outdated/insecure components | NOT VERIFIED | `pnpm audit --prod --audit-level=high` in `.github/workflows/ci.yml`; CI never run (D-01). Local run: `internal-scans.md` |
| 1.14.4 | Build pipeline verifies secure deployment | BLOCKED (no deployment pipeline) | `infra/` is skeleton only |
| 1.14.5 | Sandboxed deployment of untrusted code | BLOCKED (M10 in flight; D-21) | `threat-model-sandbox.md` |
| 1.14.6 | Deprecated technologies avoided | NOT VERIFIED | No review done |

## V2 Authentication

| ASVS ref | Requirement (short) | Status | Evidence or reason |
|---|---|---|---|
| 2.1.1 | Passwords at least 12 characters | PASS | `PASSWORD_MIN=12` `[mod]/identity/internal/password.ts`; `password.spec.ts:43`; `credentials.int.spec.ts:87` |
| 2.1.2 | 128+ characters permitted | PASS | `PASSWORD_MAX=128`, same tests |
| 2.1.3 | No truncation; whitespace handled | PASS | NFKC normalisation only (`password.ts`, `password.spec.ts:23`) |
| 2.1.4 | Any printable Unicode allowed | PASS | `passwordProblem` counts characters, no charset restriction |
| 2.1.5 | Users can change passwords | PASS | `[mod]/identity/credentials.int.spec.ts:328` |
| 2.1.6 | Change requires current and new password | PASS | Same test |
| 2.1.7 | Check against breached passwords | NOT VERIFIED | Only a 15-entry deny list (`password.ts` `COMMON`); no breach corpus. Deviation |
| 2.1.8 | Strength meter provided | NOT VERIFIED | UI not reviewed |
| 2.1.9 | No composition rules | PASS | `passwordProblem` has only length/common/same-as-email rules |
| 2.1.10 | No forced periodic rotation | PASS | No rotation logic in `credentials.service.ts` |
| 2.1.11 | Paste and password managers allowed | NOT VERIFIED | Console forms not reviewed |
| 2.1.12 | Password can be shown temporarily | NOT VERIFIED | Console forms not reviewed |
| 2.2.1 | Anti-automation against credential stuffing | NOT VERIFIED | Lockout and per-IP limiter tested (`credentials.int.spec.ts:163,199`) but limiter is in-memory and keyed by `req.ip` with no `trustProxy` found (`[api]/common/rate-limit.ts`) |
| 2.2.2 | Weak authenticators (SMS/email) not sole 2FA | N/A | No SMS/email second factor exists; TOTP and recovery codes only |
| 2.2.3 | Users notified of credential changes | NOT VERIFIED | No notification on password change/reset seen in `credentials.service.ts` |
| 2.2.4 | Impersonation resistance (e.g. phishing-resistant) | NOT VERIFIED | No FIDO/WebAuthn; MFA is TOTP |
| 2.2.5 | Credential service authenticated to CSP/verifier | N/A | No separate credential service provider |
| 2.2.6 | Replay resistance | PASS | TOTP replay rejected `[mod]/identity/mfa.int.spec.ts:86`; single-use tokens `credentials.int.spec.ts:218` |
| 2.2.7 | Intent to authenticate | N/A | No out-of-band push authenticator |
| 2.3.1 | System-generated initial credentials single-use | N/A | No generated initial passwords; invitations are token-based and single-use (`[mod]/tenancy/tenancy.int.spec.ts:433`) |
| 2.3.2 | Enrolment/use of subscriber authenticators supported | PASS | TOTP enrolment `mfa.int.spec.ts:52` |
| 2.3.3 | Renewal instructions before expiry | N/A | No expiring authenticators |
| 2.4.1 | Passwords stored with approved KDF | PASS | scrypt, params in hash string (`password.ts`; ADR-008) |
| 2.4.2 | Salt at least 32 bits, random | PASS | 16-byte random salt `password.ts` |
| 2.4.3 | PBKDF2 parameters | N/A | scrypt used |
| 2.4.4 | bcrypt parameters | N/A | scrypt used |
| 2.4.5 | Additional KDF iteration with secret salt | NOT VERIFIED | No pepper applied to passwords (a pepper exists only for recovery codes, `mfa.service.ts:16`) |
| 2.5.1 | Recovery secret not sent in clear / not guessable | PASS | Random token, hash stored, emailed once (`credentials.int.spec.ts:218`; `[db]/migrations/identity/1700__identity__credentials.sql`) |
| 2.5.2 | No password hints or knowledge-based recovery | PASS | None implemented |
| 2.5.3 | Recovery does not reveal current password | PASS | Reset only sets a new password |
| 2.5.4 | No shared or default accounts | NOT VERIFIED | Dev IdP and dev logins exist for local use only (`pnpm db:dev-logins`); production unreviewed |
| 2.5.5 | Notify user when factor changed or replaced | NOT VERIFIED | Not seen |
| 2.5.6 | Forgotten-password flow uses secure mechanism | PASS | Single-use, expiring, cancels earlier tokens, 202 always (`credentials.int.spec.ts:218-290`) |
| 2.5.7 | Lost MFA recovery needs equivalent assurance | PASS | Recovery codes single-use, hashed, regenerated invalidates old (`mfa.int.spec.ts:120`) |
| 2.6.1 | Lookup secrets single-use | PASS | `mfa.int.spec.ts:120` |
| 2.6.2 | Lookup secrets sufficiently random | PASS | 10 random bytes per code (`[mod]/identity/internal/mfa.service.ts:23`) |
| 2.6.3 | Resistant to offline guessing | PASS | HMAC with server pepper, stored only as hashes |
| 2.7.1-2.7.6 | Out-of-band authenticator (SMS/push) rules | N/A | No out-of-band authenticators |
| 2.8.1 | Time-based OTP lifetime limited | PASS | 30 s period, window 1 (`mfa.service.ts:53,146`) |
| 2.8.2 | OTP verified with approved crypto | PASS | `otpauth` library, secret in secret store (`mfa.int.spec.ts:52`) |
| 2.8.3 | Approved cryptographic algorithms | PASS | HMAC-based TOTP |
| 2.8.4 | OTP usable once in its period | PASS | `mfa.int.spec.ts:86` |
| 2.8.5 | Failed OTP attempts logged | PASS | `mfa.int.spec.ts:255` (audit of MFA outcomes) |
| 2.8.6 | Physical OTP device revocation | N/A | None |
| 2.9.1-2.9.3 | Cryptographic authenticators (FIDO) | N/A | Not implemented |
| 2.10.1 | Intra-service secrets not unchanging credentials | NOT VERIFIED | Service keys for metering producers (`[mod]/metering/internal/producer-auth.ts`) not reviewed for rotation |
| 2.10.2 | Service accounts not default | NOT VERIFIED | Not reviewed |
| 2.10.3 | Service credentials protected at rest | BLOCKED (D-12) | Only dev stores exist (`[api]/common/secrets.ts`) |
| 2.10.4 | No secrets in source or build artefacts | PASS | `pnpm scan:secrets`: 0 hits on 2026-11-18 (see `internal-scans.md`); minimal scanner |

## V3 Session management

| ASVS ref | Requirement (short) | Status | Evidence or reason |
|---|---|---|---|
| 3.1.1 | Session tokens never in URLs | PASS | Cookie-only sessions (`[mod]/identity/session.guard.ts`) |
| 3.2.1 | New session on authentication | PASS | `identity.int.spec.ts:218` |
| 3.2.2 | At least 64 bits of entropy | PASS | 32 random bytes (`session.service.ts`) |
| 3.2.3 | Token stored in browser securely (HttpOnly cookie) | PASS | `credentials.controller.ts` `cookieOpts` |
| 3.2.4 | Generated with approved crypto | PASS | `crypto.randomBytes` |
| 3.3.1 | Logout invalidates session | PASS | `identity.int.spec.ts:200` |
| 3.3.2 | Re-authentication after inactivity/time | PASS | Idle 30 min, absolute 12 h defaults (`config.ts`); `identity.int.spec.ts:167,184` |
| 3.3.3 | Option to end other sessions on password change | PASS | `credentials.int.spec.ts:328` |
| 3.3.4 | Users can view and end active sessions | PASS | `identity.int.spec.ts:230` |
| 3.4.1 | `Secure` cookie attribute | NOT VERIFIED | Set only when `NODE_ENV=production` (`config.ts`); not observable without a deployment |
| 3.4.2 | `HttpOnly` | PASS | Session cookie `httpOnly: true` (CSRF cookie is intentionally readable) |
| 3.4.3 | `SameSite` | PASS | `lax` |
| 3.4.4 | `__Host-` prefix | NOT VERIFIED | Cookie names `nuzm_session`, `nuzm_admin_session` have no prefix. Deviation |
| 3.4.5 | Cookie path attribute | PASS | `path: '/'` |
| 3.5.1 | Users can revoke tokens | PASS | API keys revoke and rotate (`api-key.int.spec.ts:101`) |
| 3.5.2 | Session tokens preferred over static API keys | NOT VERIFIED | API keys exist by design for machine access; scoped, hashed, expiring, IP allow-list |
| 3.5.3 | Stateless tokens protected | PASS | Only the login-state token is stateless: sealed AES-256-GCM, 10 min (`[mod]/identity/internal/seal.ts`) |
| 3.7.1 | Re-authentication for sensitive transactions | PASS | `@StepUp()`; `mfa.int.spec.ts:178,189` |

## V4 Access control

| ASVS ref | Requirement (short) | Status | Evidence or reason |
|---|---|---|---|
| 4.1.1 | Server-side enforcement | PASS | `access.guard.ts` |
| 4.1.2 | User/permission attributes not user-manipulable | PASS | Org from membership, not the request body (`access.guard.ts`); `tenancy.int.spec.ts:116` |
| 4.1.3 | Least privilege | PASS | `[db]/src/tenancy-rls.int.spec.ts:230-258` (role matrix) |
| 4.1.5 | Access control fails securely | PASS | Deny by default `identity.int.spec.ts:266`, `tenancy.int.spec.ts:275` |
| 4.2.1 | Object-level access (IDOR) | PASS | RLS + `[mod]/tenancy/cross-tenant.int.spec.ts`; full sweep: `tenant-isolation-sweep.md` |
| 4.2.2 | Strong anti-CSRF | PASS | Double-submit token, `session.guard.ts`; `identity.int.spec.ts:200` |
| 4.3.1 | Admin interfaces use MFA | PASS | `mfa.int.spec.ts:222`; `[mod]/admin/admin.int.spec.ts:88` |
| 4.3.2 | Directory browsing/metadata leakage prevented | NOT VERIFIED | Next.js consoles; no review of static assets |
| 4.3.3 | Additional authorisation for high-value actions | PASS | Step-up and second-approver rules (`[mod]/billing/admin-adjustments.controller.ts`; `[mod]/compliance/admin-*.controller.ts` described as different-person approval in `spec/openapi/openapi.yaml`) |

## V5 Validation, sanitisation and encoding

| ASVS ref | Requirement (short) | Status | Evidence or reason |
|---|---|---|---|
| 5.1.1 | HTTP parameter pollution defences | NOT VERIFIED | Not tested |
| 5.1.2 | Mass-assignment defences | NOT VERIFIED | Controllers read named fields (e.g. `credentials.controller.ts`) but not systematically reviewed |
| 5.1.3 | Positive validation of all input | NOT VERIFIED | Hand-written; no schema library. Deviation |
| 5.1.4 | Structured data strongly typed and validated | NOT VERIFIED | As above |
| 5.1.5 | URL redirects restricted to allow-list | PASS | `[mod]/identity/internal/return-to.ts`; `identity.int.spec.ts:132-160` |
| 5.2.1 | HTML input sanitised | NOT VERIFIED | No rich-text input located; not reviewed |
| 5.2.2 | Unstructured data sanitised | NOT VERIFIED | - |
| 5.2.3 | Mail-system injection prevented | NOT VERIFIED | `[mod]/email` not reviewed for header/command injection |
| 5.2.4 | No `eval()`/dynamic code execution | PASS | None found (grep over `apps`, `packages`) |
| 5.2.5 | Template injection prevented | NOT VERIFIED | Invoice HTML template escapes values (`invoice-render.spec.ts:97`); others not reviewed |
| 5.2.6 | SSRF protection | NOT VERIFIED | Outbound fetches: OIDC discovery (configured issuer), adapters; no allow-list control reviewed |
| 5.2.7 | SVG/scriptable content sanitised | N/A | No user-supplied SVG handling found |
| 5.2.8 | Scripting content sandboxed | N/A | None on the platform side (sandbox is M10, in flight) |
| 5.3.1 | Output encoding for the interpreter in use | NOT VERIFIED | React default escaping; no review |
| 5.3.2 | Unicode/character encoding preserved | NOT VERIFIED | - |
| 5.3.3 | Context-aware escaping against reflected/stored/DOM XSS | NOT VERIFIED | No `dangerouslySetInnerHTML` outside `apps/admin/components/FinancePanels.spec.tsx`; no DAST yet |
| 5.3.4 | Parameterised queries | PASS | `pg` `$n` binding throughout; template interpolation only for fixed SQL fragments or allow-listed columns (`[mod]/cloud/internal/resource-store.ts:56`, `[mod]/tenancy/internal/workspace.service.ts:451`) |
| 5.3.5 | ORM/other injection | N/A | No ORM |
| 5.3.6 | JavaScript/JSON injection | NOT VERIFIED | - |
| 5.3.7 | LDAP injection | N/A | No LDAP |
| 5.3.8 | OS command injection | NOT VERIFIED | `execFile` argv-only in `[mod]/invoicing/internal/pdf.renderer.ts`; hosting agent allow-list proven on a mock only (`[mod]/hosting/internal/agent/agent.spec.ts:156`) |
| 5.3.9 | Local/remote file inclusion | NOT VERIFIED | - |
| 5.3.10 | XPath/XML injection | N/A | No XML parsing in code at this commit (`@xmldom/xmldom` is declared but not imported); becomes relevant with SAML (S55) |
| 5.4.1-5.4.3 | Memory-safety/unmanaged code | N/A | TypeScript; native module is the argon2 binding only |
| 5.5.1 | Serialised objects integrity-protected | N/A | No native object serialisation |
| 5.5.2 | XML parsers prevent XXE | N/A | No XML parser in use yet; S55 requirement SS-10 |
| 5.5.3 | Untrusted deserialisation avoided | PASS | JSON only |
| 5.5.4 | `JSON.parse` not `eval` | PASS | No `eval` anywhere (grep) |

## V6 Stored cryptography

| ASVS ref | Requirement (short) | Status | Evidence or reason |
|---|---|---|---|
| 6.1.1 | Regulated personal data encrypted at rest | NOT VERIFIED | Field encryption for classified fields (`[api]/common/field-crypto.ts`, M04 S13d); database/volume encryption undecided |
| 6.1.2 | Regulated health data | N/A | Not processed |
| 6.1.3 | Regulated financial data encrypted at rest | NOT VERIFIED | Tax profile sealed (`[db]/migrations/invoicing/0503__invoicing__tax_profile_sealed.sql`); other tables rely on infrastructure |
| 6.2.1 | Crypto modules fail securely | PASS | `[api]/common/field-crypto.spec.ts:78` (fail closed) |
| 6.2.2 | Industry-proven algorithms | PASS | AES-256-GCM, HKDF-SHA256, Ed25519, SHA-256, scrypt, argon2id |
| 6.2.3 | IV/cipher configuration secure | PASS | Fresh IV each time `field-crypto.spec.ts:14` |
| 6.2.4 | Algorithm agility | PASS | Versioned sealed format with key id (`enc:v1:<keyId>:...`) |
| 6.2.5 | No insecure block modes/padding | PASS | GCM only |
| 6.2.6 | Nonces/IVs not reused | PASS | Random 12-byte IV per encryption |
| 6.2.7 | Encrypted data authenticated | PASS | GCM tag; AAD binds column and row (`field-crypto.spec.ts:31`) |
| 6.2.8 | Constant-time comparisons | PASS | `timingSafeEqual` in `password.ts`, `session.service.ts` |
| 6.3.1 | Random values from approved CSPRNG | PASS | `crypto.randomBytes` for tokens, salts, keys |
| 6.3.2 | GUIDs v4 where unguessability matters | NOT VERIFIED | Ids are UUIDv7 by project rule (CLAUDE.md §8); security tokens use `randomBytes`. Needs confirmation that no authorisation relies on id unguessability (existence hiding is enforced server-side, so low risk). Deviation |
| 6.3.3 | Random numbers resist exhaustion | PASS | OS entropy via Node |
| 6.4.1 | Secrets manager/HSM for keys | BLOCKED (D-12) | Dev stores only (`[api]/common/secrets.ts`); production refused |
| 6.4.2 | Key material not exposed to the app | BLOCKED (D-12) | Same |

## V7 Error handling and logging

| ASVS ref | Requirement (short) | Status | Evidence or reason |
|---|---|---|---|
| 7.1.1 | No credentials or payment details in logs | PASS | `[mod]/audit/audit.int.spec.ts:156`; `identity.int.spec.ts:382`; `mfa.int.spec.ts:255`; `[mod]/payments/internal/pan.ts` |
| 7.1.2 | No other sensitive data in logs | NOT VERIFIED | Audit scrubbing proven; application logs (Nest `Logger`) not scanned |
| 7.1.3 | Security-relevant events logged | PASS | Audit events for auth, MFA, admin, billing (`audit.int.spec.ts:69,143`) |
| 7.1.4 | Log events carry enough context | PASS | Actor, resource, trace id, hashed IP/UA (`audit.int.spec.ts:69`) |
| 7.2.1 | All authentication decisions logged | PASS | `identity.int.spec.ts:382` |
| 7.2.2 | Access-control failures logged | NOT VERIFIED | Not shown for 403/404 from `AccessGuard` |
| 7.3.1 | Log injection prevented | NOT VERIFIED | - |
| 7.3.3 | Logs protected from tampering | PASS | Append-only triggers + hash chain (`[plat]/audit.int.spec.ts:104-107`; `[db]/migrations/audit/0007__audit__core_tables.sql`) |
| 7.3.4 | Time source synchronised, UTC | NOT VERIFIED | `timestamptz`/UTC convention (CLAUDE.md §8); time sync is infrastructure |
| 7.4.1 | Generic error message with trace id | PASS | `[api]/common/problem.filter.ts` (500 detail withheld, trace id returned) |
| 7.4.2 | Exception handling used consistently | PASS | Global `ProblemFilter`; `[api]/common/errors.spec.ts` |
| 7.4.3 | Last-resort handler | PASS | `@Catch()` all |

## V8 Data protection

| ASVS ref | Requirement (short) | Status | Evidence or reason |
|---|---|---|---|
| 8.1.1 | Sensitive data not cached server-side unprotected | NOT VERIFIED | Role/key caches hold permissions only (30 s); not reviewed further |
| 8.1.2 | Client-side caching of sensitive data disabled | PASS | `cache-control: no-store` on every API response (`[api]/app.setup.ts`) |
| 8.1.3 | Sensitive data minimised in requests | NOT VERIFIED | - |
| 8.1.4 | Anomaly detection and alerting | BLOCKED (S57, no monitoring) | - |
| 8.1.5 | Backups taken and tested | BLOCKED (S57 DR drill; HG-05-xx) | `docs/runbooks/db-restore.md` exists, no measured restore |
| 8.1.6 | Backups stored securely | BLOCKED (D-07, D-15) | No backup sink configured |
| 8.2.1 | Anti-caching headers | PASS | As 8.1.2 |
| 8.2.2 | No sensitive data in browser storage | NOT VERIFIED | Console code not reviewed for `localStorage` use |
| 8.2.3 | Authenticated data cleared on session end | NOT VERIFIED | - |
| 8.3.1 | Sensitive data in body/headers, not URL | NOT VERIFIED | Deviation: backup download token in query string (`[mod]/hosting/backup-downloads.controller.ts`); WebSocket ticket (M10) and email links carry tokens by design |
| 8.3.2 | Users can obtain and erase their data | PASS | DSR export/erase `[mod]/compliance/dsr.controller.ts`, `dsr.int.spec.ts` (module-level handlers for M07/M08 data still being added) |
| 8.3.3 | Consent for processing, clear language | NOT VERIFIED | `consents.int.spec.ts` covers the mechanism; wording is counsel-owned (HG-04-01) |
| 8.3.4 | Sensitive data identified and handled by rules | PASS | Classification coverage, residency hooks (`[db]/src/classification.ts`, `residency-hooks.ts`) |
| 8.3.5 | Access to sensitive data audited | NOT VERIFIED | Admin reads audited for the cross-org viewer (`admin.int.spec.ts:535`); other reads not enumerated |
| 8.3.6 | Sensitive data cleared from memory after use | NOT VERIFIED | - |
| 8.3.7 | Sensitive data encrypted with approved algorithms | PASS | `field-crypto.ts` (for fields that use it) |
| 8.3.8 | Retention rules for personal data | PASS | `[mod]/compliance/admin-retention.int.spec.ts`, legal hold `docs/runbooks/legal-hold.md` (periods are counsel decisions) |

## V9 Communications

| ASVS ref | Requirement (short) | Status | Evidence or reason |
|---|---|---|---|
| 9.1.1 | TLS for all client connectivity | BLOCKED (no deployment) | HSTS header set in `apps/web/next.config.mjs`, `apps/admin/next.config.mjs`; TLS not observable |
| 9.1.2 | Strong TLS configuration | BLOCKED (no deployment) | - |
| 9.1.3 | Only current TLS versions | BLOCKED (no deployment) | - |
| 9.2.1 | Trusted TLS for outbound connections | NOT VERIFIED | Node `fetch` default verification; no pinning/policy reviewed |
| 9.2.2 | Encrypted comms for all inbound/outbound (DB, queue, etc.) | BLOCKED (no deployment) | Local dev DB is loopback, trust auth (`.env.example`) |
| 9.2.3 | Encrypted comms to external services | NOT VERIFIED | Provider adapters mock-only |
| 9.2.4 | Certificate revocation checking | BLOCKED (no deployment) | - |
| 9.2.5 | TLS failures logged | NOT VERIFIED | - |

## V10 Malicious code

| ASVS ref | Requirement (short) | Status | Evidence or reason |
|---|---|---|---|
| 10.1.1 | Code analysis tool in the pipeline | NOT VERIFIED | `eslint` + `tsc` only; no SAST tool selected or run (`internal-scans.md`) |
| 10.2.1 | Source reviewed for unauthorised phone-home/data collection | NOT VERIFIED | No such review done |
| 10.2.2 | App requests only needed permissions | N/A | Web application |
| 10.2.3 | No backdoors/time bombs/Easter eggs | NOT VERIFIED | No review |
| 10.2.4 | No time bombs | NOT VERIFIED | - |
| 10.2.5 | No malicious code/backdoors | NOT VERIFIED | - |
| 10.2.6 | No Easter eggs/unintended functionality | NOT VERIFIED | - |
| 10.3.1 | Auto-update uses signed, integrity-checked updates | NOT VERIFIED | Only the node-agent design (unbuilt) |
| 10.3.2 | Integrity protection (signing) for deployed code | NOT VERIFIED | No release pipeline |
| 10.3.3 | Subdomain takeover protection | NOT VERIFIED | Domain/DNS features exist (`[mod]/domains`); dangling-record handling not reviewed |

## V11 Business logic

| ASVS ref | Requirement (short) | Status | Evidence or reason |
|---|---|---|---|
| 11.1.1 | Steps processed in order, none skipped | PASS | State machines: `[mod]/payments/payment-state.spec.ts`, `[mod]/invoicing/invoice-state.spec.ts`; DB-level machine check `payments.int.spec.ts:822` |
| 11.1.2 | Realistic human-speed limits | NOT VERIFIED | - |
| 11.1.3 | Limits on business actions | PASS | Quotas and spend control `[mod]/billing/quotas-spend.int.spec.ts`, `[mod]/commerce/commerce.int.spec.ts:222` |
| 11.1.4 | Anti-automation on high-value flows | NOT VERIFIED | Limiters exist on auth, domain search, DNS, usage; coverage not enumerated; single-instance |
| 11.1.5 | Business logic limits and validation | PASS | As 11.1.3 |
| 11.1.6 | TOCTOU/race resistance | PASS | `ledger.int.spec.ts:336`, `refunds-topups.int.spec.ts:338`, `idempotency.int.spec.ts:89` |
| 11.1.7 | Monitoring of unusual business-logic events | BLOCKED (S57) | - |
| 11.1.8 | Configurable alerting on automated attacks | BLOCKED (S57) | - |

## V12 Files and resources

| ASVS ref | Requirement (short) | Status | Evidence or reason |
|---|---|---|---|
| 12.1.1 | Large files cannot exhaust storage | N/A | No upload endpoint in `apps/api` |
| 12.1.2 | Zip-bomb protection | N/A | No archive upload; export/import arrive with M10 |
| 12.1.3 | Per-user file quota | N/A | As 12.1.1 |
| 12.2.1 | File type validated | N/A | As 12.1.1 |
| 12.3.1 | User filenames cannot cause traversal | NOT VERIFIED | Hosting agent schemas refuse path members (mock: `agent.spec.ts:186`); real node unverified |
| 12.3.2 | No local file inclusion | NOT VERIFIED | - |
| 12.3.3 | No remote file inclusion | NOT VERIFIED | - |
| 12.3.4 | Reflected file download prevented | PASS | `attachment`, `octet-stream`, `nosniff` (`[mod]/hosting/backup-downloads.controller.ts`, `[api]/app.setup.ts`) |
| 12.3.5 | Untrusted file metadata not executed | N/A | No upload processing |
| 12.4.1 | Untrusted files outside web root | N/A | Not an application upload feature |
| 12.4.2 | Uploads scanned for malware | NOT VERIFIED | Abuse handling is reactive (`[mod]/hosting/internal/abuse.service.ts`) |
| 12.5.1 | Only required file types served | NOT VERIFIED | - |
| 12.5.2 | Direct requests to uploaded files never executed | NOT VERIFIED | Hosting executes tenant code by design inside per-site isolation (`threat-model-shared-hosting.md`) |
| 12.6.1 | SSRF allow-list for external resource requests | NOT VERIFIED | See 5.2.6 |

## V13 API and web service

| ASVS ref | Requirement (short) | Status | Evidence or reason |
|---|---|---|---|
| 13.1.1 | Consistent encoding/parsing across components | NOT VERIFIED | JSON throughout; not tested |
| 13.1.3 | URLs expose no secrets (keys, session tokens) | NOT VERIFIED | Exception: backup download token (see 8.3.1) |
| 13.1.4 | Authorisation at URI and resource level | PASS | `AccessGuard` + RLS + `cross-tenant.int.spec.ts` |
| 13.1.5 | Unexpected content types rejected | NOT VERIFIED | Fastify defaults; no test seen |
| 13.2.1 | HTTP methods restricted per resource | NOT VERIFIED | `spec/openapi` defines them; `pnpm spec:drift` checks routes exist, not that others are refused |
| 13.2.2 | JSON schema validation on input | NOT VERIFIED | OpenAPI not enforced at runtime. Deviation |
| 13.2.3 | REST requests protected against CSRF | PASS | Double-submit CSRF for cookie-authenticated unsafe methods; API keys are header-bearer |
| 13.2.5 | Content-Type explicitly checked | NOT VERIFIED | - |
| 13.2.6 | Message headers cannot be abused for auth | PASS | `X-Nuzm-Org` only selects among verified memberships; `X-Nuzm-Acting-Org` refused (`tenancy.int.spec.ts:283`) |
| 13.3.1-13.3.2 | SOAP/XML web services | N/A | None |
| 13.4.1-13.4.2 | GraphQL | N/A | None |

## V14 Configuration

| ASVS ref | Requirement (short) | Status | Evidence or reason |
|---|---|---|---|
| 14.1.1 | Build and deployment automated and secure | NOT VERIFIED | `pnpm verify`, turbo; no deployment pipeline; CI not run (D-01) |
| 14.1.2 | Compiler/build flags enable protections | PASS | TypeScript `strict: true` (`tsconfig.base.json`) |
| 14.1.3 | Server configuration hardened | BLOCKED (no deployment) | - |
| 14.1.4 | Repeatable deployment, rollback | BLOCKED (no deployment) | `infra/docker/README.md` is a skeleton |
| 14.1.5 | Integrity verification of config changes | BLOCKED (no deployment) | - |
| 14.2.1 | Components current; dependency checker used | NOT VERIFIED | `pnpm audit --prod` run 2026-11-18: 0 high/critical, 1 moderate (GHSA-8988-4f7v-96qf, `@opentelemetry/core`); dev dependencies and CI not covered |
| 14.2.2 | Unneeded features/components removed | NOT VERIFIED | - |
| 14.2.3 | Subresource integrity for external assets | PASS | CSP allows only `'self'` for script/style/font/image; no CDN assets (`apps/web/next.config.mjs`) |
| 14.2.4 | Third-party components from trusted repositories | NOT VERIFIED | Public registry via lockfile |
| 14.2.5 | SBOM maintained | NOT VERIFIED | None generated |
| 14.2.6 | Third-party libraries sandboxed | N/A | Not applicable at this level |
| 14.3.1 | Error pages hide stack traces/versions | PASS | `problem.filter.ts`; `poweredByHeader: false` in both consoles |
| 14.3.2 | Debug modes off in production | NOT VERIFIED | Dev-only stores refuse production (`common/secrets.ts`); no production bootstrap exists (`apps/api/src/main.ts` is empty) |
| 14.3.3 | No server/framework version leakage | NOT VERIFIED | - |
| 14.4.1 | Content-Type with charset on every response | NOT VERIFIED | - |
| 14.4.2 | API responses carry `Content-Disposition: attachment` when needed | PASS | Backup download sets it |
| 14.4.3 | CSP to mitigate XSS | PASS | CSP present in both consoles; **caveat**: `script-src 'unsafe-inline'` (nonce migration pending, noted in `apps/web/next.config.mjs`). Deviation |
| 14.4.4 | `X-Content-Type-Options: nosniff` | PASS | API (`app.setup.ts`) and consoles |
| 14.4.5 | HSTS | PASS | Consoles set HSTS (1 year, includeSubDomains); API relies on the consoles' origin |
| 14.4.6 | Referrer policy | PASS | `no-referrer` |
| 14.4.7 | Anti-framing | PASS | `frame-ancestors 'none'`, `X-Frame-Options: DENY` |
| 14.5.1 | Only expected HTTP methods accepted | NOT VERIFIED | See 13.2.1 |
| 14.5.2 | `Origin` header not used for authentication | PASS | No use found; CSRF uses a token |
| 14.5.3 | Strict CORS | PASS | No CORS enabled; first-party rewrite (`apps/web/next.config.mjs`); grep found no CORS configuration |
| 14.5.4 | Trusted-proxy headers handled correctly | NOT VERIFIED | No `trustProxy` setting found; rate limiting and audit hash use `req.ip` |

## Counts

Counts are of table rows above (a row covering a range, such as 2.7.1-2.7.6, counts once).

| Chapter | PASS | NOT VERIFIED | BLOCKED | N/A | Rows |
|---|---|---|---|---|---|
| V1 | 17 | 14 | 7 | 2 | 40 |
| V2 | 26 | 12 | 1 | 10 | 49 |
| V3 | 15 | 3 | 0 | 0 | 18 |
| V4 | 8 | 1 | 0 | 0 | 9 |
| V5 | 5 | 15 | 0 | 8 | 28 |
| V6 | 10 | 3 | 2 | 1 | 16 |
| V7 | 8 | 4 | 0 | 0 | 12 |
| V8 | 6 | 8 | 3 | 0 | 17 |
| V9 | 0 | 3 | 5 | 0 | 8 |
| V10 | 0 | 9 | 0 | 1 | 10 |
| V11 | 4 | 2 | 2 | 0 | 8 |
| V12 | 1 | 7 | 0 | 6 | 14 |
| V13 | 3 | 6 | 0 | 2 | 11 |
| V14 | 11 | 10 | 3 | 1 | 25 |
| **Total** | **114** | **97** | **23** | **31** | **265** |

Applicable rows (excluding N/A): 234; PASS share of applicable rows: 114/234. FAIL: 0 declared (any defect found will be raised in the tracker, not hidden in this matrix). PASS means "control and test located", not "proven in a deployed environment"; the independent verification is HG-12-01 (BLOCKED).
