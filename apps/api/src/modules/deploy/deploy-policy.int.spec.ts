import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockModelAdapter } from '@nuzm/adapter-model';
import { mockModelHandler } from '@nuzm/domain';
import { setupAiEnv, type AiEnv, type Row } from '../ai/testing/ai-harness';
import {
  DeployPolicyService,
  DeployService,
  InMemorySitePublisher,
  SitePublisherPort,
} from './index';

/**
 * Owner decisions O-1 and O-2 as policy switches (Phase 2, Session 06). Roles in the harness: alice owner, erin admin, dave developer, carol viewer (all of org A), bob owner of org B.
 * The DEFAULT (no row) must equal the behaviour before the switches existed; each stricter setting is then proven, with who may change it and the audit trail.
 * Everything runs on the in-memory publisher: SIMULATED.
 */
let e: AiEnv;
let deploys: DeployService;
let pub: InMemorySitePublisher;
let planId: string;
const A = () => e.org.A!;
const B = () => e.org.B!;
const j = (r: { json(): unknown }) => r.json() as Row;
const audits = (action: string) => e.sink.events.filter((x) => x.action === action);

const mkSite = async (org: string, user: string, name: string, domain: string) => {
  const id = randomUUID();
  await e.sql(
    `INSERT INTO hosting.sites (id, org_id, name, token, node_name, plan_id, runtime, status, data_region, created_by, credentials_ref, backup_key_ref, domain_primary)
     VALUES ($1,$2,$3,$4,$5,$6,'static','active','sa-central',$7,'vault://t/c','vault://t/b',$8)`,
    [
      id,
      org,
      name,
      randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      `s-${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      planId,
      e.ids[user],
      domain,
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
const post = (url: string, body: Row | undefined, who: string, org = A()) =>
  e.call(who, 'POST', url, body, org, { 'idempotency-key': `k-${Math.random()}` });
const put = (url: string, body: Row, who: string, org = A()) =>
  e.call(who, 'PUT', url, body, org, { 'idempotency-key': `k-${Math.random()}` });
/** ask for the production publish approval as `asker`, then confirm it as `confirmer` */
const publish = async (
  projectId: string,
  siteId: string,
  asker: string,
  confirmer = asker,
  environment = 'production',
) => {
  const first = await post('/v1/deployments', { projectId, target: siteId, environment }, asker);
  expect(first.statusCode, first.body).toBe(403);
  expect(first.json().code).toBe('approval_required');
  return post(
    '/v1/deployments',
    { projectId, target: siteId, environment, approvalId: first.json().approvalId },
    confirmer,
  );
};
const drive = async (id: string, org = A()) => {
  const r = (await e.sql(`SELECT operation_id FROM deploy.deployments WHERE id=$1`, [id]))[0]!;
  await deploys.runOne(org, r.operation_id as string);
  return j(await e.call('alice', 'GET', `/v1/deployments/${id}`, undefined, org));
};
/** two succeeded production deployments (v1 then v2) so the second can be rolled back */
const twoReleases = async (name: string, domain: string) => {
  const p = await mkProject(name);
  const site = await mkSite(A(), 'alice', name.toLowerCase().replace(/\W+/g, '-'), domain);
  const d1 = await drive(j(await publish(p.id as string, site, 'alice')).id as string);
  const h = j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}`));
  await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/changes`, {
    baseVersion: h.headVersionId,
    ops: [{ op: 'setText', target: 'footerText', locale: 'en', value: `second ${name}` }],
    source: 'user',
  });
  const d2 = await drive(j(await publish(p.id as string, site, 'alice')).id as string);
  expect(d2.state).toBe('succeeded');
  return { p, site, d1, d2 };
};
const reset = async () => {
  await e.sql(`DELETE FROM deploy.org_policies`);
};

beforeAll(async () => {
  e = await setupAiEnv();
  deploys = e.app.get(DeployService);
  pub = e.app.get(SitePublisherPort) as InMemorySitePublisher;
  await e.enableMock('mock-model', {
    adapter: new MockModelAdapter({ id: 'mock-model', handler: (r) => mockModelHandler(r) }),
  });
  planId = randomUUID();
  await e.sql(
    `INSERT INTO hosting.plan_definitions (id, key, name_ar, name_en, status, quotas, runtimes, reservation) VALUES ($1, 'pol-plan', 'خطة', 'Plan', 'active', '{"diskMb":1,"inodes":1000,"bandwidthGb":1,"dbCount":1,"sitesCount":1}', '["php"]', '{"cpu_millicores":1,"memory_mb":1,"disk_mb":1}')`,
    [planId],
  );
}, 120_000);
afterAll(() => e.h.close());

describe('defaults equal the behaviour before the switches (nothing changes unless an owner changes it)', () => {
  it('no row: the policy reads as the defaults, for every role that can read deployments', async () => {
    await reset();
    for (const who of ['alice', 'erin', 'dave', 'carol']) {
      const r = await e.call(who, 'GET', '/v1/deployments/policy');
      expect(r.statusCode, r.body).toBe(200);
      expect(j(r)).toMatchObject({
        productionPublishRoles: ['owner', 'admin', 'developer'],
        rollbackRequiresOwnApproval: false,
        source: 'default',
        version: 0,
      });
    }
  });

  it('O-1 default: a developer requests AND confirms a production publish alone (today)', async () => {
    await reset();
    const p = await mkProject('Pol Dev Self');
    const site = await mkSite(A(), 'alice', 'pol-dev-self', 'devself.example.sa');
    const r = await publish(p.id as string, site, 'dave');
    expect(r.statusCode, r.body).toBe(202);
    expect((await drive(j(r).id as string)).state).toBe('succeeded');
    const approval = (
      await e.sql(
        `SELECT decided_by FROM ai.approvals WHERE id=(SELECT approval_id FROM deploy.deployments WHERE id=$1)`,
        [j(r).id],
      )
    )[0]!;
    expect(approval.decided_by).toBe(e.ids.dave);
  });

  it('O-2 default: a developer rolls back with no new approval; the rollback reuses the earlier release approval (today)', async () => {
    await reset();
    const { d2, d1, site } = await twoReleases('Pol Rb Default', 'rbdef.example.sa');
    const hash1 = pub.live.get(site)!.hash; // v2 live
    expect(hash1).toBe(d2.artifactHash);
    const rb = await post(`/v1/deployments/${d2.id}/rollback`, undefined, 'dave');
    expect(rb.statusCode, rb.body).toBe(202);
    const done = await drive(j(rb).id as string);
    expect(done.state).toBe('succeeded');
    expect(done.artifactHash).toBe(d1.artifactHash);
    const row = (
      await e.sql(`SELECT approval_id FROM deploy.deployments WHERE id=$1`, [j(rb).id])
    )[0]!;
    const prev = (
      await e.sql(`SELECT approval_id FROM deploy.deployments WHERE id=$1`, [d1.id])
    )[0]!;
    expect(row.approval_id).toBe(prev.approval_id);
  });
});

describe('who may change the policy', () => {
  it('only an owner or admin signed in as a person; developer, viewer and other organizations cannot', async () => {
    await reset();
    const body = { productionPublishRoles: ['owner', 'admin'] };
    expect((await put('/v1/deployments/policy', body, 'dave')).statusCode).toBe(403);
    expect((await put('/v1/deployments/policy', body, 'carol')).statusCode).toBe(403);
    expect(
      (await e.call('alice', 'GET', '/v1/deployments/policy', undefined, A())).json().source,
    ).toBe('default');
    const ok = await put('/v1/deployments/policy', body, 'erin'); // admin
    expect(ok.statusCode, ok.body).toBe(200);
    expect(j(ok)).toMatchObject({
      productionPublishRoles: ['owner', 'admin'],
      source: 'organization',
      version: 1,
    });
    // organization B is not affected
    expect(
      (await e.call('bob', 'GET', '/v1/deployments/policy', undefined, B())).json(),
    ).toMatchObject({ source: 'default', productionPublishRoles: ['owner', 'admin', 'developer'] });
    // and cannot be written from B into A
    expect(
      (await put('/v1/deployments/policy', { rollbackRequiresOwnApproval: true }, 'bob', A()))
        .statusCode,
    ).toBeGreaterThanOrEqual(403);
    expect(
      j(await e.call('alice', 'GET', '/v1/deployments/policy')).rollbackRequiresOwnApproval,
    ).toBe(false);
  });

  it('validates strictly: unknown keys, empty/unknown/duplicate roles, owner removal, non-boolean, stale version', async () => {
    await reset();
    const bad = async (b: Row) => (await put('/v1/deployments/policy', b, 'alice')).statusCode;
    expect(await bad({})).toBe(422);
    expect(await bad({ surprise: true })).toBe(422);
    expect(await bad({ productionPublishRoles: [] })).toBe(422);
    expect(await bad({ productionPublishRoles: ['owner', 'root'] })).toBe(422);
    expect(await bad({ productionPublishRoles: ['owner', 'owner'] })).toBe(422);
    expect(await bad({ productionPublishRoles: ['admin'] })).toBe(422); // the owner can never be locked out
    expect(await bad({ rollbackRequiresOwnApproval: 'yes' })).toBe(422);
    expect(await bad({ rollbackRequiresOwnApproval: true, expectedVersion: 5 })).toBe(409);
    expect(Number((await e.sql(`SELECT count(*) n FROM deploy.org_policies`))[0]!.n)).toBe(0);
    // the database refuses what the service would not
    await expect(
      e.sql(
        `INSERT INTO deploy.org_policies (org_id, production_publish_roles) VALUES ($1, ARRAY['viewer'])`,
        [A()],
      ),
    ).rejects.toThrow();
  });

  it('every change is audited with before and after, by the person who made it', async () => {
    await reset();
    const n0 = audits('deploy.policy.updated').length;
    const r = await put(
      '/v1/deployments/policy',
      {
        productionPublishRoles: ['owner', 'admin'],
        rollbackRequiresOwnApproval: true,
        expectedVersion: 0,
      },
      'alice',
    );
    expect(r.statusCode, r.body).toBe(200);
    const ev = audits('deploy.policy.updated');
    expect(ev.length).toBe(n0 + 1);
    const last = ev[ev.length - 1]!;
    expect(last.actorUserId).toBe(e.ids.alice);
    expect(last.detail).toMatchObject({
      before: {
        productionPublishRoles: ['owner', 'admin', 'developer'],
        rollbackRequiresOwnApproval: false,
        source: 'default',
      },
      after: { productionPublishRoles: ['owner', 'admin'], rollbackRequiresOwnApproval: true },
    });
    // a second change bumps the version and keeps the setting it did not mention
    const r2 = await put(
      '/v1/deployments/policy',
      { productionPublishRoles: ['owner', 'admin', 'developer'] },
      'alice',
    );
    expect(j(r2)).toMatchObject({
      version: 2,
      rollbackRequiresOwnApproval: true,
      productionPublishRoles: ['owner', 'admin', 'developer'],
    });
  });

  it('two simultaneous first-ever writers: one wins, the other gets 409, never a 500 (DEFECT-11)', async () => {
    await reset();
    const results = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        put(
          '/v1/deployments/policy',
          { rollbackRequiresOwnApproval: i % 2 === 0, expectedVersion: 0 },
          i % 2 === 0 ? 'alice' : 'erin',
        ),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(3);
    expect(Number((await e.sql(`SELECT version v FROM deploy.org_policies`))[0]!.v)).toBe(1);
    expect(audits('deploy.policy.updated').length).toBeGreaterThan(0);
  });

  it('an API key cannot change the policy even with the permission', async () => {
    await reset();
    await expect(deploysPolicyAsKey()).resolves.toBe(403);
  });
});

const deploysPolicyAsKey = async () => {
  const svc = e.app.get(DeployPolicyService);
  try {
    await svc.set(
      A(),
      { userId: e.ids.alice!, role: 'owner', kind: 'api_key' },
      { rollbackRequiresOwnApproval: true },
    );
    return 200;
  } catch (err) {
    return (err as { getStatus?: () => number }).getStatus?.() ?? 500;
  }
};

describe('O-1 deploy.production_publish_roles = owner, admin', () => {
  it('a developer may REQUEST but not CONFIRM a production publish; an owner/admin confirms it; staging is unaffected', async () => {
    await reset();
    expect(
      (await put('/v1/deployments/policy', { productionPublishRoles: ['owner', 'admin'] }, 'alice'))
        .statusCode,
    ).toBe(200);
    const p = await mkProject('Pol O1');
    const site = await mkSite(A(), 'alice', 'pol-o1', 'o1.example.sa');
    const first = await post(
      '/v1/deployments',
      { projectId: p.id, target: site, environment: 'production' },
      'dave',
    );
    expect(first.json().code).toBe('approval_required');
    const approvalId = first.json().approvalId as string;
    // developer self-confirm: refused, the refusal says which policy and who may
    const self = await post(
      '/v1/deployments',
      { projectId: p.id, target: site, environment: 'production', approvalId },
      'dave',
    );
    expect(self.statusCode, self.body).toBe(403);
    expect(self.json()).toMatchObject({
      policy: 'deploy.production_publish_roles',
      allowedRoles: ['owner', 'admin'],
    });
    expect(
      Number(
        (await e.sql(`SELECT count(*) n FROM deploy.deployments WHERE project_id=$1`, [p.id]))[0]!
          .n,
      ),
    ).toBe(0);
    expect(
      (await e.sql(`SELECT state FROM ai.approvals WHERE id=$1`, [approvalId]))[0]!.state,
    ).toBe('pending'); // not consumed
    // a viewer still cannot (permission), and the admin (a second person) can confirm the developer's request
    expect(
      (
        await post(
          '/v1/deployments',
          { projectId: p.id, target: site, environment: 'production', approvalId },
          'carol',
        )
      ).statusCode,
    ).toBe(403);
    const ok = await post(
      '/v1/deployments',
      { projectId: p.id, target: site, environment: 'production', approvalId },
      'erin',
    );
    expect(ok.statusCode, ok.body).toBe(202);
    expect((await drive(j(ok).id as string)).state).toBe('succeeded');
    expect(
      (await e.sql(`SELECT decided_by FROM ai.approvals WHERE id=$1`, [approvalId]))[0]!.decided_by,
    ).toBe(e.ids.erin);
    // staging: the developer publishes alone as before
    const st = await publish(
      p.id as string,
      await mkSite(A(), 'alice', 'pol-o1-stg', 'o1stg.example.sa'),
      'dave',
      'dave',
      'staging',
    );
    expect(st.statusCode, st.body).toBe(202);
  });

  it('the owner alone: an admin is then refused too; widening back restores the developer', async () => {
    await reset();
    await put('/v1/deployments/policy', { productionPublishRoles: ['owner'] }, 'alice');
    const p = await mkProject('Pol O1 owner');
    const site = await mkSite(A(), 'alice', 'pol-o1-owner', 'o1o.example.sa');
    const adminTry = await publish(p.id as string, site, 'erin');
    expect(adminTry.statusCode).toBe(403);
    expect(adminTry.json().allowedRoles).toEqual(['owner']);
    const ownerOk = await publish(p.id as string, site, 'alice');
    expect(ownerOk.statusCode, ownerOk.body).toBe(202);
    await drive(j(ownerOk).id as string);
    await put(
      '/v1/deployments/policy',
      { productionPublishRoles: ['owner', 'admin', 'developer'] },
      'alice',
    );
    const h = j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}`));
    await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/changes`, {
      baseVersion: h.headVersionId,
      ops: [{ op: 'setText', target: 'footerText', locale: 'en', value: 'again' }],
      source: 'user',
    });
    expect((await publish(p.id as string, site, 'dave')).statusCode).toBe(202);
  });

  it('another organization is unaffected by this organization’s setting', async () => {
    await reset();
    await put('/v1/deployments/policy', { productionPublishRoles: ['owner'] }, 'alice');
    expect(
      (await e.call('bob', 'GET', '/v1/deployments/policy', undefined, B())).json()
        .productionPublishRoles,
    ).toEqual(['owner', 'admin', 'developer']);
  });
});

describe('O-2 deploy.rollback_requires_own_approval = true', () => {
  it('a production rollback asks for its own approval; the earlier release approval is not reused; a confirmed one rolls back once', async () => {
    await reset();
    const { d1, d2, site } = await twoReleases('Pol O2', 'o2.example.sa');
    expect(
      (await put('/v1/deployments/policy', { rollbackRequiresOwnApproval: true }, 'alice'))
        .statusCode,
    ).toBe(200);
    const first = await post(`/v1/deployments/${d2.id}/rollback`, undefined, 'dave');
    expect(first.statusCode, first.body).toBe(403);
    expect(first.json()).toMatchObject({
      code: 'approval_required',
      policy: 'deploy.rollback_requires_own_approval',
    });
    const approvalId = first.json().approvalId as string;
    expect(pub.live.get(site)!.hash).toBe(d2.artifactHash); // nothing rolled back by the request
    const a = (
      await e.sql(`SELECT kind, state, action_hash FROM ai.approvals WHERE id=$1`, [approvalId])
    )[0]!;
    expect(a).toMatchObject({ kind: 'publish', state: 'pending' });
    // the approval is bound to THIS rollback: a different deployment cannot use it
    expect(
      (await post(`/v1/deployments/${d1.id}/rollback`, { approvalId }, 'alice')).statusCode,
    ).toBe(409); // d1 has no predecessor, refused before approvals
    // developer under the default roles may confirm (O-1 default); an API key and a viewer may not
    expect(
      (await post(`/v1/deployments/${d2.id}/rollback`, { approvalId }, 'carol')).statusCode,
    ).toBe(403);
    const ok = await post(`/v1/deployments/${d2.id}/rollback`, { approvalId }, 'erin');
    expect(ok.statusCode, ok.body).toBe(202);
    const done = await drive(j(ok).id as string);
    expect(done.state).toBe('succeeded');
    expect(done.artifactHash).toBe(d1.artifactHash);
    const row = (
      await e.sql(`SELECT approval_id FROM deploy.deployments WHERE id=$1`, [j(ok).id])
    )[0]!;
    expect(row.approval_id).toBe(approvalId); // its OWN approval, not d1's
    expect(
      (await e.sql(`SELECT decided_by, state FROM ai.approvals WHERE id=$1`, [approvalId]))[0],
    ).toMatchObject({ state: 'approved', decided_by: e.ids.erin });
  });

  it('a spent approval cannot roll back twice; a tampered or foreign approval id is refused', async () => {
    await reset();
    const { d2, p, site } = await twoReleases('Pol O2 reuse', 'o2r.example.sa');
    await put('/v1/deployments/policy', { rollbackRequiresOwnApproval: true }, 'alice');
    const first = await post(`/v1/deployments/${d2.id}/rollback`, undefined, 'alice');
    const approvalId = first.json().approvalId as string;
    const ok = await post(`/v1/deployments/${d2.id}/rollback`, { approvalId }, 'alice');
    expect(ok.statusCode, ok.body).toBe(202);
    await drive(j(ok).id as string);
    // now v1 is live again and d2 is rolled_back: rolling d2 back again is a state error, and the spent approval is not reusable for a new rollback of the same hash
    expect(
      (await post(`/v1/deployments/${d2.id}/rollback`, { approvalId }, 'alice')).statusCode,
    ).toBe(409);
    expect(
      (await post(`/v1/deployments/${d2.id}/rollback`, { approvalId: 'not-a-uuid' }, 'alice'))
        .statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await post(`/v1/deployments/${d2.id}/rollback`, { approvalId: randomUUID() }, 'alice'))
        .statusCode,
    ).toBeGreaterThanOrEqual(400);
    void p;
    void site;
  });

  it('combined with O-1 owner/admin only: a developer asks, only an owner/admin confirms the rollback', async () => {
    await reset();
    const { d2 } = await twoReleases('Pol O1O2', 'o1o2.example.sa');
    await put(
      '/v1/deployments/policy',
      { productionPublishRoles: ['owner', 'admin'], rollbackRequiresOwnApproval: true },
      'alice',
    );
    const first = await post(`/v1/deployments/${d2.id}/rollback`, undefined, 'dave');
    expect(first.json().code).toBe('approval_required');
    const approvalId = first.json().approvalId as string;
    const self = await post(`/v1/deployments/${d2.id}/rollback`, { approvalId }, 'dave');
    expect(self.statusCode, self.body).toBe(403);
    expect(self.json().allowedRoles).toEqual(['owner', 'admin']);
    const ok = await post(`/v1/deployments/${d2.id}/rollback`, { approvalId }, 'erin');
    expect(ok.statusCode, ok.body).toBe(202);
  });

  it('a staging rollback is not affected (the switch is for production, like the M10 production_rollback rule)', async () => {
    await reset();
    await put('/v1/deployments/policy', { rollbackRequiresOwnApproval: true }, 'alice');
    const p = await mkProject('Pol O2 stg');
    const site = await mkSite(A(), 'alice', 'pol-o2-stg', 'o2stg.example.sa');
    const d1 = await drive(
      j(await publish(p.id as string, site, 'alice', 'alice', 'staging')).id as string,
    );
    const h = j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}`));
    await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/changes`, {
      baseVersion: h.headVersionId,
      ops: [{ op: 'setText', target: 'footerText', locale: 'en', value: 'stg2' }],
      source: 'user',
    });
    const d2 = await drive(
      j(await publish(p.id as string, site, 'alice', 'alice', 'staging')).id as string,
    );
    const rb = await post(`/v1/deployments/${d2.id}/rollback`, undefined, 'dave');
    expect(rb.statusCode, rb.body).toBe(202);
    expect((await drive(j(rb).id as string)).artifactHash).toBe(d1.artifactHash);
  });
});

describe('prepare deployment (read-only plan for the agent loop and the console)', () => {
  it('a website with an active static site is ready, labelled SIMULATED, and nothing is created', async () => {
    await reset();
    const p = await mkProject('Prep One');
    const site = await mkSite(A(), 'alice', 'prep-one', 'prep1.example.sa');
    const before = Number((await e.sql(`SELECT count(*) n FROM deploy.deployments`))[0]!.n);
    const approvalsBefore = Number((await e.sql(`SELECT count(*) n FROM ai.approvals`))[0]!.n);
    const plan = await deploys.prepare(A(), {
      projectId: p.id,
      environment: 'production',
      target: site,
    });
    expect(plan).toMatchObject({
      productType: 'website',
      ready: true,
      reasons: [],
      target: { kind: 'static_hosting', readiness: 'simulated' },
      publisher: { available: true, simulated: true, label: 'SIMULATED' },
      approval: {
        required: true,
        kind: 'publish',
        confirmableBy: ['owner', 'admin', 'developer'],
        apiKeyMayConfirm: false,
      },
      policy: { source: 'default', rollbackRequiresOwnApproval: false },
    });
    expect(Number((await e.sql(`SELECT count(*) n FROM deploy.deployments`))[0]!.n)).toBe(before);
    expect(Number((await e.sql(`SELECT count(*) n FROM ai.approvals`))[0]!.n)).toBe(
      approvalsBefore,
    ); // it requests no approval
  });

  it('reflects the policy: with owner/admin only, a production plan names them; staging still names everyone', async () => {
    await reset();
    await put(
      '/v1/deployments/policy',
      { productionPublishRoles: ['owner', 'admin'], rollbackRequiresOwnApproval: true },
      'alice',
    );
    const p = await mkProject('Prep Two');
    const prod = await deploys.prepare(A(), { projectId: p.id, environment: 'production' });
    expect(prod.approval.confirmableBy).toEqual(['owner', 'admin']);
    expect(prod.policy).toMatchObject({
      source: 'organization',
      rollbackRequiresOwnApproval: true,
    });
    const stg = await deploys.prepare(A(), { projectId: p.id, environment: 'staging' });
    expect(stg.approval.confirmableBy).toEqual(['owner', 'admin', 'developer']);
  });

  it('says why it is not ready: an inactive site, a type with no deployable target, an unknown or foreign project', async () => {
    await reset();
    const p = await mkProject('Prep Three');
    const sid = await mkSite(A(), 'alice', 'prep-three', 'prep3.example.sa');
    await e.sql(`UPDATE hosting.sites SET status='suspended', suspended_by='admin' WHERE id=$1`, [
      sid,
    ]);
    const plan = await deploys.prepare(A(), { projectId: p.id, target: sid });
    expect(plan.ready).toBe(false);
    expect(plan.reasons.join(' ')).toMatch(/not active/);
    await e.sql(`UPDATE builder.projects SET type='mobile' WHERE id=$1`, [p.id]);
    const mobile = await deploys.prepare(A(), { projectId: p.id });
    expect(mobile).toMatchObject({
      productType: 'mobile',
      ready: false,
      target: { kind: 'store_distribution', readiness: 'not_yet', blockers: ['store-HG'] },
    });
    await expect(deploys.prepare(B(), { projectId: p.id })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(deploys.prepare(A(), { projectId: 'nope' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
});
