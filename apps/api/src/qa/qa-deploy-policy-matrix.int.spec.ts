import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockModelAdapter } from '@nuzm/adapter-model';
import { mockModelHandler } from '@nuzm/domain';
import { setupAiEnv, type AiEnv, type Row } from '../modules/ai/testing/ai-harness';
import { DeployService, InMemorySitePublisher, SitePublisherPort } from '../modules/deploy';

/**
 * Session 07 (QA), Phase 2 - owner decisions O-1 / O-2 (deploy policy switches, Session 06) driven from outside: BOTH settings, EVERY role, plus what the owner's own suite
 * (deploy-policy.int.spec.ts) does not cover: billing administrator, a second developer confirming the first's request, the policy changing between request and
 * confirmation, an expired rollback approval, simultaneous confirmations of one approval, simultaneous policy edits. SIMULATED publisher (in-memory); own Postgres.
 *
 * Roles of the harness in org A: alice owner, erin admin, dave developer, frank billing_admin, carol viewer; bob owns org B and is added to A as a second developer here.
 */
let e: AiEnv;
let deploys: DeployService;
let pub: InMemorySitePublisher;
let planId: string;
const A = () => e.org.A!;
const j = (r: { json(): unknown }) => r.json() as Row;
const post = (url: string, body: Row | undefined, who: string, org = A()) =>
  e.call(who, 'POST', url, body, org, { 'idempotency-key': `k-${Math.random()}` });
const put = (url: string, body: Row, who: string, org = A()) =>
  e.call(who, 'PUT', url, body, org, { 'idempotency-key': `k-${Math.random()}` });
const setPolicy = async (body: Row) => {
  await e.sql(`DELETE FROM deploy.org_policies`);
  if (Object.keys(body).length) {
    const r = await put('/v1/deployments/policy', body, 'alice');
    expect(r.statusCode, r.body).toBe(200);
  }
};
const mkSite = async (name: string) => {
  const id = randomUUID();
  await e.sql(
    `INSERT INTO hosting.sites (id, org_id, name, token, node_name, plan_id, runtime, status, data_region, created_by, credentials_ref, backup_key_ref, domain_primary)
     VALUES ($1,$2,$3,$4,$5,$6,'static','active','sa-central',$7,'vault://t/c','vault://t/b',NULL)`,
    [
      id,
      A(),
      name,
      randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      `s-${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      planId,
      e.ids.alice,
    ],
  );
  return id;
};
const mkProject = async (name: string) => {
  const r = await e.call(
    'alice',
    'POST',
    '/v1/builder/projects',
    { type: 'website', name, locale: ['ar', 'en'], templateId: 'landing' },
    A(),
  );
  expect(r.statusCode, `project create: ${r.body}`).toBe(201);
  return j(r);
};
// the organization may hold at most 20 projects: ONE project is shared, every case deploys it to its own hosting site
let shared: Promise<string> | undefined;
const fresh = async (tag: string) => {
  shared ??= mkProject('QA policy shared').then((p) => p.id as string);
  return {
    projectId: await shared,
    target: await mkSite(`qa-${tag}-${Math.random().toString(36).slice(2, 9)}`),
  };
};
const request = async (who: string, o: { projectId: string; target: string }) => {
  const r = await post('/v1/deployments', { ...o, environment: 'production' }, who);
  return r;
};
const confirm = (who: string, o: { projectId: string; target: string }, approvalId: string) =>
  post('/v1/deployments', { ...o, environment: 'production', approvalId }, who);
const drive = async (id: string) => {
  const r = (await e.sql(`SELECT operation_id FROM deploy.deployments WHERE id=$1`, [id]))[0]!;
  await deploys.runOne(A(), r.operation_id as string);
  return j(await e.call('alice', 'GET', `/v1/deployments/${id}`, undefined, A()));
};
const deployCount = async (target: string) =>
  Number(
    (await e.sql(`SELECT count(*) n FROM deploy.deployments WHERE target_ref=$1`, [target]))[0]!.n,
  );
const releases = async (tag: string) => {
  const o = await fresh(tag);
  const first = await request('alice', o);
  const c1 = await confirm('alice', o, first.json().approvalId);
  expect(c1.statusCode, `first release: ${c1.body}`).toBe(202);
  const d1 = await drive(j(c1).id as string);
  const head = j(await e.call('alice', 'GET', `/v1/builder/projects/${o.projectId}`));
  await e.call('alice', 'POST', `/v1/builder/projects/${o.projectId}/changes`, {
    baseVersion: head.headVersionId,
    ops: [{ op: 'setText', target: 'footerText', locale: 'en', value: `v2 ${tag}` }],
    source: 'user',
  });
  const second = await request('alice', o);
  const c2 = await confirm('alice', o, second.json().approvalId);
  expect(c2.statusCode, `second release: ${c2.body}`).toBe(202);
  const d2 = await drive(j(c2).id as string);
  expect(d2.state).toBe('succeeded');
  return { ...o, d1, d2 };
};

const ROLES = [
  ['alice', 'owner'],
  ['erin', 'admin'],
  ['dave', 'developer'],
  ['frank', 'billing_admin'],
  ['carol', 'viewer'],
] as const;
const SETTINGS: [string, Row, string[]][] = [
  ['default (no row)', {}, ['owner', 'admin', 'developer']],
  ['owner, admin', { productionPublishRoles: ['owner', 'admin'] }, ['owner', 'admin']],
  ['owner only', { productionPublishRoles: ['owner'] }, ['owner']],
];
const CAN_REQUEST = new Set(['owner', 'admin', 'developer']); // hold deploy:write

beforeAll(async () => {
  e = await setupAiEnv();
  deploys = e.app.get(DeployService);
  pub = e.app.get(SitePublisherPort) as InMemorySitePublisher;
  await e.enableMock('mock-model', {
    adapter: new MockModelAdapter({ id: 'mock-model', handler: (r) => mockModelHandler(r) }),
  });
  planId = randomUUID();
  await e.sql(
    `INSERT INTO hosting.plan_definitions (id, key, name_ar, name_en, status, quotas, runtimes, reservation) VALUES ($1, 'qa-pol-plan', 'خطة', 'Plan', 'active', '{"diskMb":1,"inodes":1000,"bandwidthGb":1,"dbCount":1,"sitesCount":1}', '["php"]', '{"cpu_millicores":1,"memory_mb":1,"disk_mb":1}')`,
    [planId],
  );
  // a SECOND developer in org A (bob owns org B)
  await e.sql(
    `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, 'developer')`,
    [A(), e.ids.bob],
  );
}, 180_000);
afterAll(() => e.h.close());

describe('QA policy matrix O-1: who can request and who can confirm a production publish, per setting and role', () => {
  for (const [label, body, allowed] of SETTINGS)
    describe(`productionPublishRoles = ${label}`, () => {
      for (const [who, role] of ROLES) {
        it(`${role}: request ${CAN_REQUEST.has(role) ? 'allowed' : 'refused (403, no approval)'}; confirm ${allowed.includes(role) ? 'allowed' : 'refused'}`, async () => {
          await setPolicy(body);
          const o = await fresh(`o1-${role}`);
          const approvals0 = Number((await e.sql(`SELECT count(*) n FROM ai.approvals`))[0]!.n);
          const asked = await request(who, o);
          if (!CAN_REQUEST.has(role)) {
            expect(asked.statusCode, asked.body).toBe(403);
            expect(asked.json().code).toBe('forbidden');
            expect(Number((await e.sql(`SELECT count(*) n FROM ai.approvals`))[0]!.n)).toBe(
              approvals0,
            );
            return;
          }
          expect(asked.statusCode, asked.body).toBe(403);
          expect(asked.json().code).toBe('approval_required');
          const approvalId = asked.json().approvalId as string;
          // an owner always holds the right to confirm: use it as the control for "the approval itself is fine"
          const mine = await confirm(who, o, approvalId);
          if (allowed.includes(role)) {
            expect(mine.statusCode, mine.body).toBe(202);
            expect(await deployCount(o.target)).toBe(1);
          } else {
            expect(mine.statusCode, mine.body).toBe(403);
            expect(mine.json().code).toBe('forbidden');
            expect(await deployCount(o.target)).toBe(0);
            const ap = (
              await e.sql(`SELECT state, decided_by FROM ai.approvals WHERE id=$1`, [approvalId])
            )[0]!;
            expect(ap.state).toBe('pending'); // a refused confirmation does not spend or decide the approval
            expect(ap.decided_by).toBeNull();
            // the approval is still usable by someone the policy allows
            const ok = await confirm('alice', o, approvalId);
            expect(ok.statusCode, ok.body).toBe(202);
          }
        });
      }
    });

  it('a SECOND developer confirms the first developer’s request under the default (two people), and is refused once the roles are owner/admin', async () => {
    await setPolicy({});
    const o1 = await fresh('o1-two');
    const a1 = await request('dave', o1);
    const c1 = await confirm('bob', o1, a1.json().approvalId); // bob = developer of org A
    expect(c1.statusCode, c1.body).toBe(202);
    const ap = (
      await e.sql(`SELECT requested_by, decided_by FROM ai.approvals WHERE id=$1`, [
        a1.json().approvalId,
      ])
    )[0]!;
    expect(ap.requested_by).toBe(e.ids.dave);
    expect(ap.decided_by).toBe(e.ids.bob);
    await setPolicy({ productionPublishRoles: ['owner', 'admin'] });
    const o2 = await fresh('o1-two-b');
    const a2 = await request('dave', o2);
    expect((await confirm('bob', o2, a2.json().approvalId)).statusCode).toBe(403);
    expect((await confirm('erin', o2, a2.json().approvalId)).statusCode).toBe(202);
  });

  it('the policy is read when the approval is CONFIRMED, not when it was requested: tightening in between refuses the developer, widening in between allows them', async () => {
    await setPolicy({});
    const o = await fresh('o1-mid');
    const asked = await request('dave', o);
    await setPolicy({ productionPublishRoles: ['owner', 'admin'] }); // tightened after the request
    expect((await confirm('dave', o, asked.json().approvalId)).statusCode).toBe(403);
    await setPolicy({}); // widened again
    expect((await confirm('dave', o, asked.json().approvalId)).statusCode).toBe(202);
  });

  it('simultaneous confirmations of ONE publish approval by three people create exactly one deployment', async () => {
    await setPolicy({});
    const o = await fresh('o1-race');
    const asked = await request('dave', o);
    const res = await Promise.all([
      confirm('alice', o, asked.json().approvalId),
      confirm('erin', o, asked.json().approvalId),
      confirm('dave', o, asked.json().approvalId),
      confirm('bob', o, asked.json().approvalId),
    ]);
    expect(
      res.filter((r) => r.statusCode === 202),
      res.map((r) => `${r.statusCode} ${r.json().code ?? ''}`).join(' | '),
    ).toHaveLength(1);
    for (const r of res.filter((x) => x.statusCode !== 202))
      expect([409, 403]).toContain(r.statusCode);
    expect(await deployCount(o.target)).toBe(1);
  });
});

describe('QA policy matrix O-2: rollback, per setting and role', () => {
  it('default: a rollback needs no new approval for owner, admin and developer; viewer and billing administrator are refused; nothing changes for them', async () => {
    await setPolicy({});
    for (const [who, role] of ROLES) {
      const r = await releases(`o2-def-${role}`);
      const res = await post(`/v1/deployments/${r.d2.id}/rollback`, undefined, who);
      if (CAN_REQUEST.has(role)) {
        expect(res.statusCode, `${role} ${res.body}`).toBe(202);
        expect((await drive(j(res).id as string)).state).toBe('succeeded');
        expect(pub.live.get(r.target)!.hash).toBe(r.d1.artifactHash);
      } else {
        expect(res.statusCode, role).toBe(403);
        expect(pub.live.get(r.target)!.hash).toBe(r.d2.artifactHash);
      }
    }
  });

  it('rollbackRequiresOwnApproval = true, publish roles owner/admin: per role, who can request the rollback approval and who can confirm it', async () => {
    await setPolicy({
      rollbackRequiresOwnApproval: true,
      productionPublishRoles: ['owner', 'admin'],
    });
    for (const [who, role] of ROLES) {
      const r = await releases(`o2-on-${role}`);
      const asked = await post(`/v1/deployments/${r.d2.id}/rollback`, undefined, who);
      if (!CAN_REQUEST.has(role)) {
        expect(asked.statusCode, role).toBe(403);
        expect(asked.json().code, role).toBe('forbidden');
        continue;
      }
      expect(asked.statusCode, `${role} ${asked.body}`).toBe(403);
      expect(asked.json().code).toBe('approval_required');
      const approvalId = asked.json().approvalId as string;
      const mine = await post(`/v1/deployments/${r.d2.id}/rollback`, { approvalId }, who);
      if (['owner', 'admin'].includes(role))
        expect(mine.statusCode, `${role} ${mine.body}`).toBe(202);
      else {
        expect(mine.statusCode, `${role} ${mine.body}`).toBe(403); // a developer asks, cannot confirm
        expect(pub.live.get(r.target)!.hash).toBe(r.d2.artifactHash);
        expect(
          (await post(`/v1/deployments/${r.d2.id}/rollback`, { approvalId }, 'erin')).statusCode,
        ).toBe(202);
      }
    }
  });

  it('an expired rollback approval is refused (approval_expired) and nothing rolls back; a fresh request works', async () => {
    await setPolicy({ rollbackRequiresOwnApproval: true });
    const r = await releases('o2-exp');
    const asked = await post(`/v1/deployments/${r.d2.id}/rollback`, undefined, 'alice');
    const approvalId = asked.json().approvalId as string;
    await e.sql(`UPDATE ai.approvals SET expires_at = now() - interval '1 minute' WHERE id=$1`, [
      approvalId,
    ]);
    const late = await post(`/v1/deployments/${r.d2.id}/rollback`, { approvalId }, 'alice');
    expect(late.statusCode, late.body).toBeGreaterThanOrEqual(400);
    expect(late.json().code).toMatch(/approval_expired|conflict|validation/);
    expect(pub.live.get(r.target)!.hash).toBe(r.d2.artifactHash);
    const again = await post(`/v1/deployments/${r.d2.id}/rollback`, undefined, 'alice');
    expect(again.json().approvalId).toBeTruthy();
    expect(again.json().approvalId).not.toBe(approvalId);
  });

  it('simultaneous confirmations of ONE rollback approval roll back once', async () => {
    await setPolicy({ rollbackRequiresOwnApproval: true });
    const r = await releases('o2-race');
    const asked = await post(`/v1/deployments/${r.d2.id}/rollback`, undefined, 'dave');
    const approvalId = asked.json().approvalId as string;
    const before = Number(
      (await e.sql(`SELECT count(*) n FROM deploy.deployments WHERE target_ref=$1`, [r.target]))[0]!
        .n,
    );
    const res = await Promise.all(
      ['alice', 'erin', 'dave', 'bob'].map((w) =>
        post(`/v1/deployments/${r.d2.id}/rollback`, { approvalId }, w),
      ),
    );
    expect(
      res.filter((x) => x.statusCode === 202),
      res.map((x) => `${x.statusCode} ${x.json().code ?? ''}`).join(' | '),
    ).toHaveLength(1);
    const after = Number(
      (await e.sql(`SELECT count(*) n FROM deploy.deployments WHERE target_ref=$1`, [r.target]))[0]!
        .n,
    );
    expect(after - before).toBe(1);
  });

  it('a publish approval is not a rollback approval and a rollback approval is not a publish approval', async () => {
    await setPolicy({ rollbackRequiresOwnApproval: true });
    const r = await releases('o2-cross');
    const pubAsk = await request('alice', r);
    const rbAsk = await post(`/v1/deployments/${r.d2.id}/rollback`, undefined, 'alice');
    expect(
      (
        await post(
          `/v1/deployments/${r.d2.id}/rollback`,
          { approvalId: pubAsk.json().approvalId },
          'alice',
        )
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect((await confirm('alice', r, rbAsk.json().approvalId)).statusCode).toBeGreaterThanOrEqual(
      400,
    );
  });
});

describe('QA policy matrix: changing the policy', () => {
  const race = async () => {
    const cur = j(await e.call('alice', 'GET', '/v1/deployments/policy', undefined, A()));
    const n0 = e.sink.events.filter((x) => x.action === 'deploy.policy.updated').length;
    const res = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        put(
          '/v1/deployments/policy',
          { rollbackRequiresOwnApproval: i % 2 === 0, expectedVersion: cur.version as number },
          i % 2 ? 'erin' : 'alice',
        ),
      ),
    );
    return { cur, n0, res };
  };
  it('eight simultaneous edits from the same version (a row exists): exactly one wins (409 for the rest), the version moves by one and there is one audit event', async () => {
    await setPolicy({ rollbackRequiresOwnApproval: false }); // creates the row (version 1)
    const { cur, n0, res } = await race();
    expect(cur.version).toBe(1);
    expect(
      res.filter((r) => r.statusCode === 200),
      res.map((r) => r.statusCode).join(','),
    ).toHaveLength(1);
    for (const r of res.filter((x) => x.statusCode !== 200)) expect(r.statusCode).toBe(409);
    const after = j(await e.call('alice', 'GET', '/v1/deployments/policy', undefined, A()));
    expect(after.version).toBe(2);
    expect(e.sink.events.filter((x) => x.action === 'deploy.policy.updated').length - n0).toBe(1);
  });

  it('eight simultaneous FIRST-EVER edits (no row yet, version 0): exactly one wins and the rest are 409, never a server error (DEFECT-11, fixed by Session 06)', async () => {
    await setPolicy({});
    const { res } = await race();
    expect(res.filter((r) => r.statusCode >= 500).map((r) => r.statusCode)).toEqual([]);
    expect(res.filter((r) => r.statusCode === 200)).toHaveLength(1);
  });

  it('every role except owner/admin is refused, an API key too, and a refusal changes nothing and writes no audit event', async () => {
    await setPolicy({});
    const before = j(await e.call('alice', 'GET', '/v1/deployments/policy', undefined, A()));
    const n0 = e.sink.events.filter((x) => x.action === 'deploy.policy.updated').length;
    for (const who of ['dave', 'frank', 'carol']) {
      const r = await put('/v1/deployments/policy', { productionPublishRoles: ['owner'] }, who);
      expect(r.statusCode, who).toBe(403);
    }
    const k = await e.call(
      'alice',
      'POST',
      '/v1/api-keys',
      { name: 'qa-pol', scopes: ['deploy:write', 'deploy:read', 'org:security'] },
      A(),
    );
    if (k.statusCode === 201) {
      const r = await e.app.inject({
        method: 'PUT',
        url: '/v1/deployments/policy',
        headers: { authorization: `Bearer ${j(k).key}`, 'idempotency-key': `k-${Math.random()}` },
        payload: { productionPublishRoles: ['owner'] },
      });
      expect(r.statusCode).toBeGreaterThanOrEqual(401);
    }
    expect(j(await e.call('alice', 'GET', '/v1/deployments/policy', undefined, A()))).toEqual(
      before,
    );
    expect(e.sink.events.filter((x) => x.action === 'deploy.policy.updated').length).toBe(n0);
  });

  it('the policy of one organization never reaches another: org B keeps the defaults while A is set to owner only', async () => {
    await setPolicy({ productionPublishRoles: ['owner'], rollbackRequiresOwnApproval: true });
    const b = j(await e.call('bob', 'GET', '/v1/deployments/policy', undefined, e.org.B!));
    expect(b).toMatchObject({
      productionPublishRoles: ['owner', 'admin', 'developer'],
      rollbackRequiresOwnApproval: false,
      source: 'default',
    });
    // bob is also a developer in A: under A's policy he is refused, under B's defaults he is the owner
    const o = await fresh('o1-cross-org');
    const asked = await request('dave', o);
    expect((await confirm('bob', o, asked.json().approvalId)).statusCode).toBe(403);
  });
});
