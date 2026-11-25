import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setupAiEnv, type AiEnv } from './testing/ai-harness';

/**
 * O-9 for the AI routes (DEFECT-17): `builder.billing_admin_content_access = deny` is consulted by the routes that return a customer's conversation text or a run's content.
 * Only `billing_admin` is affected; usage, credits, budgets, models and approvals stay readable; each denial is audited. Mock provider; nothing leaves the process.
 */
let e: AiEnv;
const A = () => e.org.A!;
const j = (r: { json(): unknown }) => r.json() as Record<string, unknown>;
let sessionId: string;
let runId: string;
const KEY = 'builder.billing_admin_content_access';

const setPolicy = async (mode: 'allow' | 'deny' | null) => {
  await e.sql(`DELETE FROM platform.feature_flags WHERE key=$1 AND org_id=$2`, [KEY, A()]);
  if (mode)
    await e.sql(
      `INSERT INTO platform.feature_flags (id, key, org_id, value, updated_by) VALUES ($1,$2,$3,$4::jsonb,$5)`,
      [randomUUID(), KEY, A(), JSON.stringify({ mode }), e.ids.alice],
    );
};
const as = (who: string, url: string) => e.call(who, 'GET', url, undefined, A());
const CONTENT = (): [string, string][] => [
  ['sessions', '/v1/ai/sessions'],
  ['messages', `/v1/ai/sessions/${sessionId}/messages`],
  ['runs', '/v1/ai/runs'],
  ['run', `/v1/ai/runs/${runId}`],
  ['events', `/v1/ai/runs/${runId}/events`],
  ['artifact', `/v1/ai/runs/${runId}/artifacts/${randomUUID()}`],
];
const BILLING = ['/v1/ai/credits', '/v1/ai/budgets', '/v1/ai/models'];

beforeAll(async () => {
  e = await setupAiEnv();
  await e.enableMock('mock-model');
  await e.fund(A(), '100000000');
  sessionId = j(
    await e.call('alice', 'POST', '/v1/ai/sessions', { title: 'O-9 conversation' }, A()),
  ).id as string;
  runId = j(
    await e.call(
      'alice',
      'POST',
      '/v1/ai/runs',
      { sessionId, kind: 'chat', input: { message: 'hi' } },
      A(),
    ),
  ).id as string;
  // a finished run: its event stream ends at once
  await e.sql(`UPDATE ai.runs SET state='cancelled', finished_at=now() WHERE id=$1`, [runId]);
}, 300_000);
afterAll(() => e.h.close());

describe('O-9 on the AI routes', () => {
  it('default (no setting = allow): a billing administrator reads exactly what it reads today', async () => {
    await setPolicy(null);
    for (const [name, url] of CONTENT()) {
      const r = await as('frank', url);
      expect(r.statusCode, `${name}: ${r.body}`).toBe(name === 'artifact' ? 404 : 200);
    }
  });
  it('allow set explicitly: the same', async () => {
    await setPolicy('allow');
    for (const [name, url] of CONTENT())
      expect((await as('frank', url)).statusCode, name).toBe(name === 'artifact' ? 404 : 200);
  });
  it('deny: the six content routes answer 403 to a billing administrator, each denial is audited with the operation and no content', async () => {
    await setPolicy('deny');
    const before = e.sink.events.filter((x) => x.action === 'ai.content.access_denied').length;
    for (const [name, url] of CONTENT()) {
      const r = await as('frank', url);
      expect(r.statusCode, `${name}: ${r.body}`).toBe(403);
      expect(r.body).not.toContain('O-9 conversation');
    }
    const denied = e.sink.events.filter((x) => x.action === 'ai.content.access_denied');
    expect(denied.length - before).toBe(6);
    expect(denied.slice(-6).map((x) => x.detail.operation)).toEqual([
      'ai_sessions',
      'ai_messages',
      'ai_runs',
      'ai_run',
      'ai_run_events',
      'ai_artifacts',
    ]);
    for (const x of denied) {
      expect(x.actorUserId).toBe(e.ids.frank);
      expect(x.detail).toMatchObject({ role: 'billing_admin', setting: KEY });
      expect(JSON.stringify(x)).not.toContain('O-9 conversation');
    }
  });
  it('deny: billing data stays readable for the billing administrator (credits, budgets, models; the approvals list is outside this module and is not changed)', async () => {
    await setPolicy('deny');
    for (const url of BILLING) expect((await as('frank', url)).statusCode, url).toBe(200);
  });
  it('deny: nobody else is affected (owner, developer, viewer, admin member read as before)', async () => {
    await setPolicy('deny');
    for (const who of ['alice', 'dave', 'carol', 'erin'])
      for (const [name, url] of CONTENT())
        expect((await as(who, url)).statusCode, `${who} ${name}`).toBe(
          name === 'artifact' ? 404 : 200,
        );
  });
  it("a damaged setting reads as deny (the restrictive choice), and removing the setting restores today's behaviour", async () => {
    await e.sql(`DELETE FROM platform.feature_flags WHERE key=$1 AND org_id=$2`, [KEY, A()]);
    await e.sql(
      `INSERT INTO platform.feature_flags (id, key, org_id, value, updated_by) VALUES ($1,$2,$3,'"garbage"'::jsonb,$4)`,
      [randomUUID(), KEY, A(), e.ids.alice],
    );
    expect((await as('frank', '/v1/ai/sessions')).statusCode).toBe(403);
    await setPolicy(null);
    expect((await as('frank', '/v1/ai/sessions')).statusCode).toBe(200);
  });
  it("one organization's setting never affects another", async () => {
    await setPolicy('deny');
    // org B has no setting: its billing administrator (if any) is unaffected; the owner of B reads its own content
    expect((await e.call('bob', 'GET', '/v1/ai/sessions', undefined, e.org.B!)).statusCode).toBe(
      200,
    );
    await setPolicy(null);
  });
});
