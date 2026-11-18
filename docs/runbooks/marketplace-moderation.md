# Runbook — marketplace moderation and takedown (M11)

Owner: trust & safety / ops (HUMAN-owned procedure; HG-11-01 publisher terms and HG-04-01 counsel on content liability are OPEN). Status: DRAFT. A real takedown/legal process is a human responsibility: this runbook only describes what the platform does.

## States
`listing_versions.moderation_status`: `pending` → `approved` | `rejected`; `approved` → `suspended`. A version is listed, quotable, purchasable and installable ONLY when `approved` and its listing is `published`. Versions are immutable (artifact, hash, SBOM, changelog); a fix is a NEW version.

## Review (admin console, `admin:marketplace`, recent MFA)
1. Open the case: automated scan verdict and findings (secrets, malware signatures, dependency deny-list, personal data, licence, SBOM, workflow schema + no connectors). Findings never quote the matched value. The scanner is a PATTERN scanner (rule set `2026-11-18.1`), **not an antivirus**: real malware scanning needs a provider (NOT VERIFIED).
2. Decide with `POST /v1/admin/marketplace/listings/{id}/moderation {decision, reasonCode, notes, versionId?}`:
   - `approve` — a version flagged by the scans needs `reasonCode: scan_override` and a note that explains why each finding is a false positive.
   - `reject` — pending only. Reason codes are snake_case (`policy_violation`, `malware`, `secrets_found`, `pii_found`, `licence`).
   - `suspend` — takes the approved version down and suspends the whole listing: it leaves browse, no new purchase or install is possible; installs already made stay with their buyers (they are copies).
3. A second moderator or a replayed click gets `409` (stale): re-read the case first.

## Takedown (notice received)
1. Suspend the listing (above) immediately; the decision is audited (`listing.version.moderated`, actor = the admin).
2. Record the notice reference in `notes`. Tell the publisher; the publisher can submit a fixed version.
3. If buyers must be refunded, do it through the normal refund flow (M03): the entitlement is revoked automatically when a credit note covers the invoice and the publisher accrual is reversed once.
4. If buyer copies must be removed, that is a customer-data action needing the buyer's consent or a legal instruction (human decision; not automated).

## Publisher verification (HUMAN/ops, PENDING procedure)
- An organization that tries to publish is registered as `unverified` (`marketplace.publisher_accounts`). Verification is a documented human check (identity, legal entity, terms accepted — HG-11-01). The service operation is `PublisherService.verify(adminUserId, orgId)`; the admin endpoint is SCR-M11-05 (not approved). Checklist to complete before verifying: legal entity and CR verified, contact verified, publisher agreement accepted, payout details NOT collected (no payout path exists).

## Money
- Revenue share: the publisher's share is ACCRUED on ledger account 2600 (sub-ledger = publisher id) when the purchase invoice is paid; reversed on refund. The share rate is a PLACEHOLDER (`MARKETPLACE_PUBLISHER_SHARE_BPS`, default 7000) until D-26/HG-11-01. **Nothing is ever paid out by this platform version.**
