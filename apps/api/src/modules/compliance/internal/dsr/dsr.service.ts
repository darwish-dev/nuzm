import { v7 as uuidv7 } from 'uuid';
import type { Db, OperationsService } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import type { FieldCipher } from '../../../../common/field-crypto';
import { decodeCursor, pageOf, type Page } from '../../../../common/pagination';
import { selfRef } from '../consent.service';
import type { ExportService } from '../exports/export.service';
import type { DsrRegistry, HandlerResult } from './handlers';
import type { LegalHoldGate } from './legal-gate';
import {
  ACTION_OF,
  DSR_TYPES,
  REASONS,
  aggregate,
  isTerminal,
  parseSubject,
  slaState,
  type DsrConfig,
  type DsrStatus,
  type DsrType,
  type ReasonCode,
  type TaskOutcome,
} from './types';

type Row = Record<string, unknown>;
const SUBJECT = /^[A-Za-z0-9:_.-]{1,128}$/;
const DETAILS_COLUMN = 'compliance.dsr_requests.details_enc';
export const DSR_KIND = 'compliance.dsr';

export interface Caller {
  userId: string;
  canManage: boolean;
}
export interface TaskDto {
  handler: string;
  action: string;
  status: string;
  attempts: number;
  reasonCode: string | null;
  reason: { ar: string; en: string } | null;
}
export interface DsrDto {
  id: string;
  type: DsrType;
  subjectRef: string;
  status: DsrStatus;
  receivedAt: string;
  dueAt: string;
  slaState: 'ok' | 'warning' | 'escalated' | 'overdue';
  identityMethod: 'session' | 'org_attestation';
  identityVerifiedAt: string | null;
  hasDetails: boolean;
  reasonCode: string | null;
  reason: { ar: string; en: string } | null;
  outcome: Record<string, unknown> | null;
  tasks: TaskDto[];
  operationId: string | null;
  /** For access and portability: a signed, expiring link to the archive once it is ready (`?download=` on the request). */
  downloadUrl: string | null;
  closedAt: string | null;
}
const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);

export interface DsrPorts {
  /** Tell the organization's owners and admins (in-app); best effort. */
  notifyAdmins: (orgId: string, kind: string, params: Record<string, unknown>) => Promise<void>;
}

/**
 * Data-subject requests (M04 §4 task 10, docs/10 §4). The request is a row; its execution is a `platform.operations` record claimed by `ComplianceJobs`.
 * Identity is verified when the request is made: a member asking about themselves is verified by their session; an administrator asking about anyone else
 * must attest the identity check in writing (422 `dsr_identity_unverified` otherwise). Free-text details are sealed. Erasure never bypasses a legal hold
 * or mandatory retention: those are refused with a recorded reason, and the request is rejected or only partially fulfilled. SLA timers warn and escalate
 * by the share of the time to the deadline that has passed.
 */
export class DsrService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly registry: DsrRegistry,
    private readonly ops: OperationsService,
    private readonly gate: LegalHoldGate,
    private readonly cipher: FieldCipher,
    private readonly exports: ExportService,
    private readonly cfg: DsrConfig,
    private readonly ports: DsrPorts,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // ---- opening a request ----------------------------------------------------------------------------------------------------

  async open(
    orgId: string,
    caller: Caller,
    idempotencyKey: string,
    body: Record<string, unknown>,
  ): Promise<{ request: DsrDto; created: boolean }> {
    const type = body.type;
    if (typeof type !== 'string' || !(DSR_TYPES as readonly string[]).includes(type))
      throw new ProblemException(
        'validation_failed',
        `type must be one of ${DSR_TYPES.join(', ')}`,
      );
    const self = selfRef(caller.userId);
    const ref = body.subjectRef === undefined || body.subjectRef === null ? self : body.subjectRef;
    if (typeof ref !== 'string' || !SUBJECT.test(ref))
      throw new ProblemException('validation_failed', 'subjectRef must be an opaque id');
    let method: 'session' | 'org_attestation' = 'session';
    let note: string | null = null;
    if (ref !== self) {
      if (!caller.canManage)
        throw new ProblemException(
          'forbidden',
          'only an organization administrator can make a request about someone else',
        );
      note = typeof body.identityAttestation === 'string' ? body.identityAttestation.trim() : '';
      if (note.length < 10 || note.length > 500)
        throw new ProblemException(
          'dsr_identity_unverified',
          'a request about another person needs identityAttestation: how the identity of the subject was checked (10..500 characters)',
        );
      method = 'org_attestation';
    }
    const detailsRaw = body.details;
    if (
      detailsRaw !== undefined &&
      detailsRaw !== null &&
      (typeof detailsRaw !== 'object' || Array.isArray(detailsRaw))
    )
      throw new ProblemException('validation_failed', 'details must be an object');
    const details = (detailsRaw ?? null) as { text?: unknown; patch?: unknown } | null;
    if (
      details &&
      ((details.text !== undefined &&
        (typeof details.text !== 'string' || details.text.length > 2000)) ||
        (details.patch !== undefined &&
          (typeof details.patch !== 'object' ||
            details.patch === null ||
            Array.isArray(details.patch))))
    )
      throw new ProblemException(
        'validation_failed',
        'details.text must be at most 2000 characters and details.patch an object',
      );
    if (type === 'correction' && !details?.patch)
      throw new ProblemException(
        'validation_failed',
        'a correction needs details.patch (for example {"displayName": "…"})',
      );
    const now = this.clock();
    const due = new Date(now.getTime() + this.cfg.fulfilDays[type as DsrType] * 86_400_000);
    const id = uuidv7();
    const sealed = details
      ? await this.cipher.encryptJson(details, { column: DETAILS_COLUMN, row: id })
      : null;
    const result = await this.db.withOrg(orgId, async (c) => {
      const replay = (
        await c.query(
          `SELECT * FROM compliance.dsr_requests WHERE requested_by = $1 AND idempotency_key = $2`,
          [caller.userId, idempotencyKey],
        )
      ).rows[0];
      if (replay) return { row: replay, created: false };
      const row = (
        await c.query(
          `INSERT INTO compliance.dsr_requests (id, org_id, subject_ref, type, requested_by, identity_method, identity_note, details_enc, received_at, due_at, idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [id, orgId, ref, type, caller.userId, method, note, sealed, now, due, idempotencyKey],
        )
      ).rows[0]!;
      await this.audit.record({
        action: 'compliance.dsr.opened',
        actorUserId: caller.userId,
        orgId,
        resource: { type: 'dsr_request', id },
        outcome: 'success',
        after: { type, subjectRef: ref, identityMethod: method, dueAt: due.toISOString() },
      });
      return { row, created: true };
    });
    if (!result.created) return { request: await this.view(orgId, result.row), created: false };
    // the execution record; a failure here leaves the request `received` and the periodic job re-creates it
    const op = await this.ops.create(orgId, {
      kind: DSR_KIND,
      input: { requestId: id },
      resourceKind: 'dsr_request',
      resourceId: id,
      createdBy: caller.userId,
      maxAttempts: 5,
    });
    await this.db.withOrg(orgId, (c) =>
      c.query(`UPDATE compliance.dsr_requests SET operation_id = $2 WHERE id = $1`, [id, op.id]),
    );
    return { request: await this.get(orgId, caller, id), created: true };
  }

  // ---- reading ---------------------------------------------------------------------------------------------------------------

  private async view(orgId: string, r: Row): Promise<DsrDto> {
    const tasks = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM compliance.dsr_tasks WHERE request_id = $1 ORDER BY created_at, handler, action`,
            [r.id],
          )
        ).rows,
    );
    const now = this.clock();
    const exportId = (r.outcome as { exportId?: unknown } | null)?.exportId;
    const link =
      typeof exportId === 'string' ? await this.exports.linkIfLive(orgId, exportId) : null;
    const reason = (code: unknown) =>
      typeof code === 'string' && code in REASONS ? REASONS[code as ReasonCode] : null;
    return {
      id: r.id as string,
      type: r.type as DsrType,
      subjectRef: r.subject_ref as string,
      status: r.status as DsrStatus,
      receivedAt: iso(r.received_at)!,
      dueAt: iso(r.due_at)!,
      slaState: isTerminal(r.status as DsrStatus)
        ? 'ok'
        : slaState(r.received_at as Date, r.due_at as Date, now, this.cfg),
      identityMethod: r.identity_method as DsrDto['identityMethod'],
      identityVerifiedAt: iso(r.identity_verified_at),
      hasDetails: r.details_enc !== null,
      reasonCode: (r.reason_code as string | null) ?? null,
      reason: reason(r.reason_code),
      outcome: (r.outcome as Record<string, unknown> | null) ?? null,
      tasks: tasks.map((t: Row) => ({
        handler: t.handler as string,
        action: t.action as string,
        status: t.status as string,
        attempts: t.attempts as number,
        reasonCode: (t.reason_code as string | null) ?? null,
        reason: reason(t.reason_code),
      })),
      operationId: (r.operation_id as string | null) ?? null,
      downloadUrl: link
        ? `/v1/compliance/data-subject-requests/${r.id as string}?download=${encodeURIComponent(link)}`
        : null,
      closedAt: iso(r.closed_at),
    };
  }

  async get(orgId: string, caller: Caller, id: string): Promise<DsrDto> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new ProblemException('not_found', 'request not found');
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM compliance.dsr_requests WHERE id = $1`, [id])).rows[0],
    );
    if (
      !r ||
      (!caller.canManage &&
        r.subject_ref !== selfRef(caller.userId) &&
        r.requested_by !== caller.userId)
    )
      throw new ProblemException('not_found', 'request not found');
    return this.view(orgId, r);
  }

  async list(
    orgId: string,
    caller: Caller,
    q: { status?: string; type?: string; subject?: string; limit: number; cursor?: unknown },
  ): Promise<Page<DsrDto>> {
    if (
      q.status !== undefined &&
      ![
        'received',
        'identity_verified',
        'in_progress',
        'fulfilled',
        'rejected',
        'partially_fulfilled',
      ].includes(q.status)
    )
      throw new ProblemException('validation_failed', 'unknown status');
    if (q.type !== undefined && !(DSR_TYPES as readonly string[]).includes(q.type))
      throw new ProblemException('validation_failed', 'unknown type');
    if (q.subject !== undefined && !SUBJECT.test(q.subject))
      throw new ProblemException('validation_failed', 'subject must be an opaque id');
    const self = selfRef(caller.userId);
    if (!caller.canManage && q.subject !== undefined && q.subject !== self)
      throw new ProblemException('forbidden', 'members can read only their own requests');
    const cursor = decodeCursor(q.cursor);
    const rows = await this.db.withOrg(orgId, async (c) => {
      const args: unknown[] = [];
      const where: string[] = ['true'];
      if (!caller.canManage)
        where.push(
          `(subject_ref = $${args.push(self)} OR requested_by = $${args.push(caller.userId)})`,
        );
      if (q.status) where.push(`status = $${args.push(q.status)}`);
      if (q.type) where.push(`type = $${args.push(q.type)}`);
      if (q.subject) where.push(`subject_ref = $${args.push(q.subject)}`);
      if (cursor) where.push(`id < $${args.push(cursor)}`);
      return (
        await c.query(
          `SELECT * FROM compliance.dsr_requests WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${q.limit + 1}`,
          args,
        )
      ).rows;
    });
    return pageOf(await Promise.all(rows.map((r) => this.view(orgId, r))), q.limit);
  }

  // ---- execution -------------------------------------------------------------------------------------------------------------

  /** Run (or finish) one request. Idempotent and restartable: finished tasks are skipped; a closed request is returned as is. */
  async process(orgId: string, requestId: string): Promise<DsrStatus> {
    const now = () => this.clock();
    const r0 = await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM compliance.dsr_requests WHERE id = $1`, [requestId])).rows[0],
    );
    if (!r0) throw new ProblemException('not_found', 'request not found');
    if (isTerminal(r0.status)) return r0.status;
    // 1. identity
    if (r0.status === 'received') {
      if (!r0.identity_method || (r0.identity_method === 'org_attestation' && !r0.identity_note))
        return this.close(orgId, r0, 'rejected', 'identity_unverified', {});
      await this.db.withOrg(orgId, (c) =>
        c.query(
          `UPDATE compliance.dsr_requests SET status = 'identity_verified', identity_verified_at = $2 WHERE id = $1`,
          [requestId, now()],
        ),
      );
    }
    // 2. in progress
    const cur = await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM compliance.dsr_requests WHERE id = $1`, [requestId])).rows[0],
    );
    if (cur.status === 'identity_verified')
      await this.db.withOrg(orgId, (c) =>
        c.query(`UPDATE compliance.dsr_requests SET status = 'in_progress' WHERE id = $1`, [
          requestId,
        ]),
      );
    const req = (await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM compliance.dsr_requests WHERE id = $1`, [requestId])).rows[0],
    ))!;
    const type = req.type as DsrType;
    const action = ACTION_OF[type];
    const subject = parseSubject(req.subject_ref as string);
    const details = req.details_enc
      ? await this.cipher.decryptJson<{ patch?: Record<string, unknown> }>(
          req.details_enc as string,
          { column: DETAILS_COLUMN, row: requestId },
        )
      : null;
    // 3. tasks
    const handlers = this.registry.all();
    await this.db.withOrg(orgId, async (c) => {
      for (const h of handlers)
        await c.query(
          `INSERT INTO compliance.dsr_tasks (id, request_id, org_id, handler, action) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (request_id, handler, action) DO NOTHING`,
          [uuidv7(), requestId, orgId, h.name, action],
        );
    });
    const exported: { handler: string; result: HandlerResult }[] = [];
    const outcomes: TaskOutcome[] = [];
    for (const h of handlers) {
      const task = (await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `SELECT * FROM compliance.dsr_tasks WHERE request_id = $1 AND handler = $2 AND action = $3`,
              [requestId, h.name, action],
            )
          ).rows[0],
      ))!;
      if (task.status !== 'pending') {
        outcomes.push({
          handler: h.name,
          action,
          status:
            task.status === 'refused'
              ? 'refused'
              : task.status === 'failed'
                ? 'failed'
                : 'succeeded',
          reason: (task.reason_code as ReasonCode | null) ?? null,
        });
        if (action === 'export' && task.status === 'succeeded')
          exported.push({
            handler: h.name,
            result: await h.export({ orgId, subject, now: now(), db: this.db }),
          }); // an archive still needs the data after a restart
        continue;
      }
      const t = await this.runTask(orgId, req, task, h, action, subject, details?.patch ?? {});
      outcomes.push(t.outcome);
      if (t.result && action === 'export') exported.push({ handler: h.name, result: t.result });
    }
    // 4. the archive for access and portability
    const summary: Record<string, unknown> = {
      tasks: outcomes.map((o) => ({ handler: o.handler, status: o.status, reason: o.reason })),
    };
    if (action === 'export') {
      const opId = await this.exports.register(
        orgId,
        req.requested_by as string,
        { scope: 'user', subjectRef: req.subject_ref, dsrRequestId: requestId },
        { orgId, subject, results: exported, now: now() },
      );
      summary.exportId = opId;
    }
    const agg = aggregate(outcomes);
    return this.close(orgId, req, agg.status, agg.reasonCode, summary);
  }

  private async runTask(
    orgId: string,
    req: Row,
    task: Row,
    h: ReturnType<DsrRegistry['all']>[number],
    action: 'export' | 'erase' | 'rectify',
    subject: ReturnType<typeof parseSubject>,
    patch: Record<string, unknown>,
  ) {
    const ctx = { orgId, subject, now: this.clock(), db: this.db };
    let result: HandlerResult | null = null;
    let error: string | null = null;
    let attempts = Number(task.attempts);
    if (action === 'erase') {
      const hold = await this.gate.blocking(orgId, h.datasets);
      if (hold) result = { outcome: 'refused', reason: 'legal_hold_active', summary: { hold } };
    }
    while (!result && attempts < this.cfg.taskMaxAttempts) {
      attempts++;
      try {
        result =
          action === 'export'
            ? await h.export(ctx)
            : action === 'erase'
              ? await h.erase(ctx)
              : await h.rectify(ctx, patch);
      } catch (e) {
        error = (e as Error).message.slice(0, 280);
        await this.db.withOrg(orgId, (c) =>
          c.query(`UPDATE compliance.dsr_tasks SET attempts = $2, error = $3 WHERE id = $1`, [
            task.id,
            attempts,
            error,
          ]),
        );
      }
    }
    const status = result ? (result.outcome === 'refused' ? 'refused' : 'succeeded') : 'failed';
    const reason: ReasonCode | null =
      result?.outcome === 'refused'
        ? result.reason
        : result?.outcome === 'not_applicable'
          ? 'not_applicable'
          : null;
    // the stored summary holds counts and flags only, never the exported personal data
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `UPDATE compliance.dsr_tasks SET status = $2, attempts = $3, reason_code = $4, result = $5::jsonb, error = $6, started_at = coalesce(started_at, $7), finished_at = $7 WHERE id = $1`,
        [
          task.id,
          status,
          attempts,
          reason,
          JSON.stringify(result ? { outcome: result.outcome, ...result.summary } : null),
          status === 'failed' ? error : null,
          this.clock(),
        ],
      ),
    );
    await this.audit.record({
      action: 'compliance.dsr.task_completed',
      actorType: 'system',
      orgId,
      resource: { type: 'dsr_task', id: task.id as string },
      outcome: status === 'failed' ? 'failure' : 'success',
      detail: { requestId: req.id, handler: h.name, action, status, reason, attempts },
    });
    return {
      outcome: {
        handler: h.name,
        action,
        status,
        reason,
      } as TaskOutcome,
      result,
    };
  }

  private async close(
    orgId: string,
    req: Row,
    status: 'fulfilled' | 'rejected' | 'partially_fulfilled',
    reason: ReasonCode | null,
    summary: Record<string, unknown>,
  ): Promise<DsrStatus> {
    // a request that is rejected before it started goes received -> rejected (a legal move of the state machine)
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `UPDATE compliance.dsr_requests SET status = $2, reason_code = $3, outcome = $4::jsonb, closed_at = $5 WHERE id = $1`,
        [
          req.id,
          status,
          status === 'rejected' ? reason : null,
          JSON.stringify({
            ...summary,
            ...(reason && status !== 'rejected' ? { note: reason } : {}),
          }),
          this.clock(),
        ],
      ),
    );
    await this.audit.record({
      action: 'compliance.dsr.closed',
      actorType: 'system',
      orgId,
      resource: { type: 'dsr_request', id: req.id as string },
      outcome: 'success',
      detail: { type: req.type, status, reason },
    });
    return status;
  }

  // ---- timers ----------------------------------------------------------------------------------------------------------------

  /**
   * SLA sweep (docs/10 §4): warn the organization's owners and admins at `warn_at` of the time to the deadline, escalate at `escalate_at`; each fires once
   * per request. Also repairs a request whose execution record was never created. `now` is a parameter so tests drive a fake clock.
   */
  async sweep(
    now: Date = this.clock(),
  ): Promise<{ warned: number; escalated: number; repaired: number }> {
    const open = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, org_id, type, received_at, due_at, sla_warned_at, sla_escalated_at, operation_id, created_at FROM compliance.dsr_requests WHERE closed_at IS NULL ORDER BY due_at`,
          )
        ).rows,
    );
    let warned = 0;
    let escalated = 0;
    let repaired = 0;
    for (const r of open) {
      const orgId = r.org_id as string;
      const state = slaState(r.received_at, r.due_at, now, this.cfg);
      if (
        (state === 'warning' || state === 'escalated' || state === 'overdue') &&
        !r.sla_warned_at
      ) {
        await this.db.withOrg(orgId, (c) =>
          c.query(
            `UPDATE compliance.dsr_requests SET sla_warned_at = $2 WHERE id = $1 AND sla_warned_at IS NULL`,
            [r.id, now],
          ),
        );
        await this.audit.record({
          action: 'compliance.dsr.sla_warning',
          actorType: 'system',
          orgId,
          resource: { type: 'dsr_request', id: r.id },
          outcome: 'success',
          detail: { dueAt: iso(r.due_at), type: r.type },
        });
        await this.ports
          .notifyAdmins(orgId, 'compliance.dsr_sla_warning', {
            requestId: r.id,
            dueAt: iso(r.due_at),
          })
          .catch(() => undefined);
        warned++;
      }
      if ((state === 'escalated' || state === 'overdue') && !r.sla_escalated_at) {
        await this.db.withOrg(orgId, (c) =>
          c.query(
            `UPDATE compliance.dsr_requests SET sla_escalated_at = $2 WHERE id = $1 AND sla_escalated_at IS NULL`,
            [r.id, now],
          ),
        );
        await this.audit.record({
          action: 'compliance.dsr.escalated',
          actorType: 'system',
          orgId,
          resource: { type: 'dsr_request', id: r.id },
          outcome: 'failure',
          detail: { dueAt: iso(r.due_at), type: r.type, state },
        });
        await this.ports
          .notifyAdmins(orgId, 'compliance.dsr_sla_escalation', {
            requestId: r.id,
            dueAt: iso(r.due_at),
          })
          .catch(() => undefined);
        escalated++;
      }
      if (!r.operation_id && now.getTime() - (r.created_at as Date).getTime() > 60_000) {
        const op = await this.ops.create(orgId, {
          kind: DSR_KIND,
          input: { requestId: r.id },
          resourceKind: 'dsr_request',
          resourceId: r.id,
          maxAttempts: 5,
        });
        await this.db.withOrg(orgId, (c) =>
          c.query(
            `UPDATE compliance.dsr_requests SET operation_id = $2 WHERE id = $1 AND operation_id IS NULL`,
            [r.id, op.id],
          ),
        );
        repaired++;
      }
    }
    return { warned, escalated, repaired };
  }
}
