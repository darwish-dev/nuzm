import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockModelAdapter } from '@nuzm/adapter-model';
import { mockModelHandler } from '@nuzm/domain';
import { setupAiEnv, type AiEnv, type Row } from '../modules/ai/testing/ai-harness';

/**
 * Session 07 (QA) - who can decide the approval a run is waiting for (`POST /v1/ai/runs/{id}/approvals`)? The route comment says "the approver is always a human member".
 * Own Postgres, in-process server, dev-reference model; nothing leaves the process. The waiting run and its approval row are written with SQL (test fixture), because the
 * point is the decision route, not the run engine (covered by runs.int.spec.ts). `it.fails` marks DEFECT-6 (owner: Session 02, `apps/api/src/modules/ai/**`).
 */
let e: AiEnv;
const A = () => e.org.A!;
const j = (r: { json(): unknown }) => r.json() as Row;

const waitingRun = async (kind = 'plan') => {
  // the per-organization cap on active runs counts waiting ones: retire the earlier fixtures
  await e.sql(
    `UPDATE ai.runs SET state='cancelled', finished_at=now() WHERE state='waiting_approval'`,
  );
  const sid = j(await e.call('alice', 'POST', '/v1/ai/sessions', { title: 'QA' }, A()))
    .id as string;
  const run = await e.call(
    'alice',
    'POST',
    '/v1/ai/runs',
    { sessionId: sid, kind: 'chat', input: { message: 'hi' } },
    A(),
  );
  expect(run.statusCode, run.body).toBeLessThan(300);
  const runId = j(run).id as string;
  // the database enforces legal run transitions (trigger): walk the legal path
  await e.sql(`UPDATE ai.runs SET state='running' WHERE id=$1`, [runId]);
  await e.sql(`UPDATE ai.runs SET state='waiting_approval' WHERE id=$1`, [runId]);
  const id = randomUUID();
  await e.sql(
    `INSERT INTO ai.approvals (id, org_id, run_id, kind, action_hash, summary, requested_by, expires_at) VALUES ($1,$2,$3,$4,$5,'{"title":"qa"}', $6, now() + interval '1 hour')`,
    [id, A(), runId, kind, createHash('sha256').update(id).digest('hex'), e.ids.alice],
  );
  return { runId, approvalId: id };
};
const decide = (who: string, runId: string, approvalId: string, decision = 'approve') =>
  e.call(who, 'POST', `/v1/ai/runs/${runId}/approvals`, { approvalId, decision });
const viaKey = async (bearer: string, runId: string, approvalId: string) =>
  e.app.inject({
    method: 'POST',
    url: `/v1/ai/runs/${runId}/approvals`,
    headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': `k-${Math.random()}` },
    payload: { approvalId, decision: 'approve' },
  });
const state = async (id: string) =>
  (await e.sql(`SELECT state, decided_by FROM ai.approvals WHERE id=$1`, [id]))[0]!;

beforeAll(async () => {
  e = await setupAiEnv();
  await e.enableMock('mock-model', {
    adapter: new MockModelAdapter({ id: 'mock-model', handler: (r) => mockModelHandler(r) }),
  });
  await e.fund(e.org.A!, '100000000');
}, 180_000);
afterAll(() => e.h.close());

describe('QA run approvals: who may decide', () => {
  it('a viewer and a billing admin cannot decide (403) and the approval stays pending', async () => {
    const { runId, approvalId } = await waitingRun();
    for (const who of ['carol', 'frank'])
      expect((await decide(who, runId, approvalId)).statusCode, who).toBe(403);
    expect((await state(approvalId)).state).toBe('pending');
  });
  it('another organization cannot decide it (404) and the approval stays pending', async () => {
    const { runId, approvalId } = await waitingRun();
    const r = await e.call(
      'bob',
      'POST',
      `/v1/ai/runs/${runId}/approvals`,
      { approvalId, decision: 'approve' },
      e.org.B!,
    );
    expect(r.statusCode).toBe(404);
    expect((await state(approvalId)).state).toBe('pending');
  });
  it('a decision cannot be moved to a different run (approval id of run X is not found under run Y)', async () => {
    const x = await waitingRun();
    const y = await waitingRun();
    expect((await decide('alice', y.runId, x.approvalId)).statusCode).toBe(404);
    expect((await state(x.approvalId)).state).toBe('pending');
  });
  it('a decided approval is final: a second decision is a conflict, never a flip', async () => {
    const { runId, approvalId } = await waitingRun();
    expect((await decide('alice', runId, approvalId, 'deny')).statusCode).toBe(200);
    const again = await decide('alice', runId, approvalId, 'approve');
    expect(again.statusCode).toBe(409);
    expect((await state(approvalId)).state).toBe('denied');
  });

  it('DEFECT-6: an API key (not a human) cannot decide a run approval', async () => {
    const { runId, approvalId } = await waitingRun();
    const kr = await e.call(
      'alice',
      'POST',
      '/v1/api-keys',
      { name: 'qa-run-key', scopes: ['ai:write', 'ai:read'] },
      A(),
    );
    expect(kr.statusCode, kr.body).toBe(201);
    const res = await viaKey(j(kr).key as string, runId, approvalId);
    // secure expectation: refused; a human member decides
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect((await state(approvalId)).state).toBe('pending');
  });
});
