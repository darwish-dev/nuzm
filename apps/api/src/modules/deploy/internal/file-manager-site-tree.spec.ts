import { describe, expect, it } from 'vitest';
import { deployTransport as dt } from '@nuzm/domain';
import { FileManagerSiteTree, type FilesServiceLike } from './file-manager-site-tree';

/**
 * A fake of the hosting `FilesService` surface, backed by the in-memory tree, that fails the way `ProblemException` does (an object with a `code`). It checks the ADAPTER:
 * error mapping, the truncation and symlink refusals, org/actor binding, and the full shared conformance through adapter + transport (SIMULATED).
 */
class Problem extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function fakeFiles(
  tree: dt.InMemorySiteFileTree,
  opts: { truncate?: boolean; link?: string } = {},
) {
  const calls: { op: string; org: string; user?: string }[] = [];
  const wrap = async <T>(
    op: string,
    org: string,
    user: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> => {
    calls.push({ op, org, ...(user ? { user } : {}) });
    try {
      return await fn();
    } catch (e) {
      if (e instanceof dt.SiteFileError) {
        const m: Record<string, string> = {
          site_not_found: 'not_found',
          not_found: 'not_found',
          conflict: 'conflict',
          too_large: 'payload_too_large',
          quota: 'quota_exceeded',
          unavailable: 'service_unavailable',
          io: 'service_unavailable',
        };
        throw new Problem(m[e.code] ?? 'service_unavailable');
      }
      throw e;
    }
  };
  const svc: FilesServiceLike = {
    list: (org, site, q) =>
      wrap('list', org, undefined, async () => {
        const l = await tree.list(site, q.path ?? '');
        if (l === null) throw new Problem('not_found');
        const items = l.map((e) => ({ name: e.name, type: e.type, size: e.size }));
        if (opts.link) items.push({ name: opts.link, type: 'symlink' as never, size: 0 });
        return { items, truncated: !!opts.truncate };
      }),
    download: (org, site, q) =>
      wrap('download', org, undefined, async () => ({
        data: Buffer.from(await tree.read(site, q.path ?? '')),
      })),
    upload: (org, user, site, q, data) =>
      wrap('upload', org, user, () => tree.write(site, q.path ?? '', data)),
    mkdir: (org, user, site, q) =>
      wrap('mkdir', org, user, async () => {
        const exists = await tree.list(site, q.path ?? '');
        if (exists) throw new Problem('conflict'); // FilesService.mkdir: "something with this name exists"
        return tree.mkdir(site, q.path ?? '');
      }),
    rename: (org, user, site, _q, b) =>
      wrap('rename', org, user, () => tree.rename(site, String(b.from), String(b.to))),
    remove: (org, user, site, q) =>
      wrap('remove', org, user, async () => {
        if ((await tree.list(site, q.path ?? '')) === null) {
          try {
            await tree.read(site, q.path ?? '');
          } catch {
            throw new Problem('not_found');
          }
        }
        return tree.remove(site, q.path ?? '');
      }),
  };
  return { svc, calls };
}
const site = (id: string): dt.TransportSite => ({
  id,
  name: id,
  status: 'active',
  runtime: 'static',
  dataRegion: 'local',
  domain: null,
});
const LIMITS = { maxFiles: 20, maxBytes: 64 * 1024, maxFileBytes: 32 * 1024 };

function build(opts: { truncate?: boolean; link?: string } = {}) {
  const tree = new dt.InMemorySiteFileTree(['site-a', 'site-b']).onlySites(['site-a', 'site-b']);
  const docroot = new dt.InMemoryDocrootSwitch(tree);
  const { svc, calls } = fakeFiles(tree, opts);
  const port = new FileManagerSiteTree(svc, 'org-1', 'user-1');
  const transport = new dt.FileManagerArtifactTransport(
    port,
    new dt.InMemoryStatusProbe(tree, docroot),
    docroot,
    { limits: LIMITS },
  );
  return { tree, docroot, calls, port, transport };
}

describe('FileManagerSiteTree adapter', () => {
  it('passes the shared conformance T-01..T-19 through adapter + transport (SIMULATED)', async () => {
    const b = build();
    const rig: dt.TransportRig = {
      name: 'file-manager adapter over a FilesService fake (SIMULATED)',
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
    };
    const r = await dt.runArtifactTransportConformance(rig);
    expect(r.results.filter((x) => x.status !== 'pass')).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.origin).toBe('SIMULATED');
  });
  it('every call carries the bound organization; mutations carry the bound actor', async () => {
    const b = build();
    await b.transport.putRelease(site('site-a'), 'release-0001', dt.buildConformanceArtifact('x'));
    expect(b.calls.every((c) => c.org === 'org-1')).toBe(true);
    expect(
      b.calls
        .filter((c) => ['upload', 'mkdir', 'rename', 'remove'].includes(c.op))
        .every((c) => c.user === 'user-1'),
    ).toBe(true);
  });
  it('a missing web root is a missing SITE; a missing sub-folder is just absent', async () => {
    const b = build();
    await expect(b.port.list('site-unknown', '')).rejects.toMatchObject({ code: 'site_not_found' });
    expect(await b.port.list('site-a', '.nuzm/nothing')).toBeNull();
  });
  it('a truncated listing is an error, never a silent partial tree', async () => {
    const b = build({ truncate: true });
    await expect(b.port.list('site-a', '')).rejects.toMatchObject({ code: 'io' });
    await expect(b.transport.readReleaseHash(site('site-a'), 'release-0001')).rejects.toMatchObject(
      { code: 'node_unavailable' },
    );
  });
  it('a symbolic link in a listing is refused, not followed', async () => {
    const b = build({ link: 'evil' });
    await expect(b.port.list('site-a', '')).rejects.toMatchObject({ code: 'io' });
  });
  it('error mapping: payload too large and quota become limit_exceeded; an unavailable service becomes node_unavailable', async () => {
    const b = build();
    b.tree.maxFileBytes = 5;
    await expect(
      b.transport.putRelease(site('site-a'), 'release-0002', dt.buildConformanceArtifact('x')),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
    b.tree.maxFileBytes = 0;
    b.tree.unavailable = true;
    await expect(b.transport.listReleases(site('site-a'))).rejects.toMatchObject({
      code: 'node_unavailable',
    });
  });
  it('mkdir of an existing folder is idempotent; remove of a missing path is a no-op', async () => {
    const b = build();
    await b.port.mkdir('site-a', 'a');
    await b.port.mkdir('site-a', 'a');
    await b.port.remove('site-a', 'nope');
    expect(await b.port.list('site-a', '')).toEqual([{ name: 'a', type: 'dir', size: 0 }]);
  });
});
