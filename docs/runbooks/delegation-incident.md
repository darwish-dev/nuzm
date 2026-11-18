# Runbook — delegated access (agency) incident (M11)

Owner: security. Status: DRAFT. **Prerequisite open item:** the revocation HTTP routes are SCR-M11-01 (not approved). Until they exist, `agency.enabled` must stay OFF in any shared environment; this runbook documents the levers that exist today and the planned ones.

## Model in one paragraph
An agency (organization of type `agency`, profile in `programs.agencies`) gets scoped, time-boxed ACCESS to a client organization: link (client accepts) + grant (scopes ⊆ delegable catalogue, `expiresAt` mandatory ≤ 365 days, client admin accepts, never more than that admin holds). A request carries `X-Nuzm-Org: <agency org>` and `X-Nuzm-Acting-Org: <client org>`; it is allowed only on `@Delegable()` routes (today: workflows), for cookie sessions, and re-validated on EVERY request (no cache). Effective permissions = intersection(agency member role, grant scopes). There is no impersonation of client users: the actor stays the agency member. Audit: `org_id` = the client, `acting_org_id` = the agency, `actor_user_id` = the agency member; event `delegation.access.used` on every delegated request.

## Detect
- Query: `SELECT occurred_at, actor_user_id, acting_org_id, org_id, action FROM audit.audit_logs WHERE acting_org_id IS NOT NULL ORDER BY occurred_at DESC` (the client sees the same rows in its own audit log).
- Unusual: delegated requests outside business hours, from one agency member to many clients, bursts hitting the per-agency (600/min) or per-client (300/min) limits (`rate_limited`).

## Contain (fastest first)
1. **Suspend the agency organization** (admin console `PATCH /v1/admin/organizations/{id}` suspend): every delegated request answers 403 immediately (the access check reads the live organization status).
2. **Suspend the agency profile** (`UPDATE programs.agencies SET status='suspended'` via the admin scope): same effect, scoped to the program.
3. **Revoke a grant / link** — service level today: `AgencyService.revokeGrant(orgId, actor, grantId)` / `revokeLink(...)` (effective on the very next request; revoking a link revokes every grant of that agency for that client). Planned routes: SCR-M11-01.
4. **Kill switch:** set `agency.enabled` to `false` (global row) in `platform.feature_flags`.
5. **Compromised agency member:** remove the membership or reset the session (M01); their role no longer intersects any grant.

## Investigate
- What did the member do? Join `delegation.access.used` with the mutation events of the same trace. Mutations made through delegation carry the agency as `acting_org_id`.
- Which grants existed? `SELECT id, scopes, expires_at, status, granted_by FROM programs.delegated_access WHERE org_id = '<agency>'`.

## Recover and report
- The client re-grants with narrower scopes and a shorter expiry. A new grant is a new row (scopes and expiry of a grant never change).
- Personal-data exposure through an agency is a potential PDPL incident: follow the breach runbook (M04) and involve counsel (HG-04-01).
