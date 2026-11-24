import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockModelAdapter } from '@nuzm/adapter-model';
import { mockModelHandler } from '@nuzm/domain';
import { setupAiEnv, type AiEnv, type Row } from '../ai/testing/ai-harness';
import {
  DeployService,
  HostingTargetPublisher,
  InMemoryArtifactTransport,
  SitePublisherPort,
} from './index';

/**
 * The deploy service on the RELEASE-LAYOUT target (`DEPLOY_PUBLISHER=releases`): versioned releases on an in-memory node, integrity read-back, atomic switch, rollback by
 * switching back. SIMULATED: nothing reaches a hosting node. Proves `DeployService` works unchanged against the composed hosting target.
 */
process.env.DEPLOY_PUBLISHER = 'releases';
let e: AiEnv;
let deploys: DeployService;
let pub: HostingTargetPublisher;
let node: InMemoryArtifactTransport;
let planId: string;
const A = () => e.org.A!;
const j = (r: { json(): unknown }) => r.json() as Row;
const mkSite = async (name: string, domain: string | null) => {
  const id = randomUUID();
  await e.sql(
    `INSERT INTO hosting.sites (id, org_id, name, token, node_name, plan_id, runtime, status, data_region, created_by, credentials_ref, backup_key_ref, domain_primary)
     VALUES ($1,$2,$3,$4,$5,$6,'static','active','sa-central',$7,'vault://t/c','vault://t/b',$8)`,
    [
      id,
      A(),
      name,
      randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      `s-${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      planId,
      e.ids.alice,
      domain,
    ],
  );
  return id;
};
const post = (url: string, body: Row | undefined) =>
  e.call('alice', 'POST', url, body, A(), { 'idempotency-key': `k-${Math.random()}` });
const publish = async (projectId: string, site: string, environment = 'staging') => {
  const first = await post('/v1/deployments', { projectId, target: site, environment });
  expect(first.json().code).toBe('approval_required');
  return post('/v1/deployments', {
    projectId,
    target: site,
    environment,
    approvalId: first.json().approvalId,
  });
};
const drive = async (id: string) => {
  const r = (await e.sql(`SELECT operation_id FROM deploy.deployments WHERE id=$1`, [id]))[0]!;
  await deploys.runOne(A(), r.operation_id as string);
  return j(await e.call('alice', 'GET', `/v1/deployments/${id}`));
};
const edit = async (projectId: string, text: string) => {
  const h = j(await e.call('alice', 'GET', `/v1/builder/projects/${projectId}`));
  await e.call('alice', 'POST', `/v1/builder/projects/${projectId}/changes`, {
    baseVersion: h.headVersionId,
    ops: [{ op: 'setText', target: 'footerText', locale: 'en', value: text }],
    source: 'user',
  });
};

beforeAll(async () => {
  e = await setupAiEnv();
  deploys = e.app.get(DeployService);
  pub = e.app.get(SitePublisherPort) as HostingTargetPublisher;
  node = pub.transport as InMemoryArtifactTransport;
  await e.enableMock('mock-model', {
    adapter: new MockModelAdapter({ id: 'mock-model', handler: (r) => mockModelHandler(r) }),
  });
  planId = randomUUID();
  await e.sql(
    `INSERT INTO hosting.plan_definitions (id, key, name_ar, name_en, status, quotas, runtimes, reservation) VALUES ($1, 'rel-plan', 'خطة', 'Plan', 'active', '{"diskMb":1,"inodes":1000,"bandwidthGb":1,"dbCount":1,"sitesCount":1}', '["php"]', '{"cpu_millicores":1,"memory_mb":1,"disk_mb":1}')`,
    [planId],
  );
}, 120_000);
afterAll(() => e.h.close());

describe('deploy service on the release-layout target (SIMULATED)', () => {
  it('is the composed hosting target and labels every deployment simulated; a staging site without a domain gets a temporary .invalid subdomain', async () => {
    expect(pub).toBeInstanceOf(HostingTargetPublisher);
    expect(pub.simulated).toBe(true);
    const p = j(
      await e.call(
        'alice',
        'POST',
        '/v1/builder/projects',
        { type: 'website', name: 'Rel One', locale: ['ar', 'en'], templateId: 'landing' },
        A(),
      ),
    );
    const site = await mkSite('rel-one', null);
    const d = await drive(j(await publish(p.id as string, site)).id as string);
    expect(d.state, JSON.stringify(d.error)).toBe('succeeded');
    expect(d.simulated).toBe(true);
    expect(d.url).toMatch(/^https:\/\/rel-one-[0-9a-f]{16}\.staging\.nuzm\.invalid\/$/);
    expect((d.smoke as Row).ok).toBe(true);
    const target = {
      id: site,
      name: 'rel-one',
      status: 'active',
      runtime: 'static',
      dataRegion: 'sa-central',
      domain: null,
    };
    expect(await node.listReleases(target)).toHaveLength(1);
    expect(await pub.activeHash(target)).toBe(d.artifactHash);
  });

  it('versioned releases: a second release switches current; rollback switches back WITHOUT a new upload; the previous release stays on the node', async () => {
    const p = j(
      await e.call(
        'alice',
        'POST',
        '/v1/builder/projects',
        { type: 'website', name: 'Rel Two', locale: ['ar', 'en'], templateId: 'landing' },
        A(),
      ),
    );
    const site = await mkSite('rel-two', 'two.example.sa');
    const t = {
      id: site,
      name: 'rel-two',
      status: 'active',
      runtime: 'static',
      dataRegion: 'sa-central',
      domain: 'two.example.sa',
    };
    const d1 = await drive(j(await publish(p.id as string, site)).id as string);
    await edit(p.id as string, 'release two');
    const d2 = await drive(j(await publish(p.id as string, site)).id as string);
    expect(d2.artifactHash).not.toBe(d1.artifactHash);
    expect(d2.url).toBe('https://two.example.sa/');
    expect((await node.listReleases(t)).length).toBe(2);
    const puts = node.puts;
    const rb = await post(`/v1/deployments/${d2.id}/rollback`, undefined);
    expect(rb.statusCode, rb.body).toBe(202);
    const done = await drive(j(rb).id as string);
    expect(done.state).toBe('succeeded');
    expect(await pub.activeHash(t)).toBe(d1.artifactHash);
    expect(node.puts).toBe(puts); // switched to the retained release: nothing uploaded
  });

  it('a failing staged smoke check discards the staged release and the live release keeps serving', async () => {
    const p = j(
      await e.call(
        'alice',
        'POST',
        '/v1/builder/projects',
        { type: 'website', name: 'Rel Three', locale: ['ar', 'en'], templateId: 'landing' },
        A(),
      ),
    );
    const site = await mkSite('rel-three', 'three.example.sa');
    const t = {
      id: site,
      name: 'rel-three',
      status: 'active',
      runtime: 'static',
      dataRegion: 'sa-central',
      domain: 'three.example.sa',
    };
    const d1 = await drive(j(await publish(p.id as string, site)).id as string);
    await edit(p.id as string, 'will fail');
    node.failPaths.set('/', 503);
    try {
      const d2 = await drive(j(await publish(p.id as string, site)).id as string);
      expect(d2.state).toBe('rolled_back'); // the service's word for "the previous release keeps serving"
      expect(JSON.stringify(d2.error)).toMatch(/smoke/i);
    } finally {
      node.failPaths.clear();
    }
    expect(await pub.activeHash(t)).toBe(d1.artifactHash);
    expect(await node.listReleases(t)).toEqual([d1.id]); // the failed upload is gone
  });

  it('a release that does not read back identical never goes live (integrity) and the deployment fails', async () => {
    const p = j(
      await e.call(
        'alice',
        'POST',
        '/v1/builder/projects',
        { type: 'website', name: 'Rel Four', locale: ['ar', 'en'], templateId: 'landing' },
        A(),
      ),
    );
    const site = await mkSite('rel-four', 'four.example.sa');
    const t = {
      id: site,
      name: 'rel-four',
      status: 'active',
      runtime: 'static',
      dataRegion: 'sa-central',
      domain: 'four.example.sa',
    };
    node.corruptNextPut = true;
    const d = await drive(j(await publish(p.id as string, site)).id as string);
    expect(d.state).toBe('failed');
    expect(await pub.activeHash(t)).toBeNull();
    expect(await node.listReleases(t)).toEqual([]);
  });

  it('two tenants’ sites on the same node share nothing: another organization cannot deploy to or read this site', async () => {
    const p = j(
      await e.call(
        'bob',
        'POST',
        '/v1/builder/projects',
        { type: 'website', name: 'Rel Bob', locale: ['ar', 'en'], templateId: 'landing' },
        e.org.B!,
      ),
    );
    const site = await mkSite('rel-iso', 'iso.example.sa'); // a site of org A
    const r = await e.call(
      'bob',
      'POST',
      '/v1/deployments',
      { projectId: p.id, target: site, environment: 'staging' },
      e.org.B!,
      { 'idempotency-key': `k-${Math.random()}` },
    );
    expect(r.statusCode).toBe(404);
    expect(
      await node.listReleases({
        id: site,
        name: 'rel-iso',
        status: 'active',
        runtime: 'static',
        dataRegion: 'sa-central',
        domain: null,
      }),
    ).toEqual([]);
  });
});
