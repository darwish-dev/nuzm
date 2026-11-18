# S30 report — DNS engine, eligibility, Saudi TLD gating

## A. Findings and assumptions
* Only **Openprovider** hosts DNS here and its zone update is documented as **non-atomic** (every example uses one modifier per call; the schema allows several). The adapter applies one change per call; atomicity is provided by the platform (snapshot → apply → verify → rollback). ResellerClub DNS is `unsupported` (only the A/TXT pages could be read; per-record, non-atomic).
* Record wire formats for MX/SRV/CAA on Openprovider are **not documented**; the adapter's mapping is an assumption **NOT VERIFIED**.
* No Nuzm authoritative DNS in this milestone: a registrar without the `dns` capability cannot get a zone (`422 unsupported_capability`) — the open decision in the milestone issue list stays open.
* The prompt's `platform.resources_index` conflicts with docs/05 (no inventory table in `platform`): events are emitted only ([assumptions §8](M07-m05-interface-assumptions.md)).
* `records per zone` entitlement: a configurable limit (`DOMAINS_MAX_RECORDS_PER_ZONE`, default 500) is enforced; wiring it to `billing.entitlements` is not done.

## B. Changed files
`packages/domain/src/dns-validate`, migration `0920` (`dns_zones`, `dns_records`), `domains/internal/{dns,eligibility}.service.ts`, `dns.controller.ts`, `spec/providers/tld-policy.yaml`.

## C. Implemented
`GET/POST /v1/dns/zones`, `GET /v1/dns/zones/{id}`, `GET/PATCH /v1/dns/zones/{id}/records`; validation (A, AAAA, CNAME, MX, TXT, SRV, CAA, NS delegation; no CNAME at the apex or beside other records; TTL 60–86400; TXT chunking at 255 bytes; IDN→punycode; duplicates; quota; loopback/link-local/metadata addresses and control characters refused; `_acme-challenge` and Nuzm-hosting targets writable only by the linkage writer); `If-Match` on the zone version (412 `etag_mismatch`, 428); per-change results and new ETag; degraded zones + reconcile; DNSSEC shown only when the probe says supported per TLD (the OP probe says `unknown` ⇒ hidden). Eligibility: policy file (**Saudi TLDs absent ⇒ blocked at quote time**; the loader refuses to enable one without `evidence_ref`), adapter eligibility only when declared, evidence append-only.

## D. Migrations
`0920` (RLS, `managed_by` check, unique `(zone_id,name,type,value_hash)`).

## E. Tests run (actual)
| Command | Result |
|---|---|
| dns-validate unit | 120 pass (**AC-M07-05**: 60 valid accepted, 64 invalid rejected with the right code) |
| `domains-dns.int.spec` | **9 pass**: **AC-M07-06 — a failure injected at each of the 20 positions of a 20-change set** leaves the registrar zone and our copy equal to the pre-state and the ETag unchanged (the vendor really applied `k` changes first); degraded path (rollback also failing) ⇒ 503 `degraded`, reconcile operation opened, changes blocked, forced reconcile adopts the live zone; 412/428; invalid sets 422 with per-change errors and nothing applied; abuse controls; SSRF/injection values; roles and tenants |

## F. Security
Cross-tenant: zones/records of another org are 404 for read, write and create; viewers read, cannot write.

## G. Gates
HG-07-02 PENDING, D-19 OPEN ⇒ AC-M07-13 **BLOCKED**.

## H. Acceptance (S30 slice)
AC-M07-05 PASS; AC-M07-06 PASS (mock); AC-M07-13 BLOCKED.

## I. Handoff
S31: `DnsLinkagePort` uses `DnsService.applyChangeSet` with writer `linkage`.
