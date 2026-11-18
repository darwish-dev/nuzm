# M11 threat model — delegated access (agency) and its neighbours

Scope: `X-Nuzm-Acting-Org` (agency acting for a client), grants, links; plus the reseller isolation rule and the marketplace install boundary. Method: STRIDE over the request path `AccessGuard → ActingOrgService → handler → audit`. Status: prepared by the implementing session, **not reviewed by security (pen-test scope is M12)**.

## Assets
Client organization data (workflows today; other families when their owners mark them `@Delegable()`), the client's audit trail, the grant itself (scopes, expiry), agency member credentials.

## Trust boundaries and invariants
1. **Header is untrusted.** `X-Nuzm-Acting-Org` is read only after the session is authenticated and only on routes carrying `@Delegable()` (deny by default: 403 everywhere else, including admin routes, API keys, and routes without a permission declaration). Test: every documented route outside the delegable family answers 403 with the header (≈100+ routes, `programs.int.spec.ts`).
2. **Membership first.** The caller must be a member of the organization named in `X-Nuzm-Org` (the agency); failure is 403, never 404 (no oracle for agency membership).
3. **Live validation, no cache.** Agency org active and of type `agency`; agency profile active; client org active; link `active`; a grant `active` and `expires_at > now`; `agency.enabled` on. Every request reads the rows: revocation, expiry, suspension are effective on the next request (the ≤ 60 s ceiling of AC-M11-06 is met with margin; there is nothing to expire).
4. **Intersection of authority.** effective = (agency member role) ∩ (grant scopes); the needed permission must be in BOTH. A viewer member with a write grant cannot write; an owner member with a read grant cannot write.
5. **No user impersonation.** The access context carries the agency member's own user id and the role `delegate`; `owner_user_id`/`created_by` of anything created through delegation is the agency member. There is no code path that loads a client user's identity. Admin impersonation (`/v1/admin/users/{id}/impersonation`) refuses the header.
6. **One indistinguishable denial.** Unknown client, no link, pending link, no grant, wrong scope, foreign grant, other agency: the same 403 `forbidden`. Only an expired grant says `delegation_expired` (the agency already knows the grant).
7. **Both sides recorded.** `delegation.access.used` per request (`org_id` = client, `acting_org_id` = agency, actor = member) and the audit sink adds `acting_org_id` to every event raised during a delegated request. The client sees these in its own audit log.
8. **Rate limits** per agency (600/min) and per client (300/min), in process (multi-instance behaviour NOT VERIFIED).

## STRIDE
| Threat | Mitigation | Residual |
|---|---|---|
| **S**poofing: forge the acting header, reuse A's grant on B, reuse another agency's grant | membership check + per-request grant lookup keyed by (agency, client); matrix + 150-tuple property test | none known |
| **T**ampering: widen scopes after acceptance, extend expiry, accept on the client's behalf | database trigger refuses scope/expiry/party changes; only the client side can move `pending → active`; CHECK `expires_at ≤ granted_at + 365 d` | a database owner role can bypass triggers (break-glass, audited by M01) |
| **R**epudiation | audit on propose/accept/decline/revoke/use; actor + both organizations | audit write failure fails the request (fail closed, M01) |
| **I**nformation disclosure: foreign data via shared caches or listings | no cache; RLS on every row (org context = client for the whole request); property test checks no foreign ids appear | list endpoints only show the client's own rows |
| **D**oS: an agency floods a client | per-agency and per-client limits; per-org workflow limits (S51) | process-local limiter |
| **E**levation: a grant carrying billing/members/keys/privacy | delegable catalogue is a fixed allow-list (unit-tested against forbidden prefixes); the accepting admin cannot grant what they lack | catalogue is a proposal (owner to confirm) |

## Known gaps (honest list)
- **Revocation routes do not exist (SCR-M11-01).** Service-level revocation is tested; a client cannot press a button yet. Hence `agency.enabled` stays OFF in shared environments.
- Only the workflow routes are `@Delegable()`. Other owners (hosting, domains, dns, builder, …) must opt in with the decorator and their own cross-client tests; until then an agency cannot manage a client's sites through delegation.
- Consolidated billing for agencies is not built (SCR-M11-07); `consolidated_billing` is an unused opt-in column.
- Agency/client data-sharing notices for counsel (HG-04-01) are not drafted beyond this document.

## Reseller isolation (same review)
A reseller reads: its own profile, link status, the NAME of ACTIVE sub-organizations (metadata) and statement aggregates computed by platform services (rating of that organization's usage). It has no query path to sub-organization content (no cross-org SQL in the programs module besides `RatingService`/`InvoiceService` aggregate calls, each scoped by the link). The reseller cannot accept a link for the sub-organization (database trigger).

## Marketplace install boundary (same review)
Install = entitlement of the SAME organization (RLS makes foreign entitlements invisible) + range + seats + residency, then a COPY with a new id; a trigger refuses an `installations` row without an active entitlement of that organization; publishers cannot read buyer rows (publisher accruals carry no buyer identity).
