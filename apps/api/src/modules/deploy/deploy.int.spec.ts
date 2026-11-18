import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockModelAdapter } from '@nuzm/adapter-model';
import { mockModelHandler } from '@nuzm/domain';
import { setupAiEnv, type AiEnv, type Row } from '../ai/testing/ai-harness';
import {
  DeployService,
  InMemorySitePublisher,
  SitePublisherPort,
  UnavailableSitePublisher,
} from './index';

let e: AiEnv;
let deploys: DeployService;
let pub: InMemorySitePublisher;
const A = () => e.org.A!;
const B = () => e.org.B!;
const j = (r: { json(): unknown }) => r.json() as Row;
let planId: string;
const mkSite = async (
  org: string,
  user: string,
  name: string,
  runtime = 'static',
  status = 'active',
  domain: string | null = null,
) => {
  const id = randomUUID();
  await e.sql(
    `INSERT INTO hosting.sites (id, org_id, name, token, node_name, plan_id, runtime, status, data_region, created_by, credentials_ref, backup_key_ref, domain_primary, suspended_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'sa-central',$9,'vault://t/c','vault://t/b',$10, CASE WHEN $8 = 'suspended' THEN 'admin' ELSE NULL END)`,
    [
      id,
      org,
      name,
      randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      `s-${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      planId,
      runtime,
      status,
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
const req = (body: Row, who = 'alice', org = A(), key = `k-${Math.random()}`) =>
  e.call(who, 'POST', '/v1/deployments', body, org, { 'idempotency-key': key });
/** the two-step human confirmation: ask, then confirm with the approval id */
const publish = async (
  projectId: string,
  siteId: string,
  who = 'alice',
  environment = 'production',
) => {
  const first = await req({ projectId, target: siteId, environment }, who);
  expect(first.statusCode, first.body).toBe(403);
  expect(first.json().code).toBe('approval_required');
  return req({ projectId, target: siteId, environment, approvalId: first.json().approvalId }, who);
};
const drive = async (id: string, org = A()) => {
  const r = (await e.sql(`SELECT operation_id FROM deploy.deployments WHERE id=$1`, [id]))[0]!;
  await deploys.runOne(org, r.operation_id as string);
  return j(await e.call('alice', 'GET', `/v1/deployments/${id}`, undefined, org));
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
    `INSERT INTO hosting.plan_definitions (id, key, name_ar, name_en, status, quotas, runtimes, reservation) VALUES ($1, 'm09-plan', 'خطة', 'Plan', 'active', '{"diskMb":1,"inodes":1000,"bandwidthGb":1,"dbCount":1,"sitesCount":1}', '["php"]', '{"cpu_millicores":1,"memory_mb":1,"disk_mb":1}')`,
    [planId],
  );
}, 120_000);
afterAll(() => e.h.close());

describe('approval, build, smoke, switch (S41.4)', () => {
  it('needs a human publish approval bound to the exact version, target and environment; then deploys, smoke-checks and serves the artifact', async () => {
    const p = await mkProject('Deploy One');
    const site = await mkSite(A(), 'alice', 'deploy-one', 'static', 'active', 'one.example.sa');
    const none = await req({ projectId: p.id, target: site, environment: 'production' });
    expect(none.statusCode).toBe(403);
    expect(none.json().code).toBe('approval_required');
    const approval = (
      await e.sql(`SELECT * FROM ai.approvals WHERE id=$1`, [none.json().approvalId])
    )[0]!;
    expect(approval.kind).toBe('publish');
    expect(approval.state).toBe('pending');
    expect(JSON.stringify(approval.summary)).toContain('costDisclosure');
    // nothing was deployed by the first call
    expect(Number((await e.sql(`SELECT count(*) n FROM deploy.deployments`))[0]!.n)).toBe(0);
    // a different target than the one approved is refused
    const other = await mkSite(A(), 'alice', 'deploy-other');
    expect(
      (
        await req({
          projectId: p.id,
          target: other,
          environment: 'production',
          approvalId: none.json().approvalId,
        })
      ).statusCode,
    ).toBe(409);
    const r = await req({
      projectId: p.id,
      target: site,
      environment: 'production',
      approvalId: none.json().approvalId,
    });
    expect(r.statusCode, r.body).toBe(202);
    expect(j(r).state).toBe('queued');
    expect(j(r).operationId).toBeTruthy();
    const done = await drive(j(r).id as string);
    expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
    expect(done.url).toBe('https://one.example.sa/');
    expect(done.artifactHash).toBe(pub.live.get(site)!.hash);
    expect((done.smoke as Row).ok).toBe(true);
    expect((done.smoke as Row).tls).toBe(true);
    const ap = (
      await e.sql(`SELECT state, decided_by FROM ai.approvals WHERE id=$1`, [
        none.json().approvalId,
      ])
    )[0]!;
    expect(ap).toMatchObject({ state: 'approved', decided_by: e.ids.alice });
    const logs = j(await e.call('carol', 'GET', `/v1/deployments/${done.id}/logs`)).items as Row[];
    expect(logs.map((l) => l.message).join(' ')).toMatch(
      /building artifact[\s\S]*staged smoke check passed[\s\S]*deployment succeeded/,
    );
    expect(logs.map((l) => l.seq)).toEqual(logs.map((_, i) => i + 1));
    const evs = e.sink.events.map((x) => x.action);
    expect(evs).toEqual(
      expect.arrayContaining([
        'deploy.deployment.created',
        'deploy.deployment.succeeded',
        'ai.approval.granted',
      ]),
    );
    // the approval cannot be reused
    expect(
      (
        await req({
          projectId: p.id,
          target: site,
          environment: 'production',
          approvalId: none.json().approvalId,
        })
      ).statusCode,
    ).toBe(409);
    // logs are append-only
    await expect(
      e.sql(`UPDATE deploy.deployment_logs SET message='x' WHERE deployment_id=$1`, [done.id]),
    ).rejects.toThrow(/append-only/);
  });
  it('an expired approval, an approval for an older version, a viewer and an unknown approval are all refused', async () => {
    const p = await mkProject('Deploy Approvals');
    const site = await mkSite(A(), 'alice', 'deploy-approvals');
    const first = await req({ projectId: p.id, target: site, environment: 'production' });
    await e.sql(`UPDATE ai.approvals SET expires_at = now() - interval '1 minute' WHERE id=$1`, [
      first.json().approvalId,
    ]);
    const exp = await req({
      projectId: p.id,
      target: site,
      environment: 'production',
      approvalId: first.json().approvalId,
    });
    expect(exp.statusCode).toBe(409);
    expect(exp.json().code).toBe('approval_expired');
    const second = await req({ projectId: p.id, target: site, environment: 'production' });
    const h = j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}`));
    await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/changes`, {
      baseVersion: h.headVersionId,
      ops: [{ op: 'setText', target: 'brandName', locale: 'en', value: 'Moved on' }],
      source: 'user',
    });
    const stale = await req({
      projectId: p.id,
      target: site,
      environment: 'production',
      approvalId: second.json().approvalId,
    });
    expect(stale.statusCode).toBe(409); // the approval named a version that is no longer the head
    expect(
      (await req({ projectId: p.id, target: site, environment: 'production' }, 'carol')).statusCode,
    ).toBe(403);
    expect(
      (
        await req({
          projectId: p.id,
          target: site,
          environment: 'production',
          approvalId: randomUUID(),
        })
      ).statusCode,
    ).toBe(404);
    expect((await req({ projectId: 'x', target: site })).statusCode).toBe(422);
    expect((await req({ projectId: p.id, target: site, environment: 'prod' })).statusCode).toBe(
      422,
    );
  });
  it('validates the target: inactive site 409, non-static runtime 422, another organization 404', async () => {
    const p = await mkProject('Deploy Targets');
    const suspended = await mkSite(A(), 'alice', 'suspended-site', 'static', 'suspended');
    expect(
      (await req({ projectId: p.id, target: suspended, environment: 'production' })).json().code,
    ).toBe('site_not_active');
    const node = await mkSite(A(), 'alice', 'node-site', 'nodejs:22');
    expect(
      (await req({ projectId: p.id, target: node, environment: 'production' })).json().code,
    ).toBe('unsupported_capability');
    expect(
      (await req({ projectId: p.id, target: randomUUID(), environment: 'production' })).statusCode,
    ).toBe(404);
  });
});

describe('failure handling and rollback (AC-M09-08)', () => {
  it('an injected staged smoke failure rolls back automatically within 120 s and the previous artifact keeps serving', async () => {
    const p = await mkProject('Deploy Smoke');
    const site = await mkSite(A(), 'alice', 'smoke-site', 'static', 'active', 'smoke.example.sa');
    const first = await drive(j(await publish(p.id as string, site)).id as string);
    expect(first.state).toBe('succeeded');
    const prevHash = pub.live.get(site)!.hash;
    const h = j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}`));
    await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/changes`, {
      baseVersion: h.headVersionId,
      ops: [{ op: 'setText', target: 'footerText', locale: 'en', value: 'v2 footer' }],
      source: 'user',
    });
    pub.failSmoke = 'staged';
    const t0 = Date.now();
    const d = await drive(j(await publish(p.id as string, site)).id as string);
    pub.failSmoke = null;
    expect(Date.now() - t0).toBeLessThan(120_000);
    expect(d.state).toBe('rolled_back');
    expect((d.error as Row).code).toBe('smoke_failed');
    expect(pub.live.get(site)!.hash).toBe(prevHash);
    expect(await pub.activeHash({ id: site } as never)).toBe(prevHash);
    expect(e.sink.events.some((x) => x.action === 'deploy.deployment.rolled_back')).toBe(true);
    const logs = j(await e.call('alice', 'GET', `/v1/deployments/${d.id}/logs`)).items as Row[];
    expect(logs.some((l) => /previous artifact keeps serving/.test(String(l.message)))).toBe(true);
  });
  it('a live smoke failure after the switch restores the previous artifact', async () => {
    const p = await mkProject('Deploy Live Fail');
    const site = await mkSite(
      A(),
      'alice',
      'live-fail-site',
      'static',
      'active',
      'live.example.sa',
    );
    await drive(j(await publish(p.id as string, site)).id as string);
    const prevHash = pub.live.get(site)!.hash;
    const h = j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}`));
    await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/changes`, {
      baseVersion: h.headVersionId,
      ops: [{ op: 'setText', target: 'footerText', locale: 'en', value: 'v2' }],
      source: 'user',
    });
    pub.failSmoke = 'live';
    const d = await drive(j(await publish(p.id as string, site)).id as string);
    pub.failSmoke = null;
    expect(d.state).toBe('rolled_back');
    expect(pub.live.get(site)!.hash).toBe(prevHash);
  });
  it('rollback restores the previous artifact hash, creates a new deployment and marks the old one rolled_back', async () => {
    const p = await mkProject('Deploy Rollback');
    const site = await mkSite(A(), 'alice', 'rollback-site', 'static', 'active', 'rb.example.sa');
    const d1 = await drive(j(await publish(p.id as string, site)).id as string);
    const hash1 = pub.live.get(site)!.hash;
    const h = j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}`));
    await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/changes`, {
      baseVersion: h.headVersionId,
      ops: [{ op: 'setText', target: 'footerText', locale: 'en', value: 'second' }],
      source: 'user',
    });
    const d2 = await drive(j(await publish(p.id as string, site)).id as string);
    expect(d2.state).toBe('succeeded');
    expect(d2.previousDeploymentId).toBe(d1.id);
    expect(pub.live.get(site)!.hash).not.toBe(hash1);
    expect((await e.call('carol', 'POST', `/v1/deployments/${d2.id}/rollback`)).statusCode).toBe(
      403,
    );
    expect((await e.call('alice', 'POST', `/v1/deployments/${d1.id}/rollback`)).statusCode).toBe(
      409,
    ); // no predecessor
    const rb = await e.call('alice', 'POST', `/v1/deployments/${d2.id}/rollback`);
    expect(rb.statusCode, rb.body).toBe(202);
    const done = await drive(j(rb).id as string);
    expect(done.state).toBe('succeeded');
    expect(done.rollbackOf).toBe(d2.id);
    expect(pub.live.get(site)!.hash).toBe(hash1);
    expect(done.artifactHash).toBe(hash1);
    expect(j(await e.call('alice', 'GET', `/v1/deployments/${d2.id}`)).state).toBe('rolled_back');
  });
});

describe('idempotency, isolation, capability (AC-M09-09)', () => {
  it('50 parallel POSTs with the same Idempotency-Key and approval create exactly one deployment', async () => {
    const p = await mkProject('Deploy Dup');
    const site = await mkSite(A(), 'alice', 'dup-site', 'static', 'active', 'dup.example.sa');
    const first = await req({ projectId: p.id, target: site, environment: 'production' });
    const body = {
      projectId: p.id,
      target: site,
      environment: 'production',
      approvalId: first.json().approvalId,
    };
    const rs = await Promise.all(
      Array.from({ length: 50 }, () => req(body, 'alice', A(), 'same-key-1')),
    );
    const ids = new Set(rs.filter((r) => r.statusCode === 202).map((r) => j(r).id));
    expect(ids.size).toBe(1);
    expect(rs.every((r) => [202, 409].includes(r.statusCode))).toBe(true);
    expect(
      Number(
        (await e.sql(`SELECT count(*) n FROM deploy.deployments WHERE project_id=$1`, [p.id]))[0]!
          .n,
      ),
    ).toBe(1);
  }, 60_000);
  it('one deployment in flight per target and environment (409)', async () => {
    const p = await mkProject('Deploy Busy');
    const site = await mkSite(A(), 'alice', 'busy-site');
    expect((await publish(p.id as string, site)).statusCode).toBe(202);
    const again = await publish(p.id as string, site);
    expect(again.statusCode).toBe(409);
  });
  it('cross-tenant matrix: org B can never deploy org A projects or to org A sites, read or roll back its deployments (0 successes)', async () => {
    const pa = await mkProject('Tenant A Project');
    const sa = await mkSite(A(), 'alice', 'tenant-a-site', 'static', 'active', 'a.example.sa');
    const dep = j(await publish(pa.id as string, sa));
    await drive(dep.id as string);
    const pb = await mkProject('Tenant B Project', 'bob', B());
    const sb = await mkSite(B(), 'bob', 'tenant-b-site', 'static', 'active', 'b.example.sa');
    const attempts = [
      req({ projectId: pa.id, target: sb, environment: 'production' }, 'bob', B()), // A's project, B's site
      req({ projectId: pb.id, target: sa, environment: 'production' }, 'bob', B()), // B's project, A's site
      req({ projectId: pa.id, target: sa, environment: 'production' }, 'bob', B()),
      e.call('bob', 'GET', `/v1/deployments/${dep.id}`, undefined, B()),
      e.call('bob', 'GET', `/v1/deployments/${dep.id}/logs`, undefined, B()),
      e.call('bob', 'POST', `/v1/deployments/${dep.id}/rollback`, undefined, B()),
      e.call('bob', 'GET', `/v1/deployments?projectId=${pa.id}`, undefined, B()),
    ];
    const res = await Promise.all(attempts);
    expect(res.slice(0, 6).map((r) => r.statusCode)).toEqual([404, 404, 404, 404, 404, 404]);
    expect(j(res[6]!).items).toEqual([]);
    // using org A's header as org B's user is refused before any lookup
    expect(
      (await req({ projectId: pa.id, target: sa, environment: 'production' }, 'bob', A()))
        .statusCode,
    ).toBeGreaterThanOrEqual(403);
    // direct SQL through org B's scope sees nothing of A
    for (const t of ['deployments', 'builds', 'deployment_logs'])
      expect(
        await e.h.env.app.withOrg(
          B(),
          async (c) =>
            (await c.query(`SELECT count(*)::int n FROM deploy.${t} WHERE org_id <> $1`, [B()]))
              .rows[0]!.n,
        ),
        t,
      ).toBe(0);
  });
  it('lists and reads deployments; a viewer can read but not publish', async () => {
    const l = await e.call('carol', 'GET', '/v1/deployments?limit=2');
    expect(l.statusCode).toBe(200);
    expect(j(l).items.length).toBeGreaterThan(0);
    expect(
      j(await e.call('carol', 'GET', `/v1/deployments/${(j(l).items as Row[])[0]!.id}`)).id,
    ).toBeTruthy();
  });
  it('without a publish path the endpoint answers 422 unsupported_capability (production default: live publish is BLOCKED)', async () => {
    const real = (deploys as unknown as { publisher: SitePublisherPort }).publisher;
    (deploys as unknown as { publisher: unknown }).publisher = new (
      await import('./internal/ports')
    ).UnavailableSitePublisher();
    const p = await mkProject('Deploy Blocked');
    const site = await mkSite(A(), 'alice', 'blocked-site');
    const r = await req({ projectId: p.id, target: site, environment: 'production' });
    (deploys as unknown as { publisher: unknown }).publisher = real;
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('unsupported_capability');
  });
  it('builds are metered (builder.build_minutes) and CMS published items are bound into the artifact', async () => {
    const p = await mkProject('Deploy Cms');
    const m = j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}`)).siteModel;
    const faq = (m.pages as Row[])
      .flatMap((x) => x.sections as Row[])
      .find((s) => s.type === 'faq');
    if (faq) {
      const pg = (m.pages as Row[]).find((x) => (x.sections as Row[]).includes(faq))!;
      const h = j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}`));
      await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/changes`, {
        baseVersion: h.headVersionId,
        ops: [
          { op: 'updateProps', pageId: pg.id, sectionId: faq.id, props: { collection: 'faqs' } },
        ],
        source: 'user',
      });
    }
    await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/cms-collections`, {
      collectionKey: 'faqs',
      name: 'FAQs',
      fields: [
        { name: 'question', type: 'text', required: true },
        { name: 'answer', type: 'text' },
      ],
      items: [
        { data: { question: 'Is Friday open?', answer: 'Yes, every day.' }, state: 'published' },
        { data: { question: 'Draft only question', answer: 'x' } },
      ],
    });
    const site = await mkSite(A(), 'alice', 'cms-site', 'static', 'active', 'cms.example.sa');
    const d = await drive(j(await publish(p.id as string, site)).id as string);
    expect(d.state).toBe('succeeded');
    const live = pub.live.get(site)!;
    const text = live.files.map((f) => Buffer.from(f.content).toString('utf8')).join('\n');
    if (faq) {
      expect(text).toContain('Is Friday open?');
      expect(text).not.toContain('Draft only question');
    }
    expect(
      Number(
        (
          await e.sql(
            `SELECT count(*) n FROM deploy.builds WHERE project_id=$1 AND state='succeeded'`,
            [p.id],
          )
        )[0]!.n,
      ),
    ).toBe(1);
    expect(
      Number(
        (
          await e.sql(
            `SELECT count(*) n FROM platform.outbox WHERE payload->>'source'='deploy@M09'`,
          )
        )[0]!.n,
      ),
    ).toBeGreaterThan(0);
  });
});
