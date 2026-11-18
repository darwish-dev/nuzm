# Runbook — degraded DNS zone

A zone becomes **degraded** when a change-set was only partly applied by the registrar **and** the platform could not verify that the rollback restored the snapshot. Customers see a banner and cannot change the zone (409) until it is reconciled. A reconcile operation (`domains.dns.reconcile`, `needs_reconcile`) is open.

## How a change-set is applied (so you know what state to expect)
1. The whole set is validated first (nothing is sent if any record is invalid).
2. The registrar's zone is read (snapshot), the set is applied through the adapter, the zone is **re-read and compared** with the expected result.
3. Match → our copy and the ETag/version change. Mismatch → the platform restores the snapshot by the minimal inverse change-set and verifies again. Verified → the customer gets `409` with `outcome: rolled_back` and nothing changed. Not verified → `503` `outcome: degraded`.
(Openprovider's zone update is documented as non-atomic; ResellerClub DNS is not used.)

## Steps
1. Admin → Domains → Orders → open the domain → **Force reconcile** (MFA step-up). For a degraded zone the result contains `dns_adopted`: the registrar's **live** zone becomes our copy (the live zone is what the internet sees), the zone returns to `active`, the version increments and the open operation is closed.
2. Tell the customer which records now exist (their own DNS screen shows the registrar's live state) — they may need to re-apply the change.
3. If `dns_unreachable`: the registrar is down; follow `domains-registrar-outage.md` and retry.
4. Audit trail: `dns.changeset.rolled_back`, `dns.zone.degraded`, `dns.zone.reconciled`.
