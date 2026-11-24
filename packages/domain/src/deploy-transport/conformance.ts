import {
  ArtifactTransportError,
  artifactManifestHash,
  type ArtifactTransportPort,
  type TransportArtifact,
  type TransportErrorCode,
  type TransportLimits,
  type TransportSite,
} from './contract';

/**
 * ARTIFACT TRANSPORT CONFORMANCE: the test the SIMULATED transport passes today and the hosting-side implementation must pass later (the same idea as S04's hand-off
 * conformance). Framework-free: `artifactTransportConformanceCases(rig)` returns named cases; each one throws on failure. A vitest file turns them into `it`s:
 *
 *   for (const c of artifactTransportConformanceCases(rig)) it(`${c.id} ${c.title}`, c.run);
 *
 * What a pass means: the transport honours the contract in `docs/parallel/HOST-TRANSPORT-SPEC.md`. Over an in-memory or mocked node a pass is SIMULATED (wiring and rules, never
 * what a real node does). Over a real node it is LIVE-VERIFIED only together with the live evidence record (`docs/parallel/STAGING-DEPLOYMENT-PLAN.md` §17), and the rig says so.
 * Cases that need a capability the rig does not offer (fault injection) are reported `skipped`, never silently passed.
 */
export interface TransportRig {
  name: string;
  /** a rig over anything but a real node is SIMULATED */
  origin: 'SIMULATED' | 'REAL';
  transport: ArtifactTransportPort;
  /** two sites of DIFFERENT organizations on the same transport (tenant isolation) */
  siteA: TransportSite;
  siteB: TransportSite;
  /** a site the transport has never heard of: must answer `site_not_found`, like another organization's site */
  unknownSite: TransportSite;
  /** the bounds the transport enforces; the over-limit cases build trees just above them (skipped above ~8 MiB unless `heavy`) */
  limits: TransportLimits;
  heavy?: boolean;
  /** optional fault injection, supplied by a stand-in or a test node; a case that needs one is skipped when it is absent */
  faults?: {
    /** the node stores something different from what was sent for the next `putRelease` (the read-back hash must expose it) */
    corruptNextPut?: () => void;
    /** the next `putRelease` fails part-way (no partial release may stay visible) */
    failNextPut?: () => void;
  };
}

export interface ConformanceCase {
  id: string;
  title: string;
  run: () => Promise<void>;
  /** when set, the case is not run for this rig; the reason is reported */
  skip?: string;
}

const enc = (s: string) => new TextEncoder().encode(s);
const MIB = 1024 * 1024;
let serial = 0;
/** a fresh, valid release id per call so cases never collide on a shared node */
const rid = (tag: string) => `conf-${tag}-${Date.now().toString(36)}-${(serial++).toString(36)}`;

export const buildConformanceArtifact = (
  body: string,
  extra: { path: string; content: Uint8Array }[] = [],
): TransportArtifact => {
  const files = [
    { path: 'index.html', mime: 'text/html', content: enc(`<h1>${body}</h1>`) },
    { path: 'about/index.html', mime: 'text/html', content: enc(`<p>${body}</p>`) },
    ...extra.map((f) => ({ ...f, mime: 'application/octet-stream' })),
  ];
  return { hash: artifactManifestHash(files), files };
};
/** the manifest hash of `buildConformanceArtifact('conformance')`, written down so a hosting-side hash implementation cannot drift unnoticed */
export const CONFORMANCE_VECTOR = {
  body: 'conformance',
  hash: 'ab2e3dc0e8e1ef8c7760d4406639f5f62450ec6f193d94bda0e503202d59eb44',
} as const;

const fail = (msg: string): never => {
  throw new Error(`conformance: ${msg}`);
};
const eq = (a: unknown, b: unknown, what: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b))
    fail(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const truthy = (v: unknown, what: string) => {
  if (!v) fail(what);
};
/** `fn` must reject (or throw synchronously) with an `ArtifactTransportError` of exactly this code */
async function refuses(code: TransportErrorCode, fn: () => unknown, what: string) {
  try {
    await fn();
  } catch (e) {
    if (
      e instanceof ArtifactTransportError ||
      (e as { name?: string })?.name === 'ArtifactTransportError'
    ) {
      eq((e as ArtifactTransportError).code, code, `${what}: error code`);
      return;
    }
    return fail(`${what}: threw a plain error instead of an ArtifactTransportError (${String(e)})`);
  }
  fail(`${what}: expected ${code}, but the call succeeded`);
}

export function artifactTransportConformanceCases(rig: TransportRig): ConformanceCase[] {
  const t = rig.transport;
  const A = rig.siteA;
  const B = rig.siteB;
  const heavySkip =
    rig.limits.maxBytes > 8 * MIB && !rig.heavy
      ? 'over-limit tree would be larger than 8 MiB; set rig.heavy to run it'
      : undefined;
  const cases: ConformanceCase[] = [
    {
      id: 'T-01',
      title:
        'put then read back: the hash comes from the node and equals the manifest hash; counts are right',
      run: async () => {
        const art = buildConformanceArtifact(CONFORMANCE_VECTOR.body);
        eq(art.hash, CONFORMANCE_VECTOR.hash, 'manifest hash vector (the hash rule drifted)');
        const id = rid('put');
        const info = await t.putRelease(A, id, art);
        eq(info.releaseId, id, 'releaseId');
        eq(info.hash, art.hash, 'put hash');
        eq(info.files, 2, 'file count');
        eq(
          info.bytes,
          art.files.reduce((n, f) => n + f.content.byteLength, 0),
          'byte count',
        );
        eq(await t.readReleaseHash(A, id), art.hash, 'hash read back from the node');
        truthy(await t.hasRelease(A, id), 'hasRelease after put');
        eq(await t.readReleaseHash(A, rid('none')), null, 'unknown release reads null');
      },
    },
    {
      id: 'T-02',
      title: 'putRelease never switches the live release',
      run: async () => {
        const before = await t.currentRelease(A);
        await t.putRelease(A, rid('nolive'), buildConformanceArtifact('no-switch'));
        eq(await t.currentRelease(A), before, 'currentRelease after a put');
      },
    },
    {
      id: 'T-03',
      title: 'binary content and non-ASCII (Arabic) paths round-trip byte for byte',
      run: async () => {
        const bin = new Uint8Array(256).map((_, i) => i);
        const art = buildConformanceArtifact('bytes', [
          { path: 'assets/blob.bin', content: bin },
          { path: 'صفحة/مرحبا.html', content: enc('<p>مرحبا</p>') },
        ]);
        const id = rid('bin');
        await t.putRelease(A, id, art);
        eq(await t.readReleaseHash(A, id), art.hash, 'hash of binary + Arabic-named files');
      },
    },
    {
      id: 'T-04',
      title: 'idempotent: the same id and the same tree again succeeds and leaves one release',
      run: async () => {
        const art = buildConformanceArtifact('idem');
        const id = rid('idem');
        const first = await t.putRelease(A, id, art);
        const again = await t.putRelease(A, id, art);
        eq(again, first, 'second put returns the same info');
        eq((await t.listReleases(A)).filter((r) => r === id).length, 1, 'one release listed');
      },
    },
    {
      id: 'T-05',
      title: 'an existing id with a DIFFERENT tree is release_exists and the original is untouched',
      run: async () => {
        const one = buildConformanceArtifact('one');
        const two = buildConformanceArtifact('two');
        const id = rid('exists');
        await t.putRelease(A, id, one);
        await refuses(
          'release_exists',
          () => t.putRelease(A, id, two),
          'second tree under the same id',
        );
        eq(await t.readReleaseHash(A, id), one.hash, 'original content kept');
      },
    },
    {
      id: 'T-06',
      title:
        'switchCurrent returns the previous release, current reads back from the node, live serves the new tree',
      run: async () => {
        const r1 = rid('sw1');
        const r2 = rid('sw2');
        await t.putRelease(A, r1, buildConformanceArtifact('first'));
        await t.putRelease(A, r2, buildConformanceArtifact('second'));
        const start = await t.currentRelease(A);
        const s1 = await t.switchCurrent(A, r1);
        eq(s1.previousReleaseId, start, 'previous of the first switch');
        eq(await t.currentRelease(A), r1, 'current after switch 1');
        eq((await t.probe(A, 'live', '/')).status, 200, 'live serves the index');
        const s2 = await t.switchCurrent(A, r2);
        eq(s2.previousReleaseId, r1, 'previous of the second switch');
        eq(await t.currentRelease(A), r2, 'current after switch 2');
      },
    },
    {
      id: 'T-07',
      title: 'switching to an unknown release is release_not_found and changes nothing',
      run: async () => {
        const live = rid('keep');
        await t.putRelease(A, live, buildConformanceArtifact('keep'));
        await t.switchCurrent(A, live);
        await refuses(
          'release_not_found',
          () => t.switchCurrent(A, rid('ghost')),
          'switch to a ghost',
        );
        eq(await t.currentRelease(A), live, 'current unchanged');
      },
    },
    {
      id: 'T-08',
      title: 'rollback is a switch back: the earlier release is still there and needs no re-upload',
      run: async () => {
        const r1 = rid('rb1');
        const r2 = rid('rb2');
        const a1 = buildConformanceArtifact('v1');
        await t.putRelease(A, r1, a1);
        await t.putRelease(A, r2, buildConformanceArtifact('v2'));
        await t.switchCurrent(A, r1);
        await t.switchCurrent(A, r2);
        truthy(await t.hasRelease(A, r1), 'earlier release retained while a later one is live');
        const back = await t.switchCurrent(A, r1);
        eq(back.previousReleaseId, r2, 'rolled back from r2');
        eq(await t.readReleaseHash(A, r1), a1.hash, 'rolled-back release is byte-identical');
      },
    },
    {
      id: 'T-09',
      title:
        'removeRelease: the live one is live_release_protected; another is removed; a missing one is a no-op',
      run: async () => {
        const live = rid('rmlive');
        const other = rid('rmother');
        await t.putRelease(A, live, buildConformanceArtifact('live'));
        await t.putRelease(A, other, buildConformanceArtifact('other'));
        await t.switchCurrent(A, live);
        await refuses(
          'live_release_protected',
          () => t.removeRelease(A, live),
          'remove the live release',
        );
        truthy(await t.hasRelease(A, live), 'live release still there');
        await t.removeRelease(A, other);
        eq(await t.hasRelease(A, other), false, 'removed release is gone');
        await t.removeRelease(A, other); // again: no throw
        await t.removeRelease(A, rid('never')); // never existed: no throw
      },
    },
    {
      id: 'T-10',
      title: 'listReleases is oldest first and contains exactly what exists',
      run: async () => {
        const ids = [rid('ls1'), rid('ls2'), rid('ls3')];
        for (const id of ids) await t.putRelease(A, id, buildConformanceArtifact(id));
        const list = await t.listReleases(A);
        eq(
          list.filter((x) => ids.includes(x)),
          ids,
          'creation order among our releases',
        );
        await t.removeRelease(A, ids[1]!);
        eq((await t.listReleases(A)).includes(ids[1]!), false, 'a removed release is not listed');
      },
    },
    {
      id: 'T-11',
      title:
        'probe: staged and live answer from their own tree; a missing path and a missing release are not 200',
      run: async () => {
        const r = rid('probe');
        await t.putRelease(A, r, buildConformanceArtifact('probe'));
        eq((await t.probe(A, { release: r }, '/')).status, 200, 'staged index');
        eq((await t.probe(A, { release: r }, '/about/')).status, 200, 'staged nested index');
        eq((await t.probe(A, { release: r }, '/nope.html')).status, 404, 'staged missing path');
        eq(
          (await t.probe(A, { release: rid('absent') }, '/')).status,
          404,
          'staged missing release',
        );
      },
    },
    {
      id: 'T-12',
      title:
        'unsafe artifact paths are refused (traversal, absolute, backslash, NUL, dot segments, duplicates incl. case) and leave no release behind',
      run: async () => {
        const bads = [
          '../evil.html',
          '/abs.html',
          'a/../b.html',
          'a\\b.html',
          'x\u0000y.html',
          './x.html',
          'a//b.html',
          '',
          'dir/',
        ];
        for (const p of bads) {
          const id = rid('badpath');
          const files = [
            { path: 'index.html', mime: 'text/html', content: enc('ok') },
            { path: p, mime: 'text/html', content: enc('x') },
          ];
          await refuses(
            'invalid_path',
            () => t.putRelease(A, id, { hash: artifactManifestHash(files), files }),
            `path ${JSON.stringify(p)}`,
          );
          eq(await t.hasRelease(A, id), false, `no release left behind for ${JSON.stringify(p)}`);
        }
        const dup = [
          { path: 'a.html', mime: 'text/html', content: enc('1') },
          { path: 'A.html', mime: 'text/html', content: enc('2') },
        ];
        const id = rid('dup');
        await refuses(
          'invalid_path',
          () => t.putRelease(A, id, { hash: artifactManifestHash(dup), files: dup }),
          'case-insensitive duplicate',
        );
        eq(await t.hasRelease(A, id), false, 'no release left behind for the duplicate');
      },
    },
    {
      id: 'T-13',
      title:
        'bad release ids are invalid_release_id (traversal, reserved names, spaces, too short)',
      run: async () => {
        for (const id of [
          '',
          '../x',
          'current',
          'releases',
          'A B',
          'short',
          'UPPERCASE-ID-1',
          'a/b-release-id',
        ])
          await refuses(
            'invalid_release_id',
            () => t.putRelease(A, id, buildConformanceArtifact('id')),
            `release id ${JSON.stringify(id)}`,
          );
      },
    },
    {
      id: 'T-14',
      title: 'an empty artifact is empty_artifact',
      run: async () => {
        await refuses(
          'empty_artifact',
          () => t.putRelease(A, rid('empty'), { hash: artifactManifestHash([]), files: [] }),
          'no files',
        );
      },
    },
    {
      id: 'T-15',
      title:
        'bounds: more files, a bigger file or a bigger tree than the limits is limit_exceeded and nothing is left behind',
      skip: heavySkip,
      run: async () => {
        const many = Array.from({ length: rig.limits.maxFiles + 1 }, (_, i) => ({
          path: `f${i}.txt`,
          mime: 'text/plain',
          content: enc('x'),
        }));
        const id1 = rid('many');
        await refuses(
          'limit_exceeded',
          () => t.putRelease(A, id1, { hash: artifactManifestHash(many), files: many }),
          'too many files',
        );
        eq(await t.hasRelease(A, id1), false, 'no release left behind (file count)');
        const big = [
          {
            path: 'big.bin',
            mime: 'application/octet-stream',
            content: new Uint8Array(rig.limits.maxFileBytes + 1),
          },
        ];
        const id2 = rid('bigfile');
        await refuses(
          'limit_exceeded',
          () => t.putRelease(A, id2, { hash: artifactManifestHash(big), files: big }),
          'file above the per-file bound',
        );
        eq(await t.hasRelease(A, id2), false, 'no release left behind (file size)');
        // total just above the tree bound, each file within the per-file bound
        const per = Math.min(rig.limits.maxFileBytes, rig.limits.maxBytes);
        const n = Math.floor(rig.limits.maxBytes / per) + 1;
        const tree = Array.from({ length: n }, (_, i) => ({
          path: `b${i}.bin`,
          mime: 'application/octet-stream',
          content: new Uint8Array(per),
        }));
        const id3 = rid('bigtree');
        await refuses(
          'limit_exceeded',
          () => t.putRelease(A, id3, { hash: artifactManifestHash(tree), files: tree }),
          'tree above the per-deployment bound',
        );
        eq(await t.hasRelease(A, id3), false, 'no release left behind (tree size)');
      },
    },
    {
      id: 'T-16',
      title:
        'tenant isolation: a release of site A is invisible to site B; an unknown site is site_not_found for every call',
      run: async () => {
        const id = rid('tenant');
        const art = buildConformanceArtifact('tenant');
        await t.putRelease(A, id, art);
        eq(await t.hasRelease(B, id), false, "B does not have A's release");
        eq(await t.readReleaseHash(B, id), null, "B reads null for A's release");
        eq((await t.listReleases(B)).includes(id), false, "B does not list A's release");
        await refuses(
          'release_not_found',
          () => t.switchCurrent(B, id),
          "B switching to A's release",
        );
        // the same id on B is independent
        await t.putRelease(B, id, buildConformanceArtifact('tenant-b'));
        eq(await t.readReleaseHash(A, id), art.hash, "A unchanged by B's put under the same id");
        const U = rig.unknownSite;
        await refuses(
          'site_not_found',
          () => t.putRelease(U, rid('u'), buildConformanceArtifact('u')),
          'put on an unknown site',
        );
        await refuses(
          'site_not_found',
          () => t.readReleaseHash(U, id),
          'readReleaseHash on an unknown site',
        );
        await refuses(
          'site_not_found',
          () => t.switchCurrent(U, id),
          'switchCurrent on an unknown site',
        );
        await refuses(
          'site_not_found',
          () => t.currentRelease(U),
          'currentRelease on an unknown site',
        );
        await refuses('site_not_found', () => t.probe(U, 'live', '/'), 'probe on an unknown site');
        await refuses('site_not_found', () => t.hasRelease(U, id), 'hasRelease on an unknown site');
        await refuses(
          'site_not_found',
          () => t.removeRelease(U, id),
          'removeRelease on an unknown site',
        );
        await refuses('site_not_found', () => t.listReleases(U), 'listReleases on an unknown site');
      },
    },
    {
      id: 'T-17',
      title:
        'concurrency: two puts of the same id and tree leave one release; two switches end on one of the two releases',
      run: async () => {
        const art = buildConformanceArtifact('race');
        const id = rid('race');
        await Promise.all([t.putRelease(A, id, art), t.putRelease(A, id, art)]);
        eq(
          (await t.listReleases(A)).filter((x) => x === id).length,
          1,
          'one release after two concurrent puts',
        );
        eq(await t.readReleaseHash(A, id), art.hash, 'content intact');
        const r1 = rid('rs1');
        const r2 = rid('rs2');
        await t.putRelease(A, r1, buildConformanceArtifact('r1'));
        await t.putRelease(A, r2, buildConformanceArtifact('r2'));
        await Promise.all([t.switchCurrent(A, r1), t.switchCurrent(A, r2)]);
        truthy([r1, r2].includes((await t.currentRelease(A)) ?? ''), 'current is one of the two');
      },
    },
    {
      id: 'T-18',
      title:
        'integrity: a node that stores something else is exposed by the read-back hash (fault injection)',
      skip: rig.faults?.corruptNextPut ? undefined : 'the rig offers no corruptNextPut',
      run: async () => {
        const art = buildConformanceArtifact('corrupt');
        const id = rid('corrupt');
        rig.faults!.corruptNextPut!();
        await t.putRelease(A, id, art).catch(() => undefined);
        const back = await t.readReleaseHash(A, id);
        truthy(
          back !== art.hash,
          'the read-back hash must differ from the sent hash when the node stored other bytes',
        );
      },
    },
    {
      id: 'T-19',
      title:
        'failure atomicity: a put that fails part-way leaves no visible release (fault injection)',
      skip: rig.faults?.failNextPut ? undefined : 'the rig offers no failNextPut',
      run: async () => {
        const id = rid('cut');
        rig.faults!.failNextPut!();
        let threw = false;
        await t.putRelease(A, id, buildConformanceArtifact('cut')).catch(() => (threw = true));
        truthy(threw, 'the cut-short put must reject');
        eq(await t.hasRelease(A, id), false, 'no partial release is visible');
        eq((await t.listReleases(A)).includes(id), false, 'no partial release is listed');
        // and a retry under the same id works (reconcile-before-retry finds nothing, then writes)
        const art = buildConformanceArtifact('cut-retry');
        await t.putRelease(A, id, art);
        eq(await t.readReleaseHash(A, id), art.hash, 'retry after a failed put succeeds');
      },
    },
  ];
  return cases;
}

/** Run every case and collect results (for a CLI or a report); a vitest file maps the cases to `it`s instead. */
export async function runArtifactTransportConformance(rig: TransportRig) {
  const results: {
    id: string;
    title: string;
    status: 'pass' | 'fail' | 'skipped';
    detail?: string;
  }[] = [];
  for (const c of artifactTransportConformanceCases(rig)) {
    if (c.skip) {
      results.push({ id: c.id, title: c.title, status: 'skipped', detail: c.skip });
      continue;
    }
    try {
      await c.run();
      results.push({ id: c.id, title: c.title, status: 'pass' });
    } catch (e) {
      results.push({
        id: c.id,
        title: c.title,
        status: 'fail',
        detail: String((e as Error).message),
      });
    }
  }
  return {
    rig: rig.name,
    origin: rig.origin,
    results,
    passed: results.every((r) => r.status !== 'fail'),
  };
}

/**
 * A transport that is not available (no node connected, no path yet) must refuse EVERY call with `node_unavailable`, synchronously or by rejection, and never succeed.
 * `UnavailableArtifactTransport` is the deploy module's one.
 */
export async function unavailableTransportConformance(
  t: ArtifactTransportPort,
  site: TransportSite,
): Promise<void> {
  const art = buildConformanceArtifact('x');
  const calls: [string, () => unknown][] = [
    ['putRelease', () => t.putRelease(site, 'conf-unavailable-1', art)],
    ['readReleaseHash', () => t.readReleaseHash(site, 'conf-unavailable-1')],
    ['switchCurrent', () => t.switchCurrent(site, 'conf-unavailable-1')],
    ['currentRelease', () => t.currentRelease(site)],
    ['probe', () => t.probe(site, 'live', '/')],
    ['hasRelease', () => t.hasRelease(site, 'conf-unavailable-1')],
    ['removeRelease', () => t.removeRelease(site, 'conf-unavailable-1')],
    ['listReleases', () => t.listReleases(site)],
  ];
  for (const [name, fn] of calls) await refuses('node_unavailable', fn, name);
  eq(t.simulated, false, 'an unavailable transport is not a stand-in');
}
