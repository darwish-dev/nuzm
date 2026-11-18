# ADR-050: D-05 — Managed PostgreSQL / MySQL provider

- Status: **Proposed** — drafted by the M08 implementation session for the owner; **NOT accepted, NOT decided.** The agent may propose, never decide (CLAUDE.md §5; docs/14). Nothing in the code depends on this ADR being accepted: the feature flag `data.database.<provider>` stays OFF until (a) this ADR is accepted by the owner, (b) the adapter probe returns verified capabilities and region for the real account, and (c) HG-08-01 evidence exists. The admin API refuses to enable a provider row without all three (`data.data_providers`, AC-M08-02).
- Related decision: D-05 in `docs/07-open-decisions-and-blockers.md` (OPEN); comparison in `docs/14 §D-05`
- Requirements: FR-DAT-01, FR-DAT-10
- Adapter: `DatabaseAdapter` (docs/09 §5), package `@nuzm/adapter-data`

## Context
Managed data services are delivered on the adapter pattern of docs/09 without hardcoding any provider. This record prepares the decision; it asserts NOTHING about what any vendor offers: every claim below is to be established by the probes, with sandbox/test credentials supplied by the owner (HG-08-01), never by the agent.

## Options (all unverified)
(A) provider-managed RDS from Alibaba or Huawei, only where verified in a Saudi region; (B) Nuzm-operated PostgreSQL/MySQL on verified Saudi ECS behind a signed, allow-listed node agent (implemented as the `self-operated-database` family, proven only against fakes); (C) hybrid: B first, A added when verified. Docs/07 proposes C.

## Decision criteria (docs/14 §0 weights are proposals; owner may change them)
Residency per data class (verified region only); one instance per organization, per-tenant users, no shared database users; scheduled backups with a TESTED restore-to-new within an RTO the owner sets; dual-credential rotation; TLS only; private network by default; usage meters (`database.instance_hours`, `database.storage_gb_months`, `database.backup_gb_months`); cost/margin viability (D-23); operational burden (patching, HA, on-call).
Scores stay blank until each cell has an evidence link (probe output, contract clause, documentation URL read on a date). An unscored cell counts 0 and is flagged.

## Probe plan
A: list engines/versions per verified region from the live account; create/delete a test instance; backup + restore-to-new; tag or token lookup (idempotent create); metrics and bill line items. B: provision on verified ECS (needs HG-05-01/02), replication/failover test, full + WAL/binlog backup and restore-to-new within the RTO, patch procedure, TLS check, noisy-neighbour limits. All probes run on sandbox/test accounts only, read-only first.
Order: (1) the owner puts sandbox/test credentials into the NON-production vault; (2) a human triggers the read-only `probe()`; (3) provisioning only after the owner enables the live-verification job; (4) raw evidence is stored redacted; (5) a human signs the evidence index entry. Results are labelled `LIVE-VERIFIED` only with that evidence, otherwise `NOT VERIFIED`.

## Exit conditions
Standard engine protocol; a logical dump export is always available; instance migration runbook (`docs/runbooks/db-restore.md`). Switching from B to A is a restore-to-new into the vendor instance.

## Risks
Operational burden of B; provider RDS not available in a Saudi region; backup residency (system bucket pair must be in the same data_region).

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
