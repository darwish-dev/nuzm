import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../common/audit';
import { ProblemException } from '../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../common/pagination';
import { fail, str, type Row } from './common';

export interface AlertDto {
  id: string;
  ruleKey: string;
  title: string;
  severity: string;
  ownerRole: string;
  runbookUrl: string;
  rule: unknown;
  state: string;
  stateSince: string;
  silencedUntil: string | null;
  lastEvaluatedAt: string | null;
  lastValue: number | null;
  enabled: boolean;
  version: number;
}
const dto = (r: Row): AlertDto => ({
  id: r.id as string,
  ruleKey: r.rule_key as string,
  title: r.title as string,
  severity: r.severity as string,
  ownerRole: r.owner_role as string,
  runbookUrl: r.runbook_url as string,
  rule: r.rule,
  state: r.state as string,
  stateSince: (r.state_since as Date).toISOString(),
  silencedUntil: r.silenced_until ? (r.silenced_until as Date).toISOString() : null,
  lastEvaluatedAt: r.last_evaluated_at ? (r.last_evaluated_at as Date).toISOString() : null,
  lastValue: r.last_value === null ? null : Number(r.last_value),
  enabled: r.enabled as boolean,
  version: r.version as number,
});

export type Metrics = Record<string, number | undefined>;
const OPS: Record<string, (a: number, b: number) => boolean> = {
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
};
const MAX_SILENCE_MS = 30 * 86_400_000;

/**
 * Alert rules and state (FR-OPS-06). Every rule has an owner ROLE, a severity and a runbook link (DB CHECK). `evaluate` is the job body: a metric that is not
 * available leaves the rule NOT EVALUATED (state and value unchanged, `last_evaluated_at` untouched): the platform never reports "ok" for something it did not measure.
 */
export class AlertService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  async list(q: { state?: string; limit: number; cursor?: unknown }): Promise<Page<AlertDto>> {
    if (q.state && !['ok', 'firing', 'acknowledged', 'silenced'].includes(q.state))
      fail('state', 'unknown state');
    const cur = decodeCursor(q.cursor);
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query<Row>(
            `SELECT * FROM ops.alerts WHERE ($1::text IS NULL OR state = $1) AND ($2::uuid IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
            [q.state ?? null, cur, q.limit + 1],
          )
        ).rows,
    );
    return pageOf(rows.map(dto), q.limit);
  }

  /** POST body: {action: define|acknowledge|silence|unsilence, ruleKey, ...}. */
  async act(by: string, body: Row): Promise<{ created: boolean; alert: AlertDto }> {
    const action = String(body.action);
    const ruleKey = str(body, 'ruleKey', 3, 81)!;
    if (!/^[a-z][a-z0-9_.-]{2,80}$/.test(ruleKey)) fail('ruleKey', 'lowercase key');
    return this.db.withPlatformScope(async (c) => {
      if (action === 'define') {
        const title = str(body, 'title', 3, 200)!;
        const severity = ['info', 'warning', 'critical'].includes(String(body.severity))
          ? (body.severity as string)
          : fail('severity', 'info | warning | critical');
        const ownerRole = /^[a-z][a-z_]{2,40}$/.test(String(body.ownerRole))
          ? (body.ownerRole as string)
          : fail('ownerRole', 'a role name, never a person');
        const runbook =
          typeof body.runbookUrl === 'string' &&
          /^(docs\/runbooks\/[a-z0-9._-]+\.md|https:\/\/\S+)$/.test(body.runbookUrl)
            ? body.runbookUrl
            : fail(
                'runbookUrl',
                'every alert needs a runbook (docs/runbooks/<name>.md or https URL)',
              );
        const rule = body.rule as Row | undefined;
        if (
          !rule ||
          typeof rule.metric !== 'string' ||
          !(String(rule.op) in OPS) ||
          typeof rule.threshold !== 'number'
        )
          fail('rule', 'rule must be {metric, op, threshold}');
        const prior = (
          await c.query<Row>(`SELECT * FROM ops.alerts WHERE rule_key = $1`, [ruleKey])
        ).rows[0];
        if (prior) return { created: false, alert: dto(prior) };
        const row = (
          await c.query<Row>(
            `INSERT INTO ops.alerts (id, rule_key, title, severity, owner_role, runbook_url, rule, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [uuidv7(), ruleKey, title, severity, ownerRole, runbook, JSON.stringify(rule), by],
          )
        ).rows[0]!;
        return { created: true, alert: dto(row) };
      }
      const cur = (
        await c.query<Row>(`SELECT * FROM ops.alerts WHERE rule_key = $1 FOR UPDATE`, [ruleKey])
      ).rows[0];
      if (!cur) throw new ProblemException('not_found');
      let row: Row;
      if (action === 'acknowledge') {
        if (cur.state !== 'firing')
          throw new ProblemException('invalid_state', 'only a firing alert can be acknowledged');
        row = (
          await c.query<Row>(
            `UPDATE ops.alerts SET state='acknowledged', acknowledged_by=$2, state_since=now(), version=version+1 WHERE id=$1 RETURNING *`,
            [cur.id, by],
          )
        ).rows[0]!;
      } else if (action === 'silence') {
        const until = typeof body.until === 'string' ? new Date(body.until) : null;
        if (
          !until ||
          Number.isNaN(until.getTime()) ||
          until.getTime() <= Date.now() ||
          until.getTime() > Date.now() + MAX_SILENCE_MS
        )
          fail('until', 'a silence needs an expiry between now and 30 days ahead');
        row = (
          await c.query<Row>(
            `UPDATE ops.alerts SET state='silenced', silenced_until=$2, silenced_by=$3, state_since=now(), version=version+1 WHERE id=$1 RETURNING *`,
            [cur.id, until, by],
          )
        ).rows[0]!;
      } else if (action === 'unsilence') {
        if (cur.state !== 'silenced')
          throw new ProblemException('invalid_state', 'the alert is not silenced');
        row = (
          await c.query<Row>(
            `UPDATE ops.alerts SET state='ok', silenced_until=NULL, silenced_by=NULL, state_since=now(), version=version+1 WHERE id=$1 RETURNING *`,
            [cur.id],
          )
        ).rows[0]!;
      } else return fail('action', 'action must be define, acknowledge, silence or unsilence');
      await this.audit.record({
        action: `ops.alert.${action}`,
        actorUserId: by,
        resource: { type: 'alert', id: ruleKey },
        outcome: 'success',
        before: { state: cur.state },
        after: { state: row.state, silencedUntil: row.silenced_until ?? null },
      });
      return { created: false, alert: dto(row) };
    });
  }

  /** Job body. Returns the rules that changed state. */
  async evaluate(
    metrics: Metrics,
    now = new Date(),
  ): Promise<{ rule: string; from: string; to: string }[]> {
    const changes: { rule: string; from: string; to: string }[] = [];
    await this.db.withWorkerClaim(async (c) => {
      for (const a of (await c.query<Row>(`SELECT * FROM ops.alerts WHERE enabled FOR UPDATE`))
        .rows) {
        const rule = a.rule as { metric: string; op: string; threshold: number };
        const v = metrics[rule.metric];
        let state = a.state as string;
        if (
          state === 'silenced' &&
          a.silenced_until &&
          (a.silenced_until as Date).getTime() <= now.getTime()
        )
          state = 'ok'; // expiry; evaluated below
        if (v === undefined) {
          if (state !== a.state)
            await c.query(
              `UPDATE ops.alerts SET state='ok', silenced_until=NULL, state_since=$2, version=version+1 WHERE id=$1`,
              [a.id, now],
            );
          continue; // NOT EVALUATED
        }
        const breach = OPS[rule.op]!(v, rule.threshold);
        let next: string;
        if (state === 'silenced') next = 'silenced';
        else if (breach) next = state === 'acknowledged' ? 'acknowledged' : 'firing';
        else next = 'ok';
        await c.query(
          `UPDATE ops.alerts SET state=$2, state_since=CASE WHEN $2 <> state THEN $4::timestamptz ELSE state_since END, silenced_until=CASE WHEN $2 = 'silenced' THEN silenced_until ELSE NULL END, last_value=$3, last_evaluated_at=$4, version=version+(CASE WHEN $2 <> state THEN 1 ELSE 0 END) WHERE id=$1`,
          [a.id, next, v, now],
        );
        if (next !== a.state)
          changes.push({ rule: a.rule_key as string, from: a.state as string, to: next });
      }
    });
    return changes;
  }
}
