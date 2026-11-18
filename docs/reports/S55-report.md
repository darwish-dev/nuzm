# S55 report — Enterprise IAM

Status: **PARTIAL (library + service + API scope done; sign-in endpoints, SCIM token endpoint and org security policy BLOCKED on spec approval)** · Branch `claude/m12-hardening-4cc95e` · Written 2026-11-18 · Local test IdPs only: every SSO result is **NOT VERIFIED against a real enterprise IdP (HG-12-02)**.

## A. Repository findings and assumptions
- Exception recorded in [M12-report.md](M12-report.md): owner-granted start of M12 before M09–M11 gates are signed.
- Migration `1700` already exists on main (`identity.credentials`, customer sign-in); M12 numbering starts at **1710**. Manifest items for the owner are in [M12-spec-change-requests.md](M12-spec-change-requests.md).
- The approved contract has only POST/GET `sso-connections` and `/scim/v2/*`. SAML ACS / SP-metadata / OIDC callback / discovery / test-login endpoints are not in docs/04: **not built (SCR-M12-05)**. The protocol cores are implemented and tested as libraries.
- SCIM Groups = the non-administrative org roles (assumption: no group table in the manifest). Access-review items live in `audit.access_reviews.items` (SCR-M12-04).

## B. Plan and changed files
- Migrations: `identity/1710__identity__sso_scim`, `audit/1720__audit__access_reviews`, `compliance/1730__compliance__policy_versions` (+ `.down.sql` dev/staging only).
- Code (`apps/api/src/modules/enterprise/`): `saml/` (validator, metadata, tests), `oidc/`, `sso-connections.service.ts` + controller, `scim/` (filter, tokens, service, controller), `access-reviews.*`, `audit-assurance.service.ts`, `audit-retention.service.ts`, `policy-versions.*`, `flags.ts`, `ports.ts`. Small additive edits: identity (`sso-enforcement.ts`, password/register/platform-IdP checks), tenancy (`MemberService.add`, exports), domains (`DnsTxtLookup`), platform (`Db.withAuthScope` scopes), `app.setup.ts` (`application/scim+json` parser), errors registry.
- Spec: OpenAPI M12 blocks, `errors.yaml`, `ownership.yaml`; SDK regenerated.

## C. Implemented features, API and UI screens
- **SAML 2.0 SP validator**: DTD refused, pinned certificates only (KeyInfo never trusted), RSA-SHA256/384/512 + SHA-256/384/512 digests, no SHA-1/`none`/HMAC/comments-C14N, exactly one Assertion and every Signature directly under Response/Assertion, unique IDs, one Reference per signature pointing at its parent, claims read ONLY from the signed canonical XML, audience/recipient/destination/issuer/`NotOnOrAfter`/`NotBefore`, skew ≤ 120 s, InResponseTo, IdP-initiated off by default, replay claim, encrypted assertions refused. ECDSA is refused (library limitation, documented).
- **SAML metadata** import (https only, signing certificate required, expired certs refused, SSRF-safe fetcher) and SP metadata export (`WantAssertionsSigned=true`).
- **OIDC enterprise**: code + PKCE S256, state, nonce, issuer/audience/JWKS validation (RS/PS/ES only, rotation-aware key resolver), discovery issuer + https checks.
- **SSO connections** (`POST/GET /v1/organizations/{orgId}/sso-connections`): DNS TXT proof (`_nuzm-sso.<domain>`, own Nuzm zone via M07 `DnsTxtLookup` first, then public DNS), 409 `domain_claimed`, JIT with default role limited by a DB CHECK to viewer/developer/billing_admin, enforcement (gated on a verified domain and a successful test login), password/registration/platform-IdP sign-in refused for enforced domains (`sso_required`), identity resolution (`resolveLogin`) for JIT/provisioned users. POST with `connectionId` updates (enforce/JIT/enable/domains) because no PATCH is approved (SCR-M12-06).
- **SCIM 2.0** (`/scim/v2`): Users CRUD/PATCH/filter/pagination, Groups (read + member PATCH), ServiceProviderConfig/ResourceTypes/Schemas, `externalId` idempotent create, org-scoped hashed tokens (issue/rotate/revoke as a SERVICE; no endpoint, SCR-M12-01), per-token rate limit, SCIM error schema, deprovision revokes membership + API keys + all sessions synchronously.
- **Access reviews** (`GET/POST /v1/admin/access-reviews`, `POST …/{id}/decisions`): members of one org; keep/revoke; revoke removes membership (tenancy), the user's API keys in that org and all sessions; reviewer assignment; closed 409; idempotent.
- **Audit assurance/retention**: `GET/PUT /v1/admin/audit-retention` (versioned M04 policies for `audit.audit_logs`, minimum 395 days = PROPOSAL, legal-hold-aware dry run), chain verification + signed export service. **Archival DEFERRED** ([ADR-055](../adr/ADR-055-audit-log-archival.md), proposed).
- **Policy versions** (`GET/PUT /v1/admin/policy-versions`, `If-Match`, no self-approval).
- Feature flags `enterprise.sso`, `enterprise.scim` default OFF (404 when off).
- **Not built:** UI-M12-02 (SCR-M12-01), UI-M12-03 and MFA/session-age/IP policy (SCR-M12-02); SSO sign-in endpoints; SCIM token HTTP endpoint; delegated-access reviews (M11).

## D. Migrations and rollback
1710, 1720, 1730 (and 1750 for S57). Each has a dev/staging-only `.down.sql`; production is forward-fix (access reviews, policy versions and incident records are never dropped). Reversal note: disable by flags `enterprise.sso` / `enterprise.scim`.

## E. Tests run with actual results
See [M12-report.md §E](M12-report.md) for the final commands and counts. Files: `saml/saml.spec.ts` (37), `oidc/enterprise-oidc.spec.ts` (8), `enterprise.int.spec.ts` (22), `audit-assurance.int.spec.ts` (7).
- SCIM deprovision latency measured in the test (membership + keys + sessions, 3 users): see test output line `SCIM deprovision latency ms`.

## F. Security, tenant isolation, billing, residency verification
- Tenant isolation: SCIM token of org B vs org A ids → 404 (asserted for GET/PATCH/DELETE/lists); SSO connections RLS-scoped; sweep in [M12-report.md](M12-report.md).
- Residency: no region-bearing resource is created; SSO config holds public IdP data only; OIDC secret is a vault reference (a secret value is refused). Audit archive region is configuration (`AUDIT_ARCHIVE_REGION`), not enforced.
- Billing: none (no meter; enterprise SSO/SCIM are plan entitlement flags only, not wired).

## G. Human gates and live checks still needed
HG-12-02 (SSO test tenants), D-27 (scope), D-34 (retention values), HG-04-01; owner decisions SCR-M12-01…09.

## H. Acceptance checklist
| Row | Status |
|---|---|
| AC-M12-01 SAML/OIDC suite on local IdPs: negative cases rejected, positive accepted | PASS (local test IdP; library level) — wired sign-in flow BLOCKED (SCR-M12-05) |
| AC-M12-02 real IdP per protocol | BLOCKED (HG-12-02) |
| AC-M12-03 SCIM conformance + deprovision ≤ 60 s | PASS (own conformance tests, not an external RFC suite; latency measured in-process) |
| AC-M12-04 access review revokes end to end, 0 residual | PASS (members/keys/sessions; delegated access NOT VERIFIED until M11) |
| AC-M12-05 chain verification, tamper detected, legal hold | PASS for verification, tamper and hold-aware dry run; archival purge path DEFERRED (ADR-055) |

## I. Next-sprint handoff and open decisions
S56/S57 build on `ops` and the tenant sweep. Open: SCR-M12-01…09, D-27, D-34, ADR-055.
