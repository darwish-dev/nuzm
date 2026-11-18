# Threat model: agency delegated access and reseller isolation (M11), PROVISIONAL

> INTERNAL self-assessment, 2026-11-18. NOT independent (HG-12-01 / D-28 BLOCKED).
>
> **Provisional: M11 is in flight and its code is not on this branch.** Written from `docs/milestones/M11_automation_marketplace_programs.md` (§4 S54, §6, §7, §9, §11). Every mitigation is `DESIGNED, NOT VERIFIED (M11 in flight)` except the one interim control that exists today and was checked in code (DG-00). Revocation of delegated access depends on SCR-M11-01 (spec change request, not yet approved per the prompt), so the revoke endpoint is not yet in the contract.

## 1. Scope and assets

Agency (`programs.agencies`, `agency_clients`, `delegated_access`), the `X-Nuzm-Acting-Org` header, effective-permission calculation, reseller sub-organizations and price rules, consolidated billing. Marketplace and workflow surfaces are noted only where they interact with delegation.

| Asset | Why it matters |
|---|---|
| Client org data reachable through a grant | Agency staff gain it; scope must be minimal and revocable |
| Grant records (scopes, expiry, client acceptance) | Source of truth for access |
| Client audit trail | Must show who acted and for whom |
| Reseller wholesale/retail pricing and statements | Margin data must not leak to sub-orgs and vice versa |

## 2. Trust boundaries and actors

- Agency member to client org: crosses an organization boundary through a grant. The grant is the only bridge.
- Agency org to platform: agency admin can link clients (client must accept) and request scopes (client admin approves).
- Reseller to sub-org: commercial aggregates and metadata only, **not** customer content, unless a separate delegated grant exists.
- Actors: malicious agency member, compromised agency account, malicious client admin granting too much, spoofer of the acting-org header, user of client A trying to use a grant belonging to client B, expired or revoked grant still cached, reseller peeking into a sub-org.

## 3. Threats and mitigations

| ID | STRIDE | Threat | Mitigation | Status | Residual risk | Proposed test |
|---|---|---|---|---|---|---|
| DG-00 | S/E | Acting-org header used before the feature exists | `AccessGuard` rejects any request carrying `x-nuzm-acting-org` with 403 `forbidden`; test `tenancy/tenancy.int.spec.ts:283` | PASS (interim, code seen) | Must be replaced by real validation without opening a bypass; the guard line is the single point to change | Keep the test, extend into the full matrix below |
| DG-01 | E | Header spoofing: act as client B with a grant for client A | Header re-validated on every request against an active grant: unexpired, scope covers the permission, client link active (M11 §9) | DESIGNED, NOT VERIFIED (M11 in flight) | - | Matrix: every route family x {no link, pending, active, expired, revoked, wrong scope, scope subset but action outside, spoofed client id, grant A on client B}; property-based random org/resource pairs (M11 §11) |
| DG-02 | E | Privilege escalation through grant scope | Scopes must be a subset of the client's grantable scopes; effective permissions = intersection(agency member role, grant scopes); `expires_at` mandatory (default 90 days, max 365, DB check) | DESIGNED, NOT VERIFIED (M11 in flight) | Grantable-scope definition drift | DB-level and API-level tests for exceed-scope (422) and expiry-missing |
| DG-03 | E | Delegation on non-delegable endpoints | Header ignored/rejected on endpoints not marked delegable; deny by default | DESIGNED, NOT VERIFIED (M11 in flight) | New endpoints default-delegable by mistake | Sweep: every operation without a delegable marker must reject the header |
| DG-04 | I | Cross-client leak through shared caches | Cache key includes acting org; per-agency and per-client rate limits | DESIGNED, NOT VERIFIED (M11 in flight) | Existing 30 s role/key caches in `PolicyService`, `ApiKeyService` (`access/policy.service.ts`, `identity/internal/api-key.service.ts`) would need acting-org-aware keys | Cache-poisoning test: alternate A/B calls with identical paths |
| DG-05 | R | Confused-deputy audit: actions attributed to the agency only, or the client only | All audit events record both `actorOrg` and `actingOrg`; `delegation.granted/revoked/used` events | DESIGNED, NOT VERIFIED (M11 in flight) | Audit chain placement (agency vs client chain) must be decided | Audit assertion in every positive matrix cell |
| DG-06 | E | Revocation or expiry takes too long | Effective within 60 s (cache TTL at most 60 s, AC-M11-06); client can revoke any time; revoke endpoint pending SCR-M11-01 | DESIGNED, NOT VERIFIED (M11 in flight) | Spec not yet approved | Timing test: revoke then call within 60 s |
| DG-07 | S | Impersonation of client users by agency staff | Impersonation of client users not allowed; acting-as changes the org context, not the user identity | DESIGNED, NOT VERIFIED (M11 in flight) | Overlap with platform support impersonation (`admin/internal/impersonation.service.ts`, an existing audited control) | Attempt to start impersonation through a delegated context |
| DG-08 | I | Reseller reads sub-org content | Aggregates and metadata only unless a separate delegated grant exists | DESIGNED, NOT VERIFIED (M11 in flight) | RLS policy complexity: `programs.delegated_access` must evaluate both agency `org_id` and the client link | Policy tests mandatory per M11 §7 (RLS tests on every new table) |
| DG-09 | T | Client-side consent bypass (link without acceptance) | Link requires client acceptance; grants need client-admin approval | DESIGNED, NOT VERIFIED (M11 in flight) | Invitation takeover (pending links) | Pending-link state machine tests; link to an org the agency does not control |
| DG-10 | T | Grant tampering or silent extension | Grant rows modified only through audited APIs; check `expires_at <= granted_at + 365d` | DESIGNED, NOT VERIFIED (M11 in flight) | Direct DB access outside the app | Append-only/versioning decision for grants |
| DG-11 | I | Billing data exposure through consolidated billing | Opt-in only; reseller statements via billing owner; reseller issuer model only the approved D-24 model may be enabled | DESIGNED, NOT VERIFIED (M11 in flight); issuer model `BLOCKED (D-24)` | Wholesale margin visibility | Statement visibility tests per role |

## 4. Residual risk

Delegation is the one feature whose purpose is to cross the tenant boundary, so the cross-tenant promise (`threat-model-control-plane.md` CP-01) depends on it being exactly right. Until M11 lands this branch refuses the header entirely (DG-00), which is safe but means every other row is unproven. M12 must re-run the agency matrix (M11 §11, AC-M11-06) and include the surface in pen-test scope (`pen-test-scope.md`).

## 5. Dependencies

SCR-M11-01 (revoke endpoint), SCR-M11-02..04, D-24, D-26, HG-11-01, M11 completion.
