# ADR-055: Archival of the hash-chained audit log

- Status: **Proposed - OPEN** (not binding until accepted by the owner). Related: ADR-010 (append-only enforcement), M04 S13c (retention, legal holds, `audit.detach_partition`), M12 S55 task 5, D-34 (retention periods, counsel).
- Source: M12 S55 report (`docs/reports/S55-report.md`).

## Context
M12 asks to apply `audit.retention_policies` / `audit.legal_holds` to `audit.audit_logs` "via partition-level archival (no new audit table)". Today `audit.audit_logs` is ONE table, not partitioned: rows form a per-organization SHA-256 hash chain computed by a trigger, `UNIQUE (chain_key, chain_seq)`, with signed checkpoints in `audit.audit_checkpoints`. Detaching an old partition would (a) require converting the table to a partitioned one (a rewrite of the evidence store, and a primary key / unique constraints that must contain the partition key), and (b) leave a chain whose first retained row no longer links to a `prev_hash` that is present, so `audit.verify_chain` (which starts from sequence 1 and zeroed `prev_hash`) would report a gap.

## Decision (proposed default)
1. **Not built in M12.** M12 delivers the parts that are safe without that decision: the retention policy facade (`GET/PUT /v1/admin/audit-retention`, minimum retention, versioned policies), the legal-hold-aware DRY RUN (nothing is archived), chain verification across all chains, and SIGNED EXPORTS (manifest + digest + signature, `AuditAssuranceService`). Archival of `audit.audit_logs` is DEFERRED and recorded in `docs/reports/blocked-register.md`.
2. When the owner and counsel set D-34, build archival as: range-partition `audit_logs` by month in an expand/contract migration (new partitioned table, copy under lock, swap, verify every chain before and after, keep the old table until the owner signs off); extend `audit.verify_chain` to verify FROM the latest signed checkpoint that precedes the archive boundary (the checkpoint's `head_hash` becomes the expected `prev_hash`); register `audit.audit_logs` in `audit.archivable_tables`; archive only through `audit.detach_partition()` (two people, break-glass, hold-checked).
3. An archived partition must be exported with a signed manifest first and stored in the data region required by `ResidencyPolicyService`.

## Alternatives considered
- **Delete or truncate old rows**: breaks the evidence property; refused.
- **Copy-and-delete to an archive table**: needs UPDATE/DELETE on the append-only table; refused.
- **Never archive**: legitimate until volume demands it; storage growth is the only cost.

## Consequences
Until accepted, audit retention is configuration plus evidence (policy versions, dry run, signed exports); the audit log keeps growing. Volume must be watched (an M12 alert is proposed but no table-size metric is wired).

## Owner / date
OWNER-PLACEHOLDER / —
