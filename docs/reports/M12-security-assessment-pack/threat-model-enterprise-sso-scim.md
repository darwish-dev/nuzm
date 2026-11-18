# Threat model: enterprise SSO (SAML 2.0, OIDC) and SCIM 2.0 (S55)

> INTERNAL self-assessment, 2026-11-18. NOT independent (HG-12-01 / D-28 BLOCKED). Real enterprise IdP verification is `BLOCKED (HG-12-02)`; local test IdPs only, results `NOT VERIFIED` against real IdPs.
>
> **This file lists REQUIREMENTS the code must meet. It is not a review of code.** The implementation under `apps/api/src/modules/enterprise` did not exist when this was written; another session is building it. A draft migration `packages/db/migrations/identity/1710__identity__sso_scim.sql` (tables `identity.sso_connections`, `sso_domain_proofs`, `sso_assertion_replays`, `scim_tokens`, `scim_identities`) was present but uncommitted and is not reviewed here. Status of every requirement: `NOT VERIFIED` until the code and its negative tests exist; the reviewer must then fill the "Evidence" column. Sources: `docs/milestones/M12_enterprise_hardening_launch.md` §4 (S55), §6, §9, §11; `docs/04` conventions table (SCIM base-path exception: `/scim/v2/*` is served outside `/v1`).

## 1. Scope and assets

SSO connection management (`/v1/organizations/{orgId}/sso-connections`), SAML ACS/metadata and OIDC enterprise callback endpoints, domain-proof verification (DNS TXT via M07), enforcement flag, JIT provisioning, SCIM server (`/scim/v2/*`, outside `/v1`), SCIM token issuance, access reviews and org security policy only where they touch SSO.

| Asset | Why it matters |
|---|---|
| Ability to mint a session for any user of an enterprise org | Full tenant takeover |
| IdP signing certificates and trust configuration per connection | Trust root; tampering = forged logins |
| SCIM bearer tokens | Create/disable users and group roles in an org |
| Verified-domain claims | Controls who may force SSO on whose email addresses |
| Replay cache | Prevents assertion reuse |
| Existing session and MFA controls (`identity/internal/session.service.ts`, `mfa.service.ts`) | SSO must not downgrade them |

## 2. Trust boundaries and actors

IdP (semi-trusted, per-org, supplied by the customer admin) to Nuzm ACS; browser as carrier of untrusted assertions; customer org admin (configures a connection; may be malicious or compromised); IdP admin (may be a different party from the org); SCIM client (IdP) holding a bearer token; other org's admin trying to claim a domain; platform staff.
Actors: forged-assertion attacker, replay attacker, attacker with a valid assertion for another SP, malicious org admin claiming someone else's domain, token thief, insider at the IdP, external attacker abusing an IdP-initiated flow.

## 3. Required mitigations

IDs are for tracking; "Required test" is the negative or positive test that must exist before the row can leave `NOT VERIFIED`. The M12 §11 SSO test list is the minimum: valid, unsigned, wrong audience, expired, replayed, wrapped, wrong issuer, algorithm downgrade; OIDC bad nonce/state/issuer/JWKS rotation; enforcement bypass; SCIM RFC 7644 conformance, deprovision latency, cross-org token reuse.

### 3.1 SAML

| ID | Threat | Requirement the code must meet | Required test | Status | Evidence |
|---|---|---|---|---|---|
| SS-01 | XML signature wrapping | Validate the signature over the exact element that is then consumed (reference URI resolved to the element by ID, element not relocatable); reject documents with duplicate IDs, multiple `Assertion`/`Response` ambiguities, or signed content that differs from consumed content; select the signed element first, then read all claims only from that verified subtree; never use XPath on the unverified tree | Wrapping corpus (extra assertion, moved assertion, duplicated ID, comment injection in NameID) all rejected | NOT VERIFIED | |
| SS-02 | Unsigned or partially signed responses | Require a valid signature on the Assertion or on the Response (state which; the connection's metadata must declare it); `WantAssertionsSigned` equivalent in SP metadata; unsigned => 422 at configuration time when metadata is unsigned and 401 at login | Unsigned response and unsigned assertion rejected | NOT VERIFIED | |
| SS-03 | Algorithm downgrade / `none` | Algorithm allow-list: RSA-SHA256 or stronger and ECDSA-SHA256+; digest SHA-256+; SHA-1 and `none` rejected for both signature and digest; key size floor for RSA (at least 2048) | SHA-1 signature, SHA-1 digest, missing algorithm, `none` all rejected | NOT VERIFIED | |
| SS-04 | Wrong signing key (trust confusion) | Signature must verify with a certificate pinned in the connection configuration (from admin-supplied metadata), not a certificate embedded in the message; certificate expiry checked; rollover supports two certificates | Self-signed message with an embedded attacker certificate rejected | NOT VERIFIED | |
| SS-05 | Wrong audience / recipient / destination | `Audience` equals this SP entity id; `SubjectConfirmationData/@Recipient` equals the exact ACS URL for this connection; `Destination` matches; `InResponseTo` matches an outstanding request when SP-initiated | Wrong audience, wrong recipient, wrong destination, mismatched InResponseTo rejected | NOT VERIFIED | |
| SS-06 | Wrong issuer | `Issuer` equals the connection's configured IdP entity id; a connection is selected by an unguessable id in the ACS path, not by trusting `Issuer` in the message | Another connection's valid assertion presented at this connection rejected | NOT VERIFIED | |
| SS-07 | Replay | Reject an assertion id already seen within its validity window; persist (hash of assertion id, expiry) with a unique constraint so replay is rejected across instances and restarts (not an in-memory set); retain at least until `NotOnOrAfter` plus skew | Replay of a valid assertion (same node, after restart, concurrent twice) accepted once only | NOT VERIFIED | |
| SS-08 | Expired / not-yet-valid assertions | Enforce `NotBefore`, `NotOnOrAfter` and `SubjectConfirmationData/@NotOnOrAfter` with clock skew at most 2 minutes; cap the accepted lifetime | Expired, future, and skew-boundary cases | NOT VERIFIED | |
| SS-09 | IdP-initiated flow abuse (login CSRF, forced session) | IdP-initiated login disabled by default; enabling is an explicit per-connection setting recorded in audit; when disabled an unsolicited response (no `InResponseTo`) is rejected; SP-initiated requests bind a signed/sealed relay state (as `identity/internal/seal.ts` does for OIDC) | Unsolicited response rejected when disabled; relay state tamper rejected | NOT VERIFIED | |
| SS-10 | XXE, XML bombs, entity expansion | Parser configured without DTD/external entity resolution; size and depth limits; no network fetch during parsing; metadata XML upload parsed the same way (`@xmldom/xmldom` is a declared dependency; it must be configured accordingly) | XXE, billion-laughs and oversized document corpus | NOT VERIFIED | |
| SS-11 | SSRF via metadata URL | If metadata is fetched by URL: HTTPS only, resolve and block private/loopback/link-local ranges after DNS resolution and on every redirect, timeouts and size cap, no credentials sent | SSRF corpus (private IPs, DNS rebinding, redirects, `file:`) | NOT VERIFIED | |
| SS-12 | NameID/attribute abuse | Identity key is the stable subject (NameID/`sub` plus connection id), not the email string; email changes at the IdP must not silently merge accounts; email domain must be a verified domain of the connection; require `email_verified`-equivalent trust only from verified domains | Email collision and domain-mismatch cases | NOT VERIFIED | |
| SS-13 | Open redirect through RelayState / return URL | Reuse `safeReturnTo` rules (`identity/internal/return-to.ts`): relative paths or allow-listed origins only | Return-URL corpus | NOT VERIFIED | |
| SS-14 | Session fixation and MFA downgrade after SSO | SSO login creates a fresh session and revokes a presented one (as the OIDC callback and password login already do, `identity.int.spec.ts:218`); session realm `web`; org policy `mfaRequired` still applies unless the IdP asserts an acceptable authentication context, which must be an explicit, audited per-org setting | Fixation test; MFA policy honoured after SSO | NOT VERIFIED | |

### 3.2 OIDC enterprise connection

| ID | Threat | Requirement | Required test | Status | Evidence |
|---|---|---|---|---|---|
| SS-20 | Code interception / CSRF / replay | Authorization code + PKCE S256, `state` and `nonce` single-use, sealed login state with short expiry (the existing OIDC client in `identity/internal/oidc.ts` and `seal.ts` is the pattern; per-connection configuration must keep every check) | Bad state, bad nonce, replayed code | NOT VERIFIED | |
| SS-21 | Issuer / JWKS confusion | Issuer equals discovery `issuer` and equals the connection's configured issuer; algorithm allow-list (no `none`, no HS* with a public key); JWKS fetched only from the discovered `jwks_uri`, cached with rotation handling and key-id selection | Wrong issuer, `alg=none`, HS256 confusion, JWKS rotation | NOT VERIFIED | |
| SS-22 | Audience / azp confusion | `aud` contains this connection's client id; `azp` checked when multiple audiences | Wrong audience | NOT VERIFIED | |
| SS-23 | Client secret exposure | Client secret stored only as a vault reference (`vault_ref`), never returned by any API, log or audit entry (audit scrubbing in `audit/internal/db-audit.sink.ts` covers secret-shaped keys) | Secret never present in responses or audit rows | NOT VERIFIED | |
| SS-24 | SSRF through discovery URL | As SS-11 for tenant-supplied issuers | SSRF corpus | NOT VERIFIED | |

### 3.3 Domains, enforcement, JIT, break-glass

| ID | Threat | Requirement | Required test | Status | Evidence |
|---|---|---|---|---|---|
| SS-30 | Domain claim hijack | A domain may be bound to an SSO connection (and enforcement) only after DNS TXT proof via M07; a verified domain is unique across all orgs; re-verification before any change; removing the proof must stop enforcement safely (and be audited) | Two orgs claim one domain; unverified domain cannot enforce | NOT VERIFIED | |
| SS-31 | Enforcement bypass | For enforced domains, password login, registration, password reset, email-link verification, social/other OIDC login and API key creation by such users cannot yield a session unless via the SSO connection; enforcement must also block `POST /v1/auth/password/login`, `.../register` and reset for those emails and must not leak whether the email is enforced beyond what login discovery requires | Every auth route against an enforced-domain user | NOT VERIFIED | |
| SS-32 | Lockout of everyone (IdP outage or misconfiguration) | Documented owner break-glass: designated owner(s) with a non-SSO path, MFA required, audited (`sso.connection.enforced`, break-glass use event), time-boxed and notified; enforcement cannot be enabled until a successful test login by the enabling admin; runbook `sso-lockout` | Break-glass works, is audited, and cannot be used by non-designated users | NOT VERIFIED | |
| SS-33 | JIT privilege escalation | JIT creates members with the connection's `defaultRole` only; never `owner`/`admin`; role claims from the IdP are not trusted for elevated roles; attribute-to-role mapping, if any, is an explicit admin setting limited to non-admin roles; JIT can only create users whose email domain is verified for the connection | Assertion carrying an admin-role attribute still yields default role | NOT VERIFIED | |
| SS-34 | Account takeover through pre-existing account | First SSO login for an email that already has a local account links only when the domain is verified for this org, records the link, and applies enforcement; a local account in another org is never merged | Pre-existing account and cross-org email cases | NOT VERIFIED | |
| SS-35 | Connection tampering | Creating/updating a connection needs `org:security` and a recent MFA step-up (M12 §6); changes are audited (`sso.connection.created|enforced`); metadata/cert changes re-require a test login | Role and step-up matrix; audit rows present | NOT VERIFIED | |
| SS-36 | Cross-org SSO | A connection serves only its own org; a user authenticated through org A's IdP cannot obtain membership of org B; ACS path binds connection id to org | Cross-org assertion presented to another org's ACS | NOT VERIFIED | |

### 3.4 SCIM

| ID | Threat | Requirement | Required test | Status | Evidence |
|---|---|---|---|---|---|
| SS-40 | Token theft | Tokens random (at least 256 bits), shown once, stored only as a hash, with a non-secret lookup prefix; revocable and rotatable; optional expiry; audit `scim.token.issued|revoked`; never in logs (SCIM `Authorization` header redacted) | Token not retrievable after issue; hash-only storage; revoked token 401 | NOT VERIFIED | |
| SS-41 | Cross-org token reuse | Token bound to exactly one org; every SCIM query runs inside that org's RLS scope; ids from another org return 404; no org id accepted from the request | Org A token against org B user/group ids and filters | NOT VERIFIED | |
| SS-42 | Privilege escalation via SCIM | SCIM can create/modify/disable members and non-admin roles only; it cannot grant owner/admin, cannot touch platform users, cannot change SSO or security policy, cannot create API keys; group-to-role mapping excludes admin roles unless explicitly configured by an org admin with step-up | Attempt to set an admin group or role through `Groups` and `Users` PATCH | NOT VERIFIED | |
| SS-43 | Deprovision incomplete | Deactivation disables the membership and revokes sessions and API keys and delegated grants created for that user within 60 seconds (p95), audited (`scim.user.deprovisioned`); re-activation does not restore revoked keys | Latency test and a verification query showing 0 residual access | NOT VERIFIED | |
| SS-44 | Replay / duplicate creation | Create is idempotent by `externalId` (unique per org); concurrent creates produce one user | Concurrent duplicate create | NOT VERIFIED | |
| SS-45 | Filter/PATCH injection and DoS | Filter grammar parsed into a typed AST and bound parameters (no string concatenation into SQL); page size cap, filter complexity cap, PATCH path whitelist; RFC 7644 error schema | Injection corpus, huge pages | NOT VERIFIED | |
| SS-46 | Abuse and enumeration | Rate limit per token and per source address (the in-memory limiter in `common/rate-limit.ts` is single-instance only; a shared store is needed for multi-instance); uniform 401/404 behaviour | Rate-limit test | NOT VERIFIED | |
| SS-47 | Auth confusion | `/scim/v2/*` accepts only SCIM tokens (not sessions, not user API keys); session/API-key routes reject SCIM tokens; marked public to the session guard but authenticated by its own guard; deny-by-default preserved | Token-type matrix | NOT VERIFIED | |
| SS-48 | Disabled SSO but live SCIM | Token stops working when the connection is disabled or the org is suspended | State matrix | NOT VERIFIED | |

### 3.5 Cross-cutting

| ID | Requirement | Status |
|---|---|---|
| SS-50 | Each new route is in `spec/openapi/openapi.yaml` (spec drift) and appears in the tenant sweep (`tenant-isolation-sweep.md`) with a cross-tenant token; the public/token-authenticated endpoints (ACS, callbacks, `/scim/v2/*`) go on the sweep allow-list with a stated reason | NOT VERIFIED |
| SS-51 | Audit events recorded atomically: `sso.connection.created|enforced`, `scim.token.issued|revoked`, `scim.user.provisioned|deprovisioned` (M12 §9) | NOT VERIFIED |
| SS-52 | Feature flag default off (CLAUDE.md §4); entitlement flag only, no meter | NOT VERIFIED |
| SS-53 | No secret or assertion bodies in logs; assertion ids hashed in the replay cache | NOT VERIFIED |
| SS-54 | Real IdP verification | `BLOCKED (HG-12-02)` |

## 4. Residual risk (before implementation)

SAML is the highest-risk surface in the platform's authentication story: implementation errors (signature wrapping, canonicalization, ID resolution) are subtle and well known. Prefer a maintained, audited SAML library over custom XML-DSig handling if the owner accepts the dependency; either way, the SS-01..SS-10 negative corpus is non-negotiable (AC-M12-01: 100 % of negative cases rejected) and the pen-test vendor should receive the SSO/SCIM endpoints with seeded test connections (`pen-test-scope.md`).

## 5. Review procedure once S55 lands

1. Re-read this file against `apps/api/src/modules/enterprise/**` and the migration; fill "Evidence" with test names and file paths.
2. Run the negative corpus on local test IdPs; record command and output in `M12-report.md`.
3. Update statuses; anything not demonstrated stays `NOT VERIFIED`.
