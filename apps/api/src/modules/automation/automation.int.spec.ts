import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sign, signatureHeader } from '@nuzm/domain';
import { ActionError, ConnectorService, ExecutionEngine, ExecutionService, TriggerService, WorkflowService, tenantSecretId } from './index';
import { setupAutomationEnv, type AutoEnv, type Row } from './testing/automation-harness';

let e: AutoEnv;
const A = () => e.org.A!;
const B = () => e.org.B!;
const rid = () => Math.random().toString(36).slice(2, 8);
const engine = () => e.app.get(ExecutionEngine);
const sql = (q: string, p: unknown[] = []) => e.h.env.sql(q, p);

const def = (steps: Row[], start?: string) => ({ schemaVersion: 1, start: start ?? steps[0]!.id, steps });
const SIMPLE = def([{ id: 'calc', type: 'transform', params: { output: { double: '{{ input.n * 2 }}' } } }]);

const mkWorkflow = async (definition: Row, triggers: Row[] = [{ type: 'manual' }], who = 'alice', org = A()) => {
  const r = await e.call(who, 'POST', '/v1/workflows', { name: `wf-${rid()}`, definition, triggers }, org);
  if (r.statusCode !== 201) throw new Error(`create workflow: ${r.statusCode} ${r.body}`);
  return r.json() as Row;
};
const activate = async (w: Row, who = 'alice', org = A()) => {
  const g = await e.call(who, 'GET', `/v1/workflows/${w.id}`, undefined, org);
  const r = await e.call(who, 'PATCH', `/v1/workflows/${w.id}`, { status: 'active' }, org, { 'if-match': `"${g.json().etag}"` });
  if (r.statusCode !== 200) throw new Error(`activate: ${r.statusCode} ${r.body}`);
  return r.json() as Row;
};
const run = (w: Row, body: Row = {}, who = 'alice', org = A()) => e.call(who, 'POST', `/v1/workflows/${w.id}/executions`, { dedupeKey: `d-${rid()}`, input: {}, ...body }, org);
/** Drive an execution to a terminal state; a deferral is made due at once (time passes). */
const finish = async (orgId: string, id: string, max = 60) => {
  for (let i = 0; i < max; i++) {
    const r = await engine().runOne(orgId, id);
    if (r === 'finished' || r === 'failed' || r === 'cancelled') return (await e.call('alice', 'GET', `/v1/workflow-executions/${id}`, undefined, orgId)).json() as Row;
    await sql(`UPDATE platform.operations SET next_run_at = now() - interval '1 second', lease_expires_at = now() - interval '1 second' WHERE id = (SELECT operation_id FROM automation.executions WHERE id = $1) AND state IN ('pending','running')`, [id]);
  }
  throw new Error('execution did not finish');
};
const mkConnector = async (org = A(), over: Row = {}) => {
  const r = await e.call('alice', 'POST', '/v1/connectors', { type: 'http', name: `c-${rid()}`, scopes: ['reports:read'], config: { allowedHosts: ['api.example.com'], authType: 'bearer', hostRegion: 'sa-central' }, ...over }, org);
  if (r.statusCode !== 201) throw new Error(`connector: ${r.statusCode} ${r.body}`);
  return r.json() as Row;
};
const authorize = async (c: Row, token = `tok_${rid()}secret`, org = A()) => {
  const ref = await e.secrets.put(tenantSecretId(org, 'cred', rid()), token);
  const r = await e.call('alice', 'POST', `/v1/connectors/${c.id}/authorization`, { kind: 'credential', vaultRef: ref }, org);
  if (r.statusCode !== 201) throw new Error(`authorize: ${r.statusCode} ${r.body}`);
  return { token, ref, auth: r.json() as Row };
};
const usage = async (meter: string, resourceId: string) => (await sql(`SELECT payload FROM platform.outbox WHERE topic = 'usage.recorded' AND payload->>'meterId' = $1 AND payload->>'resourceId' = $2`, [meter, resourceId])).map((r) => r.payload as Row);

beforeAll(async () => {
  e = await setupAutomationEnv();
}, 180_000);
afterAll(() => e.h.close());

describe('feature flag and authorization', () => {
  it('is OFF by default: a manual run answers 403 feature_disabled until the flag is on', async () => {
    const w = await mkWorkflow(SIMPLE);
    await e.setFlag('automation.enabled', false);
    const r = await run(w, { input: { n: 1 } });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('feature_disabled');
    await e.setFlag('automation.enabled', true);
    expect((await run(w, { input: { n: 1 } })).statusCode).toBe(202);
  });
  it('a viewer reads but cannot create, version or run', async () => {
    const w = await mkWorkflow(SIMPLE);
    expect((await e.call('carol', 'GET', `/v1/workflows/${w.id}`)).statusCode).toBe(200);
    expect((await e.call('carol', 'POST', '/v1/workflows', { name: 'x', definition: SIMPLE })).statusCode).toBe(403);
    expect((await e.call('carol', 'POST', `/v1/workflows/${w.id}/versions`, { definition: SIMPLE })).statusCode).toBe(403);
    expect((await run(w, {}, 'carol')).statusCode).toBe(403);
    expect((await e.call('dave', 'POST', `/v1/workflows/${w.id}/executions`, { dedupeKey: rid(), input: { n: 1 } })).statusCode).toBe(202);
  });
});

describe('definitions and versions (FR-AUT-01)', () => {
  it('creates a workflow with version 1, publishes immutable versions and keeps the old ones', async () => {
    const w = await mkWorkflow(SIMPLE);
    expect(w.activeVersion).toBe(1);
    const next = def([{ id: 'calc', type: 'transform', params: { output: { triple: '{{ input.n * 3 }}' } } }]);
    const v2 = await e.call('alice', 'POST', `/v1/workflows/${w.id}/versions`, { definition: next, notes: 'triple' });
    expect(v2.statusCode).toBe(201);
    expect(v2.json().version).toBe(2);
    const same = await e.call('alice', 'POST', `/v1/workflows/${w.id}/versions`, { definition: next });
    expect(same.json().unchanged).toBe(true);
    expect(same.json().version).toBe(2);
    const g = (await e.call('alice', 'GET', `/v1/workflows/${w.id}`)).json();
    expect(g.activeVersion).toBe(2);
    expect(g.versions.map((v: Row) => v.version)).toEqual([2, 1]);
    // immutability is enforced by the database itself
    await expect(sql(`UPDATE automation.workflow_versions SET definition = '{}'::jsonb WHERE workflow_id = $1`, [w.id])).rejects.toThrow(/immutable/);
    await expect(sql(`DELETE FROM automation.workflow_versions WHERE workflow_id = $1`, [w.id])).rejects.toThrow(/immutable/);
  });
  it('422 for a cycle, an unknown step type, an unparsable expression and a literal credential', async () => {
    const cyc = def([{ id: 'a', type: 'delay', params: { seconds: 1 }, next: 'b' }, { id: 'b', type: 'delay', params: { seconds: 1 }, next: 'a' }]);
    for (const bad of [cyc, def([{ id: 'a', type: 'teleport', params: {} }]), def([{ id: 'a', type: 'condition', params: { expr: 'eval(1)' }, onTrue: 'a' }]), def([{ id: 'a', type: 'http_request', params: { url: 'https://x.example.com', headers: { Authorization: 'Bearer abcdefghijklmn' } } }])]) {
      const r = await e.call('alice', 'POST', '/v1/workflows', { name: 'bad', definition: bad });
      expect(r.statusCode, JSON.stringify(bad)).toBe(422);
      expect(r.json().code).toBe('validation_failed');
      expect(r.json().errors.length).toBeGreaterThan(0);
    }
  });
  it('PATCH changes name and status only; ETag is enforced', async () => {
    const w = await mkWorkflow(SIMPLE);
    const g = await e.call('alice', 'GET', `/v1/workflows/${w.id}`);
    const etag = g.headers.etag as string;
    expect((await e.call('alice', 'PATCH', `/v1/workflows/${w.id}`, { name: 'renamed' })).statusCode).toBe(428);
    expect((await e.call('alice', 'PATCH', `/v1/workflows/${w.id}`, { definition: {} }, undefined, { 'if-match': etag })).statusCode).toBe(422);
    const ok = await e.call('alice', 'PATCH', `/v1/workflows/${w.id}`, { name: 'renamed' }, undefined, { 'if-match': etag });
    expect(ok.statusCode).toBe(200);
    expect((await e.call('alice', 'PATCH', `/v1/workflows/${w.id}`, { name: 'again' }, undefined, { 'if-match': etag })).statusCode).toBe(412);
  });
  it('another organization sees 404 for every workflow route', async () => {
    const w = await mkWorkflow(SIMPLE);
    const get = await e.call('bob', 'GET', `/v1/workflows/${w.id}`, undefined, B());
    expect(get.statusCode).toBe(404);
    expect((await e.call('bob', 'POST', `/v1/workflows/${w.id}/versions`, { definition: SIMPLE }, B())).statusCode).toBe(404);
    expect((await run(w, {}, 'bob', B())).statusCode).toBe(404);
    expect((await e.call('bob', 'GET', `/v1/workflows/${w.id}/executions`, undefined, B())).statusCode).toBe(404);
    const ex = (await run(w, { input: { n: 1 } })).json();
    expect((await e.call('bob', 'GET', `/v1/workflow-executions/${ex.id}`, undefined, B())).statusCode).toBe(404);
  });
});

describe('executions (FR-AUT-02)', () => {
  it('runs a workflow to completion with ordered, redacted steps and exact metering', async () => {
    const c = await mkConnector();
    const { token } = await authorize(c);
    const d = def([
      { id: 'fetch', type: 'http_request', params: { method: 'GET', url: 'https://api.example.com/r?n={{ input.n }}', connectorId: c.id, scope: 'reports:read' }, next: 'calc' },
      { id: 'calc', type: 'transform', params: { output: { double: '{{ input.n * 2 }}', status: '{{ steps.fetch.output.status }}' } }, next: 'check' },
      { id: 'check', type: 'condition', params: { expr: 'steps.calc.output.double == 14' }, onTrue: 'mail', onFalse: 'never' },
      { id: 'mail', type: 'send_email', params: { senderId: '0190a000-0000-7000-8000-0000000000aa', to: ['x@example.com'], subject: 'Hi {{ steps.calc.output.double }}', text: 'ok' } },
      { id: 'never', type: 'delay', params: { seconds: 5 } },
    ]);
    const w = await mkWorkflow(d);
    e.fakes.egress.handler = async (r) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ echoedAuth: r.headers?.authorization, n: 1 }), finalUrl: r.url, redirects: 0 });
    const r = await run(w, { input: { n: 7 } });
    expect(r.statusCode).toBe(202);
    const done = await finish(A(), r.json().id);
    expect(done.status).toBe('succeeded');
    expect(done.steps.map((s: Row) => `${s.stepKey}:${s.status}`)).toEqual(['fetch:succeeded', 'calc:succeeded', 'check:succeeded', 'mail:succeeded']);
    // the bearer token was SENT but is nowhere in what is stored or returned
    expect(e.fakes.egress.calls.at(-1)!.headers!.authorization).toBe(`Bearer ${token}`);
    expect(JSON.stringify(done)).not.toContain(token);
    const stored = await sql(`SELECT input::text i, output::text o FROM automation.execution_steps WHERE execution_id = $1`, [done.id]);
    expect(JSON.stringify(stored)).not.toContain(token);
    // metering: one execution event, one step event per billable step (http + email)
    expect(await usage('automation.executions', done.id)).toHaveLength(1);
    expect(await usage('automation.steps', done.id)).toHaveLength(2);
    const audited = e.sink.events.filter((x) => x.action.startsWith('workflow.execution') && x.resource?.id === done.id).map((x) => x.action);
    expect(audited).toContain('workflow.execution.started');
  });
  it('the same dedupeKey twice yields ONE execution (the original comes back)', async () => {
    const w = await mkWorkflow(SIMPLE);
    const key = `same-${rid()}`;
    const [a, b] = [await run(w, { dedupeKey: key, input: { n: 1 } }), await run(w, { dedupeKey: key, input: { n: 999 } })];
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id);
    expect(b.json().duplicate).toBe(true);
    expect(b.json().input).toEqual({ n: 1 });
    expect(Number((await sql(`SELECT count(*) n FROM automation.executions WHERE workflow_id = $1`, [w.id]))[0]!.n)).toBe(1);
    expect(await usage('automation.executions', a.json().id)).toHaveLength(0); // metered at START, and only once
    await finish(A(), a.json().id);
    expect(await usage('automation.executions', a.json().id)).toHaveLength(1);
  });
  it('a loop is bounded, iterates in order and exposes item/index', async () => {
    const d = def([{ id: 'each', type: 'loop', params: { over: 'input.items', maxIterations: 3 }, body: [{ id: 'sq', type: 'transform', params: { output: { v: '{{ item * item }}', i: '{{ index }}' } } }] }]);
    const w = await mkWorkflow(d);
    const ok = await finish(A(), (await run(w, { input: { items: [2, 3, 4] } })).json().id);
    expect(ok.status).toBe('succeeded');
    expect(ok.steps.map((s: Row) => s.stepKey)).toEqual(['each[0].sq', 'each[1].sq', 'each[2].sq']);
    expect(ok.steps.map((s: Row) => s.output.v)).toEqual([4, 9, 16]);
    const over = await finish(A(), (await run(w, { input: { items: [1, 2, 3, 4] } })).json().id);
    expect(over.status).toBe('failed');
    expect(over.error.code).toBe('loop_bound_exceeded');
  });
  it('a delay is durable: the execution waits and resumes when due', async () => {
    const w = await mkWorkflow(def([{ id: 'w', type: 'delay', params: { seconds: 3600 }, next: 'after' }, { id: 'after', type: 'transform', params: { output: { done: true } } }]));
    const id = (await run(w)).json().id;
    expect(await engine().runOne(A(), id)).toBe('deferred');
    let g = (await e.call('alice', 'GET', `/v1/workflow-executions/${id}`)).json();
    expect(g.status).toBe('waiting');
    // the operation is parked in the future: nobody can claim it early
    expect(await engine().runOne(A(), id)).toBe('not_claimed');
    const later = new Date(Date.now() + 3601_000);
    engine().useClock(() => later);
    await sql(`UPDATE platform.operations SET next_run_at = now() WHERE id = $1`, [g.operationId]);
    expect(await engine().runOne(A(), id)).toBe('finished');
    engine().useClock(() => new Date());
    g = (await e.call('alice', 'GET', `/v1/workflow-executions/${id}`)).json();
    expect(g.status).toBe('succeeded');
  });
  it('cancel stops a queued execution and the operations endpoint is honoured', async () => {
    const w = await mkWorkflow(SIMPLE);
    const r = (await run(w, { input: { n: 1 } })).json();
    const c = await e.call('alice', 'POST', `/v1/operations/${r.operationId}/cancellation`, {});
    expect(c.statusCode).toBe(200);
    await e.app.get(ExecutionEngine).runOne(A(), r.id);
    // the tick settles an execution whose operation was cancelled through the generic endpoint
    const jobs = (await import('./index')).AutomationJobs;
    await e.app.get(jobs).tick();
    expect((await e.call('alice', 'GET', `/v1/workflow-executions/${r.id}`)).json().status).toBe('cancelled');
  });
  it('services are wired and the module exports its public surface', () => {
    for (const t of [WorkflowService, ExecutionService, ExecutionEngine, ConnectorService, TriggerService]) expect(e.app.get(t)).toBeTruthy();
    expect(new ActionError('x', 'y').retryable).toBe(false);
    expect(createHash('sha256')).toBeTruthy();
    expect(sign('s', 1, 'b')).toHaveLength(64);
    expect(signatureHeader(['s'], 1, 'b')).toMatch(/^t=1,v1=/);
  });
});
