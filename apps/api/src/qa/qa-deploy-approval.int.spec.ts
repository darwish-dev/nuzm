import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockModelAdapter } from '@nuzm/adapter-model';
import { mockModelHandler } from '@nuzm/domain';
import { setupAiEnv, type AiEnv, type Row } from '../modules/ai/testing/ai-harness';

/**
 * Session 07 (QA) - who can "approve" a website publish, and does tenant isolation hold on the deploy routes? Needs the database (own cluster, port 54347).
 * Offline: the publisher is the in-memory fake node (`InMemorySitePublisher`), nothing is deployed anywhere. It says nothing about a real hosting node.
 *
 * `it.fails` marks a DEFECT owned by another session (docs/parallel/sessions/DEFECT-4-*.md): the test states the SECURE expectation and is expected to fail today.
 */
let e: AiEnv;
const A = () => e.org.A!;
const B = () => e.org.B!;
const j = (r: { json(): unknown }) => r.json() as Row;
let planId: string;

const mkSite = async (org: string, user: string, name: string) => {
  const id = randomUUID();
  await e.sql(
    `INSERT INTO hosting.sites (id, org_id, name, token, node_name, plan_id, runtime, status, data_region, created_by, credentials_ref, backup_key_ref, domain_primary)
     VALUES ($1,$2,$3,$4,$5,$6,'static','active','sa-central',$7,'vault://t/c','vault://t/b',NULL)`,
    [
      id,
      org,
      name,
      randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      `s-${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      planId,
      e.ids[user],
    ],
  );
  return id;
};
const mkProject = async (name: string, who = 'alice', org = A()) =>
  j(
    await e.call(
      who,
      'POST',
      '/v1/builder/projects',
      { type: 'website', name, locale: ['ar', 'en'], templateId: 'landing' },
      org,
    ),
  );
const asUser = (
  body: Row,
  who: string,
  org = A(),
  key = `k-${Math.random()}`,
  url = '/v1/deployments',
) => e.call(who, 'POST', url, body, org, { 'idempotency-key': key });
const asKey = (body: Row, bearer: string, key = `k-${Math.random()}`, url = '/v1/deployments') =>
  e.app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': key },
    payload: body,
  });
const mkKey = async (who: string, scopes: string[], org = A()) => {
  const r = await e.call(who, 'POST', '/v1/api-keys', { name: `qa-${Math.random()}`, scopes }, org);
  expect(r.statusCode, r.body).toBe(201);
  return j(r).key as string;
};
const deployCount = async () =>
  Number((await e.sql(`SELECT count(*) n FROM deploy.deployments`))[0]!.n);

beforeAll(async () => {
  e = await setupAiEnv();
  await e.enableMock('mock-model', {
    adapter: new MockModelAdapter({ id: 'mock-model', handler: (r) => mockModelHandler(r) }),
  });
  planId = randomUUID();
  await e.sql(
    `INSERT INTO hosting.plan_definitions (id, key, name_ar, name_en, status, quotas, runtimes, reservation) VALUES ($1, 'qa-plan', 'خطة', 'Plan', 'active', '{"diskMb":1,"inodes":1000,"bandwidthGb":1,"dbCount":1,"sitesCount":1}', '["php"]', '{"cpu_millicores":1,"memory_mb":1,"disk_mb":1}')`,
    [planId],
  );
}, 120_000);
afterAll(() => e.h.close());

describe('QA deploy: tenant isolation (org B cannot reach org A through any deploy route)', () => {
  it('another organization cannot ask for, confirm or read a deployment of org A, and nothing is created', async () => {
    const p = await mkProject('QA Iso');
    const site = await mkSite(A(), 'alice', 'qa-iso');
    const first = await asUser(
      { projectId: p.id, target: site, environment: 'production' },
      'alice',
    );
    expect(first.statusCode, first.body).toBe(403);
    const approvalId = first.json().approvalId as string;

    // bob (owner of org B) tries org B's context with org A's project, site and approval
    const a1 = await asUser(
      { projectId: p.id, target: site, environment: 'production' },
      'bob',
      B(),
    );
    expect([404, 422]).toContain(a1.statusCode); // the project is not found in B
    const a2 = await asUser(
      { projectId: p.id, target: site, environment: 'production', approvalId },
      'bob',
      B(),
    );
    expect([404, 422]).toContain(a2.statusCode);
    // bob names org A in the header although he is not a member of it
    const a3 = await asUser(
      { projectId: p.id, target: site, environment: 'production', approvalId },
      'bob',
      A(),
    );
    expect([403, 404]).toContain(a3.statusCode);
    expect(await deployCount()).toBe(0);
    // the approval is untouched (still pending, not decided by bob)
    const ap = (
      await e.sql(`SELECT state, decided_by FROM ai.approvals WHERE id=$1`, [approvalId])
    )[0]!;
    expect(ap.state).toBe('pending');
    expect(ap.decided_by).toBeNull();
    // listing and reading are scoped too
    expect(j(await e.call('bob', 'GET', '/v1/deployments', undefined, B())).items).toEqual([]);
    expect(
      (await e.call('bob', 'GET', `/v1/deployments/${randomUUID()}`, undefined, B())).statusCode,
    ).toBe(404);
  });
});

describe('QA deploy: roles', () => {
  it('a viewer and a billing admin cannot even ask for a publish (403, no approval row)', async () => {
    const p = await mkProject('QA Roles');
    const site = await mkSite(A(), 'alice', 'qa-roles');
    const before = Number((await e.sql(`SELECT count(*) n FROM ai.approvals`))[0]!.n);
    for (const who of ['carol', 'frank']) {
      const r = await asUser({ projectId: p.id, target: site, environment: 'production' }, who);
      expect(r.statusCode, who).toBe(403);
      expect(r.json().code, who).toBe('forbidden');
    }
    expect(Number((await e.sql(`SELECT count(*) n FROM ai.approvals`))[0]!.n)).toBe(before);
  });
  it('a viewer cannot confirm an approval that someone else requested', async () => {
    const p = await mkProject('QA Roles 2');
    const site = await mkSite(A(), 'alice', 'qa-roles-2');
    const first = await asUser(
      { projectId: p.id, target: site, environment: 'production' },
      'alice',
    );
    const r = await asUser(
      {
        projectId: p.id,
        target: site,
        environment: 'production',
        approvalId: first.json().approvalId,
      },
      'carol',
    );
    expect(r.statusCode).toBe(403);
    expect(await deployCount()).toBe(0);
  });
});

describe('QA deploy: the human approval of a publish', () => {
  it('OBSERVATION: a developer (deploy:write, no ai:approve) completes both steps for himself/herself: the publish confirmation is a self-confirmation', async () => {
    const p = await mkProject('QA Dev', 'dave');
    const site = await mkSite(A(), 'dave', 'qa-dev');
    const body = { projectId: p.id, target: site, environment: 'staging' };
    const first = await asUser(body, 'dave');
    expect(first.statusCode, first.body).toBe(403);
    const second = await asUser({ ...body, approvalId: first.json().approvalId }, 'dave');
    // documents today's behaviour; the product decision (is "a human with a write role" enough?) belongs to the owner: see DEFECT-4 section "Developer role"
    expect(second.statusCode, second.body).toBe(202);
    const ap = (
      await e.sql(`SELECT state, requested_by, decided_by FROM ai.approvals WHERE id=$1`, [
        first.json().approvalId,
      ])
    )[0]!;
    expect(ap.requested_by).toBe(ap.decided_by);
  });

  it.fails('DEFECT-4: an API key (not a human) cannot confirm a publish approval', async () => {
    const p = await mkProject('QA Key');
    const site = await mkSite(A(), 'alice', 'qa-key');
    const body = { projectId: p.id, target: site, environment: 'production' };
    const key = await mkKey('alice', ['deploy:write', 'deploy:read']);
    const first = await asKey(body, key);
    expect(first.statusCode, first.body).toBe(403);
    expect(first.json().code).toBe('approval_required');
    const before = await deployCount();
    const second = await asKey({ ...body, approvalId: first.json().approvalId }, key);
    // secure expectation: a non-human actor never completes the approval; a human must decide it (e.g. through POST /v1/ai/approvals/{id}/decisions with ai:approve)
    expect(second.statusCode).toBeGreaterThanOrEqual(400);
    expect(await deployCount()).toBe(before);
  });

  it('CONFIRMED TODAY (the other half of DEFECT-4): the same API key creates the deployment in two calls and the approval records the key creator as the human decider', async () => {
    const p = await mkProject('QA Key2');
    const site = await mkSite(A(), 'alice', 'qa-key2');
    const body = { projectId: p.id, target: site, environment: 'production' };
    const key = await mkKey('alice', ['deploy:write']);
    const first = await asKey(body, key);
    const second = await asKey({ ...body, approvalId: first.json().approvalId }, key);
    expect(second.statusCode, second.body).toBe(202);
    const ap = (
      await e.sql(`SELECT state, decided_by FROM ai.approvals WHERE id=$1`, [
        first.json().approvalId,
      ])
    )[0]!;
    expect(ap.state).toBe('approved');
    expect(ap.decided_by).toBe(e.ids.alice);
  });

  it('a used approval is never reusable and an approval cannot be moved to another environment or site', async () => {
    const p = await mkProject('QA Replay', 'alice');
    const site = await mkSite(A(), 'alice', 'qa-replay');
    const other = await mkSite(A(), 'alice', 'qa-replay-2');
    const body = { projectId: p.id, target: site, environment: 'staging' };
    const first = await asUser(body, 'alice');
    const approvalId = first.json().approvalId as string;
    expect(
      (await asUser({ ...body, environment: 'production', approvalId }, 'alice')).statusCode,
    ).toBe(409);
    expect((await asUser({ ...body, target: other, approvalId }, 'alice')).statusCode).toBe(409);
    const ok = await asUser({ ...body, approvalId }, 'alice');
    expect(ok.statusCode, ok.body).toBe(202);
    const replay = await asUser({ ...body, approvalId }, 'alice');
    expect(replay.statusCode).toBe(409);
  });

  it('malformed identifiers are validation errors, not server errors', async () => {
    const p = await mkProject('QA Bad');
    const site = await mkSite(A(), 'alice', 'qa-bad');
    for (const body of [
      { projectId: 'not-a-uuid', target: site },
      { projectId: p.id, target: 'not-a-uuid' },
      { projectId: p.id, target: site, environment: 'prod; DROP TABLE' },
      { projectId: p.id, target: site, approvalId: 'x' },
      { projectId: p.id, target: { hostingSiteId: { $ne: null } } },
      { projectId: p.id, target: [site] },
    ]) {
      const r = await asUser(body as Row, 'alice');
      expect(r.statusCode, JSON.stringify(body)).toBeLessThan(500);
    }
  });
});
