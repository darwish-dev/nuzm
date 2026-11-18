# S54 report — Programs and portals (M11)

Status: **IMPLEMENTED around the pre-S54 blocker SCR-M11-01 (revocation routes not approved, therefore not built); local evidence only. `agency.enabled` must stay OFF in shared environments.** `reseller.issuer_model` = `disabled`; D-24 unchanged.

## Built (`apps/api/src/modules/programs`, migration 1603/1604/1605)
- **Agency**: profile (type `agency` only), client links (agency proposes, ONLY the client accepts; database trigger enforces who may do which transition), delegated-access grants (scopes ⊆ delegable catalogue ⊆ what the accepting admin holds; `expiresAt` mandatory ≤ 365 days; scopes/expiry immutable; CHECK at the database).
- **Acting-as** (`acting.service.ts`, `access.guard.ts`): header honoured only on `@Delegable()` routes (today: workflows), cookie sessions, per-request live validation (no cache), effective permissions = member role ∩ grant scopes, one indistinguishable 403 (except `delegation_expired`), no client-user impersonation, rate limits per agency and per client, audit with agency as actor organization.
- **Revocation (service level only)**: `AgencyService.revokeGrant/revokeLink`, tested to take effect on the next request. HTTP routes = **SCR-M11-01 (BLOCKER, not implemented)**.
- **Reseller**: profile (type `reseller`), sub-organization links (the sub-org accepts), versioned append-only price rules (`billing.reseller_price_rules` through the billing module's `ResellerPriceRuleService`; effective ≥ +1 day, below-cost refused, ETag), statements (wholesale from the platform's rating, retail via the rule in force, margin, provisional VAT, ledger variance, CSV, immutable once the period is closed).
- **Issuer model** (`issuer.ts`): `APPROVED_ISSUER_MODEL = null`; any requested model other than `disabled` resolves to `disabled` with status BLOCKED; DB CHECK accepts only `disabled`; `StatementService.issueSubOrgInvoice` answers 409 `issuer_model_blocked` before anything is created; a scenario pack (wholesale, retail, refund, marketplace) is prepared for HG-03-04.
- **Portals/UI**: see `docs/reports/evidence/M11/ui-notes.md` (built by a separate pass; Playwright NOT RUN).

## Evidence (`programs.int.spec.ts` 19 tests; unit `delegation.spec.ts` 5, `pricing.spec.ts` 4)
- **AC-M11-06 (matrix part)**: 17 deny cells (no link, pending link, no grant, pending grant, expired, revoked grant, revoked link, wrong scope, read-only grant vs write/run, member role lacks scope, grant of A used on B, spoofed/malformed client id, own org as client, other agency, non-member) + 1 allow control; every documented route outside the delegable family (≈100+) refuses the header; 150 random (member, agency, client) tuples: allowed only for the one valid combination, never a foreign id in a body. **The AC row stays BLOCKED because the revoke path needs SCR-M11-01.**
- **AC-M11-09**: statement wholesale = ledger-posted invoice usage net (variance 0) on fixtures; retail = wholesale + 15 % exactly; below-cost rejected; closed period stored once.
- **AC-M11-10 posture**: disabled/BLOCKED asserted for env, constructor, API and database.

## Not done / blocked
Consolidated billing (SCR-M11-07), sub-organization creation (SCR-M11-08), admin oversight lists (SCR-M11-05), the `@Delegable()` marker on other modules' routes (each owner), revocation and acceptance notifications (the client learns of a proposal by listing; no notification kinds were added).
