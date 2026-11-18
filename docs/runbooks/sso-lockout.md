# Runbook — SSO enforcement lock-out (M12 S57)

Status: DRAFT 2026-11-18. **NOT VERIFIED and partly design-level.** Enterprise SSO (SAML and OIDC connections, enforcement flag) is being built in S55 and is feature-flagged off; there is no SSO connection code or endpoint in `spec/openapi/openapi.yaml` on this branch. SSO scope is D-27 (OPEN); real enterprise IdP tenants are HG-12-02 (PENDING), so any real-IdP behaviour is BLOCKED. Items marked *(proposal)* are recommended policy to be confirmed with the owner and the S55 implementation. Do not tell a customer that a capability exists until the flag is on for them and tested.

## Purpose
Restore access for an organization whose users cannot sign in after SSO enforcement was turned on for their verified email domain (IdP outage, wrong metadata or certificate, domain mismatch, deprovisioned administrators), without weakening security for anyone else.

## Trigger / alert
A customer reports that nobody (or the owners) can sign in; a rise in failed SSO logins for one organization; IdP certificate expiry; an IdP outage notice; support sees `sso.connection.enforced` shortly before the reports.

## Severity guidance (proposal)
SEV2: an entire organization locked out; SEV1 if a platform defect locks out many organizations or bypasses enforcement the other way (users enforced-off can use passwords: a security issue); SEV3: individual users blocked.

## Preconditions / access
- Customer side: the connection API is `POST/GET /v1/organizations/{orgId}/sso-connections` (permission `org:security` with recent MFA, per the M12 prompt). Body fields in the design: `{protocol: saml|oidc, metadataUrl|xml|issuer, domains[], jit{enabled, defaultRole}, enforce}`; the response carries domain-proof status and test-login result. Errors: 422 invalid or unsigned metadata, 409 domain claimed.
- Staff side: platform admin and security in the admin realm with MFA and step-up. Feature flags: `PUT /v1/admin/feature-flags` (`admin:flags:manage`, audited with before/after). Break-glass for database access: `break-glass-draft.md` (BLOCKED, D-12).
- **Owner break-glass policy** *(proposal; the M12 design says it must be documented)*: each organization keeps at least two named owner accounts; enforcement never removes the ability of designated break-glass owners to authenticate with a password plus MFA; their use is audited and notified to all owners; they cannot be JIT-created and JIT never grants admin roles by default. Confirm the exact rule during S55 and record it in the customer documentation.
- Password sign-in exists today for customer accounts (`POST /v1/auth/password/login`, `customer-accounts.md`); platform staff use OIDC with MFA and have no password.

## Steps
1. **Verify the person.** Staff never lift enforcement on an unauthenticated request. Verify the requester is an owner of the organization through a pre-agreed channel (support procedure: contact on file, second contact, written confirmation). Record who verified and how. **Two-person rule:** one staff member requests the change, a different staff member approves it; both ids go into the incident record.
2. **Diagnose without changing anything.** Read the connection state (`GET /v1/organizations/{orgId}/sso-connections`, staff read path to be confirmed) and the audit trail (`GET /v1/admin/audit-logs`, action prefix `sso.*`). Typical causes: IdP certificate rotated or expired, metadata URL unreachable, email domain not (or no longer) verified, clock skew (the design allows at most 2 minutes), IdP-initiated flow not enabled, user not provisioned (JIT off).
3. **Preferred fix (customer-side):** an owner who can still sign in (break-glass owner) updates the connection (new metadata or certificate) or sets `enforce: false` on it. The contract lists POST/GET only: whether POST updates an existing connection or a PATCH/DELETE endpoint is needed is **to be confirmed in S55** (raise an SCR if missing).
4. **Staff fallback (no owner can sign in):** with both approvals, disable enforcement for that organization only. Mechanism, in order of preference: (a) the organization security-policy field `ssoEnforced` once SCR-M12-02 / PA-05 is approved (`PATCH /v1/organizations/{orgId}`, not yet in the contract); (b) a per-organization feature-flag override (`PUT /v1/admin/feature-flags` with `scope: org`, key to be confirmed when S55 merges); (c) break-glass database change (last resort, BLOCKED until D-12, two people, session-logged, reviewed within 24 h).
5. **Do not** use impersonation to enter the account (`POST /v1/admin/users/{id}/impersonation` is time-boxed, needs a reason and approval, and is meant for support, not for bypassing enforcement), reset passwords for enforced users, or disable enforcement globally.
6. **Restore access:** the owner signs in, fixes the connection, runs the **test login** (the connection reports its result), then re-enables enforcement. Staff re-check that enforcement is on and that password sign-in is refused again for enforced domains.
7. **Follow-up:** advise at least two break-glass owners, calendar the IdP certificate expiry, and record the cause in the review.

## Verification
An owner signs in; test login passes; enforcement state matches the customer's intent; other organizations are unaffected (no global flag changes); audit events show the change (`sso.connection.created|enforced` and flag audit) and the two approvers.

## Escalation
L2 on-call (identity module owner) → L3 engineering lead; security officer for any suspicion that the request is an account-takeover attempt (stop and escalate); compliance officer if personal data was accessed during recovery (break-glass notification duty: `break-glass-draft.md`, PDPL); owner for any global change.

## Communication draft
EN: "We have restored access to your organization. Single sign-on enforcement was [paused/updated] at your request on [date] UTC. Please review your identity-provider settings and re-enable enforcement after a successful test sign-in. Reference: [ticket id]."
AR: "أعدنا إتاحة الوصول إلى مؤسستكم. تم [إيقاف/تحديث] إلزام تسجيل الدخول الموحّد بناءً على طلبكم بتاريخ [التاريخ] بالتوقيت العالمي المنسّق. نرجو مراجعة إعدادات مزوّد الهوية لديكم وإعادة تفعيل الإلزام بعد نجاح تجربة تسجيل دخول. المرجع: [رقم التذكرة]."

## Records to keep
Requester identity verification notes, the two approvers, the exact change made and when, audit event ids, test-login result, follow-up actions. No assertions, tokens or certificates in tickets.

## Last exercised
NOT EXERCISED (drill pending, AC-M12-18). SSO negative-case tests on local test IdPs are AC-M12-01; real IdP verification is BLOCKED (HG-12-02).
