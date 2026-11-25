import { describe, expect, it } from 'vitest';
import {
  HostingTargetPublisher,
  InMemoryArtifactTransport,
  InMemoryHostingSiteOps,
  ReleaseIntegrityError,
  UnavailableArtifactTransport,
} from './hosting-target';
import { artifactHash, type Artifact, type TargetSite } from './ports';
import { SIMULATED_STAGING_TARGET, type StagingTarget } from './targets';
import { planSsl } from './ssl-flow';
import { syntheticApp } from './rehearsal';

const enc = (s: string) => new TextEncoder().encode(s);
const art = (body: string): Artifact => {
  const files = [
    { path: 'index.html', mime: 'text/html', content: enc(`<h1>${body}</h1>`) },
    { path: 'about/index.html', mime: 'text/html', content: enc(`<p>${body}</p>`) },
  ];
  return { hash: artifactHash(files), files };
};
const site: TargetSite = {
  id: 's1',
  name: 'Acme',
  status: 'active',
  runtime: 'static',
  dataRegion: 'local',
  domain: null,
};
const mk = (over: Partial<ConstructorParameters<typeof HostingTargetPublisher>[3]> = {}) => {
  const transport = new InMemoryArtifactTransport();
  const ops = new InMemoryHostingSiteOps();
  const pub = new HostingTargetPublisher(ops, transport, SIMULATED_STAGING_TARGET, over);
  return { transport, ops, pub };
};

describe('HostingTargetPublisher (release layout, SIMULATED transport)', () => {
  it('stage → smoke staged → activate → smoke live; the URL is a simulated temporary host', async () => {
    const { pub } = mk();
    const a = art('v1');
    const { stagingRef } = await pub.stage(site, a, 'dep-00000001');
    expect((await pub.smoke(site, 'staged', stagingRef, ['/', '/about/'])).ok).toBe(true);
    expect(await pub.activeHash(site)).toBeNull(); // staged, not live
    const { url } = await pub.activate(site, stagingRef);
    expect(url).toMatch(/^https:\/\/acme-[0-9a-f]{16}\.staging\.nuzm\.invalid\/$/);
    expect(await pub.activeHash(site)).toBe(a.hash);
    expect(
      (await pub.smoke(site, 'live', null, ['/', '/missing'])).results.map((r) => r.status),
    ).toEqual([200, 404]);
    expect(pub.simulated).toBe(true);
    expect(pub.available()).toBe(true);
  });

  it('a release that does not read back identical is refused and removed (integrity)', async () => {
    const { pub, transport } = mk();
    transport.corruptNextPut = true;
    await expect(pub.stage(site, art('v1'), 'dep-00000001')).rejects.toBeInstanceOf(
      ReleaseIntegrityError,
    );
    expect(await transport.hasRelease(site, 'dep-00000001')).toBe(false);
  });

  it('an artifact whose hash does not match its files never reaches the node', async () => {
    const { pub, transport } = mk();
    await expect(
      pub.stage(site, { ...art('v1'), hash: 'f'.repeat(64) }, 'dep-00000001'),
    ).rejects.toThrow(/hash/);
    expect(transport.puts).toBe(0);
  });

  it('a missing or suspended site is refused before anything is uploaded', async () => {
    const { pub, ops, transport } = mk();
    ops.suspended.add(site.id);
    await expect(pub.stage(site, art('v1'), 'd')).rejects.toThrow(/suspended/);
    ops.suspended.clear();
    ops.missing.add(site.id);
    await expect(pub.stage(site, art('v1'), 'd')).rejects.toThrow(/does not exist/);
    expect(transport.puts).toBe(0);
  });

  it('cancellation discards a staged release and never touches the live one', async () => {
    const { pub, transport } = mk();
    const v1 = art('v1');
    await pub.activate(site, (await pub.stage(site, v1, 'dep-00000001')).stagingRef);
    await pub.stage(site, art('v2'), 'dep-00000002');
    await pub.discard(site, 'dep-00000002');
    expect(await transport.listReleases(site)).toEqual(['dep-00000001']);
    await pub.discard(site, 'dep-00000001'); // the live release: a no-op
    expect(await pub.activeHash(site)).toBe(v1.hash);
  });

  it('rollback switches back to the retained release without a new upload; falls back to upload when it was pruned', async () => {
    const { pub, transport } = mk({ keepReleases: 2 });
    const v1 = art('v1');
    const v2 = art('v2');
    const v3 = art('v3');
    for (const [id, a] of [
      ['dep-00000001', v1],
      ['dep-00000002', v2],
    ] as const)
      await pub.activate(site, (await pub.stage(site, a, id)).stagingRef);
    const putsBefore = transport.puts;
    await pub.restore(site, v1);
    expect(transport.puts).toBe(putsBefore); // switched, not re-uploaded
    expect(await pub.activeHash(site)).toBe(v1.hash);
    // two more releases push v1 out of the retained window; v1 is no longer live so it can be pruned
    await pub.activate(site, (await pub.stage(site, v2, 'dep-00000003')).stagingRef);
    await pub.activate(site, (await pub.stage(site, v3, 'dep-00000004')).stagingRef);
    expect((await transport.listReleases(site)).length).toBeLessThanOrEqual(2);
    await pub.restore(site, v1); // gone: uploaded again, verified, switched
    expect(await pub.activeHash(site)).toBe(v1.hash);
  });

  it('the live release is never pruned, whatever the retention', async () => {
    const { pub, transport } = mk({ keepReleases: 2 });
    for (let i = 1; i <= 6; i++)
      await pub.activate(site, (await pub.stage(site, art(`v${i}`), `dep-0000000${i}`)).stagingRef);
    const live = await transport.currentRelease(site);
    expect(live).toBe('dep-00000006');
    expect(await transport.listReleases(site)).toContain('dep-00000006');
    await expect(transport.removeRelease(site, 'dep-00000006')).rejects.toThrow(/live release/);
  });

  it('a real target without the HG-05 approval is unavailable (refuses, never degrades); the missing upload path refuses every call', async () => {
    const real: StagingTarget = {
      id: 'hosting:n1',
      kind: 'static_hosting',
      provider: 'hosting_panel',
      verification: 'NOT VERIFIED',
      region: 'sa',
      previewDomain: 'nuzm-staging.example',
      approvalRef: null,
      evidenceRef: null,
    };
    const pub = new HostingTargetPublisher(
      new InMemoryHostingSiteOps(),
      new UnavailableArtifactTransport(),
      real,
    );
    expect(pub.available()).toBe(false);
    expect(pub.simulated).toBe(false);
    await expect(pub.stage(site, art('v1'), 'd')).rejects.toThrow(/HG-05/); // sealed before the transport is reached
    const approved = new HostingTargetPublisher(
      new InMemoryHostingSiteOps(),
      new UnavailableArtifactTransport(),
      { ...real, approvalRef: 'HG-05:2026-12-01' },
    );
    expect(approved.available()).toBe(true); // authorised in principle; the transport still refuses until SFTP exists
    await expect(approved.stage(site, art('v1'), 'd')).rejects.toThrow(/no artifact upload path/);
  });

  it('SSL actions run through the hosting ops (managed only) and a custom domain uses its own host', async () => {
    const { pub, ops } = mk();
    const plan = planSsl({
      hostKind: 'custom',
      host: 'shop.example.sa',
      simulated: true,
      hg06Approved: false,
      dnsVerified: true,
      cert: { state: 'none', notAfter: null, failures: 0 },
      now: '2026-12-01T00:00:00Z',
    });
    expect(plan.action.kind).toBe('issue_managed');
    const cert = await pub.applySsl(site, plan.action);
    expect(cert?.domains).toEqual(['shop.example.sa']);
    expect(ops.issued).toHaveLength(1);
    expect(await pub.applySsl(site, { kind: 'none' })).toBeNull();
    const { url } = await pub.activate(
      { ...site, domain: 'shop.example.sa' },
      (await pub.stage(site, art('v1'), 'dep-00000001')).stagingRef,
    );
    expect(url).toBe('https://shop.example.sa/');
  });

  it('the seal: an unapproved real target cannot stage, switch, restore or issue even when built directly', async () => {
    const real: StagingTarget = {
      id: 'hosting:n1',
      kind: 'static_hosting',
      provider: 'hosting_panel',
      verification: 'NOT VERIFIED',
      region: 'sa',
      previewDomain: 'nuzm-staging.example',
      approvalRef: null,
      evidenceRef: null,
    };
    const transport = new InMemoryArtifactTransport();
    const pub = new HostingTargetPublisher(new InMemoryHostingSiteOps(), transport, real);
    await expect(pub.stage(site, art('v1'), 'd')).rejects.toThrow(/HG-05/);
    await expect(pub.activate(site, 'd')).rejects.toThrow(/HG-05/);
    await expect(pub.restore(site, art('v1'))).rejects.toThrow(/HG-05/);
    await expect(
      pub.applySsl(site, { kind: 'issue_managed', domains: ['x.example.sa'] }),
    ).rejects.toThrow(/HG-05/);
    expect(transport.puts).toBe(0);
  });
});

describe('HostingTargetPublisher: optional health policy on the smoke checks', () => {
  const a = syntheticApp(1);
  const s: TargetSite = {
    id: 'hp-site',
    name: 'hp',
    status: 'active',
    runtime: 'static',
    dataRegion: 'local',
    domain: null,
  };
  it('without a policy the smoke is one round (a transient 503 fails it)', async () => {
    const t = new InMemoryArtifactTransport();
    const pub = new HostingTargetPublisher(
      new InMemoryHostingSiteOps(),
      t,
      SIMULATED_STAGING_TARGET,
    );
    await pub.stage(s, a, 'release-0001');
    t.failPaths.set('/', 503);
    expect((await pub.smoke(s, 'staged', 'release-0001', ['/'])).ok).toBe(false);
  });
  it('with a policy a node that needs a moment becomes healthy; a node that stays broken still fails', async () => {
    const t = new InMemoryArtifactTransport();
    const waits: number[] = [];
    const pub = new HostingTargetPublisher(
      new InMemoryHostingSiteOps(),
      t,
      SIMULATED_STAGING_TARGET,
      {
        health: { attempts: 5, delayMs: 7, requiredConsecutive: 2 },
        sleep: async (ms) => void waits.push(ms),
      },
    );
    await pub.stage(s, a, 'release-0001');
    const real = t.probe.bind(t);
    let n = 0;
    t.probe = async (site, where, path) => (n++ < 3 ? { status: 503 } : real(site, where, path));
    expect((await pub.smoke(s, 'staged', 'release-0001', ['/'])).ok).toBe(true);
    expect(waits.length).toBeGreaterThan(0);
    t.probe = async () => ({ status: 500 });
    const bad = await pub.smoke(s, 'staged', 'release-0001', ['/']);
    expect(bad.ok).toBe(false);
    expect(bad.results).toEqual([{ path: '/', status: 500 }]);
  });
});
