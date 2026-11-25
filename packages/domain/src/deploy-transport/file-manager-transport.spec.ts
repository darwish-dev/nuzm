import { describe, expect, it } from 'vitest';
import { ArtifactTransportError, artifactManifestHash, type TransportSite } from './contract';
import {
  artifactTransportConformanceCases,
  buildConformanceArtifact,
  runArtifactTransportConformance,
  type TransportRig,
  unavailableTransportConformance,
} from './conformance';
import { FileManagerArtifactTransport } from './file-manager-transport';
import {
  InMemoryDocrootSwitch,
  InMemorySiteFileTree,
  InMemoryStatusProbe,
} from './file-manager-transport.sim';

/**
 * The SIMULATED file-manager transport (HOST-TRANSPORT option B) against the shared conformance T-01..T-19, plus what only this implementation can get wrong: the layout,
 * the cut-short cleanup, the switch that is not available / rejected / not applied, the plan's limits and the unavailable file manager. Nothing here touches a node.
 */
const site = (id: string): TransportSite => ({
  id,
  name: id,
  status: 'active',
  runtime: 'static',
  dataRegion: 'local',
  domain: null,
});
const LIMITS = { maxFiles: 20, maxBytes: 64 * 1024, maxFileBytes: 32 * 1024 };

function build(opts: { docroot?: boolean } = {}) {
  const tree = new InMemorySiteFileTree(['site-a', 'site-b']).onlySites(['site-a', 'site-b']);
  const docroot = new InMemoryDocrootSwitch(tree);
  const probe = new InMemoryStatusProbe(tree, docroot);
  let t = 1_700_000_000_000;
  const transport = new FileManagerArtifactTransport(
    tree,
    probe,
    opts.docroot === false ? null : docroot,
    { limits: LIMITS, now: () => t++ },
  );
  return { tree, docroot, probe, transport };
}
const rigOf = (b: ReturnType<typeof build>, over: Partial<TransportRig> = {}): TransportRig => ({
  name: 'file-manager transport over the in-memory file tree (SIMULATED)',
  origin: 'SIMULATED',
  transport: b.transport,
  siteA: site('site-a'),
  siteB: site('site-b'),
  unknownSite: site('site-unknown'),
  limits: LIMITS,
  faults: {
    corruptNextPut: () => (b.tree.corruptNextWrite = true),
    failNextPut: () => (b.tree.failAfterWrites = 1),
  },
  ...over,
});

describe('FileManagerArtifactTransport: shared conformance over the SIMULATED file tree', () => {
  const cases = artifactTransportConformanceCases(rigOf(build()));
  it('runs all 19 cases, none skipped', () => {
    expect(cases).toHaveLength(19);
    expect(cases.filter((c) => c.skip)).toEqual([]);
  });
  for (const c of cases) it(`${c.id} ${c.title}`, c.run);
  it('the whole run passes and is labelled SIMULATED', async () => {
    const r = await runArtifactTransportConformance(rigOf(build()));
    expect(r.passed).toBe(true);
    expect(r.origin).toBe('SIMULATED');
  });
});

describe('FileManagerArtifactTransport: layout and failure behaviour', () => {
  const A = site('site-a');
  const art = buildConformanceArtifact('layout');

  it('a release is written under .nuzm/releases/<id> with an index marker; nothing is left in .nuzm/tmp', async () => {
    const b = build();
    await b.transport.putRelease(A, 'release-0001', art);
    const p = b.tree.paths('site-a');
    expect(p).toContain('.nuzm/releases/release-0001/index.html');
    expect(p).toContain('.nuzm/releases/release-0001/about/index.html');
    expect(p.filter((x) => x.startsWith('.nuzm/index/'))).toHaveLength(1);
    expect(p.filter((x) => x.startsWith('.nuzm/tmp/') && x !== '.nuzm/tmp')).toEqual([]);
  });

  it('a transfer cut off part-way leaves no tmp tree, no release and no marker, and the retry works', async () => {
    const b = build();
    b.tree.failAfterWrites = 1;
    await expect(b.transport.putRelease(A, 'release-0002', art)).rejects.toMatchObject({
      code: 'transfer_failed',
    });
    const p = b.tree.paths('site-a');
    expect(p.filter((x) => x.includes('release-0002'))).toEqual([]);
    await b.transport.putRelease(A, 'release-0002', art);
    expect(await b.transport.readReleaseHash(A, 'release-0002')).toBe(art.hash);
  });

  it('bytes that the node stored wrongly are caught at put time: nothing becomes visible', async () => {
    const b = build();
    b.tree.corruptNextWrite = true;
    await expect(b.transport.putRelease(A, 'release-0003', art)).rejects.toMatchObject({
      code: 'transfer_failed',
    });
    expect(await b.transport.hasRelease(A, 'release-0003')).toBe(false);
  });

  it('tampering after the put is exposed by the read-back from the node', async () => {
    const b = build();
    await b.transport.putRelease(A, 'release-0004', art);
    b.tree.tamper('site-a', '.nuzm/releases/release-0004/index.html', new Uint8Array([1, 2, 3]));
    expect(await b.transport.readReleaseHash(A, 'release-0004')).not.toBe(art.hash);
  });

  it('releases are listed oldest first by their markers, even when put in reverse alphabetical order', async () => {
    const b = build();
    for (const id of ['zzzz-release', 'mmmm-release', 'aaaa-release'])
      await b.transport.putRelease(A, id, buildConformanceArtifact(id));
    expect(await b.transport.listReleases(A)).toEqual([
      'zzzz-release',
      'mmmm-release',
      'aaaa-release',
    ]);
  });

  it('plan limits: a per-file upload limit and a disk quota are limit_exceeded and leave nothing', async () => {
    const b = build();
    b.tree.maxFileBytes = 10;
    await expect(b.transport.putRelease(A, 'release-0005', art)).rejects.toMatchObject({
      code: 'limit_exceeded',
    });
    b.tree.maxFileBytes = 0;
    b.tree.quotaBytes = 5;
    await expect(b.transport.putRelease(A, 'release-0006', art)).rejects.toMatchObject({
      code: 'limit_exceeded',
    });
    expect(b.tree.paths('site-a').filter((x) => x.includes('release-000'))).toEqual([]);
  });

  it('unsafe artifact paths never reach the file tree', async () => {
    const b = build();
    const bad = { path: '../evil.html', mime: 'text/html', content: new Uint8Array([1]) };
    const files = [...art.files, bad];
    await expect(
      b.transport.putRelease(A, 'release-0007', { hash: artifactManifestHash(files), files }),
    ).rejects.toMatchObject({ code: 'invalid_path' });
    expect(b.tree.writes).toBe(0);
  });
});

describe('FileManagerArtifactTransport: the document-root switch', () => {
  const A = site('site-a');
  const art1 = buildConformanceArtifact('one');
  const art2 = buildConformanceArtifact('two');

  it('switch, read back, switch again, roll back to the retained release with no new write', async () => {
    const b = build();
    await b.transport.putRelease(A, 'release-aaaa1', art1);
    await b.transport.putRelease(A, 'release-bbbb2', art2);
    expect(await b.transport.switchCurrent(A, 'release-aaaa1')).toEqual({
      previousReleaseId: null,
    });
    expect(await b.transport.currentRelease(A)).toBe('release-aaaa1');
    expect(await b.transport.probe(A, 'live', '/')).toEqual({ status: 200 });
    expect(await b.transport.switchCurrent(A, 'release-bbbb2')).toEqual({
      previousReleaseId: 'release-aaaa1',
    });
    const writes = b.tree.writes;
    await b.transport.switchCurrent(A, 'release-aaaa1');
    expect(b.tree.writes).toBe(writes);
    expect(await b.transport.readReleaseHash(A, (await b.transport.currentRelease(A))!)).toBe(
      art1.hash,
    );
    await expect(b.transport.removeRelease(A, 'release-aaaa1')).rejects.toMatchObject({
      code: 'live_release_protected',
    });
  });

  it('without a docroot port the switch REFUSES (node_unavailable): it never pretends', async () => {
    const b = build({ docroot: false });
    await b.transport.putRelease(A, 'release-aaaa1', art1);
    await expect(b.transport.switchCurrent(A, 'release-aaaa1')).rejects.toMatchObject({
      code: 'node_unavailable',
    });
    await expect(b.transport.currentRelease(A)).rejects.toMatchObject({ code: 'node_unavailable' });
  });

  it('a panel that rejects the command leaves the previous release serving', async () => {
    const b = build();
    await b.transport.putRelease(A, 'release-aaaa1', art1);
    await b.transport.putRelease(A, 'release-bbbb2', art2);
    await b.transport.switchCurrent(A, 'release-aaaa1');
    b.docroot.rejectNext = true;
    await expect(b.transport.switchCurrent(A, 'release-bbbb2')).rejects.toBeInstanceOf(
      ArtifactTransportError,
    );
    expect(await b.transport.currentRelease(A)).toBe('release-aaaa1');
  });

  it('a panel that says OK but did not apply it is caught by the read-back', async () => {
    const b = build();
    await b.transport.putRelease(A, 'release-aaaa1', art1);
    b.docroot.ignoreNext = true;
    await expect(b.transport.switchCurrent(A, 'release-aaaa1')).rejects.toMatchObject({
      code: 'transfer_failed',
    });
    expect(await b.transport.currentRelease(A)).toBeNull();
  });

  it('switching to a release that is not on the node never calls the panel', async () => {
    const b = build();
    await expect(b.transport.switchCurrent(A, 'release-nope1')).rejects.toMatchObject({
      code: 'release_not_found',
    });
    expect(b.docroot.calls).toBe(0);
  });

  it('a staged probe of a release that does not exist is 404, a forced bad page is reported as is', async () => {
    const b = build();
    await b.transport.putRelease(A, 'release-aaaa1', art1);
    expect(await b.transport.probe(A, { release: 'release-aaaa1' }, '/about/')).toEqual({
      status: 200,
    });
    expect(await b.transport.probe(A, { release: 'release-zzzz9' }, '/')).toEqual({ status: 404 });
    b.probe.forced.set('/health/', 503);
    expect(await b.transport.probe(A, { release: 'release-aaaa1' }, '/health/')).toEqual({
      status: 503,
    });
  });
});

describe('FileManagerArtifactTransport: unavailable file manager', () => {
  it('refuses every call with node_unavailable, never succeeds', async () => {
    const b = build();
    b.tree.unavailable = true;
    const t = new FileManagerArtifactTransport(b.tree, b.probe, b.docroot, {
      simulated: false,
      limits: LIMITS,
    });
    await unavailableTransportConformance(t, site('site-a'));
  });
});
