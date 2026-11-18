# Runbook — database failover and node loss (M08, self-operated family)

**Status: PROCEDURE DRAFT — not exercised.** The `self-operated-database` family was only run against a fake compute port and a fake node agent. No HA/failover was built or tested in M08 (D-05 OPEN, HG-05-01/02 PENDING). This runbook records what must be proven before the family is enabled.

1. Preconditions to prove on a verified Saudi ECS: replication (primary + replica) and a failover test within the RTO the owner sets; WAL/binlog archive to the SAME-region system bucket; restore-to-new within the RTO.
2. Until HA exists, the recovery path for a lost node is **restore-to-new from the newest verified backup** (`docs/runbooks/db-restore.md`), then re-point consumers through `DatabaseBindingPort` (a credential rotation notice carries the new vault reference).
3. The node agent accepts only the allow-listed signed commands (`packages/adapters/data/src/self-operated/agent-protocol.ts`); there is no SSH shell path for operators in this design. Break-glass access is a human decision (HG-12-xx) and must be audited.
4. Patching: `apply_patch` (policy `minor|security`) is an agent command; schedule and rollback are owner decisions (not defined here).
