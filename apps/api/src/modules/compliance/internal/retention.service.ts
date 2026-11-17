import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';

export interface PolicyDto {
  id: string;
  dataClass: string;
  dataset: string | null;
  version: number;
  retainDays: number;
  archiveAfterDays: number;
  basis: string;
  status: 'proposal' | 'approved';
  documentRef: string | null;
  approvedBy: string | null;
  changeNote: string | null;
  createdBy: string | null;
  createdAt: string;
}
type Row = Record<string, unknown>;
const dto = (r: Row): PolicyDto => ({
  id: r.id as string,
  dataClass: r.data_class as string,
  dataset: (r.dataset as string | null) ?? null,
  version: r.version as number,
  retainDays: r.retain_days as number,
  archiveAfterDays: r.archive_after_days as number,
  basis: r.basis as string,
  status: r.status as PolicyDto['status'],
  documentRef: (r.document_ref as string | null) ?? null,
  approvedBy: (r.approved_by as string | null) ?? null,
  changeNote: (r.change_note as string | null) ?? null,
  createdBy: (r.created_by as string | null) ?? null,
  createdAt: (r.created_at as Date).toISOString(),
});

const CLASS = /^[a-z][a-z-]{2,30}$/;
const DATASET = /^[a-z_]+\.[a-z_]+$/;

export interface PolicyInput {
  dataClass: string;
  dataset: string | null;
  retainDays: number;
  archiveAfterDays: number;
  basis: string;
  status: 'proposal' | 'approved';
  documentRef: string | null;
  changeNote: string | null;
  baseVersion: number | null;
}

/** Validate a retention-policy body (422 with one entry per bad field). */
export function parsePolicyInput(raw: Record<string, unknown>): PolicyInput {
  const errors: { field: string; message: string }[] = [];
  const bad = (field: string, message: string) => errors.push({ field, message });
  const days = (k: string): number => {
    const v = raw[k];
    if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 36500) {
      bad(k, 'must be a whole number of days from 1 to 36500');
      return 0;
    }
    return v as number;
  };
  const opt = (k: string, max: number): string | null => {
    const v = raw[k];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' || v.trim().length < 1 || v.trim().length > max) {
      bad(k, `must be 1..${max} characters`);
      return null;
    }
    return v.trim();
  };
  const dataClass =
    typeof raw.dataClass === 'string' && CLASS.test(raw.dataClass)
      ? raw.dataClass
      : (bad('dataClass', 'is required (a data class key)'), '');
  const dataset = opt('dataset', 80);
  if (dataset && !DATASET.test(dataset)) bad('dataset', 'must look like schema.table');
  const retainDays = days('retainDays');
  const archiveAfterDays = days('archiveAfterDays');
  if (retainDays && archiveAfterDays && archiveAfterDays > retainDays)
    bad('archiveAfterDays', 'cannot be longer than retainDays');
  const basis = opt('basis', 500);
  if (!basis || basis.length < 3)
    bad('basis', 'is required (3..500 characters): the legal or business basis');
  const status = raw.status === undefined ? 'proposal' : raw.status;
  if (status !== 'proposal' && status !== 'approved')
    bad('status', "must be 'proposal' or 'approved'");
  const documentRef = opt('documentRef', 200);
  if (status === 'approved' && !documentRef)
    bad(
      'documentRef',
      'an approved policy needs the document that approves it (counsel memo, signed config)',
    );
  const base = raw.baseVersion;
  if (base !== undefined && base !== null && (!Number.isInteger(base) || (base as number) < 1))
    bad('baseVersion', 'must be a positive integer');
  if (errors.length)
    throw new ProblemException('validation_failed', 'invalid retention policy', errors);
  return {
    dataClass,
    dataset,
    retainDays,
    archiveAfterDays,
    basis: basis!,
    status: status as 'proposal' | 'approved',
    documentRef,
    changeNote: opt('changeNote', 500),
    baseVersion: typeof base === 'number' ? base : null,
  };
}

/**
 * Datasets the retention job knows. `partition-detach` = whole old partitions can be archived through audit.detach_partition() (break-glass);
 * `not-built` = the engine only reports (the audit log is hash-chained: its archival needs chain anchors and is built in M12).
 */
export interface RetentionTarget {
  dataset: string;
  dataClass: string;
  timeColumn: string;
  orgColumn: string;
  execution: 'partition-detach' | 'not-built';
}
export const RETENTION_TARGETS: RetentionTarget[] = [
  {
    dataset: 'audit.audit_logs',
    dataClass: 'personal',
    timeColumn: 'occurred_at',
    orgColumn: 'org_id',
    execution: 'not-built',
  },
  {
    dataset: 'metering.usage_events',
    dataClass: 'internal',
    timeColumn: 'window_start',
    orgColumn: 'org_id',
    execution: 'partition-detach',
  },
];

export interface PartitionPreview {
  partition: string;
  upperBound: string;
  rows: number;
  heldRows: number;
  eligible: boolean;
  blockedBy: 'legal_hold' | null;
}
export interface TargetPreview {
  dataset: string;
  dataClass: string;
  policy: {
    version: number;
    status: 'proposal' | 'approved';
    retainDays: number;
    archiveAfterDays: number;
    dataset: string | null;
  };
  archiveCutoff: string;
  expiryCutoff: string;
  archiveCandidates: number;
  expiryCandidates: number;
  heldCandidates: number;
  eligibleToArchive: number;
  execution: RetentionTarget['execution'];
  partitions: PartitionPreview[];
  note: string;
}
export interface RetentionPreview {
  dryRun: true;
  asOf: string;
  proposalPolicies: boolean;
  targets: TargetPreview[];
}

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
const qualified = (name: string) => name.split('.').map(q).join('.');

/**
 * Retention (M04 §4 task 5). Policies are versioned and immutable and every seeded value is a PROPOSAL until a human approves it with a document.
 * `preview` is a DRY RUN: it counts what the policy WOULD archive or expire, minus anything under an active legal hold, and changes nothing. There is
 * no deletion path: data leaves the online tables only by detaching a whole old partition through the break-glass function
 * `audit.detach_partition()` (two people, hold-checked, audited, never from this API).
 */
export class RetentionService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  async list(q2: {
    dataClass?: string;
    dataset?: string;
    history?: boolean;
    limit: number;
    cursor?: unknown;
  }): Promise<Page<PolicyDto>> {
    if (q2.dataClass !== undefined && !CLASS.test(q2.dataClass))
      throw new ProblemException('validation_failed', 'dataClass must be a data class key');
    if (q2.dataset !== undefined && !DATASET.test(q2.dataset))
      throw new ProblemException('validation_failed', 'dataset must look like schema.table');
    const cursor = decodeCursor(q2.cursor);
    return this.db.withPlatformScope(async (c) => {
      const args: unknown[] = [];
      const where: string[] = ['true'];
      if (q2.dataClass) where.push(`data_class = $${args.push(q2.dataClass)}`);
      if (q2.dataset) where.push(`dataset = $${args.push(q2.dataset)}`);
      const inner = q2.history
        ? `SELECT * FROM audit.retention_policies WHERE ${where.join(' AND ')}`
        : `SELECT DISTINCT ON (data_class, coalesce(dataset, '')) * FROM audit.retention_policies WHERE ${where.join(' AND ')} ORDER BY data_class, coalesce(dataset, ''), version DESC`;
      const outer = cursor ? `WHERE id < $${args.push(cursor)}` : '';
      const rows = (
        await c.query(
          `SELECT * FROM (${inner}) t ${outer} ORDER BY id DESC LIMIT ${q2.limit + 1}`,
          args,
        )
      ).rows;
      return pageOf(rows.map(dto), q2.limit);
    });
  }

  /** Set a policy: creates version 1, or version n+1 with `baseVersion` = n (409 otherwise). The same content as the current version changes nothing (200). */
  async put(
    actorUserId: string,
    body: Record<string, unknown>,
  ): Promise<{ policy: PolicyDto; created: boolean }> {
    const input = parsePolicyInput(body);
    return this.db.withPlatformScope(async (c) => {
      if (
        !(await c.query(`SELECT 1 FROM compliance.data_classes WHERE key = $1`, [input.dataClass]))
          .rowCount
      )
        throw new ProblemException(
          'validation_failed',
          `unknown data class "${input.dataClass.slice(0, 40)}"`,
          [{ field: 'dataClass', message: 'is not in the catalogue' }],
        );
      const prior = (
        await c.query(
          `SELECT * FROM audit.retention_policies WHERE data_class = $1 AND dataset IS NOT DISTINCT FROM $2 ORDER BY version DESC LIMIT 1`,
          [input.dataClass, input.dataset],
        )
      ).rows[0];
      if (prior) {
        const same =
          prior.retain_days === input.retainDays &&
          prior.archive_after_days === input.archiveAfterDays &&
          prior.basis === input.basis &&
          prior.status === input.status &&
          (prior.document_ref ?? null) === input.documentRef;
        if (same) return { policy: dto(prior), created: false }; // the same request again, or a retry after success: nothing is written
        if (input.baseVersion !== prior.version)
          throw new ProblemException(
            'conflict',
            `the policy is at version ${prior.version}; send baseVersion ${prior.version}`,
          );
      } else if (input.baseVersion !== null)
        throw new ProblemException('conflict', 'baseVersion is only for a policy that exists');
      const id = uuidv7();
      let row: Row;
      try {
        row = (
          await c.query(
            `INSERT INTO audit.retention_policies (id, data_class, dataset, version, retain_days, archive_after_days, basis, status, document_ref, approved_by, change_note, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [
              id,
              input.dataClass,
              input.dataset,
              prior ? Number(prior.version) + 1 : 1,
              input.retainDays,
              input.archiveAfterDays,
              input.basis,
              input.status,
              input.documentRef,
              input.status === 'approved' ? actorUserId : null,
              input.changeNote,
              actorUserId,
            ],
          )
        ).rows[0]!;
      } catch (e) {
        if ((e as { code?: string }).code === '23505' || (e as { code?: string }).code === '23514')
          throw new ProblemException(
            'conflict',
            'the policy changed at the same time; reload and try again',
          );
        throw e;
      }
      await this.audit.record({
        action: 'compliance.retention.policy_set',
        actorUserId,
        resource: { type: 'retention_policy', id },
        outcome: 'success',
        before: prior
          ? {
              version: prior.version,
              retainDays: prior.retain_days,
              archiveAfterDays: prior.archive_after_days,
              status: prior.status,
            }
          : undefined,
        after: {
          dataClass: input.dataClass,
          dataset: input.dataset,
          version: row.version,
          retainDays: input.retainDays,
          archiveAfterDays: input.archiveAfterDays,
          status: input.status,
        },
      });
      return { policy: dto(row), created: true };
    });
  }

  /** DRY RUN. Counts only; nothing is archived, expired, updated or deleted. Reads of customer data are counts, never rows. */
  async preview(actorUserId: string, asOf: Date = new Date()): Promise<RetentionPreview> {
    if (Number.isNaN(asOf.getTime()))
      throw new ProblemException('validation_failed', 'asOf must be a date');
    const out = await this.db.withPlatformScope(async (c) => {
      const holds = (
        await c.query(`SELECT id, org_id, dataset FROM audit.legal_holds WHERE status = 'active'`)
      ).rows as { id: string; org_id: string | null; dataset: string | null }[];
      const targets: TargetPreview[] = [];
      for (const t of RETENTION_TARGETS) {
        const pol = (
          await c.query(
            `SELECT * FROM audit.retention_policies WHERE (dataset = $1) OR (dataset IS NULL AND data_class = $2)
              ORDER BY (dataset IS NOT NULL) DESC, version DESC LIMIT 1`,
            [t.dataset, t.dataClass],
          )
        ).rows[0];
        if (!pol) continue; // a dataset without any policy is never touched
        const day = 86_400_000;
        const archiveCutoff = new Date(asOf.getTime() - Number(pol.archive_after_days) * day);
        const expiryCutoff = new Date(asOf.getTime() - Number(pol.retain_days) * day);
        const own = holds.filter((h) => h.dataset === t.dataset || h.dataset === null);
        const wholeDataset = own.some((h) => h.org_id === null);
        const heldOrgs = own.filter((h) => h.org_id !== null).map((h) => h.org_id as string);
        const tbl = qualified(t.dataset);
        const counts = (
          await c.query(
            `SELECT count(*) FILTER (WHERE ${q(t.timeColumn)} < $1)::bigint AS a, count(*) FILTER (WHERE ${q(t.timeColumn)} < $2)::bigint AS e,
                    count(*) FILTER (WHERE ${q(t.timeColumn)} < $1 AND ${q(t.orgColumn)} = ANY($3::uuid[]))::bigint AS h
               FROM ${tbl}`,
            [archiveCutoff, expiryCutoff, heldOrgs],
          )
        ).rows[0]!;
        const archiveCandidates = Number(counts.a);
        const heldCandidates = wholeDataset ? archiveCandidates : Number(counts.h);
        const partitions: PartitionPreview[] = [];
        if (t.execution === 'partition-detach') {
          const parts = (
            await c.query(
              `SELECT n.nspname AS schema, c.relname AS name,
                      substring(pg_get_expr(c.relpartbound, c.oid) from 'FROM \\(''([^'']+)''\\)')::timestamptz AS lower,
                      substring(pg_get_expr(c.relpartbound, c.oid) from 'TO \\(''([^'']+)''\\)')::timestamptz AS upper
                 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE i.inhparent = $1::regclass AND pg_get_expr(c.relpartbound, c.oid) <> 'DEFAULT' ORDER BY 3`,
              [t.dataset],
            )
          ).rows as { schema: string; name: string; lower: Date; upper: Date }[];
          for (const p of parts) {
            if (p.upper > archiveCutoff) continue;
            // counted THROUGH the parent with the partition's own bounds (partition pruning): the runtime roles hold no grants on the partitions themselves
            const r = (
              await c.query(
                `SELECT count(*)::bigint AS n, count(*) FILTER (WHERE ${q(t.orgColumn)} = ANY($3::uuid[]))::bigint AS h
                   FROM ${tbl} WHERE ${q(t.timeColumn)} >= $1 AND ${q(t.timeColumn)} < $2`,
                [p.lower, p.upper, heldOrgs],
              )
            ).rows[0]!;
            const held = wholeDataset || Number(r.h) > 0;
            partitions.push({
              partition: `${p.schema}.${p.name}`,
              upperBound: p.upper.toISOString(),
              rows: Number(r.n),
              heldRows: wholeDataset ? Number(r.n) : Number(r.h),
              eligible: !held,
              blockedBy: held ? 'legal_hold' : null,
            });
          }
        }
        targets.push({
          dataset: t.dataset,
          dataClass: t.dataClass,
          policy: {
            version: pol.version,
            status: pol.status,
            retainDays: pol.retain_days,
            archiveAfterDays: pol.archive_after_days,
            dataset: pol.dataset,
          },
          archiveCutoff: archiveCutoff.toISOString(),
          expiryCutoff: expiryCutoff.toISOString(),
          archiveCandidates,
          expiryCandidates: Number(counts.e),
          heldCandidates,
          eligibleToArchive: archiveCandidates - heldCandidates,
          execution: t.execution,
          partitions,
          note:
            t.execution === 'partition-detach'
              ? 'archival = detaching a whole partition through audit.detach_partition() under the break-glass role (two people); nothing is deleted from the API'
              : 'report only: the audit log is hash-chained, its archival is built in M12',
        });
      }
      return {
        dryRun: true as const,
        asOf: asOf.toISOString(),
        proposalPolicies: targets.some((x) => x.policy.status === 'proposal'),
        targets,
      };
    });
    await this.audit.record({
      action: 'compliance.retention.job_run',
      actorUserId,
      resource: { type: 'retention_job' },
      outcome: 'success',
      detail: {
        dryRun: true,
        asOf: out.asOf,
        datasets: out.targets.map((x) => x.dataset),
        eligible: out.targets.reduce((n, x) => n + x.eligibleToArchive, 0),
      },
    });
    return out;
  }
}
