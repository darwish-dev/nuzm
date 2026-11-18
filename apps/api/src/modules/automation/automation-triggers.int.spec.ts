import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_SCHEDULE_SECONDS,
  signatureHeader,
  verifySignature,
  type SafeRequest,
} from '@nuzm/domain';
import {
  AbuseService,
  AUTOMATION_CONFIG,
  AutomationJobs,
  ExecutionEngine,
  ExecutionService,
  TriggerService,
  WebhookEndpointService,
  WorkflowService,
  type AutomationConfig,
} from './index';
import { setupAutomationEnv, type AutoEnv, type Row } from './testing/automation-harness';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';

let e: AutoEnv;
const A = () => e.org.A!;
const rid = () => Math.random().toString(36).slice(2, 8);
const sql = (q: string, p: unknown[] = []) => e.h.env.sql(q, p);
const SIMPLE = {
  schemaVersion: 1,
  start: 'calc',
  steps: [{ id: 'calc', type: 'transform', params: { output: { ok: true } } }],
};
const mkWorkflow = async (
  triggers: Row[],
  status: 'draft' | 'active' = 'active',
  definition: Row = SIMPLE,
) => {
  const r = await e.call('alice', 'POST', '/v1/workflows', {
    name: `wf-${rid()}`,
    definition,
    triggers,
  });
  if (r.statusCode !== 201) throw new Error(`workflow: ${r.statusCode} ${r.body}`);
  const w = r.json() as Row;
  if (status === 'active') {
    const p = await e.call(
      'alice',
      'PATCH',
      `/v1/workflows/${w.id}`,
      { status: 'active' },
      undefined,
      { 'if-match': `"${w.etag}"` },
    );
    if (p.statusCode !== 200) throw new Error(`activate: ${p.statusCode} ${p.body}`);
  }
  return w;
};
const count = async (workflowId: string) =>
  Number(
    (
      await sql(`SELECT count(*) n FROM automation.executions WHERE workflow_id = $1`, [workflowId])
    )[0]!.n,
  );
const ok = () => ({ status: 200, headers: {}, body: '{}', finalUrl: '', redirects: 0 });

beforeAll(async () => {
  e = await setupAutomationEnv();
}, 180_000);
afterAll(() => e.h.close());

const SSRF_URLS = [
  'https://localhost/',
  'https://LOCALHOST/',
  'https://app.localhost/',
  'https://127.0.0.1/',
  'https://127.1/',
  'https://2130706433/',
  'https://0x7f000001/',
  'https://0177.0.0.1/',
  'https://0.0.0.0/',
  'https://10.0.0.1/',
  'https://10.255.255.255/',
  'https://172.16.0.1/',
  'https://172.31.255.254/',
  'https://192.168.1.1/',
  'https://169.254.169.254/latest/meta-data/',
  'https://100.100.100.200/',
  'https://100.64.0.1/',
  'https://metadata.google.internal/',
  'https://[::1]/',
  'https://[::]/',
  'https://[::ffff:127.0.0.1]/',
  'https://[fe80::1]/',
  'https://[fc00::1]/',
  'https://[fd00:ec2::254]/',
  'https://[64:ff9b::7f00:1]/',
  'https://[2002:7f00:1::1]/',
  'https://internal.corp/',
  'https://db.cluster.local/',
  'https://printer.lan/',
  'https://singlelabel/',
  'https://127.0.0.1:8080/',
  'https://example.com:22/',
  'https://user:pass@example.com/',
  'http://example.com/',
  'ftp://example.com/',
  'file:///etc/passwd',
  'gopher://example.com/',
  'javascript:alert(1)',
  'not a url',
  '',
  'https://198.18.0.1/',
  'https://224.0.0.1/',
  'https://255.255.255.255/',
];

describe('outbound webhook endpoints (FR-AUT-04)', () => {
  it('shows the secret once; the list never returns it', async () => {
    const r = await e.call('alice', 'POST', '/v1/webhook-endpoints', {
      url: `https://hooks.example.com/${rid()}`,
      events: ['invoice.issued', 'site.deployed'],
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    const list = (await e.call('alice', 'GET', '/v1/webhook-endpoints')).json();
    expect(JSON.stringify(list)).not.toContain('whsec_');
    expect(JSON.stringify(list)).not.toContain('vault://');
    const row = await sql(
      `SELECT secret_vault_ref FROM automation.webhook_endpoints WHERE id = $1`,
      [r.json().id],
    );
    expect(String(row[0]!.secret_vault_ref)).toMatch(/^vault:\/\//);
  });
  it('AC-M11-03: registering a URL that points inside is 422 ssrf_denied for all of >= 40 payloads (endpoints and connectors)', async () => {
    expect(SSRF_URLS.length).toBeGreaterThanOrEqual(40);
    const leaked: string[] = [];
    for (const url of SSRF_URLS) {
      const r = await e.call('alice', 'POST', '/v1/webhook-endpoints', {
        url,
        events: ['invoice.issued'],
      });
      if (r.statusCode !== 422 || !['ssrf_denied', 'validation_failed'].includes(r.json().code))
        leaked.push(url);
      const c = await e.call('alice', 'POST', '/v1/connectors', {
        type: 'oauth2',
        name: `o-${rid()}`,
        scopes: [],
        config: { authorizationUrl: 'https://idp.example.com/auth', tokenUrl: url, clientId: 'c' },
      });
      if (c.statusCode !== 422) leaked.push(`connector:${url}`);
    }
    expect(leaked).toEqual([]);
    expect(
      (
        await sql(
          `SELECT count(*) n FROM automation.webhook_endpoints WHERE url LIKE 'https://127.%' OR url LIKE 'https://10.%' OR url LIKE 'https://localhost%'`,
        )
      )[0]!.n,
    ).toBe('0');
  });
  it('validates events, duplicates and permissions', async () => {
    const url = `https://hooks.example.com/${rid()}`;
    expect(
      (await e.call('alice', 'POST', '/v1/webhook-endpoints', { url, events: ['made.up'] }))
        .statusCode,
    ).toBe(422);
    expect(
      (await e.call('alice', 'POST', '/v1/webhook-endpoints', { url, events: [] })).statusCode,
    ).toBe(422);
    expect(
      (
        await e.call('alice', 'POST', '/v1/webhook-endpoints', {
          url,
          events: ['invoice.issued'],
          secret: 'mine',
        })
      ).json().code,
    ).toBe('credential_value_rejected');
    expect(
      (await e.call('alice', 'POST', '/v1/webhook-endpoints', { url, events: ['invoice.issued'] }))
        .statusCode,
    ).toBe(201);
    expect(
      (await e.call('alice', 'POST', '/v1/webhook-endpoints', { url, events: ['invoice.issued'] }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await e.call('dave', 'POST', '/v1/webhook-endpoints', {
          url: `https://x.example.com/${rid()}`,
          events: ['invoice.issued'],
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await e.call('bob', 'GET', '/v1/webhook-endpoints', undefined, e.org.B)).json().items,
    ).toHaveLength(0);
  });
  it('signs deliveries (HMAC-SHA256 over timestamp.body) and rotation keeps the old secret valid during the overlap only', async () => {
    const svc = e.app.get(WebhookEndpointService);
    const url = `https://hooks.example.com/${rid()}`;
    const created = (
      await e.call('alice', 'POST', '/v1/webhook-endpoints', { url, events: ['invoice.issued'] })
    ).json();
    const seen: SafeRequest[] = [];
    e.fakes.egress.handler = (r) => (r.url === url && seen.push(r), ok());
    await svc.enqueueEvent(A(), 'invoice.issued', 'evt-1', { invoiceId: 'i1' });
    expect((await svc.dispatchDue()).delivered).toBeGreaterThanOrEqual(1);
    expect(seen).toHaveLength(1);
    const req = seen.at(-1)!;
    const v = verifySignature(
      req.headers!['x-nuzm-signature'],
      req.body!,
      [created.secret],
      Math.floor(Date.now() / 1000),
    );
    expect(v.ok).toBe(true);
    expect(
      verifySignature(
        req.headers!['x-nuzm-signature'],
        req.body! + 'x',
        [created.secret],
        Math.floor(Date.now() / 1000),
      ).ok,
    ).toBe(false);
    expect(req.headers!['x-nuzm-event-id']).toBe('evt-1');
    expect(JSON.parse(req.body!).type).toBe('invoice.issued');
    // rotate with a 24 h overlap: both secrets sign
    const rot = (
      await e.call('alice', 'POST', '/v1/webhook-endpoints', {
        url,
        events: ['invoice.issued'],
        secretRotation: { overlapHours: 24 },
      })
    ).json();
    expect(rot.rotated).toBe(true);
    expect(rot.secret).not.toBe(created.secret);
    await svc.enqueueEvent(A(), 'invoice.issued', 'evt-2', { n: 2 });
    await svc.dispatchDue();
    const h2 = seen.at(-1)!.headers!['x-nuzm-signature']!;
    const now = Math.floor(Date.now() / 1000);
    expect(verifySignature(h2, seen.at(-1)!.body!, [created.secret], now).ok).toBe(true); // old receiver still verifies
    expect(verifySignature(h2, seen.at(-1)!.body!, [rot.secret], now).ok).toBe(true); // new receiver verifies
    // after the overlap only the new secret signs
    await sql(
      `UPDATE automation.webhook_endpoints SET previous_secret_expires_at = now() - interval '1 minute' WHERE id = $1`,
      [created.id],
    );
    await svc.enqueueEvent(A(), 'invoice.issued', 'evt-3', { n: 3 });
    await svc.dispatchDue();
    const h3 = seen.at(-1)!;
    expect(
      verifySignature(h3.headers!['x-nuzm-signature'], h3.body!, [created.secret], now).ok,
    ).toBe(false);
    expect(verifySignature(h3.headers!['x-nuzm-signature'], h3.body!, [rot.secret], now).ok).toBe(
      true,
    );
  });
  it('a duplicate event creates ONE delivery; a topic the endpoint did not choose creates none', async () => {
    const svc = e.app.get(WebhookEndpointService);
    const created = (
      await e.call('alice', 'POST', '/v1/webhook-endpoints', {
        url: `https://hooks.example.com/${rid()}`,
        events: ['domain.registered'],
      })
    ).json();
    e.fakes.egress.handler = ok;
    expect(await svc.enqueueEvent(A(), 'domain.registered', 'dup-1', {})).toBe(1);
    expect(await svc.enqueueEvent(A(), 'domain.registered', 'dup-1', {})).toBe(0);
    expect(await svc.enqueueEvent(A(), 'resource.state_changed', 'x-1', {})).toBe(0);
    expect(await svc.enqueueEvent(A(), 'not.allowed', 'x-2', {})).toBe(0);
    await svc.dispatchDue();
    await svc.dispatchDue();
    const rows = await sql(
      `SELECT attempt, status FROM automation.webhook_deliveries WHERE endpoint_id = $1 AND event_id = 'dup-1' ORDER BY attempt, created_at`,
      [created.id],
    );
    expect(rows.map((r) => `${r.attempt}:${r.status}`)).toEqual([
      '0:pending',
      '1:sending',
      '1:delivered',
    ]);
    // the log is append-only
    await expect(
      sql(`UPDATE automation.webhook_deliveries SET status = 'delivered' WHERE endpoint_id = $1`, [
        created.id,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql(`DELETE FROM automation.webhook_deliveries WHERE endpoint_id = $1`, [created.id]),
    ).rejects.toThrow(/immutable/);
  });
  it('retries follow the exponential schedule for up to 24 h, then the delivery is dead; replay delivers it', async () => {
    const svc = e.app.get(WebhookEndpointService);
    const url = `https://hooks.example.com/${rid()}`;
    const created = (
      await e.call('alice', 'POST', '/v1/webhook-endpoints', { url, events: ['site.deployed'] })
    ).json();
    let clock = new Date();
    svc.useClock(() => clock);
    let hits = 0;
    let fail = true;
    e.fakes.egress.handler = (r) =>
      r.url !== url
        ? ok()
        : (++hits,
          fail ? { status: 503, headers: {}, body: '', finalUrl: '', redirects: 0 } : ok());
    await svc.enqueueEvent(A(), 'site.deployed', 'sched-1', {});
    const times: number[] = [];
    const t0 = clock.getTime();
    for (let i = 0; i < WEBHOOK_MAX_ATTEMPTS + 2; i++) {
      const r = await svc.dispatchDue();
      if (r.failed || r.dead) times.push(clock.getTime() - t0);
      // jump to the next due time
      const next = (
        await sql(
          `SELECT max(next_attempt_at) n FROM automation.webhook_deliveries WHERE endpoint_id = $1 AND event_id = 'sched-1'`,
          [created.id],
        )
      )[0]!.n as Date | null;
      if (!next) break;
      clock = new Date(Math.max(clock.getTime() + 1000, next.getTime() + 1000));
    }
    expect(hits).toBe(WEBHOOK_MAX_ATTEMPTS);
    const log = (await svc.deliveries(A(), created.id, { limit: 10 }))[0]!;
    expect(log.status).toBe('dead');
    expect(times[times.length - 1]! / 1000).toBeLessThanOrEqual(24 * 3600 + 3600);
    expect(times[times.length - 1]! / 1000).toBeGreaterThan(18 * 3600);
    expect(WEBHOOK_SCHEDULE_SECONDS.length + 1).toBe(WEBHOOK_MAX_ATTEMPTS);
    // replay (service-level; the HTTP route is SCR-M11-02) once the receiver recovered
    fail = false;
    await svc.replay(A(), e.ids.alice!, created.id, 'sched-1');
    await expect(svc.replay(A(), e.ids.alice!, created.id, 'sched-1')).rejects.toThrow();
    expect((await svc.dispatchDue()).delivered).toBeGreaterThanOrEqual(1);
    expect((await svc.deliveries(A(), created.id, { limit: 10 }))[0]!.status).toBe('delivered');
    svc.useClock(() => new Date());
  });
  it('a 4xx (410 Gone) is permanent: the delivery is dead at once; two dispatchers never both send an attempt', async () => {
    const svc = e.app.get(WebhookEndpointService);
    const url = `https://hooks.example.com/${rid()}`;
    const created = (
      await e.call('alice', 'POST', '/v1/webhook-endpoints', { url, events: ['payment.failed'] })
    ).json();
    let hits = 0;
    e.fakes.egress.handler = (r) =>
      r.url === url
        ? (++hits, { status: 410, headers: {}, body: '', finalUrl: '', redirects: 0 })
        : ok();
    await svc.enqueueEvent(A(), 'payment.failed', 'gone-1', {});
    const [r1, r2] = await Promise.all([svc.dispatchDue(), svc.dispatchDue()]);
    expect(hits).toBe(1);
    expect(r1.dead + r2.dead).toBeGreaterThanOrEqual(1);
    expect((await svc.deliveries(A(), created.id, { limit: 5 }))[0]!.status).toBe('dead');
  });
});

describe('triggers (FR-AUT-02)', () => {
  it('inbound webhook: valid signature starts ONE execution; tampered, expired, replayed and unsigned are refused', async () => {
    const w = await mkWorkflow([{ type: 'webhook' }]);
    expect(w.webhook.path).toMatch(/^\/v1\/webhooks\/workflows\//);
    const body = JSON.stringify({ hello: 'world' });
    const post = (headers: Record<string, string>, payload = body, path = w.webhook.path) =>
      e.app.inject({
        method: 'POST',
        url: path,
        headers: { 'content-type': 'application/json', ...headers },
        payload,
      });
    const now = Math.floor(Date.now() / 1000);
    const good = {
      'x-nuzm-signature': signatureHeader([w.webhook.secret], now, body),
      'x-nuzm-event-id': 'in-1',
    };
    const r1 = await post(good);
    expect(r1.statusCode).toBe(202);
    expect(await count(w.id)).toBe(1);
    // a captured request replayed (same event id, still inside the window) returns the original execution
    const r2 = await post(good);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().executionId).toBe(r1.json().executionId);
    expect(await count(w.id)).toBe(1);
    // tampered body / wrong secret / expired timestamp / future timestamp / missing signature / missing event id
    expect((await post(good, body + ' ')).statusCode).toBe(401);
    expect(
      (
        await post({
          ...good,
          'x-nuzm-event-id': 'in-2',
          'x-nuzm-signature': signatureHeader(['whsec_wrong'], now, body),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await post({
          ...good,
          'x-nuzm-event-id': 'in-3',
          'x-nuzm-signature': signatureHeader([w.webhook.secret], now - 330, body),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await post({
          ...good,
          'x-nuzm-event-id': 'in-4',
          'x-nuzm-signature': signatureHeader([w.webhook.secret], now + 330, body),
        })
      ).statusCode,
    ).toBe(401);
    expect((await post({ 'x-nuzm-event-id': 'in-5' })).statusCode).toBe(401);
    expect((await post({ 'x-nuzm-signature': good['x-nuzm-signature'] })).statusCode).toBe(422);
    expect((await post(good, body, '/v1/webhooks/workflows/' + 'a'.repeat(43))).statusCode).toBe(
      404,
    );
    expect(await count(w.id)).toBe(1);
    expect(
      JSON.stringify(
        (
          await sql(`SELECT triggers, webhook_token_hash FROM automation.workflows WHERE id = $1`, [
            w.id,
          ])
        )[0],
      ),
    ).not.toContain(w.webhook.secret);
  });
  it('platform events: one execution per event id; non-allow-listed topics start nothing', async () => {
    const w = await mkWorkflow([{ type: 'platform_event', topic: 'invoice.issued' }]);
    const t = e.app.get(TriggerService);
    expect(await t.platformEvent(A(), 'invoice.issued', 'ev-1', { invoiceId: 'i1' })).toBe(1);
    expect(await t.platformEvent(A(), 'invoice.issued', 'ev-1', { invoiceId: 'i1' })).toBe(0); // duplicate outbox event
    expect(await t.platformEvent(A(), 'site.deployed', 'ev-2', {})).toBe(0);
    expect(await t.platformEvent(A(), 'secrets.leaked', 'ev-3', {})).toBe(0);
    expect(await count(w.id)).toBe(1);
    const x = (
      await sql(`SELECT input FROM automation.executions WHERE workflow_id = $1`, [w.id])
    )[0]!.input as Row;
    expect(x.topic).toBe('invoice.issued');
    const bad = await e.call('alice', 'POST', '/v1/workflows', {
      name: 'x',
      definition: SIMPLE,
      triggers: [{ type: 'platform_event', topic: 'secrets.leaked' }],
    });
    expect(bad.statusCode).toBe(422);
  });
  it('a chain deeper than the limit pauses the workflow and opens a recursion case', async () => {
    const w = await mkWorkflow([{ type: 'platform_event', topic: 'site.deployed' }]);
    const t = e.app.get(TriggerService);
    expect(await t.platformEvent(A(), 'site.deployed', 'deep-1', { automationDepth: 5 })).toBe(0);
    const g = (await e.call('alice', 'GET', `/v1/workflows/${w.id}`)).json();
    expect(g.status).toBe('paused');
    expect(
      (await sql(`SELECT kind FROM automation.anomaly_cases WHERE workflow_id = $1`, [w.id]))[0]!
        .kind,
    ).toBe('recursion');
  });
  it('schedule: a due schedule fires once per slot and moves on (UTC and an organization time zone)', async () => {
    const w = await mkWorkflow([
      { type: 'schedule', cron: '*/5 * * * *', timezone: 'Asia/Riyadh' },
    ]);
    expect((await e.call('alice', 'GET', `/v1/workflows/${w.id}`)).json().nextRunAt).toBeTruthy();
    const t = e.app.get(TriggerService);
    await sql(
      `UPDATE automation.workflows SET next_run_at = now() - interval '10 seconds' WHERE id = $1`,
      [w.id],
    );
    expect(await t.fireSchedules()).toBe(1);
    expect(await t.fireSchedules()).toBe(0);
    expect(await count(w.id)).toBe(1);
    const next = (
      await sql(`SELECT next_run_at FROM automation.workflows WHERE id = $1`, [w.id])
    )[0]!.next_run_at as Date;
    expect(next.getTime()).toBeGreaterThan(Date.now());
    // two instances racing for the same slot create one execution (the slot is the dedupe key)
    await sql(
      `UPDATE automation.workflows SET next_run_at = now() - interval '10 seconds' WHERE id = $1`,
      [w.id],
    );
    const [a, b] = await Promise.all([t.fireSchedules(), t.fireSchedules()]);
    expect(a + b).toBeLessThanOrEqual(1);
    expect(await count(w.id)).toBeLessThanOrEqual(2);
    expect(
      (
        await e.call('alice', 'POST', '/v1/workflows', {
          name: 'bad',
          definition: SIMPLE,
          triggers: [{ type: 'schedule', cron: '* * * *' }],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await e.call('alice', 'POST', '/v1/workflows', {
          name: 'bad',
          definition: SIMPLE,
          triggers: [{ type: 'schedule', cron: '0 * * * *', timezone: 'Mars/Base' }],
        })
      ).statusCode,
    ).toBe(422);
  });
  it('a paused or disabled workflow never runs from any trigger', async () => {
    const w = await mkWorkflow([
      { type: 'manual' },
      { type: 'platform_event', topic: 'org.created' },
    ]);
    const g = (await e.call('alice', 'GET', `/v1/workflows/${w.id}`)).json();
    const pa = await e.call(
      'alice',
      'PATCH',
      `/v1/workflows/${w.id}`,
      { status: 'paused' },
      undefined,
      { 'if-match': `"${g.etag}"` },
    );
    expect(pa.statusCode).toBe(200);
    const r = await e.call('alice', 'POST', `/v1/workflows/${w.id}/executions`, {
      dedupeKey: rid(),
    });
    expect(r.statusCode).toBe(409);
    expect(await e.app.get(TriggerService).platformEvent(A(), 'org.created', 'p-1', {})).toBe(0);
  });
});

describe('abuse prevention', () => {
  const abuse = (over: Partial<AutomationConfig>) =>
    new AbuseService(e.app.get(DB), e.app.get(AuditSink), {
      ...e.app.get<AutomationConfig>(AUTOMATION_CONFIG),
      ...over,
    });
  it('an execution spike pauses the workflow, opens an admin case and tells the managers; the organization can resume, an admin pause cannot be lifted', async () => {
    const w = await mkWorkflow([{ type: 'manual' }]);
    const ex = e.app.get(ExecutionService);
    for (let i = 0; i < 6; i++)
      await ex.enqueue(A(), {
        workflowId: w.id,
        trigger: 'manual',
        dedupeKey: `spike-${i}`,
        input: {},
      });
    expect(await abuse({ spikePerMinute: 5 }).checkSpikes()).toBe(1);
    expect(await abuse({ spikePerMinute: 5 }).checkSpikes()).toBe(0); // already paused: no second case
    const g = (await e.call('alice', 'GET', `/v1/workflows/${w.id}`)).json();
    expect(g.status).toBe('paused');
    expect(g.pausedReason).toContain('execution_spike');
    const cases = await sql(
      `SELECT kind, status FROM automation.anomaly_cases WHERE workflow_id = $1`,
      [w.id],
    );
    expect(cases).toEqual([{ kind: 'execution_spike', status: 'open' }]);
    expect(
      e.sink.events.some(
        (x) => x.action === 'workflow.workflow.auto_paused' && x.resource?.id === w.id,
      ),
    ).toBe(true);
    const notices = await sql(
      `SELECT kind FROM platform.notifications WHERE kind = 'automation.workflow_paused' AND org_id = $1`,
      [A()],
    );
    expect(notices.length).toBeGreaterThan(0);
    // resume by the organization works (it was an anomaly pause)...
    const res = await e.call(
      'alice',
      'PATCH',
      `/v1/workflows/${w.id}`,
      { status: 'active' },
      undefined,
      { 'if-match': `"${g.etag}"` },
    );
    expect(res.statusCode).toBe(200);
    // ...but an administrator pause (kill switch) cannot be lifted by the organization
    await e.app.get(WorkflowService).adminPause(w.id, A(), 'investigation', e.padmin);
    const g2 = (await e.call('alice', 'GET', `/v1/workflows/${w.id}`)).json();
    expect(g2.pausedByAdmin).toBe(true);
    const lift = await e.call(
      'alice',
      'PATCH',
      `/v1/workflows/${w.id}`,
      { status: 'active' },
      undefined,
      { 'if-match': `"${g2.etag}"` },
    );
    expect(lift.statusCode).toBe(403);
  });
  it('a high 4xx share pauses the workflow', async () => {
    const w = await mkWorkflow([{ type: 'manual' }]);
    const ex = (
      await e.call('alice', 'POST', `/v1/workflows/${w.id}/executions`, { dedupeKey: rid() })
    ).json();
    for (let i = 0; i < 10; i++)
      await sql(
        `INSERT INTO automation.execution_steps (id, org_id, execution_id, step_key, attempt, status, idempotent, idempotency_key, step_type, error) VALUES (gen_random_uuid(), $1, $2, $3, 1, 'failed', true, $4, 'http_request', '{"code":"http_4xx"}')`,
        [A(), ex.id, `s${i}`, 'a'.repeat(64)],
      );
    expect(await abuse({ rateWindow: 10, http4xxRate: 0.5 }).check4xx()).toBe(1);
    expect((await e.call('alice', 'GET', `/v1/workflows/${w.id}`)).json().status).toBe('paused');
    expect(
      (await sql(`SELECT kind FROM automation.anomaly_cases WHERE workflow_id = $1`, [w.id]))[0]!
        .kind,
    ).toBe('high_4xx_rate');
  });
  it('the whole tick runs: schedules, runnable executions, deliveries and abuse rules', async () => {
    const w = await mkWorkflow([{ type: 'manual' }]);
    const id = (
      await e.call('alice', 'POST', `/v1/workflows/${w.id}/executions`, { dedupeKey: rid() })
    ).json().id;
    const r = await e.app.get(AutomationJobs).tick();
    expect(r.ran).toBeGreaterThanOrEqual(1);
    expect((await e.call('alice', 'GET', `/v1/workflow-executions/${id}`)).json().status).toBe(
      'succeeded',
    );
    expect(e.app.get(ExecutionEngine)).toBeTruthy();
  });
});
