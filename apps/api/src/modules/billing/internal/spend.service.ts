import { v7 as uuidv7 } from 'uuid';
import type { PoolClient } from 'pg';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';
import { UUID } from '@nuzm/domain';

type Row = Record<string, unknown>;
const MINOR = /^[1-9]\d{0,17}$/; // positive integer minor units as a string (no floats, no exponent, fits bigint)
const CURRENCY = /^[A-Z]{3}$/;

export interface SpendingLimitDto {
  id: string;
  scope: 'org' | 'project';
  projectId: string | null;
  monthlyCapMinor: string;
  currency: string;
  alertThresholds: number[];
  fourEyesAboveMinor: string | null;
  version: number;
  updatedAt: string;
}
export interface SpendApprovalDto {
  id: string;
  requesterUserId: string;
  subjectKind: 'quote' | 'operation';
  subjectId: string;
  projectId: string | null;
  amountMinor: string;
  currency: string;
  reason: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  fourEyes: boolean;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}
export interface SpendDecision {
  allowed: boolean;
  requiresApproval: boolean;
  /** One entry per limit that would be exceeded. `spentMinor` is rated usage (org scope) + committed approvals. */
  exceeded: {
    scope: 'org' | 'project';
    projectId: string | null;
    capMinor: string;
    spentMinor: string;
  }[];
  approvalId: string | null;
}

const limitDto = (r: Row): SpendingLimitDto => ({
  id: r.id as string,
  scope: r.scope as 'org' | 'project',
  projectId: (r.project_id as string | null) ?? null,
  monthlyCapMinor: String(r.monthly_cap_minor),
  currency: (r.currency as string).trim(),
  alertThresholds: r.alert_thresholds as number[],
  fourEyesAboveMinor: r.four_eyes_above_minor === null ? null : String(r.four_eyes_above_minor),
  version: r.version as number,
  updatedAt: (r.updated_at as Date).toISOString(),
});
const approvalDto = (r: Row, now: Date): SpendApprovalDto => ({
  id: r.id as string,
  requesterUserId: r.requester_user_id as string,
  subjectKind: r.subject_kind as 'quote' | 'operation',
  subjectId: r.subject_id as string,
  projectId: (r.project_id as string | null) ?? null,
  amountMinor: String(r.amount_minor),
  currency: (r.currency as string).trim(),
  reason: r.reason as string,
  // a pending request past its expiry is reported as expired (the row itself is transitioned on the next decision/request)
  status:
    r.status === 'pending' && (r.expires_at as Date).getTime() <= now.getTime()
      ? 'expired'
      : (r.status as SpendApprovalDto['status']),
  fourEyes: r.four_eyes as boolean,
  expiresAt: (r.expires_at as Date).toISOString(),
  decidedBy: (r.decided_by as string | null) ?? null,
  decidedAt: r.decided_at ? (r.decided_at as Date).toISOString() : null,
  decisionNote: (r.decision_note as string | null) ?? null,
  createdAt: (r.created_at as Date).toISOString(),
});

export type SpendNotifier = (n: {
  orgId: string;
  kind: 'requested' | 'decided';
  approvalId: string;
  recipients: string[];
  params: Record<string, unknown>;
}) => Promise<void>;

/**
 * Spending limits (monthly caps) and spend approvals (docs/04 §2.2, M02 §4.12). A cap is enforced by `evaluate`
 * (called by quotes in S07b); going over it needs a decided approval for that exact subject. Approvals are decided
 * once; above the four-eyes threshold the requester can never decide their own request.
 */
export class SpendService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly notify: SpendNotifier = async () => undefined,
    private readonly opts: { approvalTtlHours: number } = { approvalTtlHours: 24 },
    private readonly log: (m: string, x?: Record<string, unknown>) => void = (m, x) =>
      process.stderr.write(JSON.stringify({ spend: m, ...x }) + '\n'),
  ) {}

  // ---- month spend ------------------------------------------------------------------------------------------------

  /**
   * Rated usage of the UTC month (latest rating per key, net of corrections) plus committed spend (approvals decided
   * `approved` this month). Rated usage has no project attribution before M05, so project caps see approvals only.
   */
  async monthSpend(
    c: PoolClient,
    orgId: string,
    currency: string,
    projectId: string | null,
    now = new Date(),
  ): Promise<{ ratedMinor: bigint; committedMinor: bigint }> {
    const period = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const rated =
      projectId === null
        ? (
            await c.query<{ s: string }>(
              `SELECT coalesce(sum(amount_minor), 0)::text AS s FROM (
                 SELECT DISTINCT ON (meter_id, resource_key, segment_start) amount_minor
                   FROM metering.rated_usage
                  WHERE org_id = $1 AND period_start = $2 AND currency = $3
                  ORDER BY meter_id, resource_key, segment_start, created_at DESC, id DESC) t`,
              [orgId, period, currency],
            )
          ).rows[0]!.s
        : '0';
    const committed = (
      await c.query<{ s: string }>(
        `SELECT coalesce(sum(amount_minor), 0)::text AS s FROM billing.spend_approvals
          WHERE org_id = $1 AND status = 'approved' AND currency = $2 AND decided_at >= $3
            AND ($4::uuid IS NULL OR project_id = $4::uuid)`,
        [orgId, currency, period, projectId],
      )
    ).rows[0]!.s;
    return { ratedMinor: BigInt(rated), committedMinor: BigInt(committed) };
  }

  // ---- spending limits --------------------------------------------------------------------------------------------

  async listLimits(orgId: string): Promise<SpendingLimitDto[]> {
    return this.db.withOrg(orgId, async (c) =>
      (
        await c.query(
          `SELECT * FROM billing.spending_limits WHERE org_id = $1 ORDER BY scope, project_id NULLS FIRST, id`,
          [orgId],
        )
      ).rows.map(limitDto),
    );
  }

  private parseLimit(input: Record<string, unknown>) {
    const scope = input.scope;
    if (scope !== 'org' && scope !== 'project')
      throw new ProblemException('validation_failed', "scope must be 'org' or 'project'");
    const projectId = input.projectId ?? null;
    if (scope === 'org' && projectId !== null)
      throw new ProblemException('validation_failed', 'projectId is only valid for scope project');
    if (scope === 'project' && (typeof projectId !== 'string' || !UUID.test(projectId)))
      throw new ProblemException(
        'validation_failed',
        'projectId (uuid) is required for scope project',
      );
    if (typeof input.monthlyCapMinor !== 'string' || !MINOR.test(input.monthlyCapMinor))
      throw new ProblemException(
        'validation_failed',
        'monthlyCapMinor must be a positive integer string (minor units)',
      );
    if (typeof input.currency !== 'string' || !CURRENCY.test(input.currency))
      throw new ProblemException('validation_failed', 'currency must be an ISO 4217 code');
    const th = input.alertThresholds ?? [80, 100];
    if (
      !Array.isArray(th) ||
      th.length > 8 ||
      !th.every((n) => Number.isInteger(n) && n >= 1 && n <= 100) ||
      new Set(th).size !== th.length
    )
      throw new ProblemException(
        'validation_failed',
        'alertThresholds must be up to 8 distinct integers in 1..100',
      );
    let fourEyes: string | null = null;
    if (input.fourEyesAboveMinor !== undefined && input.fourEyesAboveMinor !== null) {
      if (scope !== 'org')
        throw new ProblemException(
          'validation_failed',
          'fourEyesAboveMinor is only valid for scope org',
        );
      if (
        typeof input.fourEyesAboveMinor !== 'string' ||
        !/^(0|[1-9]\d{0,17})$/.test(input.fourEyesAboveMinor)
      )
        throw new ProblemException(
          'validation_failed',
          'fourEyesAboveMinor must be a non-negative integer string',
        );
      fourEyes = input.fourEyesAboveMinor;
    }
    return {
      scope,
      projectId: projectId as string | null,
      cap: input.monthlyCapMinor,
      currency: input.currency,
      thresholds: [...(th as number[])].sort((a, b) => a - b),
      fourEyes,
    };
  }

  /**
   * Create or replace one cap (identified by scope + project). Replacing needs the current version (If-Match →
   * `expectedVersion`): 412 when stale. A new or LOWERED cap below this month's spend is refused (422 spend_approval_required): the
   * overspend would already be unapproved.
   */
  async putLimit(
    orgId: string,
    input: Record<string, unknown>,
    expectedVersion: number | null,
    actorUserId: string,
    now = new Date(),
  ): Promise<SpendingLimitDto> {
    const p = this.parseLimit(input);
    return this.db.withOrg(orgId, async (c) => {
      if (p.projectId) {
        const ok = (
          await c.query(`SELECT 1 FROM tenancy.projects WHERE id = $1 AND org_id = $2`, [
            p.projectId,
            orgId,
          ])
        ).rowCount;
        if (!ok) throw new ProblemException('not_found', 'project not found');
      }
      const existing = (
        await c.query(
          `SELECT * FROM billing.spending_limits WHERE org_id = $1 AND scope = $2 AND project_id IS NOT DISTINCT FROM $3::uuid FOR UPDATE`,
          [orgId, p.scope, p.projectId],
        )
      ).rows[0];
      if (existing) {
        if (expectedVersion === null)
          throw new ProblemException('precondition_required', 'send the current ETag in If-Match');
        if (existing.version !== expectedVersion)
          throw new ProblemException(
            'precondition_failed',
            'the spending limit changed; reload it',
          );
      }
      // Only creating or LOWERING a cap is checked: approved overspend must not lock the limit's other settings
      // (thresholds, four-eyes), and keeping or raising the cap never makes things worse.
      if (!existing || BigInt(p.cap) < BigInt(existing.monthly_cap_minor as string)) {
        const s = await this.monthSpend(c, orgId, p.currency, p.projectId, now);
        if (s.ratedMinor + s.committedMinor > BigInt(p.cap))
          throw new ProblemException(
            'spend_approval_required',
            "the cap is below this month's spend; set it to at least the current spend or obtain an approval first",
          );
      }
      const row = existing
        ? (
            await c.query(
              `UPDATE billing.spending_limits SET monthly_cap_minor=$2, currency=$3, alert_thresholds=$4, four_eyes_above_minor=$5,
                      version = version + 1, updated_by=$6, updated_at=now() WHERE id=$1 RETURNING *`,
              [existing.id, p.cap, p.currency, p.thresholds, p.fourEyes, actorUserId],
            )
          ).rows[0]!
        : (
            await c.query(
              `INSERT INTO billing.spending_limits (id, org_id, scope, project_id, monthly_cap_minor, currency, alert_thresholds, four_eyes_above_minor, updated_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
              [
                uuidv7(),
                orgId,
                p.scope,
                p.projectId,
                p.cap,
                p.currency,
                p.thresholds,
                p.fourEyes,
                actorUserId,
              ],
            )
          ).rows[0]!;
      await this.audit.record({
        action: existing ? 'billing.spending_limit.updated' : 'billing.spending_limit.created',
        actorUserId,
        orgId,
        resource: { type: 'spending_limit', id: row.id as string },
        outcome: 'success',
        ...(existing
          ? {
              before: {
                monthlyCapMinor: String(existing.monthly_cap_minor),
                currency: existing.currency,
              },
            }
          : {}),
        after: {
          scope: p.scope,
          projectId: p.projectId,
          monthlyCapMinor: p.cap,
          currency: p.currency,
        },
      });
      return limitDto(row);
    });
  }

  // ---- enforcement ------------------------------------------------------------------------------------------------

  /**
   * Would a new commitment of `amountMinor` push the month past a cap? When it would, it is allowed only with a decided
   * (approved) approval for exactly this subject whose amount covers it.
   */
  async evaluate(
    orgId: string,
    input: {
      amountMinor: string;
      currency: string;
      projectId?: string | null;
      subject?: { kind: 'quote' | 'operation'; id: string };
    },
    now = new Date(),
  ): Promise<SpendDecision> {
    if (!MINOR.test(input.amountMinor) && input.amountMinor !== '0')
      throw new ProblemException(
        'validation_failed',
        'amountMinor must be a non-negative integer string',
      );
    if (!CURRENCY.test(input.currency))
      throw new ProblemException('validation_failed', 'currency must be an ISO 4217 code');
    const amount = BigInt(input.amountMinor);
    return this.db.withOrg(orgId, async (c) => {
      const limits = (
        await c.query(
          `SELECT * FROM billing.spending_limits WHERE org_id = $1 AND currency = $2
              AND (scope = 'org' OR project_id = $3::uuid)`,
          [orgId, input.currency, input.projectId ?? null],
        )
      ).rows;
      const exceeded: SpendDecision['exceeded'] = [];
      for (const l of limits) {
        const pid = l.scope === 'project' ? (l.project_id as string) : null;
        const s = await this.monthSpend(c, orgId, input.currency, pid, now);
        const spent = s.ratedMinor + s.committedMinor;
        if (spent + amount > BigInt(l.monthly_cap_minor as string))
          exceeded.push({
            scope: l.scope,
            projectId: pid,
            capMinor: String(l.monthly_cap_minor),
            spentMinor: spent.toString(),
          });
      }
      if (exceeded.length === 0)
        return { allowed: true, requiresApproval: false, exceeded, approvalId: null };
      let approvalId: string | null = null;
      if (input.subject) {
        const a = (
          await c.query(
            `SELECT id FROM billing.spend_approvals
              WHERE org_id = $1 AND subject_kind = $2 AND subject_id = $3 AND status = 'approved'
                AND currency = $4 AND amount_minor >= $5 ORDER BY decided_at DESC LIMIT 1`,
            [orgId, input.subject.kind, input.subject.id, input.currency, input.amountMinor],
          )
        ).rows[0];
        approvalId = (a?.id as string | undefined) ?? null;
      }
      return {
        allowed: approvalId !== null,
        requiresApproval: approvalId === null,
        exceeded,
        approvalId,
      };
    });
  }

  async assertAllowed(
    orgId: string,
    input: Parameters<SpendService['evaluate']>[1],
    now = new Date(),
  ): Promise<SpendDecision> {
    const d = await this.evaluate(orgId, input, now);
    if (!d.allowed)
      throw new ProblemException(
        'spend_approval_required',
        'this would exceed the monthly spending limit; request an approval',
      );
    return d;
  }

  // ---- approvals --------------------------------------------------------------------------------------------------

  async request(
    orgId: string,
    requesterUserId: string,
    input: Record<string, unknown>,
    now = new Date(),
  ): Promise<SpendApprovalDto> {
    const quoteId = input.quoteId;
    const operationId = input.operationId;
    if ((quoteId === undefined) === (operationId === undefined))
      throw new ProblemException('validation_failed', 'send exactly one of quoteId or operationId');
    const subjectKind = quoteId !== undefined ? 'quote' : 'operation';
    const subjectId = (quoteId ?? operationId) as unknown;
    if (typeof subjectId !== 'string' || !UUID.test(subjectId))
      throw new ProblemException('validation_failed', `${subjectKind}Id must be a uuid`);
    if (typeof input.amount !== 'string' || !MINOR.test(input.amount))
      throw new ProblemException(
        'validation_failed',
        'amount must be a positive integer string (minor units)',
      );
    if (typeof input.currency !== 'string' || !CURRENCY.test(input.currency))
      throw new ProblemException('validation_failed', 'currency must be an ISO 4217 code');
    if (
      typeof input.reason !== 'string' ||
      input.reason.trim().length < 1 ||
      input.reason.length > 500
    )
      throw new ProblemException('validation_failed', 'reason must be 1..500 characters');
    const projectId = input.projectId ?? null;
    if (projectId !== null && (typeof projectId !== 'string' || !UUID.test(projectId)))
      throw new ProblemException('validation_failed', 'projectId must be a uuid');
    const ttlMs = this.opts.approvalTtlHours * 3_600_000;

    const dto = await this.db.withOrg(orgId, async (c) => {
      if (projectId) {
        const ok = (
          await c.query(`SELECT 1 FROM tenancy.projects WHERE id = $1 AND org_id = $2`, [
            projectId,
            orgId,
          ])
        ).rowCount;
        if (!ok) throw new ProblemException('not_found', 'project not found');
      }
      if (subjectKind === 'operation') {
        const ok = (
          await c.query(`SELECT 1 FROM platform.operations WHERE id = $1 AND org_id = $2`, [
            subjectId,
            orgId,
          ])
        ).rowCount;
        if (!ok) throw new ProblemException('not_found', 'operation not found');
      }
      // stale pending requests for this subject no longer block a new one
      await c.query(
        `UPDATE billing.spend_approvals SET status = 'expired'
          WHERE org_id = $1 AND subject_kind = $2 AND subject_id = $3 AND status = 'pending' AND expires_at <= $4`,
        [orgId, subjectKind, subjectId, now],
      );
      const threshold = (
        await c.query(
          `SELECT four_eyes_above_minor FROM billing.spending_limits WHERE org_id = $1 AND scope = 'org'`,
          [orgId],
        )
      ).rows[0]?.four_eyes_above_minor as string | null | undefined;
      const fourEyes =
        threshold === undefined ||
        threshold === null ||
        BigInt(input.amount as string) > BigInt(threshold);
      let row: Row;
      try {
        row = (
          await c.query(
            `INSERT INTO billing.spend_approvals (id, org_id, requester_user_id, subject_kind, subject_id, project_id, amount_minor, currency, reason, four_eyes, expires_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
            [
              uuidv7(),
              orgId,
              requesterUserId,
              subjectKind,
              subjectId,
              projectId,
              input.amount,
              input.currency,
              (input.reason as string).trim(),
              fourEyes,
              new Date(now.getTime() + ttlMs),
            ],
          )
        ).rows[0]!;
      } catch (e) {
        if ((e as { code?: string }).code === '23505')
          throw new ProblemException(
            'conflict',
            'an approval request for this subject is already open',
          );
        throw e;
      }
      await this.audit.record({
        action: 'billing.spend_approval.requested',
        actorUserId: requesterUserId,
        orgId,
        resource: { type: 'spend_approval', id: row.id as string },
        outcome: 'success',
        after: {
          subjectKind,
          subjectId,
          amountMinor: input.amount,
          currency: input.currency,
          fourEyes,
        },
      });
      return approvalDto(row, now);
    });
    const approvers = await this.approvers(orgId, requesterUserId, dto.fourEyes);
    await this.safeNotify({
      orgId,
      kind: 'requested',
      approvalId: dto.id,
      recipients: approvers,
      params: { approvalId: dto.id, amountMinor: dto.amountMinor, currency: dto.currency },
    });
    return dto;
  }

  /** Members whose role carries `billing:manage` (the approvers); the requester is excluded under four-eyes. */
  private async approvers(orgId: string, requester: string, fourEyes: boolean): Promise<string[]> {
    return this.db.withOrg(orgId, async (c) =>
      (
        await c.query<{ user_id: string }>(
          `SELECT DISTINCT m.user_id FROM tenancy.memberships m
             JOIN tenancy.role_permissions rp ON rp.role = m.role AND rp.permission = 'billing:manage'
            WHERE m.org_id = $1 AND ($3::boolean = false OR m.user_id <> $2)`,
          [orgId, requester, fourEyes],
        )
      ).rows.map((r) => r.user_id),
    );
  }

  private async safeNotify(n: Parameters<SpendNotifier>[0]): Promise<void> {
    try {
      await this.notify(n);
    } catch (e) {
      this.log('notification_failed', {
        orgId: n.orgId,
        approvalId: n.approvalId,
        error: (e as Error).message,
      });
    }
  }

  async list(
    orgId: string,
    viewer: { userId: string; seesAll: boolean },
    o: { limit: number; cursor?: string | undefined; status?: string | undefined },
    now = new Date(),
  ): Promise<Page<SpendApprovalDto>> {
    if (o.status !== undefined && !['pending', 'approved', 'denied', 'expired'].includes(o.status))
      throw new ProblemException(
        'validation_failed',
        'status must be pending, approved, denied or expired',
      );
    const after = decodeCursor(o.cursor);
    return this.db.withOrg(orgId, async (c) => {
      const rows = (
        await c.query(
          `SELECT * FROM billing.spend_approvals
            WHERE org_id = $1 AND ($2::boolean OR requester_user_id = $3)
              AND ($4::text IS NULL OR (CASE WHEN status = 'pending' AND expires_at <= $6 THEN 'expired' ELSE status END) = $4)
              AND ($5::uuid IS NULL OR id < $5::uuid)
            ORDER BY id DESC LIMIT $7`,
          [orgId, viewer.seesAll, viewer.userId, o.status ?? null, after, now, o.limit + 1],
        )
      ).rows;
      return pageOf(
        rows.map((r) => ({ ...approvalDto(r, now) })),
        o.limit,
      );
    });
  }

  async get(
    orgId: string,
    id: string,
    viewer: { userId: string; seesAll: boolean },
    now = new Date(),
  ): Promise<SpendApprovalDto> {
    return this.db.withOrg(orgId, async (c) => {
      const r = (
        await c.query(`SELECT * FROM billing.spend_approvals WHERE id = $1 AND org_id = $2`, [
          id,
          orgId,
        ])
      ).rows[0];
      if (!r || (!viewer.seesAll && r.requester_user_id !== viewer.userId))
        throw new ProblemException('not_found');
      return approvalDto(r, now);
    });
  }

  async decide(
    orgId: string,
    id: string,
    decider: string,
    input: Record<string, unknown>,
    now = new Date(),
  ): Promise<SpendApprovalDto> {
    if (input.decision !== 'approve' && input.decision !== 'deny')
      throw new ProblemException('validation_failed', "decision must be 'approve' or 'deny'");
    if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 500))
      throw new ProblemException('validation_failed', 'note must be at most 500 characters');
    const status = input.decision === 'approve' ? 'approved' : 'denied';
    const result = await this.db.withOrg(orgId, async (c) => {
      const r = (
        await c.query(
          `SELECT * FROM billing.spend_approvals WHERE id = $1 AND org_id = $2 FOR UPDATE`,
          [id, orgId],
        )
      ).rows[0];
      if (!r) throw new ProblemException('not_found');
      if (r.status !== 'pending')
        throw new ProblemException('conflict', `this approval is already ${r.status as string}`);
      // (the row is moved to 'expired' by the next request for this subject; a failed decision writes nothing)
      if ((r.expires_at as Date).getTime() <= now.getTime())
        throw new ProblemException(
          'conflict',
          'this approval request has expired; request it again',
        );
      if (r.four_eyes && r.requester_user_id === decider)
        throw new ProblemException(
          'forbidden',
          'a second person must decide this request (four-eyes)',
        );
      const u = (
        await c.query(
          `UPDATE billing.spend_approvals SET status = $2, decided_by = $3, decided_at = $4, decision_note = $5
            WHERE id = $1 RETURNING *`,
          [id, status, decider, now, typeof input.note === 'string' ? input.note : null],
        )
      ).rows[0]!;
      await this.audit.record({
        action: 'billing.spend_approval.decided',
        actorUserId: decider,
        orgId,
        resource: { type: 'spend_approval', id },
        outcome: 'success',
        after: {
          decision: status,
          amountMinor: String(u.amount_minor),
          currency: (u.currency as string).trim(),
        },
      });
      return approvalDto(u, now);
    });
    await this.safeNotify({
      orgId,
      kind: 'decided',
      approvalId: id,
      recipients: [result.requesterUserId],
      params: { approvalId: id, decision: status },
    });
    return result;
  }
}
