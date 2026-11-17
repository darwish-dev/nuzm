# Runbook — retention and archival of append-only tables (M04 S13c)

**Nothing is ever deleted by the application.** Data leaves an online table only by detaching a whole old **partition** of a registered append-only table. That step is a **break-glass** procedure: it is not an API action (`execute` is refused with 422), it needs two people, and production use is **BLOCKED** until the owner decides the vault/KMS and the legal basis (D-12, D-34, HG-04-01; see [break-glass-draft](break-glass-draft.md)).

## Policies
`GET/PUT /v1/admin/compliance/retention-policies`: one policy per data class, optionally overridden per dataset (`schema.table`). Versions are immutable. **Every value seeded today is a PROPOSAL** (basis "PROPOSAL (D-34)"); a policy becomes `approved` only with the approving document (`documentRef`) and records the human approver. Rules: `archiveAfterDays <= retainDays`; same content again changes nothing.

## Dry run (the normal, safe step)
`GET /v1/admin/compliance/retention-policies?evaluate=true[&asOf=<date>]` counts, per known dataset, the rows older than the archive and expiry cutoffs, the rows covered by an **active legal hold**, and, for partitioned tables, each partition that could be detached (rows, held rows, `eligible`, `blockedBy`). It changes nothing and is audited (`compliance.retention.job_run`). `proposalPolicies: true` means a proposal, not an approved policy, produced the numbers.

Known datasets: `metering.usage_events` (monthly partitions by `window_start`: archival by detach) and `audit.audit_logs` (report only: the table is hash-chained; archival needs chain anchors and is built in M12).

## Detach a partition (break-glass; needs HG)
Preconditions: an approved decision of the two people below, the dry run showing the partition `eligible`, no active legal hold covering it, and the owner's recorded permission to use break-glass for this window.
1. Two different people (compliance officer or platform admin): the **requester** and the **approver**; both ids are written into the audit event.
2. A DBA enables the break-glass role for a fixed window (see the break-glass draft), connects as `nuzm_admin_breakglass` and runs:
   `SELECT * FROM audit.detach_partition('metering.usage_events', 'metering.usage_events_202401', '<requester id>', '<approver id>', '<reason, 10+ characters>');`
3. The function refuses (with `retention_mandatory`, `legal_hold_active` or a precise message) when: the table is not registered in `audit.archivable_tables`; the two ids are not two different staff with the right roles; the partition is the default one, not of that table, or **newer than the archive cutoff** of the dataset's policy; or a legal hold covers its data. A dataset with no policy is never archived.
4. On success the partition is detached and renamed `archived_<partition>`, **locked away from every runtime role** (no grants, forced row-level security that admits nothing), kept **append-only** (update/delete/truncate refused) and listed in the audit trail (`compliance.retention.partition_detached`: parent, archived name, rows, both people, reason, policy version and status). The rows still exist: moving them to cold storage is a separate step (ExportSink, M08).
5. The DBA removes the break-glass login window immediately and attaches the session log to the ticket.

## Things to know
- New events for a month whose partition was archived land in the **default partition** (it is never archived) until a new partition is created; create partitions ahead with `metering.ensure_usage_partitions`.
- Reading an archive needs its own logged procedure; forced row-level security hides the rows from everyone but the table owner.
- Restoring an archive is not built. Treat a detach as a one-way step in S13c.
