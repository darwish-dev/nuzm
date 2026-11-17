import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';
import { RECON_TYPES, RECONCILERS, type Ctx, type ReconType, type Sources } from './reconcilers';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACTIONS = ['assign', 'adjustment', 'accept'] as const;
type Action = (typeof ACTIONS)[number];

export interface RunDto {
  id: string;
  type: ReconType;
  periodFrom: string;
  periodTo: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  trigger: 'manual' | 'scheduled';
  itemsChecked: number;
  breaksCount: number;
  openBreaks: number;
  summary: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}
export interface ItemDto {
  id: string;
  runId: string;
  type: ReconType;
  matchKey: string;
  kind: string;
  relatedOrg: string | null;
  details: Record<string, unknown>;
  status: 'open' | 'assigned' | 'resolved';
  assignedTo: string | null;
  assignedAt: string | null;
  resolvedAt: string | null;
  overSla: boolean;
  createdAt: string;
  resolutions: {
    id: string;
    action: Action;
    adjustmentId: string | null;
    note: string | null;
    createdBy: string;
    createdAt: string;
  }[];
}
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDay = (s: string, n: number) =>
  ymd(new Date(Date.parse(`${s}T00:00:00Z`) + n * 86_400_000));

export interface FinrecOptions {
  rc03Bps: number;
  rc04Bps: number;
  /** Open breaks older than this many days raise an alert (docs/11 proposes 5 business days; calendar days here, [VERIFY D-31]). */
  slaDays: number;
}
export function finrecOptsFromEnv(env: NodeJS.ProcessEnv = process.env): FinrecOptions {
  const n = (k: string, d: number, max: number) => {
    const v = Number(env[k] ?? d);
    if (!Number.isInteger(v) || v < 0 || v > max)
      throw new Error(`${k} must be an integer 0..${max}`);
    return v;
  };
  return {
    rc03Bps: n('FINREC_RC03_TOLERANCE_BPS', 0, 10_000),
    rc04Bps: n('FINREC_RC04_TOLERANCE_BPS', 0, 10_000),
    slaDays: n('FINREC_SLA_DAYS', 7, 90),
  };
}

/**
 * Financial reconciliation (docs/11 §9). Runs are requested (manual, 202) or scheduled (daily, for the previous day); a run reads two independent
 * sources and records BREAKS as items. Results are immutable; the break workflow is open → assigned → resolved, and a resolution links an
 * APPROVED adjustment (the two-person flow of M02) or accepts the variance with a note. Reconciliation never edits the ledger.
 * Only one run per (type, period) may be in progress: a second request is a 409.
 */
export class FinrecService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly sources: Sources,
    private readonly zatca: Ctx['zatca'],
    private readonly opts: FinrecOptions,
  ) {}

  private dto(r: Row, open = 0): RunDto {
    return {
      id: r.id as string,
      type: r.type as ReconType,
      periodFrom: String(r.period_from_t ?? r.period_from),
      periodTo: String(r.period_to_t ?? r.period_to),
      status: r.status as RunDto['status'],
      trigger: r.trigger as RunDto['trigger'],
      itemsChecked: r.items_checked as number,
      breaksCount: r.breaks_count as number,
      openBreaks: open,
      summary: r.summary as Record<string, unknown>,
      error: (r.error as string | null) ?? null,
      createdAt: (r.created_at as Date).toISOString(),
      startedAt: r.started_at ? (r.started_at as Date).toISOString() : null,
      completedAt: r.completed_at ? (r.completed_at as Date).toISOString() : null,
    };
  }
  private static readonly COLS = `*, period_from::text AS period_from_t, period_to::text AS period_to_t`;

  // ---- request / process ---------------------------------------------------------------------------------------------------

  async request(
    actorUserId: string | null,
    input: Record<string, unknown>,
    trigger: 'manual' | 'scheduled' = 'manual',
    now = new Date(),
  ): Promise<RunDto[]> {
    for (const k of Object.keys(input))
      if (!['types', 'periodFrom', 'periodTo'].includes(k))
        throw new ProblemException('validation_failed', `unknown field ${k}`);
    const types = input.types;
    if (
      !Array.isArray(types) ||
      types.length < 1 ||
      types.length > 6 ||
      new Set(types).size !== types.length ||
      types.some((t) => !RECON_TYPES.includes(t as ReconType))
    )
      throw new ProblemException(
        'validation_failed',
        `types must be 1..6 distinct values of ${RECON_TYPES.join(', ')}`,
      );
    const { periodFrom: from, periodTo: to } = input;
    if (
      typeof from !== 'string' ||
      typeof to !== 'string' ||
      !DATE.test(from) ||
      !DATE.test(to) ||
      Number.isNaN(Date.parse(from)) ||
      Number.isNaN(Date.parse(to))
    )
      throw new ProblemException(
        'validation_failed',
        'periodFrom and periodTo must be dates (YYYY-MM-DD)',
      );
    if (to < from)
      throw new ProblemException('validation_failed', 'periodTo must not be before periodFrom');
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 400)
      throw new ProblemException('validation_failed', 'a run covers at most 400 days');
    if (Date.parse(to) > now.getTime() + 86_400_000)
      throw new ProblemException('validation_failed', 'periodTo is in the future');
    const tolerance = { rc03Bps: this.opts.rc03Bps, rc04Bps: this.opts.rc04Bps };
    try {
      const rows = await this.db.withPlatformScope(async (c) => {
        const out: Row[] = [];
        for (const t of types as ReconType[]) {
          const id = uuidv7();
          const r = await c.query(
            `INSERT INTO finrec.reconciliation_runs (id, type, period_from, period_to, trigger, requested_by, tolerance, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT DO NOTHING RETURNING ${FinrecService.COLS}`,
            [id, t, from, to, trigger, actorUserId, JSON.stringify(tolerance), now],
          );
          if (!r.rows[0]) {
            if (trigger === 'scheduled') continue; // already scheduled for this day
            throw new ProblemException(
              'conflict',
              `a run of ${t} for this period is already in progress`,
            );
          }
          out.push(r.rows[0] as Row);
          await this.audit.record({
            action: 'finrec.run.requested',
            ...(actorUserId ? { actorUserId } : { actorType: 'system' as const }),
            resource: { type: 'reconciliation_run', id },
            outcome: 'success',
            after: { type: t, periodFrom: from, periodTo: to, trigger },
          });
        }
        return out;
      });
      return rows.map((r) => this.dto(r));
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException(
          'conflict',
          'a run for one of these types and this period is already in progress',
        );
      throw e;
    }
  }

  /** Run one queued reconciliation: claim it (queued → running), compare, record the items and the totals (running → completed | failed). */
  async process(runId: string, now = new Date()): Promise<RunDto | null> {
    const claimed = (await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `UPDATE finrec.reconciliation_runs SET status = 'running', started_at = $2 WHERE id = $1 AND status = 'queued' RETURNING ${FinrecService.COLS}`,
            [runId, now],
          )
        ).rows[0],
    )) as Row | undefined;
    if (!claimed) return null; // another worker has it, or it is finished
    const type = claimed.type as ReconType;
    const from = String(claimed.period_from_t);
    const to = String(claimed.period_to_t);
    try {
      const det = await this.db.withPlatformScope((c) =>
        RECONCILERS[type]({
          c,
          from,
          to,
          toExclusive: addDay(to, 1),
          tolerance: claimed.tolerance as { rc03Bps: number; rc04Bps: number },
          sources: this.sources,
          zatca: this.zatca,
        }),
      );
      await this.db.withPlatformScope(async (c) => {
        for (const b of det.breaks)
          await c.query(
            `INSERT INTO finrec.reconciliation_items (id, run_id, type, match_key, kind, related_org, details, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (run_id, match_key, kind) DO NOTHING`,
            [
              uuidv7(),
              runId,
              type,
              b.key.slice(0, 300),
              b.kind,
              b.orgId ?? null,
              JSON.stringify(b.details),
              now,
            ],
          );
        await c.query(
          `UPDATE finrec.reconciliation_runs SET status = 'completed', completed_at = $2, items_checked = $3, breaks_count = $4, summary = $5 WHERE id = $1`,
          [runId, now, det.checked, det.breaks.length, JSON.stringify(det.summary)],
        );
        await this.audit.record({
          action: 'finrec.run.completed',
          actorType: 'system',
          resource: { type: 'reconciliation_run', id: runId },
          outcome: det.breaks.length ? 'failure' : 'success',
          detail: { type, checked: det.checked, breaks: det.breaks.length },
        });
      });
    } catch (e) {
      await this.db.withPlatformScope(async (c) => {
        await c.query(
          `UPDATE finrec.reconciliation_runs SET status = 'failed', completed_at = $2, error = $3 WHERE id = $1 AND status = 'running'`,
          [runId, now, (e as Error).message.slice(0, 300)],
        );
        await this.audit.record({
          action: 'finrec.run.failed',
          actorType: 'system',
          resource: { type: 'reconciliation_run', id: runId },
          outcome: 'failure',
          detail: { type },
        });
      });
    }
    return this.get(runId).then((r) => r.run);
  }

  async processQueued(limit = 10, now = new Date()): Promise<number> {
    const ids = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `SELECT id FROM finrec.reconciliation_runs WHERE status = 'queued' ORDER BY created_at LIMIT $1`,
            [limit],
          )
        ).rows,
    );
    let n = 0;
    for (const r of ids) if (await this.process(r.id, now)) n++;
    return n;
  }

  /** Daily schedule: every type for the previous UTC day, once (the database refuses a second scheduled run for the same type and day). */
  async scheduleDaily(now = new Date()): Promise<number> {
    const day = addDay(ymd(now), -1);
    return (
      await this.request(
        null,
        { types: [...RECON_TYPES], periodFrom: day, periodTo: day },
        'scheduled',
        now,
      )
    ).length;
  }

  /** Breaks still unresolved after the SLA raise an alert once (audit event). */
  async slaSweep(now = new Date(), limit = 200): Promise<number> {
    const cutoff = new Date(now.getTime() - this.opts.slaDays * 86_400_000);
    return this.db.withPlatformScope(async (c) => {
      const rows = (
        await c.query(
          `UPDATE finrec.reconciliation_items SET sla_alerted_at = $2 WHERE id IN (SELECT id FROM finrec.reconciliation_items WHERE status <> 'resolved' AND created_at < $1 AND sla_alerted_at IS NULL ORDER BY created_at LIMIT $3) RETURNING id, type, kind, related_org`,
          [cutoff, now, limit],
        )
      ).rows;
      for (const r of rows)
        await this.audit.record({
          action: 'finrec.break.sla_breached',
          actorType: 'system',
          resource: { type: 'reconciliation_item', id: r.id as string },
          outcome: 'failure',
          detail: { type: r.type, kind: r.kind, slaDays: this.opts.slaDays },
        });
      return rows.length;
    });
  }

  /** After a 202: start the queued runs in the background (the scheduler also picks up anything left). Never throws into the request. */
  kick(runIds: string[]): void {
    setImmediate(() => {
      for (const id of runIds) void this.process(id).catch(() => undefined);
    });
  }

  // ---- reads ----------------------------------------------------------------------------------------------------------------

  async list(o: {
    limit: number;
    cursor?: string | undefined;
    type?: string | undefined;
    status?: string | undefined;
  }): Promise<Page<RunDto>> {
    if (o.type !== undefined && !RECON_TYPES.includes(o.type as ReconType))
      throw new ProblemException(
        'validation_failed',
        `type must be one of ${RECON_TYPES.join(', ')}`,
      );
    if (o.status !== undefined && !['queued', 'running', 'completed', 'failed'].includes(o.status))
      throw new ProblemException(
        'validation_failed',
        'status must be queued, running, completed or failed',
      );
    const after = decodeCursor(o.cursor);
    return this.db.withPlatformScope(async (c) => {
      const rows = (
        await c.query(
          `SELECT ${FinrecService.COLS}, (SELECT count(*)::int FROM finrec.reconciliation_items i WHERE i.run_id = r.id AND i.status <> 'resolved') AS open_n FROM finrec.reconciliation_runs r WHERE ($1::text IS NULL OR type = $1) AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR id < $3::uuid) ORDER BY id DESC LIMIT $4`,
          [o.type ?? null, o.status ?? null, after, o.limit + 1],
        )
      ).rows as Row[];
      const p = pageOf(
        rows.map((r) => ({ id: r.id as string, r })),
        o.limit,
      );
      return {
        items: p.items.map((x) => this.dto(x.r, x.r.open_n as number)),
        nextCursor: p.nextCursor,
      };
    });
  }

  async get(
    runId: string,
    o: { itemStatus?: string | undefined; now?: Date } = {},
  ): Promise<{ run: RunDto; items: ItemDto[]; itemsTruncated: boolean }> {
    if (!UUID.test(runId)) throw new ProblemException('not_found');
    if (o.itemStatus !== undefined && !['open', 'assigned', 'resolved'].includes(o.itemStatus))
      throw new ProblemException('validation_failed', 'status must be open, assigned or resolved');
    const now = o.now ?? new Date();
    return this.db.withPlatformScope(async (c) => {
      const r = (
        await c.query(
          `SELECT ${FinrecService.COLS}, (SELECT count(*)::int FROM finrec.reconciliation_items i WHERE i.run_id = r.id AND i.status <> 'resolved') AS open_n FROM finrec.reconciliation_runs r WHERE id = $1`,
          [runId.toLowerCase()],
        )
      ).rows[0] as Row | undefined;
      if (!r) throw new ProblemException('not_found');
      const items = (
        await c.query(
          `SELECT * FROM finrec.reconciliation_items WHERE run_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at, id LIMIT 501`,
          [runId.toLowerCase(), o.itemStatus ?? null],
        )
      ).rows as Row[];
      const res = items.length
        ? ((
            await c.query(
              `SELECT * FROM finrec.reconciliation_resolutions WHERE item_id = ANY($1::uuid[]) ORDER BY created_at, id`,
              [items.slice(0, 500).map((i) => i.id)],
            )
          ).rows as Row[])
        : [];
      return {
        run: this.dto(r, r.open_n as number),
        items: items.slice(0, 500).map((i) => this.itemDto(i, res, now)),
        itemsTruncated: items.length > 500,
      };
    });
  }

  private itemDto(i: Row, resolutions: Row[], now: Date): ItemDto {
    return {
      id: i.id as string,
      runId: i.run_id as string,
      type: i.type as ReconType,
      matchKey: i.match_key as string,
      kind: i.kind as string,
      relatedOrg: (i.related_org as string | null) ?? null,
      details: i.details as Record<string, unknown>,
      status: i.status as ItemDto['status'],
      assignedTo: (i.assigned_to as string | null) ?? null,
      assignedAt: i.assigned_at ? (i.assigned_at as Date).toISOString() : null,
      resolvedAt: i.resolved_at ? (i.resolved_at as Date).toISOString() : null,
      overSla:
        i.status !== 'resolved' &&
        now.getTime() - (i.created_at as Date).getTime() > this.opts.slaDays * 86_400_000,
      createdAt: (i.created_at as Date).toISOString(),
      resolutions: resolutions
        .filter((r) => r.item_id === i.id)
        .map((r) => ({
          id: r.id as string,
          action: r.action as Action,
          adjustmentId: (r.adjustment_id as string | null) ?? null,
          note: (r.note as string | null) ?? null,
          createdBy: r.created_by as string,
          createdAt: (r.created_at as Date).toISOString(),
        })),
    };
  }

  // ---- resolve ---------------------------------------------------------------------------------------------------------------

  /** Break workflow: assign to yourself, resolve with an APPROVED adjustment (linked, never created here), or accept the variance with a note. */
  async resolve(
    actorUserId: string,
    runId: string,
    input: Record<string, unknown>,
    now = new Date(),
  ): Promise<ItemDto> {
    for (const k of Object.keys(input))
      if (!['itemId', 'action', 'adjustmentId', 'note'].includes(k))
        throw new ProblemException('validation_failed', `unknown field ${k}`);
    if (typeof input.itemId !== 'string' || !UUID.test(input.itemId))
      throw new ProblemException('validation_failed', 'itemId must be a uuid');
    if (!ACTIONS.includes(input.action as Action))
      throw new ProblemException(
        'validation_failed',
        `action must be one of ${ACTIONS.join(', ')}`,
      );
    const action = input.action as Action;
    if (
      input.note !== undefined &&
      (typeof input.note !== 'string' || input.note.trim().length < 1 || input.note.length > 500)
    )
      throw new ProblemException('validation_failed', 'note must be 1..500 characters');
    const note = typeof input.note === 'string' ? input.note.trim() : null;
    if (action === 'accept' && !note)
      throw new ProblemException(
        'validation_failed',
        'accepting a variance needs a note that says why',
      );
    if (
      action === 'adjustment' &&
      (typeof input.adjustmentId !== 'string' || !UUID.test(input.adjustmentId))
    )
      throw new ProblemException(
        'validation_failed',
        'adjustmentId (an approved adjustment) is required',
      );
    if (action !== 'adjustment' && input.adjustmentId !== undefined)
      throw new ProblemException(
        'validation_failed',
        'adjustmentId is only for the adjustment action',
      );
    if (!UUID.test(runId)) throw new ProblemException('not_found');
    const itemId = input.itemId.toLowerCase();
    await this.db.withPlatformScope(async (c) => {
      const item = (
        await c.query(`SELECT * FROM finrec.reconciliation_items WHERE id = $1 AND run_id = $2`, [
          itemId,
          runId.toLowerCase(),
        ])
      ).rows[0] as Row | undefined;
      if (!item) throw new ProblemException('not_found', 'no such break in this run');
      if (item.status === 'resolved')
        throw new ProblemException('conflict', 'this break is already resolved');
      if (action === 'assign' && item.assigned_to === actorUserId) return; // idempotent
      if (action === 'adjustment') {
        const adj = (
          await c.query(`SELECT org_id, status FROM billing.adjustment_requests WHERE id = $1`, [
            (input.adjustmentId as string).toLowerCase(),
          ])
        ).rows[0] as Row | undefined;
        if (!adj) throw new ProblemException('not_found', 'adjustment not found');
        if (adj.status !== 'approved')
          throw new ProblemException(
            'conflict',
            `the adjustment is ${adj.status as string}: only an approved adjustment can resolve a break`,
          );
        if (item.related_org && adj.org_id !== item.related_org)
          throw new ProblemException(
            'validation_failed',
            'the adjustment belongs to another organization',
          );
      }
      await c.query(
        `INSERT INTO finrec.reconciliation_resolutions (id, item_id, action, adjustment_id, note, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          uuidv7(),
          itemId,
          action,
          action === 'adjustment' ? (input.adjustmentId as string).toLowerCase() : null,
          note,
          actorUserId,
          now,
        ],
      );
      await c.query(
        action === 'assign'
          ? `UPDATE finrec.reconciliation_items SET status = 'assigned', assigned_to = $2, assigned_at = $3 WHERE id = $1`
          : `UPDATE finrec.reconciliation_items SET status = 'resolved', resolved_at = $3, assigned_to = coalesce(assigned_to, $2), assigned_at = coalesce(assigned_at, $3) WHERE id = $1`,
        [itemId, actorUserId, now],
      );
      await this.audit.record({
        action: `finrec.break.${action === 'assign' ? 'assigned' : action === 'adjustment' ? 'resolved_with_adjustment' : 'variance_accepted'}`,
        actorUserId,
        resource: { type: 'reconciliation_item', id: itemId },
        outcome: 'success',
        detail: { type: item.type, kind: item.kind },
      });
    });
    const full = await this.get(runId, { now });
    return (
      full.items.find((i) => i.id === itemId) ??
      (await this.get(runId, { now })).items.find((i) => i.id === itemId)!
    );
  }
}
