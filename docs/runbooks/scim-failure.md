# Runbook — SCIM provisioning failure (M12 S57)

Status: DRAFT 2026-11-18. **NOT VERIFIED and design-level.** The SCIM 2.0 server (`/scim/v2/*`) is being built in S55 and is feature-flagged off; it is not in `spec/openapi/openapi.yaml` on this branch. Token issuance/rotation endpoints are only proposed (PA-04, SCR-M12-01: `POST /v1/organizations/{orgId}/scim-tokens`, `DELETE …/{id}`) and are NOT approved. Enterprise IdP behaviour cannot be verified until HG-12-02 (BLOCKED). Do not offer SCIM to a customer until the flag is on and tested.

## Purpose
Diagnose and recover when an identity provider cannot create, update or deprovision users and groups through SCIM, or when deprovisioning does not remove access in time.

## Design facts this runbook relies on (M12 prompt, to be re-checked against the code)
`/scim/v2/*` supports `Users`, `Groups`, `ServiceProviderConfig`, `Schemas`, `ResourceTypes`, filter, PATCH and pagination (RFC 7643/7644). Authentication is a bearer token from `identity.scim_tokens`: stored hashed, scoped to **one** organization, shown once, rotated, rate-limited. `externalId` makes create idempotent. Errors use the SCIM error schema (401, 403, 409, 429). Deprovisioning disables the membership and revokes sessions and API keys within 60 seconds (target p95, AC-M12-03). JIT and SCIM never grant admin roles by default.

## Trigger / alert
Customer's IdP shows provisioning errors; users still active after being removed at the IdP; users missing after being assigned; a burst of 401/429 on `/scim/v2`; audit events `scim.user.provisioned|deprovisioned` missing or lagging; token expiry.

## Severity guidance (proposal)
SEV1 if a deprovisioned user keeps access beyond 60 s repeatedly (access-control failure) or a token works across organizations; SEV2 for provisioning broken for one organization; SEV3 for attribute mapping issues.

## Preconditions / access
Support L1/L2 can read state; security and platform admin act (admin realm, MFA). Customer admins hold `org:security` (recent MFA). No bearer token value is ever pasted into a ticket or chat.

## Steps
1. **Classify the error** from the IdP log (customer) and the response codes:
   - 401: token wrong, expired or revoked. Rotate (below). Never ask for the old token.
   - 403: token valid but not allowed (scope, organization mismatch, flag off for the organization).
   - 409: duplicate `externalId` or userName conflict: find the existing user in the organization; reconcile the mapping at the IdP rather than creating a duplicate.
   - 429: rate limit: ask the IdP to retry with backoff or reduce page/batch size; do not raise limits without engineering approval.
   - 5xx: platform fault: open an incident (`incident-response.md`).
2. **Rotate the token** (customer admin, `org:security`): issue a new token, copy it once into the IdP, revoke the old one. Contract is PROPOSED (PA-04); until approved the UI may not exist: the action is then BLOCKED and engineering assists under the two-person rule. Audit: `scim.token.issued|revoked`.
3. **Deprovisioning did not take effect.** Treat as urgent. Immediate containment by an org admin or staff: remove the membership (`DELETE /v1/organizations/{orgId}/members/{userId}`, `member:manage`, recent MFA), revoke the user's API keys (`DELETE /v1/api-keys/{id}` by the key owner or an org admin per permissions) and sessions. Then find why the SCIM path failed (queue lag: `queue-recovery.md`; worker down; deactivation sent as PATCH `active:false` not understood).
4. **Org mismatch or cross-org suspicion.** A token that works for another organization is a SEV1 isolation defect: revoke, preserve logs, involve the security officer, and consider `data-breach-workflow.md`.
5. **Replays after an outage.** IdPs resend; `externalId` idempotency should make this harmless. Confirm no duplicate users were created; if any, resolve by hand through support with the customer admin, never by editing identity rows.
6. **Roles and groups.** Group-to-role mapping never yields admin roles by default; changing a mapping is the customer admin's change and audited.
7. **Fallback.** While SCIM is broken, the customer admin manages members manually (`/v1/organizations/{orgId}/members`), noting that manual changes may be overwritten at the next IdP sync (agree who is the source of truth).

## Verification
A test user created at the IdP appears (and disappears on deprovision) within the target; deprovisioned user cannot use a previous session or API key; no duplicate `externalId`; audit events present; token usage shows `last_used_at` updating only for the intended organization.

## Escalation
L2 on-call (identity owner) → L3 engineering lead; security officer (any access-control or cross-org issue); customer's IdP administrator for mapping issues.

## Communication draft
EN: "We identified why user provisioning from your identity provider was not completing: [cause]. We have [action]. Please [customer action, e.g. update the token in your IdP] and confirm that a test user is provisioned. Until then, member changes can be made manually. Reference: [ticket id]."
AR: "حدّدنا سبب عدم اكتمال تزويد المستخدمين من مزوّد الهوية لديكم: [السبب]. وقد [الإجراء المتخذ]. نرجو [إجراء العميل، مثل تحديث الرمز في مزوّد الهوية] ثم التأكد من إنشاء مستخدم تجريبي. وإلى ذلك الحين يمكن إدارة الأعضاء يدويًا. المرجع: [رقم التذكرة]."

## Records to keep
Error class and timestamps (no tokens), rotation events, the membership and key revocations done as containment, latency measurements for the deprovision case, ticket or incident reference.

## Last exercised
NOT EXERCISED (drill pending, AC-M12-18). SCIM conformance and deprovision latency tests are AC-M12-03.
