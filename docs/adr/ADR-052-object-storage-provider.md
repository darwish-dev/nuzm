# ADR-052: D-07 — Object storage provider

- Status: **Proposed** — drafted by the M08 implementation session for the owner; **NOT accepted, NOT decided.** The agent may propose, never decide (CLAUDE.md §5; docs/14). Nothing in the code depends on this ADR being accepted: the feature flag `data.object-storage.<provider>` stays OFF until (a) this ADR is accepted by the owner, (b) the adapter probe returns verified capabilities and region for the real account, and (c) HG-08-01 evidence exists. The admin API refuses to enable a provider row without all three (`data.data_providers`, AC-M08-02).
- Related decision: D-07 in `docs/07-open-decisions-and-blockers.md` (OPEN); comparison in `docs/14 §D-07`
- Requirements: FR-DAT-03
- Adapter: `ObjectStorageAdapter` (docs/09 §5), package `@nuzm/adapter-data`

## Context
Managed data services are delivered on the adapter pattern of docs/09 without hardcoding any provider. This record prepares the decision; it asserts NOTHING about what any vendor offers: every claim below is to be established by the probes, with sandbox/test credentials supplied by the owner (HG-08-01), never by the agent.

## Options (all unverified)
(A) provider object storage (Alibaba OSS / Huawei OBS) through an S3-compatible adapter ONLY if S3-API compatibility and a Saudi region are verified; (B) self-hosted S3-compatible service (Ceph RGW, SeaweedFS or Garage; MinIO only after a licence review) on verified ECS; (C) hybrid. Default: A if verified, else B.

## Decision criteria (docs/14 §0 weights are proposals; owner may change them)
Verified S3 operation matrix (the compat suite), per-bucket access policy, tenant-scoped credentials, signed URLs, lifecycle, optional versioning, in-region placement, usage meters (`storage.object_gb_months`, `storage.requests_k`, `storage.egress_gb`; a meter the provider cannot report is `unavailable`, never estimated), erasure semantics for DSR.
Scores stay blank until each cell has an evidence link (probe output, contract clause, documentation URL read on a date). An unscored cell counts 0 and is flagged.

## Probe plan
S3 operation matrix actually supported (PutObject, multipart, presign, lifecycle, policy, ACL, versioning, CORS), signature version, per-credential scoping test (a credential of org X can neither list nor read org Y), egress/request metrics availability, region list, bill lines, delete/erasure semantics, durability/replication description from the contract.
Order: (1) the owner puts sandbox/test credentials into the NON-production vault; (2) a human triggers the read-only `probe()`; (3) provisioning only after the owner enables the live-verification job; (4) raw evidence is stored redacted; (5) a human signs the evidence index entry. Results are labelled `LIVE-VERIFIED` only with that evidence, otherwise `NOT VERIFIED`.

## Exit conditions
S3 copy tooling; documented bulk export.

## Risks
Partial S3 compatibility; licence of self-hosted software; egress cost. DB backups use a SYSTEM bucket pair in the same data_region: with no verified provider the backup sink is blocked and databases cannot be enabled (owner decision).

## Outcomes the code already implements (docs/14 §0)
| Outcome | Behaviour |
|---|---|
| Option verified and approved | Run the conformance suite against the real adapter, then enable through the two-person admin flow |
| Several approved | One primary; the others stay capability-gated and disabled by flag |
| None verified / none approved | The feature is disabled; endpoints answer `422 unsupported_capability`; the UI shows "not available"; M08 acceptance rows stay BLOCKED (never PASS via mocks) |

## Decision
**OPEN.** To be recorded by the owner. The M08 implementation provides dev-reference (mock) adapters for tests only; they are `environment=local`, refused in production, and never evidence.

## Consequences
To be filled in at acceptance.

## Owner / date
OWNER-PLACEHOLDER / —
