import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupAiEnv, type AiEnv } from './testing/ai-harness';

/** DEFECT-15 (Session 07): a burst of run creations must never leave more active runs than the organization's ceiling (here 3). Mock provider; nothing leaves the process. */
let e: AiEnv;
const A = () => e.org.A!;
const j = (r: { json(): unknown }) => r.json() as Record<string, unknown>;

beforeAll(async () => {
  process.env.AI_MAX_CONCURRENT_RUNS = '3';
  e = await setupAiEnv();
  await e.enableMock('mock-model');
  await e.fund(A(), '100000000');
}, 300_000);
afterAll(() => {
  delete process.env.AI_MAX_CONCURRENT_RUNS;
  return e.h.close();
});

describe('concurrent-run ceiling', () => {
  it('30 simultaneous run creations leave at most 3 active runs; the rest are refused 429', async () => {
    const sessions = await Promise.all(
      Array.from(
        { length: 30 },
        async (_v, i) =>
          j(await e.call('alice', 'POST', '/v1/ai/sessions', { title: `burst ${i}` }, A()))
            .id as string,
      ),
    );
    const results = await Promise.all(
      sessions.map((sessionId) =>
        e.call(
          'alice',
          'POST',
          '/v1/ai/runs',
          { sessionId, kind: 'chat', input: { message: 'hi' } },
          A(),
        ),
      ),
    );
    const created = results.filter((r) => r.statusCode < 300).length;
    const refused = results.filter((r) => r.statusCode === 429).length;
    expect(created + refused, results.map((r) => r.statusCode).join()).toBe(30);
    const active = Number(
      (
        await e.sql(`SELECT count(*)::int n FROM ai.runs WHERE org_id=$1 AND state = ANY($2)`, [
          A(),
          ['queued', 'running', 'waiting_approval'],
        ])
      )[0]!.n,
    );
    expect(active).toBeLessThanOrEqual(3);
    expect(created).toBeLessThanOrEqual(3);
    expect(created).toBeGreaterThan(0);
  });
});
