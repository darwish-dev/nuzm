import { describe, expect, it } from 'vitest';
import { deployTransport as dt } from '@nuzm/domain';
import { HostingTargetPublisher, InMemoryHostingSiteOps } from './hosting-target';
import { SIMULATED_STAGING_TARGET } from './targets';
import { syntheticApp } from './rehearsal';
import type { TargetSite } from './ports';

/**
 * The product's own publisher (`HostingTargetPublisher`) over the SIMULATED file-manager transport: stage, integrity read-back, switch through the docroot port, health, rollback by
 * hash, and the failures that must leave the previous release serving. Same publisher code a real node would run; the node under it is a stand-in, so every result is SIMULATED.
 */
const site: TargetSite = {
  id: 'fm-site',
  name: 'fm',
  status: 'active',
  runtime: 'static',
  dataRegion: 'local',
  domain: null,
};
function rig() {
  const tree = new dt.InMemorySiteFileTree(['fm-site']).onlySites(['fm-site']);
  const docroot = new dt.InMemoryDocrootSwitch(tree);
  const probe = new dt.InMemoryStatusProbe(tree, docroot);
  const transport = new dt.FileManagerArtifactTransport(tree, probe, docroot);
  const pub = new HostingTargetPublisher(
    new InMemoryHostingSiteOps(),
    transport,
    SIMULATED_STAGING_TARGET,
  );
  return { tree, docroot, probe, transport, pub };
}

describe('HostingTargetPublisher over the file-manager transport (SIMULATED)', () => {
  it('release 1, release 2, rollback to release 1: hash equal byte for byte, no re-upload', async () => {
    const { pub, tree } = rig();
    const a1 = syntheticApp(1);
    const a2 = syntheticApp(2);
    await pub.stage(site, a1, 'release-0001');
    expect((await pub.smoke(site, 'staged', 'release-0001', ['/', '/about/', '/health/'])).ok).toBe(
      true,
    );
    await pub.activate(site, 'release-0001');
    expect(await pub.activeHash(site)).toBe(a1.hash);
    await pub.stage(site, a2, 'release-0002');
    await pub.activate(site, 'release-0002');
    expect(await pub.activeHash(site)).toBe(a2.hash);
    const writes = tree.writes;
    await pub.restore(site, a1);
    expect(await pub.activeHash(site)).toBe(a1.hash);
    expect(tree.writes).toBe(writes);
    expect((await pub.smoke(site, 'live', null, ['/', '/about/'])).ok).toBe(true);
  });
  it('a corrupted upload is refused at stage time and leaves nothing on the node', async () => {
    const { pub, tree, transport } = rig();
    tree.corruptNextWrite = true;
    await expect(pub.stage(site, syntheticApp(1), 'release-0001')).rejects.toThrow();
    expect(await transport.listReleases(site)).toEqual([]);
  });
  it('without a docroot port the publisher can stage but never activate (the product refuses, nothing is faked)', async () => {
    const tree = new dt.InMemorySiteFileTree(['fm-site']);
    const transport = new dt.FileManagerArtifactTransport(
      tree,
      new dt.InMemoryStatusProbe(tree, new dt.InMemoryDocrootSwitch(tree)),
      null,
    );
    const pub = new HostingTargetPublisher(
      new InMemoryHostingSiteOps(),
      transport,
      SIMULATED_STAGING_TARGET,
    );
    await pub.stage(site, syntheticApp(1), 'release-0001');
    await expect(pub.activate(site, 'release-0001')).rejects.toMatchObject({
      code: 'node_unavailable',
    });
  });
  it('a panel that rejects the switch leaves the previous release serving', async () => {
    const { pub, docroot } = rig();
    const a1 = syntheticApp(1);
    await pub.stage(site, a1, 'release-0001');
    await pub.activate(site, 'release-0001');
    await pub.stage(site, syntheticApp(2), 'release-0002');
    docroot.rejectNext = true;
    await expect(pub.activate(site, 'release-0002')).rejects.toThrow();
    expect(await pub.activeHash(site)).toBe(a1.hash);
  });
});
