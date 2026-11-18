import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_EGRESS, SafeHttpClient, type SafeRequest } from '@nuzm/domain';
import { ActionError, ConnectorService, ExecutionEngine, ExecutionService, SimulatedCrash, tenantSecretId, type CrashPoint } from './index';
import { GuardedEgressPort } from './internal/default-ports';
import { setupAutomationEnv, type AutoEnv, type Row } from './testing/automation-harness';

let e: AutoEnv;
const A = () => e.org.A!;
const rid = () => Math.random().toString(36).slice(2, 8);
const engine = () => e.app.get(ExecutionEngine);
const sql = (q: string, p: unknown[] = []) => e.h.env.sql(q, p);
const SENDER = '0190a000-0000-7000-8000-0000000000aa';
const def = (steps: Row[], start?: string) => ({ schemaVersion: 1, start: start ?? steps[0]!.id, steps });

const mkWorkflow = async (definition: Row) => {
  const r = await e.call('alice', 'POST', '/v1/workflows', { name: `wf-${rid()}`, definition, triggers: [{ type: 'manual' }] });
  if (r.statusCode !== 201) throw new Error(`create workflow: ${r.statusCode} ${r.body}`);
  return r.json() as Row;
};
const start = async (w: Row, input: Row = {}) => {
  const r = await e.call('alice', 'POST', `/v1/workflows/${w.id}/executions`, { dedupeKey: `d-${rid()}`, input });
  if (r.statusCode !== 202) throw new Error(`start: ${r.statusCode} ${r.body}`);
  return r.json() as Row;
};
const get = async (id: string) => (await e.call('alice', 'GET', `/v1/workflow-executions/${id}`)).json() as Row;
const makeDue = (execId: string) => sql(`UPDATE platform.operations SET lease_expires_at = now() - interval '1 second', next_run_at = now() - interval '1 second' WHERE id = (SELECT operation_id FROM automation.executions WHERE id = $1) AND state IN ('pending','running')`, [execId]);
/** Run until terminal. A SimulatedCrash is a killed worker: the next pass (after its lease expires) takes over. */
async function finishWithCrashes(id: string, plan: { stepKey: string; point: CrashPoint }[] = []) {
  const left = [...plan];
  engine().hooks.at = (point, ctx) => {
    const i = left.findIndex((p) => p.point === point && p.stepKey === ctx.stepKey);
    if (i >= 0) {
      left.splice(i, 1);
      throw new SimulatedCrash(`${point}@${ctx.stepKey}`);
    }
  };
  let crashes = 0;
  try {
    for (let i = 0; i < 80; i++) {
      try {
        const r = await engine().runOne(A(), id);
        if (r === 'finished' || r === 'failed' || r === 'cancelled') return { exec: await get(id), crashes };
      } catch (err) {
        if (!(err instanceof SimulatedCrash)) throw err;
        crashes++;
      }
      await makeDue(id);
    }
    throw new Error('did not finish');
  } finally {
    engine().hooks.at = undefined;
  }
}
const usage = async (meter: string, resourceId: string) => (await sql(`SELECT payload FROM platform.outbox WHERE topic = 'usage.recorded' AND payload->>'meterId' = $1 AND payload->>'resourceId' = $2`, [meter, resourceId])).length;
const mkConnector = async (over: Row = {}) => {
  const r = await e.call('alice', 'POST', '/v1/connectors', { type: 'http', name: `c-${rid()}`, scopes: ['reports:read'], config: { allowedHosts: ['api.example.com'], authType: 'bearer', hostRegion: 'sa-central' }, ...over });
  if (r.statusCode !== 201) throw new Error(`connector: ${r.statusCode} ${r.body}`);
  return r.json() as Row;
};
const authorize = async (c: Row, org = A(), token = `tok_${rid()}`) => {
  const ref = await e.secrets.put(tenantSecretId(org, 'cred', rid()), token);
  const r = await e.call('alice', 'POST', `/v1/connectors/${c.id}/authorization`, { kind: 'credential', vaultRef: ref });
  if (r.statusCode !== 201) throw new Error(`authorize: ${r.statusCode} ${r.body}`);
  return token;
};
const ok200 = () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}', finalUrl: '', redirects: 0 });
const reset = () => {
  e.fakes.egress.calls = [];
  e.fakes.egress.handler = ok200;
  e.fakes.email.effects.clear();
  e.fakes.email.attempts = 0;
  e.fakes.email.failWith = undefined;
};
/** Replace the stored definition (a version that was valid when it was published; the connector changed afterwards). */
const forceDefinition = async (workflowId: string, d: Row) => {
  const vid = (await sql(`SELECT id FROM automation.workflow_versions WHERE workflow_id = $1`, [workflowId]))[0]!.id;
  await sql(`ALTER TABLE automation.workflow_versions DISABLE TRIGGER workflow_versions_immutable`);
  await sql(`UPDATE automation.workflow_versions SET definition = $2 WHERE id = $1`, [vid, JSON.stringify(d)]);
  await sql(`ALTER TABLE automation.workflow_versions ENABLE TRIGGER workflow_versions_immutable`);
};

beforeAll(async () => {
  e = await setupAutomationEnv();
}, 180_000);
afterAll(() => e.h.close());

/** mulberry32: a seeded PRNG so a failing fault run can be replayed from its seed. */
const prng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('AC-M11-01: idempotent retries, kills and duplicates (>= 200 randomized fault runs)', () => {
  it('0 duplicate effects, exactly-once metering and one result in every run', async () => {
    reset();
    const keys = new Set<string>();
    const receiver = (r: SafeRequest) => {
      const k = r.headers?.['idempotency-key'];
      if (k) keys.add(k); // the receiver dedupes by key
      return ok200();
    };
    const w = await mkWorkflow(
      def([
        { id: 'mail1', type: 'send_email', params: { senderId: SENDER, to: ['a@example.com'], subject: 'one {{ input.n }}', text: 'x' }, next: 'put', retry: { maxAttempts: 8 } },
        { id: 'put', type: 'http_request', params: { method: 'PUT', url: 'https://api.example.com/r/{{ input.n }}', body: { n: '{{ input.n }}' }, region: 'sa-central' }, next: 'calc', retry: { maxAttempts: 8 } },
        { id: 'calc', type: 'transform', params: { output: { n: '{{ input.n }}' } }, next: 'mail2' },
        { id: 'mail2', type: 'send_email', params: { senderId: SENDER, to: ['b@example.com'], subject: 'two {{ input.n }}', text: 'y' }, retry: { maxAttempts: 8 } },
      ]),
    );
    const RUNS = 210;
    const points: CrashPoint[] = ['before_effect', 'after_effect', 'after_step_commit'];
    const steps = ['mail1', 'put', 'mail2'];
    let totalCrashes = 0;
    let retriedSteps = 0;
    for (let n = 0; n < RUNS; n++) {
      const seed = 1000 + n;
      const rnd = prng(seed);
      const plan: { stepKey: string; point: CrashPoint }[] = [];
      for (let k = Math.floor(rnd() * 4); k > 0; k--) plan.push({ stepKey: steps[Math.floor(rnd() * steps.length)]!, point: points[Math.floor(rnd() * points.length)]! });
      // transient provider failures: the email port fails (retryable) and the target answers 503 some of the time
      let emailFails = Math.floor(rnd() * 3);
      e.fakes.email.failWith = () => (emailFails-- > 0 ? new ActionError('provider_down', 'try again', { retryable: true }) : null);
      let putFails = Math.floor(rnd() * 3);
      e.fakes.egress.handler = (r) => (putFails-- > 0 ? { status: 503, headers: {}, body: '', finalUrl: '', redirects: 0 } : receiver(r));
      const emailBefore = e.fakes.email.effects.size;
      const keysBefore = keys.size;
      const ex = await start(w, { n });
      const { exec, crashes } = await finishWithCrashes(ex.id, plan);
      totalCrashes += crashes;
      const ctx = `seed ${seed} plan ${JSON.stringify(plan)}`;
      expect(exec.status, ctx).toBe('succeeded');
      // exactly one effect per logical step, however many attempts or takeovers it took
      expect(e.fakes.email.effects.size - emailBefore, ctx).toBe(2);
      expect(keys.size - keysBefore, ctx).toBe(1);
      const okSteps = exec.steps.filter((s: Row) => s.status === 'succeeded').map((s: Row) => s.stepKey);
      expect(okSteps, ctx).toEqual(['mail1', 'put', 'calc', 'mail2']);
      // metering reconciles with the log: one execution event, one step event per succeeded billable step (3), none extra
      expect(await usage('automation.executions', exec.id), ctx).toBe(1);
      expect(await usage('automation.steps', exec.id), ctx).toBe(3);
      retriedSteps += exec.steps.filter((s: Row) => s.attempt > 1).length;
    }
    expect(RUNS).toBeGreaterThanOrEqual(200);
    expect(totalCrashes).toBeGreaterThan(100); // the faults really happened
    expect(retriedSteps).toBeGreaterThan(50); // and steps really were attempted more than once
  }, 900_000);

  it('a step is attempted again with the SAME idempotency key (the receiver sees one key)', async () => {
    reset();
    const w = await mkWorkflow(def([{ id: 'mail', type: 'send_email', params: { senderId: SENDER, to: ['a@example.com'], subject: 's', text: 't' } }]));
    const ex = await start(w);
    const { exec } = await finishWithCrashes(ex.id, [{ stepKey: 'mail', point: 'after_effect' }]);
    expect(exec.status).toBe('succeeded');
    expect(e.fakes.email.attempts).toBe(2); // attempted twice...
    expect(e.fakes.email.effects.size).toBe(1); // ...one effect
    const rows = await sql(`SELECT DISTINCT idempotency_key FROM automation.execution_steps WHERE execution_id = $1 AND step_key = 'mail'`, [ex.id]);
    expect(rows).toHaveLength(1);
  });
});

describe('non-idempotent actions are never retried automatically', () => {
  it('a POST that fails with 503 is attempted ONCE and dead-lettered', async () => {
    reset();
    e.fakes.egress.handler = () => ({ status: 503, headers: {}, body: '', finalUrl: '', redirects: 0 });
    const w = await mkWorkflow(def([{ id: 'charge', type: 'http_request', params: { method: 'POST', url: 'https://api.example.com/charge', body: { a: 1 }, region: 'sa-central' } }]));
    const { exec } = await finishWithCrashes((await start(w)).id);
    expect(exec.status).toBe('failed');
    expect(e.fakes.egress.calls).toHaveLength(1);
    expect(exec.steps).toHaveLength(1);
    expect(exec.steps[0].idempotent).toBe(false);
    expect(exec.deadLetters).toHaveLength(1);
  });
  it('a worker killed INSIDE a POST leaves an uncertain outcome: no second POST, a dead letter says reconcile first', async () => {
    reset();
    const w = await mkWorkflow(def([{ id: 'charge', type: 'http_request', params: { method: 'POST', url: 'https://api.example.com/charge', region: 'sa-central' } }]));
    const { exec, crashes } = await finishWithCrashes((await start(w)).id, [{ stepKey: 'charge', point: 'after_effect' }]);
    expect(crashes).toBe(1);
    expect(exec.status).toBe('failed');
    expect(e.fakes.egress.calls).toHaveLength(1);
    expect(exec.error.code).toBe('uncertain_outcome');
    expect(exec.steps.map((s: Row) => s.status)).toEqual(['unknown']);
  });
  it('the same POST WITH an idempotency-key mapping IS retried (and carries the key)', async () => {
    reset();
    let n = 0;
    e.fakes.egress.handler = () => (++n < 3 ? { status: 503, headers: {}, body: '', finalUrl: '', redirects: 0 } : { status: 201, headers: {}, body: '{}', finalUrl: '', redirects: 0 });
    const w = await mkWorkflow(def([{ id: 'charge', type: 'http_request', params: { method: 'POST', url: 'https://api.example.com/charge', region: 'sa-central' }, idempotencyKey: 'order-{{ input.orderId }}' }]));
    const { exec } = await finishWithCrashes((await start(w, { orderId: 42 })).id);
    expect(exec.status).toBe('succeeded');
    expect(e.fakes.egress.calls).toHaveLength(3);
    expect(new Set(e.fakes.egress.calls.map((c) => c.headers?.['idempotency-key']))).toEqual(new Set(['order-42']));
  });
  it('retries stop at the maximum and the execution fails with a dead letter; replay is idempotent', async () => {
    reset();
    e.fakes.egress.handler = () => ({ status: 503, headers: {}, body: '', finalUrl: '', redirects: 0 });
    const w = await mkWorkflow(def([{ id: 'put', type: 'http_request', params: { method: 'PUT', url: 'https://api.example.com/x', region: 'sa-central' }, retry: { maxAttempts: 3 }, next: 'mail' }, { id: 'mail', type: 'send_email', params: { senderId: SENDER, to: ['a@example.com'], subject: 's', text: 't' } }]));
    const { exec } = await finishWithCrashes((await start(w)).id);
    expect(exec.status).toBe('failed');
    expect(exec.steps.filter((s: Row) => s.stepKey === 'put')).toHaveLength(3);
    expect(exec.deadLetters).toHaveLength(1);
    const dl = exec.deadLetters[0];
    // the target recovers; replay twice (a double click, a retried request) = ONE new execution
    e.fakes.egress.handler = ok200;
    const ex = e.app.get(ExecutionService);
    const r1 = await ex.replay(A(), e.ids.alice!, dl.id);
    const r2 = await ex.replay(A(), e.ids.alice!, dl.id);
    expect(r2.id).toBe(r1.id);
    expect(r2.duplicate).toBe(true);
    const done = (await finishWithCrashes(r1.id)).exec;
    expect(done.status).toBe('succeeded');
    expect(e.fakes.email.effects.size).toBe(1);
    // the replay reused the original's idempotency keys
    const keys = await sql(`SELECT count(DISTINCT idempotency_key) n FROM automation.execution_steps WHERE execution_id IN ($1,$2) AND step_key = 'put'`, [exec.id, r1.id]);
    expect(Number(keys[0]!.n)).toBe(1);
  });
});

describe('AC-M11-02: unauthorized and revoked connectors are blocked (>= 30 fixtures)', () => {
  const httpDef = (connectorId: string, extra: Row = {}) => def([{ id: 'call', type: 'http_request', params: { method: 'GET', url: 'https://api.example.com/r', connectorId, scope: 'reports:read', region: 'sa-central', ...extra } }]);

  it('runtime fails closed (403 connector_not_authorized semantics) in every fixture; nothing leaves', async () => {
    reset();
    let fixtures = 0;
    const blockedAtRuntime = async (d: Row, label: string) => {
      fixtures++;
      const wf = await mkWorkflow(def([{ id: 'tr', type: 'transform', params: { output: { a: 1 } } }]));
      await forceDefinition(wf.id, d); // a version that was valid when it was published; the connector changed afterwards
      const before = e.fakes.egress.calls.length + e.fakes.nuzm.calls.length;
      const { exec } = await finishWithCrashes((await start(wf)).id);
      expect(exec.status, label).toBe('failed');
      expect(exec.error.code, label).toBe('connector_not_authorized');
      expect(e.fakes.egress.calls.length + e.fakes.nuzm.calls.length, label).toBe(before); // nothing left the building
    };
    const cs = e.app.get(ConnectorService);
    // 1-4: states of the authorization / connector
    const pending = await mkConnector();
    await blockedAtRuntime(httpDef(pending.id), 'never authorized');
    const revoked = await mkConnector();
    await authorize(revoked);
    await cs.revoke(A(), e.ids.alice!, revoked.id);
    await blockedAtRuntime(httpDef(revoked.id), 'revoked');
    const expired = await mkConnector();
    await authorize(expired);
    await sql(`UPDATE automation.connector_authorizations SET expires_at = now() - interval '1 second' WHERE connector_id = $1`, [expired.id]);
    await blockedAtRuntime(httpDef(expired.id), 'expired');
    const disabled = await mkConnector();
    await authorize(disabled);
    await sql(`UPDATE automation.connectors SET status = 'disabled' WHERE id = $1`, [disabled.id]);
    await blockedAtRuntime(httpDef(disabled.id), 'disabled');
    // 5-10: scope not granted
    const scoped = await mkConnector();
    await authorize(scoped);
    for (const scope of ['reports:write', 'billing:read', 'admin:*', 'reports', 'reports:read:extra', '*']) await blockedAtRuntime(httpDef(scoped.id, { scope }), `scope ${scope}`);
    // 11-16: ids that do not exist, are malformed or hostile
    for (const id of ['0190a000-0000-7000-8000-00000000dead', '00000000-0000-0000-0000-000000000000', 'not-a-uuid', '../../etc', "1' OR '1'='1", 'x'.repeat(40)]) await blockedAtRuntime(httpDef(id), `bad id ${id}`);
    // 17-20: another organization's connector, authorized THERE
    const other = (await e.call('bob', 'POST', '/v1/connectors', { type: 'http', name: `c-${rid()}`, scopes: ['reports:read'], config: { allowedHosts: ['api.example.com'], hostRegion: 'sa-central' } }, e.org.B)).json();
    const ref = await e.secrets.put(tenantSecretId(e.org.B!, 'cred', rid()), 'tok_other');
    expect((await e.call('bob', 'POST', `/v1/connectors/${other.id}/authorization`, { kind: 'credential', vaultRef: ref }, e.org.B)).statusCode).toBe(201);
    for (let i = 0; i < 4; i++) await blockedAtRuntime(httpDef(other.id, { i }), `foreign connector ${i}`);
    // 21-26: a Nuzm API step needs a first-party connector with the right scope
    const nz = (await e.call('alice', 'POST', '/v1/connectors', { type: 'nuzm', name: `n-${rid()}`, scopes: ['projects:read'] })).json();
    await authorize(nz);
    for (const [method, path] of [['POST', '/v1/projects'], ['DELETE', '/v1/projects/x'], ['PATCH', '/v1/projects/x'], ['GET', '/v1/billing/ledger'], ['GET', '/v1/audit-logs'], ['PUT', '/v1/billing/spending-limits']] as const)
      await blockedAtRuntime(def([{ id: 'call', type: 'nuzm_api', params: { method, path, connectorId: nz.id } }]), `nuzm ${method} ${path}`);
    // 27-28: connector of the wrong type for the step
    const h = await mkConnector();
    await authorize(h);
    await blockedAtRuntime(def([{ id: 'call', type: 'nuzm_api', params: { method: 'GET', path: '/v1/projects', connectorId: h.id, scope: 'reports:read' } }]), 'http connector on a nuzm step');
    const mail = (await e.call('alice', 'POST', '/v1/connectors', { type: 'email', name: `m-${rid()}`, scopes: [] })).json();
    await blockedAtRuntime(httpDef(mail.id), 'email connector never authorized');
    // 29-31: the connector is authorized but the revoked authorization was the only one; a second revoke is harmless
    const twice = await mkConnector();
    await authorize(twice);
    await cs.revoke(A(), e.ids.alice!, twice.id);
    await cs.revoke(A(), e.ids.alice!, twice.id);
    await blockedAtRuntime(httpDef(twice.id), 'revoked twice');
    await blockedAtRuntime(httpDef(twice.id, { scope: 'reports:read' }), 'revoked twice, scope given');
    await blockedAtRuntime(httpDef(twice.id, { scope: undefined }), 'revoked twice, no scope');
    expect(fixtures).toBeGreaterThanOrEqual(30);
  }, 300_000);

  it('publish: a version referencing an unauthorized connector is 422 with connector_not_authorized in errors[]', async () => {
    const c = await mkConnector(); // pending: no authorization
    const r = await e.call('alice', 'POST', '/v1/workflows', { name: 'x', definition: httpDef(c.id) });
    expect(r.statusCode).toBe(422);
    expect(r.json().errors.map((x: Row) => x.code)).toContain('connector_not_authorized');
    await authorize(c);
    expect((await e.call('alice', 'POST', '/v1/workflows', { name: 'x', definition: httpDef(c.id) })).statusCode).toBe(201);
    const foreign = (await e.call('bob', 'POST', '/v1/connectors', { type: 'http', name: 'f', scopes: [], config: { allowedHosts: ['api.example.com'] } }, e.org.B)).json();
    expect((await e.call('alice', 'POST', '/v1/workflows', { name: 'x', definition: httpDef(foreign.id) })).statusCode).toBe(422);
  });

  it('revoking the authorization stops a RUNNING execution at its next step', async () => {
    reset();
    const c = await mkConnector();
    await authorize(c);
    const w = await mkWorkflow(
      def([
        { id: 'first', type: 'http_request', params: { method: 'GET', url: 'https://api.example.com/1', connectorId: c.id, scope: 'reports:read', region: 'sa-central' }, next: 'pause' },
        { id: 'pause', type: 'delay', params: { seconds: 60 }, next: 'second' },
        { id: 'second', type: 'http_request', params: { method: 'GET', url: 'https://api.example.com/2', connectorId: c.id, scope: 'reports:read', region: 'sa-central' } },
      ]),
    );
    const id = (await start(w)).id;
    expect(await engine().runOne(A(), id)).toBe('deferred'); // first step done, waiting
    expect(e.fakes.egress.calls).toHaveLength(1);
    await e.app.get(ConnectorService).revoke(A(), e.ids.alice!, c.id);
    engine().useClock(() => new Date(Date.now() + 61_000));
    await makeDue(id);
    const { exec } = await finishWithCrashes(id);
    engine().useClock(() => new Date());
    expect(exec.status).toBe('failed');
    expect(exec.error.code).toBe('connector_not_authorized');
    expect(e.fakes.egress.calls).toHaveLength(1); // the second call never went out
    expect(e.sink.events.some((x) => x.action === 'connector.connector.revoked')).toBe(true);
  });

  it('a token cannot gain scopes: authorization requesting an undeclared scope is refused', async () => {
    const c = await mkConnector();
    const ref = await e.secrets.put(tenantSecretId(A(), 'cred', rid()), 'tok');
    const r = await e.call('alice', 'POST', `/v1/connectors/${c.id}/authorization`, { kind: 'credential', vaultRef: ref, scopes: ['reports:read', 'billing:write'] });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('connector_not_authorized');
  });

  it("rejects raw secrets in bodies and vault references that are not this organization's", async () => {
    const c = await mkConnector();
    for (const body of [{ kind: 'credential', token: 'plain-secret-value' }, { kind: 'credential', apiKey: 'abc' }, { kind: 'credential', vaultRef: 'plain-text-secret' }, { kind: 'credential', vaultRef: 'vault://dev/audit-checkpoint-key' }, { kind: 'credential', vaultRef: `vault://mem/tenant-${e.org.B}-cred-x` }]) {
      const r = await e.call('alice', 'POST', `/v1/connectors/${c.id}/authorization`, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(422);
      expect(r.json().code).toBe('credential_value_rejected');
    }
    const create = await e.call('alice', 'POST', '/v1/connectors', { type: 'http', name: `x-${rid()}`, scopes: [], config: { allowedHosts: ['a.example.com'] }, clientSecret: 'oops' });
    expect(create.statusCode).toBe(422);
    expect(create.json().code).toBe('credential_value_rejected');
  });

  it('rate limit (token bucket) and circuit breaker trip per connector', async () => {
    const c = await mkConnector({ rateLimit: { perMinute: 60, burst: 2 } });
    const cs = e.app.get(ConnectorService);
    cs.acquire(c.id, { perMinute: 60, burst: 2 });
    cs.acquire(c.id, { perMinute: 60, burst: 2 });
    expect(() => cs.acquire(c.id, { perMinute: 60, burst: 2 })).toThrow(/rate limit/);
    const c2 = await mkConnector();
    for (let i = 0; i < 5; i++) {
      cs.acquire(c2.id, { perMinute: 6000, burst: 1000 });
      cs.outcome(c2.id, false);
    }
    expect(() => cs.acquire(c2.id, { perMinute: 6000, burst: 1000 })).toThrow(/circuit/);
  });
});

describe('AC-M11-03 at runtime: tenant URLs never reach internal targets', () => {
  it('the guarded egress denies private, loopback, metadata and rebinding targets; steps fail with ssrf_denied', async () => {
    const transportHits: string[] = [];
    const guard = new GuardedEgressPort(
      new SafeHttpClient(
        DEFAULT_EGRESS,
        async (h) => (h === 'rebind.example.com' ? ['10.0.0.7'] : ['93.184.216.34']),
        async (r) => {
          transportHits.push(r.url.href);
          return { status: 200, headers: {}, body: '{}' };
        },
      ),
    );
    reset();
    e.fakes.egress.handler = (r) => guard.request(r, {});
    const urls = ['https://localhost/x', 'https://127.0.0.1/', 'https://169.254.169.254/latest/meta-data/', 'https://10.1.2.3/', 'https://[::1]/', 'https://rebind.example.com/', 'https://metadata.google.internal/', 'https://2130706433/', 'https://192.168.0.1/'];
    // plain http never even publishes
    expect((await e.call('alice', 'POST', '/v1/workflows', { name: 'h', definition: def([{ id: 'go', type: 'http_request', params: { method: 'GET', url: 'http://api.example.com/' } }]) })).statusCode).toBe(422);
    for (const u of urls) {
      const w = await mkWorkflow(def([{ id: 'go', type: 'http_request', params: { method: 'PUT', url: u, region: 'sa-central' }, retry: { maxAttempts: 1 } }]));
      const { exec } = await finishWithCrashes((await start(w)).id);
      expect(exec.status, u).toBe('failed');
      expect(exec.error.code, u).toBe('ssrf_denied');
    }
    expect(transportHits).toHaveLength(0);
  });
  it('residency: a target the policy denies is never called', async () => {
    reset();
    e.fakes.residency.deny = true;
    const w = await mkWorkflow(def([{ id: 'go', type: 'http_request', params: { method: 'GET', url: 'https://api.example.com/x', region: 'eu-frankfurt' } }]));
    const { exec } = await finishWithCrashes((await start(w)).id);
    e.fakes.residency.deny = false;
    expect(exec.status).toBe('failed');
    expect(exec.error.code).toBe('residency_denied');
    expect(e.fakes.egress.calls).toHaveLength(0);
  });
});

describe('AI and deployment actions go through the M09 ports (NOT VERIFIED against the real service)', () => {
  it('start_ai_run and create_deployment are idempotent per step', async () => {
    reset();
    const w = await mkWorkflow(def([{ id: 'ai', type: 'start_ai_run', params: { kind: 'website', prompt: 'a bakery site' }, next: 'dep' }, { id: 'dep', type: 'create_deployment', params: { projectId: 'p-1' } }]));
    const { exec } = await finishWithCrashes((await start(w)).id, [{ stepKey: 'ai', point: 'after_effect' }, { stepKey: 'dep', point: 'after_effect' }]);
    expect(exec.status).toBe('succeeded');
    expect(e.fakes.ai.runs.size).toBe(1);
    expect(e.fakes.deploy.deployments.size).toBe(1);
  });
});

describe('per-organization concurrency cap', () => {
  it('a run beyond the cap is deferred, not dropped', async () => {
    reset();
    const w = await mkWorkflow(def([{ id: 'mail', type: 'send_email', params: { senderId: SENDER, to: ['a@example.com'], subject: 's', text: 't' } }]));
    const held: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = (await start(w)).id;
      engine().hooks.at = (p) => {
        if (p === 'before_effect') throw new SimulatedCrash('held');
      };
      await expect(engine().runOne(A(), id)).rejects.toBeInstanceOf(SimulatedCrash);
      engine().hooks.at = undefined;
      held.push(id);
    }
    const fourth = (await start(w)).id;
    expect(await engine().runOne(A(), fourth)).toBe('deferred');
    expect((await get(fourth)).status).toBe('queued');
    for (const id of held) await finishWithCrashes(id); // the "dead" ones are taken over and finish
    expect((await finishWithCrashes(fourth)).exec.status).toBe('succeeded');
  });
});
