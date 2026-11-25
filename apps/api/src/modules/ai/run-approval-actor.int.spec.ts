import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockModelAdapter } from '@nuzm/adapter-model';
import { mockModelHandler } from '@nuzm/domain';
import { setupAiEnv, type AiEnv, type Row } from './testing/ai-harness';

/**
 * DEFECT-6 (Session 07): who may decide the approval an AI run is waiting for. A person in a session with `ai:approve` may; an API key never may (even one that
 * created the run), and the audit names the person who really decided. The waiting run and its approval row are written with SQL: the point is the decision route.
 */
let e: AiEnv;
const A = () => e.org.A!;
const j = (r: { json(): unknown }) => r.json() as Row;

const waitingRun = async (kind = 'publish') => {
  await e.sql(
    `UPDATE ai.runs SET state='cancelled', finished_at=now() WHERE state='waiting_approval'`,
  );
  const sid = j(await e.call('alice', 'POST', '/v1/ai/sessions', { title: 'approval actor' }, A()))
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
  await e.sql(`UPDATE ai.runs SET state='running' WHERE id=$1`, [runId]);
  await e.sql(`UPDATE ai.runs SET state='waiting_approval' WHERE id=$1`, [runId]);
  const id = randomUUID();
  await e.sql(
    `INSERT INTO ai.approvals (id, org_id, run_id, kind, action_hash, summary, requested_by, expires_at) VALUES ($1,$2,$3,$4,$5,'{"title":"t"}', $6, now() + interval '1 hour')`,
    [id, A(), runId, kind, createHash('sha256').update(id).digest('hex'), e.ids.alice],
  );
  return { runId, approvalId: id };
};
const viaKey = (bearer: string, runId: string, approvalId: string, decision = 'approve') =>
  e.app.inject({
    method: 'POST',
    url: `/v1/ai/runs/${runId}/approvals`,
    headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': `k-${Math.random()}` },
    payload: { approvalId, decision },
  });
const state = async (id: string) =>
  (await e.sql(`SELECT state, decided_by FROM ai.approvals WHERE id=$1`, [id]))[0]!;
const key = async (scopes: string[]) => {
  const r = await e.call(
    'alice',
    'POST',
    '/v1/api-keys',
    { name: `k-${Math.random()}`, scopes },
    A(),
  );
  expect(r.statusCode, r.body).toBe(201);
  return j(r).key as string;
};
const decide = (who: string, runId: string, approvalId: string, decision = 'approve') =>
  e.call(who, 'POST', `/v1/ai/runs/${runId}/approvals`, { approvalId, decision });

beforeAll(async () => {
  e = await setupAiEnv();
  await e.enableMock('mock-model', {
    adapter: new MockModelAdapter({ id: 'mock-model', handler: (r) => mockModelHandler(r) }),
  });
  await e.fund(A(), '100000000');
}, 180_000);
afterAll(() => e.h.close());

describe('DEFECT-6: the approver of a run approval is a person with ai:approve', () => {
  it('an API key with ai:write cannot approve or deny (403) and the approval stays pending', async () => {
    const { runId, approvalId } = await waitingRun();
    const bearer = await key(['ai:write', 'ai:read']);
    expect((await viaKey(bearer, runId, approvalId)).statusCode).toBe(403);
    expect((await viaKey(bearer, runId, approvalId, 'deny')).statusCode).toBe(403);
    expect((await state(approvalId)).state).toBe('pending');
  });
  it('a viewer and a billing admin stay refused; the organization owner decides, and the audit names that person', async () => {
    const { runId, approvalId } = await waitingRun('spend');
    for (const who of ['carol', 'frank'])
      expect((await decide(who, runId, approvalId)).statusCode, who).toBe(403);
    expect((await state(approvalId)).state).toBe('pending');
    const ok = await decide('alice', runId, approvalId);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await state(approvalId)).toMatchObject({ state: 'approved', decided_by: e.ids.alice });
    expect(
      (e.sink.events as { action: string; actorUserId?: string; actorType?: string }[]).some(
        (x) =>
          x.action === 'ai.approval.granted' &&
          x.actorUserId === e.ids.alice &&
          x.actorType === 'user',
      ),
    ).toBe(true);
  });
  it('a developer and an admin member (roles with ai:approve) can still decide', async () => {
    for (const who of ['dave', 'erin']) {
      const { runId, approvalId } = await waitingRun('delete');
      const r = await decide(who, runId, approvalId, 'deny');
      expect(r.statusCode, `${who}: ${r.body}`).toBe(200);
      expect((await state(approvalId)).state).toBe('denied');
    }
  });
  it('an API key can still cancel its run (ai:write is enough for that): only the gate moved', async () => {
    const { runId } = await waitingRun();
    const r = await e.app.inject({
      method: 'POST',
      url: `/v1/ai/runs/${runId}/cancellation`,
      headers: {
        authorization: `Bearer ${await key(['ai:write'])}`,
        'idempotency-key': `k-${Math.random()}`,
      },
    });
    expect(r.statusCode, r.body).toBe(202);
  });
});
