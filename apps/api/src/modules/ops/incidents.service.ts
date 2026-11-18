import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../common/audit';
import { ProblemException } from '../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../common/pagination';
import { UUID_RE, assertNoPii, fail, str, type Row } from './common';

export const SEVERITIES = ['SEV1', 'SEV2', 'SEV3', 'SEV4'] as const;
export const STATUSES = [
  'open',
  'investigating',
  'identified',
  'monitoring',
  'resolved',
  'closed',
] as const;
type Status = (typeof STATUSES)[number];
/** Forward progress, plus reopening a RESOLVED incident; `closed` is terminal. */
const NEXT: Record<Status, Status[]> = {
  open: ['investigating', 'identified', 'monitoring', 'resolved'],
  investigating: ['identified', 'monitoring', 'resolved'],
  identified: ['monitoring', 'resolved'],
  monitoring: ['resolved', 'investigating'],
  resolved: ['closed', 'investigating'],
  closed: [],
};

export interface IncidentDto {
  id: string;
  severity: string;
  title: string;
  status: string;
  components: string[];
  summary: string | null;
  breachCaseId: string | null;
  openedBy: string;
  openedAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  version: number;
  timeline: {
    id: string;
    kind: string;
    body: string | null;
    statusTo: string | null;
    severityTo: string | null;
    author: string;
    at: string;
  }[];
}
const dto = (r: Row, ups: Row[]): IncidentDto => ({
  id: r.id as string,
  severity: r.severity as string,
  title: r.title as string,
  status: r.status as string,
  components: r.components as string[],
  summary: (r.summary as string | null) ?? null,
  breachCaseId: (r.breach_case_id as string | null) ?? null,
  openedBy: r.opened_by as string,
  openedAt: (r.opened_at as Date).toISOString(),
  resolvedAt: r.resolved_at ? (r.resolved_at as Date).toISOString() : null,
  closedAt: r.closed_at ? (r.closed_at as Date).toISOString() : null,
  version: r.version as number,
  timeline: ups.map((u) => ({
    id: u.id as string,
    kind: u.kind as string,
    body: (u.body as string | null) ?? null,
    statusTo: (u.status_to as string | null) ?? null,
    severityTo: (u.severity_to as string | null) ?? null,
    author: u.author as string,
    at: (u.created_at as Date).toISOString(),
  })),
});

/** Incident tooling (M12 S57, FR-OPS-07): severity workflow, timeline, breach-case link (M04 workflow owns the case). No raw PII in any record. */
export class IncidentService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  private async withTimeline(c: import('pg').PoolClient, rows: Row[]): Promise<IncidentDto[]> {
    if (!rows.length) return [];
    const ups = (
      await c.query<Row>(
        `SELECT * FROM ops.incident_updates WHERE incident_id = ANY($1::uuid[]) ORDER BY created_at, id`,
        [rows.map((r) => r.id)],
      )
    ).rows;
    return rows.map((r) => dto(r, ups.filter((u) => u.incident_id === r.id).slice(-50)));
  }

  async list(q: {
    status?: string;
    severity?: string;
    limit: number;
    cursor?: unknown;
  }): Promise<Page<IncidentDto>> {
    if (q.status && !(STATUSES as readonly string[]).includes(q.status))
      fail('status', 'unknown status');
    if (q.severity && !(SEVERITIES as readonly string[]).includes(q.severity))
      fail('severity', 'unknown severity');
    const cur = decodeCursor(q.cursor);
    return this.db.withPlatformScope(async (c) => {
      const rows = (
        await c.query<Row>(
          `SELECT * FROM ops.incidents WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR severity = $2) AND ($3::uuid IS NULL OR id < $3) ORDER BY id DESC LIMIT $4`,
          [q.status ?? null, q.severity ?? null, cur, q.limit + 1],
        )
      ).rows;
      const page = pageOf(
        rows.map((r) => ({ id: r.id as string, r })),
        q.limit,
      );
      const items = await this.withTimeline(
        c,
        page.items.map((x) => x.r),
      );
      return { items, nextCursor: page.nextCursor };
    });
  }

  async open(
    by: string,
    key: string,
    body: Row,
  ): Promise<{ created: boolean; incident: IncidentDto }> {
    const severity = (SEVERITIES as readonly string[]).includes(String(body.severity))
      ? (body.severity as string)
      : fail('severity', 'severity must be SEV1..SEV4');
    const title = str(body, 'title', 3, 200)!;
    const summary = str(body, 'summary', 1, 2000, false) ?? null;
    const comps = body.components === undefined ? [] : body.components;
    if (
      !Array.isArray(comps) ||
      comps.length > 30 ||
      comps.some((x) => typeof x !== 'string' || !/^[a-z][a-z0-9_.:-]{1,60}$/.test(x))
    )
      fail('components', 'components must be a list of component keys (lowercase)');
    const breach =
      body.breachCaseId === undefined || body.breachCaseId === null
        ? null
        : typeof body.breachCaseId === 'string' && UUID_RE.test(body.breachCaseId)
          ? body.breachCaseId
          : fail('breachCaseId', 'must be a breach case id');
    return this.db.withPlatformScope(async (c) => {
      const prior = (
        await c.query<Row>(
          `SELECT * FROM ops.incidents WHERE opened_by = $1 AND idempotency_key = $2`,
          [by, key],
        )
      ).rows[0];
      if (prior) return { created: false, incident: (await this.withTimeline(c, [prior]))[0]! };
      if (
        breach &&
        !(await c.query(`SELECT 1 FROM compliance.breach_cases WHERE id = $1`, [breach])).rowCount
      )
        throw new ProblemException('validation_failed', 'unknown breach case', [
          { field: 'breachCaseId', message: 'not found' },
        ]);
      const id = uuidv7();
      const row = (
        await c.query<Row>(
          `INSERT INTO ops.incidents (id, severity, title, components, summary, breach_case_id, opened_by, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [id, severity, title, comps, summary, breach, by, key],
        )
      ).rows[0]!;
      await c.query(
        `INSERT INTO ops.incident_updates (id, incident_id, kind, body, status_to, severity_to, author) VALUES ($1,$2,'opened',$3,'open',$4,$5)`,
        [uuidv7(), id, summary, severity, by],
      );
      if (breach)
        await c.query(
          `INSERT INTO ops.incident_updates (id, incident_id, kind, body, author) VALUES ($1,$2,'breach_link',$3,$4)`,
          [uuidv7(), id, `linked breach case ${breach}`, by],
        );
      await this.audit.record({
        action: 'ops.incident.opened',
        actorUserId: by,
        resource: { type: 'incident', id },
        outcome: 'success',
        after: { severity, components: comps, breachCaseId: breach },
      });
      return { created: true, incident: (await this.withTimeline(c, [row]))[0]! };
    });
  }

  async update(by: string, id: string, body: Row): Promise<IncidentDto> {
    if (!UUID_RE.test(id)) throw new ProblemException('not_found');
    const note = str(body, 'note', 1, 4000, false);
    const comms = str(body, 'commsDraft', 1, 4000, false);
    const sev =
      body.severity === undefined
        ? undefined
        : (SEVERITIES as readonly string[]).includes(String(body.severity))
          ? (body.severity as string)
          : fail('severity', 'SEV1..SEV4');
    const st =
      body.status === undefined
        ? undefined
        : (STATUSES as readonly string[]).includes(String(body.status))
          ? (body.status as Status)
          : fail('status', 'unknown status');
    const breach =
      body.breachCaseId === undefined
        ? undefined
        : typeof body.breachCaseId === 'string' && UUID_RE.test(body.breachCaseId)
          ? body.breachCaseId
          : fail('breachCaseId', 'must be a breach case id');
    if (!note && !comms && !sev && !st && !breach) fail('body', 'nothing to change');
    let closedNow = false;
    const out = await this.db.withPlatformScope(async (c) => {
      const cur = (await c.query<Row>(`SELECT * FROM ops.incidents WHERE id = $1 FOR UPDATE`, [id]))
        .rows[0];
      if (!cur) throw new ProblemException('not_found');
      if (cur.status === 'closed')
        throw new ProblemException('invalid_state', 'a closed incident cannot change');
      if (st && st !== cur.status && !NEXT[cur.status as Status].includes(st))
        throw new ProblemException(
          'invalid_state',
          `cannot go from ${cur.status as string} to ${st}`,
        );
      if (
        breach &&
        !(await c.query(`SELECT 1 FROM compliance.breach_cases WHERE id = $1`, [breach])).rowCount
      )
        throw new ProblemException('validation_failed', 'unknown breach case', [
          { field: 'breachCaseId', message: 'not found' },
        ]);
      const status = st ?? (cur.status as Status);
      await c.query(
        `UPDATE ops.incidents SET status = $2, severity = $3, breach_case_id = coalesce($4, breach_case_id),
           resolved_at = CASE WHEN $2 IN ('resolved','closed') THEN coalesce(resolved_at, now()) ELSE NULL END, closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE NULL END,
           updated_at = now(), version = version + 1 WHERE id = $1`,
        [id, status, sev ?? cur.severity, breach ?? null],
      );
      const add = (kind: string, text: string | null, s: string | null, sv: string | null) =>
        c.query(
          `INSERT INTO ops.incident_updates (id, incident_id, kind, body, status_to, severity_to, author) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [uuidv7(), id, kind, text, s, sv, by],
        );
      if (st && st !== cur.status) await add('status_change', null, st, null);
      if (sev && sev !== cur.severity) await add('severity_change', null, null, sev);
      if (breach) await add('breach_link', `linked breach case ${breach}`, null, null);
      if (note) await add('note', note, null, null);
      if (comms) await add('comms_draft', comms, null, null);
      closedNow = status === 'closed';
      const row = (await c.query<Row>(`SELECT * FROM ops.incidents WHERE id = $1`, [id])).rows[0]!;
      return (await this.withTimeline(c, [row]))[0]!;
    });
    await this.audit.record({
      action: closedNow ? 'ops.incident.closed' : 'ops.incident.updated',
      actorUserId: by,
      resource: { type: 'incident', id },
      outcome: 'success',
      after: { status: out.status, severity: out.severity },
    });
    void assertNoPii;
    return out;
  }
}
