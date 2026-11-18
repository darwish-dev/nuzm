# ADR-051: D-06 — Managed Redis provider

- Status: **Proposed** — drafted by the M08 implementation session for the owner; **NOT accepted, NOT decided.** The agent may propose, never decide (CLAUDE.md §5; docs/14). Nothing in the code depends on this ADR being accepted: the feature flag `data.cache.<provider>` stays OFF until (a) this ADR is accepted by the owner, (b) the adapter probe returns verified capabilities and region for the real account, and (c) HG-08-01 evidence exists. The admin API refuses to enable a provider row without all three (`data.data_providers`, AC-M08-02).
- Related decision: D-06 in `docs/07-open-decisions-and-blockers.md` (OPEN); comparison in `docs/14 §D-06`
- Requirements: FR-DAT-02
- Adapter: `CacheAdapter` (docs/09 §5), package `@nuzm/adapter-data`

## Context
Managed data services are delivered on the adapter pattern of docs/09 without hardcoding any provider. This record prepares the decision; it asserts NOTHING about what any vendor offers: every claim below is to be established by the probes, with sandbox/test credentials supplied by the owner (HG-08-01), never by the agent.

## Options (all unverified)
(A) provider Redis service where verified; (B) Nuzm-operated Redis (primary + replica) on verified ECS; (C) hybrid. Docs/07 proposes the same pattern as D-05. Redis is the `engine=redis` of `/v1/databases` (docs/04), served by `CacheAdapter`.

## Decision criteria (docs/14 §0 weights are proposals; owner may change them)
TLS + ACL users per tenant, memory limits, declared eviction policy, persistence option, failover information, `cache.instance_hours`. A shared multi-tenant instance is FORBIDDEN: one instance (or one verified isolation unit) per organization.
Scores stay blank until each cell has an evidence link (probe output, contract clause, documentation URL read on a date). An unscored cell counts 0 and is flagged.

## Probe plan
A: engine versions, TLS/ACL support, HA topology, regions, metrics, bill items. B: failover test, memory-limit enforcement, ACL isolation test between two tenants, persistence/restore test. Persistence is only offered when the probe says so.
Order: (1) the owner puts sandbox/test credentials into the NON-production vault; (2) a human triggers the read-only `probe()`; (3) provisioning only after the owner enables the live-verification job; (4) raw evidence is stored redacted; (5) a human signs the evidence index entry. Results are labelled `LIVE-VERIFIED` only with that evidence, otherwise `NOT VERIFIED`.

## Exit conditions
RDB export / standard protocol.

## Risks
Temptation of shared instances (rejected here); persistence differs between vendors; no Redis is installed in the dev environment, so every Redis result of M08 is mock-only and NOT VERIFIED.

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
