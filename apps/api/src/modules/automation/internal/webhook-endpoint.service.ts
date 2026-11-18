import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import { SsrfError, checkUrl, isRetryableStatus, signatureHeader, webhookDelaySeconds } from '@nuzm/domain';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';
import type { SecretStore } from '../../../common/secrets';
import { ALLOWED_EVENT_TOPICS, DEFAULT_DATA_REGION, badRequest, isAllowedTopic, isUuid, iso, pgCode, rejectRawSecrets, tenantSecretId, type Row } from './model';
import { EgressHttpPort } from './ports';

export interface WebhookEndpointDto {
  id: string;
  url: string;
  events: string[];
  description: string | null;
  status: 'active' | 'paused' | 'disabled';
  consecutiveFailures: number;
  secretRotation: { overlapUntil: string | null };
  /** Shown ONCE: at creation and when the secret is rotated. */
  secret?: string;
  rotated?: boolean;
  etag: number;
  createdAt: string;
}
export interface DeliveryDto {
  endpointId: string;
  eventId: string;
  topic: string;
  attempts: number;
  status: 'pending' | 'sending' | 'delivered' | 'failed' | 'dead';
  statusCode: number | null;
  error: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
}

const PAUSE_AFTER_FAILURES = 50;

/**
 * Outbound webhook endpoints and deliveries (M11 S52). The URL is validated (https, public address, SSRF policy) when it is registered AND again before every
 * delivery (DNS can change). The signing secret is generated here, kept as a vault reference and shown once; a rotation keeps the previous secret signing alongside the new one
 * until the overlap ends, so a receiver can switch without downtime. Deliveries are append-only rows with retries on an exponential schedule that spans 24 h, then dead.
 */
export class WebhookEndpointService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly secrets: SecretStore,
    private readonly egress: EgressHttpPort,
    private now: () => Date = () => new Date(),
    private readonly random: () => number = Math.random,
  ) {}

  /** Tests only: a controllable clock for the retry schedule. */
  useClock(fn: () => Date) {
    this.now = fn;
  }

  private dto(r: Row, extra: Partial<WebhookEndpointDto> = {}): WebhookEndpointDto {
    return {
      id: r.id, url: r.url, events: r.events, description: r.description ?? null, status: r.status, consecutiveFailures: r.consecutive_failures,
      secretRotation: { overlapUntil: r.previous_secret_expires_at && (r.previous_secret_expires_at as Date) > this.now() ? iso(r.previous_secret_expires_at) : null },
      etag: r.version_lock, createdAt: iso(r.created_at)!, ...extra,
    };
  }

  private validateUrl(u: unknown): string {
    if (typeof u !== 'string') throw badRequest('url is required');
    try {
      return checkUrl(u).url.href;
    } catch (e) {
      if (e instanceof SsrfError) throw new ProblemException('ssrf_denied', e.message);
      throw e;
    }
  }
  private validateEvents(ev: unknown): string[] {
    if (!Array.isArray(ev) || ev.length < 1 || ev.length > 20 || ev.some((x) => !isAllowedTopic(x))) throw badRequest(`events must list 1..20 of: ${ALLOWED_EVENT_TOPICS.join(', ')}`);
    return [...new Set(ev as string[])];
  }
  private newSecret = () => `whsec_${randomBytes(32).toString('hex')}`;

  /** POST /v1/webhook-endpoints. A body whose `url` already belongs to an endpoint of the organization with `secretRotation` rotates that endpoint's secret instead. */
  async create(orgId: string, actor: string, body: Record<string, unknown>): Promise<WebhookEndpointDto> {
    rejectRawSecrets(body);
    for (const k of Object.keys(body)) if (!['url', 'events', 'secretRotation', 'description'].includes(k)) throw badRequest(`unknown field ${k}`);
    const url = this.validateUrl(body.url);
    const rot = body.secretRotation as { overlapHours?: unknown } | undefined;
    if (rot !== undefined && (typeof rot !== 'object' || rot === null || (rot.overlapHours !== undefined && (!Number.isInteger(rot.overlapHours) || (rot.overlapHours as number) < 0 || (rot.overlapHours as number) > 168)))) throw badRequest('secretRotation.overlapHours must be 0..168');
    const events = this.validateEvents(body.events);
    if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 200)) throw badRequest('description must be at most 200 characters');
    const existing = (await this.db.withOrg(orgId, async (c) => (await c.query(`SELECT * FROM automation.webhook_endpoints WHERE org_id = $1 AND url = $2 AND status <> 'disabled'`, [orgId, url])).rows[0])) as Row | undefined;
    const secret = this.newSecret();
    if (existing) {
      if (rot === undefined) throw new ProblemException('name_taken', 'an endpoint with this URL already exists (send secretRotation to rotate its secret)');
      const ref = await this.secrets.put(tenantSecretId(orgId, 'whsec', uuidv7()), secret);
      const overlapHours = (rot.overlapHours as number | undefined) ?? 24;
      const row = (await this.db.withOrg(orgId, async (c) =>
        (await c.query(`UPDATE automation.webhook_endpoints SET previous_secret_vault_ref = secret_vault_ref, previous_secret_expires_at = $3, secret_vault_ref = $2, events = $4 WHERE id = $1 RETURNING *`, [existing.id, ref, new Date(this.now().getTime() + overlapHours * 3_600_000), events])).rows[0],
      )) as Row;
      await this.audit.record({ action: 'webhook.endpoint.secret_rotated', actorUserId: actor, orgId, resource: { type: 'webhook_endpoint', id: row.id }, outcome: 'success', detail: { overlapHours } });
      return this.dto(row, { secret, rotated: true });
    }
    const id = uuidv7();
    const ref = await this.secrets.put(tenantSecretId(orgId, 'whsec', id), secret);
    try {
      const row = (await this.db.withOrg(orgId, async (c) =>
        (await c.query(`INSERT INTO automation.webhook_endpoints (id, org_id, url, events, description, secret_vault_ref, data_region, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [id, orgId, url, events, body.description ?? null, ref, DEFAULT_DATA_REGION, actor])).rows[0],
      )) as Row;
      await this.audit.record({ action: 'webhook.endpoint.created', actorUserId: actor, orgId, resource: { type: 'webhook_endpoint', id }, outcome: 'success', after: { url, events } });
      return this.dto(row, { secret });
    } catch (e) {
      if (pgCode(e) === '23505') throw new ProblemException('conflict', 'duplicate endpoint');
      throw e;
    }
  }

  async list(orgId: string, q: { limit: number; cursor?: string }): Promise<Page<WebhookEndpointDto>> {
    const before = decodeCursor(q.cursor);
    const rows = await this.db.withOrg(orgId, async (c) => (await c.query(`SELECT * FROM automation.webhook_endpoints WHERE org_id = $1 AND ($2::uuid IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`, [orgId, before, q.limit + 1])).rows as Row[]);
    const p = pageOf(rows as (Row & { id: string })[], q.limit);
    return { items: p.items.map((r) => this.dto(r)), nextCursor: p.nextCursor };
  }

  // ---- events and deliveries --------------------------------------------------------------------------------------------------
  /** One delivery per (endpoint, event): the attempt-0 row. A duplicate event (outbox redelivery) inserts nothing. Returns how many endpoints were targeted. */
  async enqueueEvent(orgId: string, topic: string, eventId: string, data: unknown): Promise<number> {
    if (!isAllowedTopic(topic)) return 0;
    return this.db.withOrg(orgId, async (c) => {
      const eps = (await c.query(`SELECT id FROM automation.webhook_endpoints WHERE org_id = $1 AND status = 'active' AND $2 = ANY(events)`, [orgId, topic])).rows as Row[];
      let n = 0;
      const payload = { id: eventId, type: topic, createdAt: this.now().toISOString(), orgId, data };
      for (const e of eps) {
        const r = await c.query(`INSERT INTO automation.webhook_deliveries (id, org_id, endpoint_id, event_id, topic, attempt, status, payload, next_attempt_at) VALUES ($1,$2,$3,$4,$5,0,'pending',$6,$7) ON CONFLICT DO NOTHING`, [uuidv7(), orgId, e.id, eventId, topic, JSON.stringify(payload), this.now()]);
        n += r.rowCount ?? 0;
      }
      return n;
    });
  }

  private async latest(c: import('pg').PoolClient, endpointId: string, eventId: string): Promise<Row | undefined> {
    return (await c.query(`SELECT * FROM automation.webhook_deliveries WHERE endpoint_id = $1 AND event_id = $2 ORDER BY attempt DESC, (status = 'sending') ASC, created_at DESC LIMIT 1`, [endpointId, eventId])).rows[0] as Row | undefined;
  }

  /** Delivery log of an endpoint (service-level and used by tests; the HTTP read is SCR-M11-02, BLOCKED). */
  async deliveries(orgId: string, endpointId: string, q: { limit: number }): Promise<DeliveryDto[]> {
    if (!isUuid(endpointId)) throw new ProblemException('not_found');
    return this.db.withOrg(orgId, async (c) => {
      const rows = (await c.query(`SELECT DISTINCT ON (event_id) * FROM automation.webhook_deliveries WHERE endpoint_id = $1 AND org_id = $2 ORDER BY event_id, attempt DESC, (status = 'sending') ASC, created_at DESC`, [endpointId, orgId])).rows as Row[];
      return rows.slice(0, q.limit).map((r) => ({ endpointId, eventId: r.event_id, topic: r.topic, attempts: r.attempt, status: r.status, statusCode: r.status_code ?? null, error: r.error ?? null, nextAttemptAt: iso(r.next_attempt_at), createdAt: iso(r.created_at)! }));
    });
  }

  /** Replay a DEAD delivery (service-level; the HTTP route is SCR-M11-02, BLOCKED). The next dispatcher run sends it with the same event id, so a receiver that dedupes is safe. */
  async replay(orgId: string, actor: string, endpointId: string, eventId: string): Promise<void> {
    await this.db.withOrg(orgId, async (c) => {
      const l = await this.latest(c, endpointId, eventId);
      if (!l || l.org_id !== orgId) throw new ProblemException('not_found');
      if (l.status !== 'dead') throw new ProblemException('invalid_state', 'only a dead delivery can be replayed');
      await c.query(`INSERT INTO automation.webhook_deliveries (id, org_id, endpoint_id, event_id, topic, attempt, status, next_attempt_at) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)`, [uuidv7(), orgId, endpointId, eventId, l.topic, l.attempt + 1, this.now()]);
    });
    await this.audit.record({ action: 'webhook.delivery.replayed', actorUserId: actor, orgId, resource: { type: 'webhook_endpoint', id: endpointId }, outcome: 'success', detail: { eventId } });
  }

  /** Send every delivery that is due. Returns the numbers per outcome. Safe to run in several processes: the claim row is exclusive. */
  async dispatchDue(limit = 50): Promise<{ delivered: number; failed: number; dead: number }> {
    const now = this.now();
    const due = await this.db.withPlatformScope(async (c) =>
      (
        await c.query(
          `SELECT d.org_id, d.endpoint_id, d.event_id FROM automation.webhook_deliveries d
            WHERE d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= $1
              AND NOT EXISTS (SELECT 1 FROM automation.webhook_deliveries n WHERE n.endpoint_id = d.endpoint_id AND n.event_id = d.event_id AND (n.attempt > d.attempt OR (n.attempt = d.attempt AND d.status = 'sending' AND n.status <> 'sending')))
              AND d.status IN ('pending','failed','sending')
            ORDER BY d.next_attempt_at LIMIT $2`,
          [now, limit],
        )
      ).rows as Row[],
    );
    const out = { delivered: 0, failed: 0, dead: 0 };
    for (const d of due) {
      const r = await this.deliverOne(d.org_id, d.endpoint_id, d.event_id).catch(() => null);
      if (r) out[r]++;
    }
    return out;
  }

  private async deliverOne(orgId: string, endpointId: string, eventId: string): Promise<'delivered' | 'failed' | 'dead' | null> {
    const now = this.now();
    const claim = await this.db.withOrg(orgId, async (c) => {
      const l = await this.latest(c, endpointId, eventId);
      if (!l || !l.next_attempt_at || (l.next_attempt_at as Date) > now || !['pending', 'failed', 'sending'].includes(l.status)) return null;
      const first = (await c.query(`SELECT payload FROM automation.webhook_deliveries WHERE endpoint_id = $1 AND event_id = $2 AND attempt = 0`, [endpointId, eventId])).rows[0]?.payload;
      const attempt = l.attempt + 1;
      try {
        await c.query(`INSERT INTO automation.webhook_deliveries (id, org_id, endpoint_id, event_id, topic, attempt, status, next_attempt_at) VALUES ($1,$2,$3,$4,$5,$6,'sending',$7)`, [uuidv7(), orgId, endpointId, eventId, l.topic, attempt, new Date(now.getTime() + 60_000)]);
      } catch (e) {
        if (pgCode(e) === '23505') return null; // another dispatcher claimed this attempt
        throw e;
      }
      const ep = (await c.query(`SELECT * FROM automation.webhook_endpoints WHERE id = $1 AND org_id = $2`, [endpointId, orgId])).rows[0] as Row | undefined;
      return { attempt, payload: first, ep, topic: l.topic as string };
    });
    if (!claim) return null;
    const { attempt, payload, ep, topic } = claim;
    const record = (status: 'delivered' | 'failed' | 'dead', f: { code?: number; error?: string; next?: Date | null; ms?: number }) =>
      this.db.withOrg(orgId, async (c) => {
        await c.query(`INSERT INTO automation.webhook_deliveries (id, org_id, endpoint_id, event_id, topic, attempt, status, status_code, error, next_attempt_at, duration_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [uuidv7(), orgId, endpointId, eventId, topic, attempt, status, f.code ?? null, f.error?.slice(0, 500) ?? null, f.next ?? null, f.ms ?? null]);
        if (status === 'delivered') await c.query(`UPDATE automation.webhook_endpoints SET consecutive_failures = 0 WHERE id = $1`, [endpointId]);
        else {
          const r = await c.query(`UPDATE automation.webhook_endpoints SET consecutive_failures = consecutive_failures + 1, status = CASE WHEN consecutive_failures + 1 >= $2 AND status = 'active' THEN 'paused' ELSE status END WHERE id = $1 RETURNING status`, [endpointId, PAUSE_AFTER_FAILURES]);
          if (r.rows[0]?.status === 'paused') await this.audit.record({ action: 'webhook.endpoint.auto_paused', actorType: 'system', orgId, resource: { type: 'webhook_endpoint', id: endpointId }, outcome: 'failure', detail: { failures: PAUSE_AFTER_FAILURES } });
        }
      });
    if (!ep || ep.status !== 'active') {
      await record('dead', { error: 'the endpoint is not active' });
      return 'dead';
    }
    const retryOrDead = async (f: { code?: number; error: string; ms?: number }, retryable: boolean) => {
      const delay = retryable ? webhookDelaySeconds(attempt, this.random) : null;
      if (delay === null) {
        await record('dead', f);
        return 'dead' as const;
      }
      await record('failed', { ...f, next: new Date(this.now().getTime() + delay * 1000) });
      return 'failed' as const;
    };
    // the URL is checked again now: a name that resolved publicly at registration may not today (the egress client resolves and pins the address)
    const body = JSON.stringify(payload ?? { id: eventId, type: topic });
    const secrets: string[] = [await this.secrets.get(ep.secret_vault_ref)];
    if (ep.previous_secret_vault_ref && ep.previous_secret_expires_at && (ep.previous_secret_expires_at as Date) > this.now()) secrets.push(await this.secrets.get(ep.previous_secret_vault_ref));
    const ts = Math.floor(this.now().getTime() / 1000);
    const t0 = Date.now();
    try {
      const res = await this.egress.request(
        { url: ep.url, method: 'POST', body, headers: { 'content-type': 'application/json', 'user-agent': 'Nuzm-Webhooks/1', 'x-nuzm-event-id': eventId, 'x-nuzm-event-type': topic, 'x-nuzm-signature': signatureHeader(secrets, ts, body) } },
        {},
      );
      const ms = Date.now() - t0;
      if (res.status >= 200 && res.status < 300) {
        await record('delivered', { code: res.status, ms });
        return 'delivered';
      }
      return retryOrDead({ code: res.status, error: `the receiver answered ${res.status}`, ms }, isRetryableStatus(res.status));
    } catch (e) {
      if (e instanceof SsrfError) return retryOrDead({ error: `${e.code}: ${e.message}` }, e.code === 'timeout' || e.code === 'transport_error' || e.code === 'dns_failed');
      return retryOrDead({ error: (e as Error).message }, true);
    }
  }
}
