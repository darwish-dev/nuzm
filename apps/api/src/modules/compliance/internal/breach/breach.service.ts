import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../../common/pagination';
import {
  BREACH_STATES,
  canMove,
  SEVERITIES,
  timersFor,
  type BreachConfig,
  type BreachState,
  type BreachTimers,
  type Severity,
} from './state';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABLE = /^[a-z][a-z0-9_]{1,40}\.[a-z][a-z0-9_]{1,60}$/;

export interface TimelineEntry {
  at: string;
  by: string;
  event: 'opened' | 'transition';
  from: BreachState | null;
  to: BreachState;
  note: string | null;
  data: Record<string, unknown> | null;
  idempotencyKey: string | null;
}
export interface BreachDto {
  id: string;
  severity: Severity;
  state: BreachState;
  summary: string;
  detectedAt: string;
  linkedIncidentId: string | null;
  assessment: Record<string, unknown> | null;
  decision: Record<string, unknown> | null;
  timeline: TimelineEntry[];
  timers: BreachTimers;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  evidencePack?: Record<string, unknown>;
}

const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);

/**
 * Breach cases (M04 §4 task 14, docs/10 §6). A case moves through fixed states; the timeline is appended to (a database guard refuses edits); the
 * decision to notify and any notification are HUMAN steps recorded here: the platform never contacts a regulator, a customer or anyone else.
 * The person who decides about notification is not the person who assessed the case. Timers are placeholders (HG-04-01) and are only shown.
 */
export class BreachService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly cfg: BreachConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private dto(r: Row): BreachDto {
    return {
      id: r.id as string,
      severity: r.severity as Severity,
      state: r.state as BreachState,
      summary: r.summary as string,
      detectedAt: iso(r.detected_at)!,
      linkedIncidentId: (r.linked_incident_id as string | null) ?? null,
      assessment: (r.assessment as Record<string, unknown> | null) ?? null,
      decision: (r.decision as Record<string, unknown> | null) ?? null,
      timeline: r.timeline as TimelineEntry[],
      timers: timersFor(r.detected_at as Date, r.state as BreachState, this.cfg, this.clock()),
      version: r.version as number,
      createdBy: r.created_by as string,
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
      closedAt: iso(r.closed_at),
    };
  }

  async open(
    actor: string,
    key: string,
    body: Record<string, unknown>,
  ): Promise<{ case: BreachDto; created: boolean }> {
    const errors: { field: string; message: string }[] = [];
    const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
    if (summary.length < 10 || summary.length > 2000)
      errors.push({ field: 'summary', message: 'must be 10..2000 characters' });
    if (!SEVERITIES.includes(body.severity as Severity))
      errors.push({ field: 'severity', message: `must be one of ${SEVERITIES.join(', ')}` });
    const detected = typeof body.detectedAt === 'string' ? new Date(body.detectedAt) : null;
    if (!detected || Number.isNaN(detected.getTime()))
      errors.push({ field: 'detectedAt', message: 'must be a date-time' });
    else if (detected.getTime() > this.clock().getTime() + 5 * 60_000)
      errors.push({ field: 'detectedAt', message: 'cannot be in the future' });
    const linked = body.linkedIncidentId ?? null;
    if (linked !== null && (typeof linked !== 'string' || !/^[A-Za-z0-9:_.-]{1,128}$/.test(linked)))
      errors.push({
        field: 'linkedIncidentId',
        message: 'must be an opaque id (1..128 characters)',
      });
    if (errors.length)
      throw new ProblemException('validation_failed', 'invalid breach case', errors);
    const id = uuidv7();
    const now = this.clock();
    const first: TimelineEntry = {
      at: now.toISOString(),
      by: actor,
      event: 'opened',
      from: null,
      to: 'detected',
      note: null,
      data: null,
      idempotencyKey: key,
    };
    return this.db.withPlatformScope(async (c) => {
      const replay = (
        await c.query(
          `SELECT * FROM compliance.breach_cases WHERE created_by = $1 AND idempotency_key = $2`,
          [actor, key],
        )
      ).rows[0];
      if (replay) {
        if (replay.summary !== summary || replay.severity !== body.severity)
          throw new ProblemException(
            'idempotency_key_reuse',
            'this Idempotency-Key was used with different content',
          );
        return { case: this.dto(replay), created: false };
      }
      const row = (
        await c.query(
          `INSERT INTO compliance.breach_cases (id, severity, summary, detected_at, timeline, linked_incident_id, created_by, idempotency_key)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING *`,
          [id, body.severity, summary, detected, JSON.stringify([first]), linked, actor, key],
        )
      ).rows[0]!;
      await this.audit.record({
        action: 'compliance.breach.opened',
        actorUserId: actor,
        resource: { type: 'breach_case', id },
        outcome: 'success',
        after: {
          severity: body.severity,
          detectedAt: detected!.toISOString(),
          linkedIncidentId: linked,
        },
      });
      return { case: this.dto(row), created: true };
    });
  }

  /** Validate the data a transition carries; returns what is stored on the case (assessment or decision) and in the timeline. */
  private parseData(
    to: BreachState,
    d: Record<string, unknown>,
    actor: string,
    prior: Row,
  ): {
    assessment?: Record<string, unknown>;
    decision?: Record<string, unknown>;
    severity?: Severity;
    timeline: Record<string, unknown> | null;
  } {
    const errors: { field: string; message: string }[] = [];
    const bad = (field: string, message: string) =>
      errors.push({ field: `data.${field}`, message });
    const text = (k: string, lo: number, hi: number) => {
      const v = d[k];
      if (typeof v !== 'string' || v.trim().length < lo || v.trim().length > hi) {
        bad(k, `must be ${lo}..${hi} characters`);
        return '';
      }
      return v.trim();
    };
    const list = (k: string, max: number, ok: (x: string) => boolean, optional = true) => {
      const v = d[k] ?? (optional ? [] : undefined);
      if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || !ok(x))) {
        bad(k, `must be a list of at most ${max} valid values`);
        return [];
      }
      return v as string[];
    };
    let out: ReturnType<BreachService['parseData']> = { timeline: null };
    if (to === 'triaged') {
      if (d.severity !== undefined && !SEVERITIES.includes(d.severity as Severity))
        bad('severity', `must be one of ${SEVERITIES.join(', ')}`);
      out = {
        severity: d.severity as Severity | undefined,
        timeline: d.severity ? { severity: d.severity } : null,
      };
    } else if (to === 'assessed') {
      if (typeof d.personalDataAffected !== 'boolean')
        bad('personalDataAffected', 'must be true or false');
      const scope = text('scope', 10, 1000);
      const dataClasses = list('dataClasses', 6, (x) => /^[a-z][a-z-]{1,40}$/.test(x));
      const regions = list('regions', 20, (x) => /^([A-Z]{2}|in_kingdom|gcc|eu|other)$/.test(x));
      const orgIds = list('orgIds', 100, (x) => UUID.test(x));
      const tables = list('tables', 50, (x) => TABLE.test(x));
      if (d.personalDataAffected === true && dataClasses.length === 0)
        bad('dataClasses', 'name the data classes when personal data is affected');
      const a = {
        personalDataAffected: d.personalDataAffected,
        scope,
        dataClasses,
        regions,
        orgIds: orgIds.map((x) => x.toLowerCase()),
        tables,
        assessedBy: actor,
      };
      out = { assessment: a, timeline: { personalDataAffected: d.personalDataAffected } };
    } else if (to === 'notification_decision') {
      const asm = (prior.assessment ?? {}) as { assessedBy?: string };
      if (asm.assessedBy === actor)
        throw new ProblemException(
          'forbidden',
          'the decision about notification is made by a different person than the one who assessed the case',
        );
      if (typeof d.notify !== 'boolean') bad('notify', 'must be true or false');
      const rationale = text('rationale', 10, 1000);
      const recipients = list('recipients', 20, (x) => x.length >= 2 && x.length <= 120);
      if (d.notify === true && recipients.length === 0)
        bad(
          'recipients',
          'name who is to be notified (people decide this; the platform sends nothing)',
        );
      out = {
        decision: {
          notify: d.notify,
          rationale,
          recipients,
          decidedBy: actor,
          decidedAt: this.clock().toISOString(),
        },
        timeline: { notify: d.notify },
      };
    } else if (to === 'notified') {
      const reference = text('reference', 3, 300);
      let notifiedAt: string | null = null;
      if (typeof d.notifiedAt !== 'string' || Number.isNaN(Date.parse(d.notifiedAt)))
        bad('notifiedAt', 'must be a date-time');
      else if (Date.parse(d.notifiedAt) > this.clock().getTime() + 5 * 60_000)
        bad('notifiedAt', 'cannot be in the future');
      else notifiedAt = new Date(d.notifiedAt).toISOString();
      const dec = {
        ...((prior.decision ?? {}) as Record<string, unknown>),
        notification: { notifiedAt, reference, recordedBy: actor },
      };
      out = { decision: dec, timeline: { notifiedAt, reference } };
    } else if (to === 'remediation') {
      out = { timeline: null };
    }
    if (errors.length)
      throw new ProblemException('validation_failed', 'invalid transition data', errors);
    return out;
  }

  /** One POST for every move: `{caseId, transition: <target state>, baseVersion, note?, data?}`. */
  async transition(actor: string, key: string, body: Record<string, unknown>): Promise<BreachDto> {
    const id = typeof body.caseId === 'string' ? body.caseId.toLowerCase() : '';
    if (!UUID.test(id)) throw new ProblemException('validation_failed', 'caseId must be a case id');
    const to = body.transition;
    if (
      typeof to !== 'string' ||
      !(BREACH_STATES as readonly string[]).includes(to) ||
      to === 'detected'
    )
      throw new ProblemException(
        'validation_failed',
        `transition must be one of ${BREACH_STATES.slice(1).join(', ')}`,
      );
    const base = body.baseVersion;
    if (!Number.isInteger(base) || (base as number) < 1)
      throw new ProblemException(
        'validation_failed',
        'baseVersion must be the current version of the case',
      );
    const note = body.note === undefined || body.note === null ? null : body.note;
    if (
      note !== null &&
      (typeof note !== 'string' || note.trim().length < 1 || note.trim().length > 1000)
    )
      throw new ProblemException('validation_failed', 'note must be 1..1000 characters');
    if ((to === 'remediation' || to === 'closed') && note === null)
      throw new ProblemException('validation_failed', `a note is required to move to ${to}`, [
        {
          field: 'note',
          message: to === 'closed' ? 'state the outcome' : 'state the actions taken or planned',
        },
      ]);
    const data = body.data === undefined || body.data === null ? {} : body.data;
    if (typeof data !== 'object' || Array.isArray(data))
      throw new ProblemException('validation_failed', 'data must be an object');
    return this.db.withPlatformScope(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`breach:${id}`]);
      const cur = (await c.query(`SELECT * FROM compliance.breach_cases WHERE id = $1`, [id]))
        .rows[0];
      if (!cur) throw new ProblemException('not_found', 'breach case not found');
      const timeline = cur.timeline as TimelineEntry[];
      if (timeline.some((t) => t.idempotencyKey === key && t.by === actor)) return this.dto(cur); // replay
      if (cur.version !== base)
        throw new ProblemException(
          'conflict',
          `the case is at version ${cur.version}; reload and send baseVersion ${cur.version}`,
        );
      const from = cur.state as BreachState;
      if (!canMove(from, to as BreachState))
        throw new ProblemException('conflict', `a case in ${from} cannot move to ${to}`);
      const decided = (cur.decision as { notify?: boolean } | null)?.notify;
      if (from === 'notification_decision' && to === 'notified' && decided !== true)
        throw new ProblemException('conflict', 'no notification was decided: move to remediation');
      if (from === 'notification_decision' && to === 'remediation' && decided !== false)
        throw new ProblemException(
          'conflict',
          'notification was decided: record it as notified first',
        );
      const parsed = this.parseData(to as BreachState, data as Record<string, unknown>, actor, cur);
      const entry: TimelineEntry = {
        at: this.clock().toISOString(),
        by: actor,
        event: 'transition',
        from,
        to: to as BreachState,
        note: note === null ? null : (note as string).trim(),
        data: parsed.timeline,
        idempotencyKey: key,
      };
      const row = (
        await c.query(
          `UPDATE compliance.breach_cases SET state = $2, timeline = $3::jsonb,
             assessment = coalesce($4::jsonb, assessment), decision = coalesce($5::jsonb, decision), severity = coalesce($6, severity),
             closed_at = CASE WHEN $2 = 'closed' THEN $7::timestamptz ELSE closed_at END
           WHERE id = $1 RETURNING *`,
          [
            id,
            to,
            JSON.stringify([...timeline, entry]),
            parsed.assessment ? JSON.stringify(parsed.assessment) : null,
            parsed.decision ? JSON.stringify(parsed.decision) : null,
            parsed.severity ?? null,
            this.clock(),
          ],
        )
      ).rows[0]!;
      await this.audit.record({
        action: 'compliance.breach.transition',
        actorUserId: actor,
        resource: { type: 'breach_case', id },
        outcome: 'success',
        before: { state: from },
        after: { state: to },
        detail: { version: row.version },
      });
      return this.dto(row);
    });
  }

  async list(
    q: {
      id?: string;
      state?: string;
      severity?: string;
      pack?: boolean;
      reason?: string;
      limit: number;
      cursor?: unknown;
    },
    actor: string,
  ): Promise<Page<BreachDto>> {
    if (q.state !== undefined && !(BREACH_STATES as readonly string[]).includes(q.state))
      throw new ProblemException(
        'validation_failed',
        `state must be one of ${BREACH_STATES.join(', ')}`,
      );
    if (q.severity !== undefined && !SEVERITIES.includes(q.severity as Severity))
      throw new ProblemException(
        'validation_failed',
        `severity must be one of ${SEVERITIES.join(', ')}`,
      );
    if (q.id !== undefined && !UUID.test(q.id))
      throw new ProblemException('validation_failed', 'id must be a case id');
    if (q.pack) {
      if (!q.id)
        throw new ProblemException(
          'validation_failed',
          'the evidence pack is for one case: send id',
        );
      const reason = (q.reason ?? '').trim();
      if (reason.length < 10 || reason.length > 300)
        throw new ProblemException(
          'validation_failed',
          'a cross-organization read needs a reason (10..300 characters)',
          [{ field: 'reason', message: 'is required for the evidence pack' }],
        );
    }
    const cursor = decodeCursor(q.cursor);
    const page = await this.db.withPlatformScope(async (c) => {
      const args: unknown[] = [];
      const where: string[] = [];
      if (q.id) where.push(`id = $${args.push(q.id.toLowerCase())}`);
      if (q.state) where.push(`state = $${args.push(q.state)}`);
      if (q.severity) where.push(`severity = $${args.push(q.severity)}`);
      if (cursor) where.push(`id < $${args.push(cursor)}`);
      const rows = (
        await c.query(
          `SELECT * FROM compliance.breach_cases ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${q.limit + 1}`,
          args,
        )
      ).rows;
      return pageOf(
        rows.map((r) => this.dto(r)),
        q.limit,
      );
    });
    if (q.pack) {
      const one = page.items[0];
      if (!one) throw new ProblemException('not_found', 'breach case not found');
      one.evidencePack = await this.evidencePack(one, actor, (q.reason ?? '').trim());
    }
    return page;
  }

  /**
   * The evidence pack: the case, its timeline, and for each organization named in the assessment the audit activity from `evidence_lookback_hours`
   * before detection until now (counts per action and outcome, first and last time). It reads across organizations, so it needs a reason and is audited.
   * The digest covers everything except the time it was generated.
   */
  private async evidencePack(
    c: BreachDto,
    actor: string,
    reason: string,
  ): Promise<Record<string, unknown>> {
    const from = new Date(Date.parse(c.detectedAt) - this.cfg.evidenceLookbackHours * 3_600_000);
    const orgIds = ((c.assessment?.orgIds as string[] | undefined) ?? []).slice(0, 100);
    const orgs = await this.db.withPlatformScope(async (cl) => {
      const out: {
        orgId: string;
        activity: {
          action: string;
          outcome: string;
          events: number;
          first: string;
          last: string;
        }[];
      }[] = [];
      for (const orgId of orgIds) {
        const rows = (
          await cl.query(
            `SELECT action, outcome, count(*)::int AS events, min(occurred_at) AS first, max(occurred_at) AS last
               FROM audit.audit_logs WHERE org_id = $1 AND occurred_at >= $2 GROUP BY action, outcome ORDER BY action, outcome`,
            [orgId, from],
          )
        ).rows;
        out.push({
          orgId,
          activity: rows.map((r) => ({
            action: r.action as string,
            outcome: r.outcome as string,
            events: r.events as number,
            first: iso(r.first)!,
            last: iso(r.last)!,
          })),
        });
      }
      return out;
    });
    const body = {
      case: {
        id: c.id,
        severity: c.severity,
        state: c.state,
        summary: c.summary,
        detectedAt: c.detectedAt,
        linkedIncidentId: c.linkedIncidentId,
      },
      window: { from: from.toISOString(), lookbackHours: this.cfg.evidenceLookbackHours },
      assessment: c.assessment,
      decision: c.decision,
      timeline: c.timeline,
      tables: (c.assessment?.tables as string[] | undefined) ?? [],
      organizations: orgs,
      note: 'Compiled from the audit trail for people to review. The platform notifies no regulator, customer or other party.',
    };
    const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    await this.audit.record({
      action: 'compliance.breach.evidence_pack',
      actorUserId: actor,
      resource: { type: 'breach_case', id: c.id },
      outcome: 'success',
      detail: { reason, organizations: orgIds.length, digest },
    });
    return { generatedAt: this.clock().toISOString(), digest, ...body };
  }
}
