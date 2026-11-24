import { describe, expect, it } from 'vitest';
import { deployTransport as dt } from '@nuzm/domain';
import { InMemoryArtifactTransport, UnavailableArtifactTransport } from './hosting-target';

/**
 * The shared ArtifactTransport conformance (`@nuzm/domain` deployTransport) run over the SIMULATED in-memory transport. The hosting-side implementation runs the SAME cases
 * later (see docs/parallel/HOST-TRANSPORT-SPEC.md §9). A second block proves the suite CAN fail: each deliberately broken transport must be caught by the named case.
 */
const site = (id: string): dt.TransportSite => ({
  id,
  name: id,
  status: 'active',
  runtime: 'static',
  dataRegion: 'local',
  domain: null,
});
const LIMITS = { maxFiles: 20, maxBytes: 64 * 1024, maxFileBytes: 32 * 1024 };

const mkRig = (
  transport: InMemoryArtifactTransport,
  over: Partial<dt.TransportRig> = {},
): dt.TransportRig => ({
  name: 'in-memory (SIMULATED)',
  origin: 'SIMULATED',
  transport,
  siteA: site('site-a'),
  siteB: site('site-b'),
  unknownSite: site('site-unknown'),
  limits: LIMITS,
  faults: {
    corruptNextPut: () => (transport.corruptNextPut = true),
    failNextPut: () => (transport.failNextPut = true),
  },
  ...over,
});
const fresh = () => new InMemoryArtifactTransport(LIMITS).onlySites(['site-a', 'site-b']);

describe('ArtifactTransport conformance over the SIMULATED in-memory transport', () => {
  const rig = mkRig(fresh());
  const cases = dt.artifactTransportConformanceCases(rig);
  it('runs every case (none skipped: this rig offers the fault injection)', () => {
    expect(cases.map((c) => c.id)).toEqual(
      Array.from({ length: 19 }, (_, i) => `T-${String(i + 1).padStart(2, '0')}`),
    );
    expect(cases.filter((c) => c.skip)).toEqual([]);
  });
  for (const c of cases) it(`${c.id} ${c.title}`, c.run);

  it('the whole run reports a pass, SIMULATED', async () => {
    const r = await dt.runArtifactTransportConformance(mkRig(fresh()));
    expect(r.passed).toBe(true);
    expect(r.origin).toBe('SIMULATED');
    expect(r.results.every((x) => x.status === 'pass')).toBe(true);
  });

  it('a rig without fault injection skips T-18 and T-19 and says why (never a silent pass)', async () => {
    const r = await dt.runArtifactTransportConformance(mkRig(fresh(), { faults: {} }));
    expect(r.results.filter((x) => x.status === 'skipped').map((x) => x.id)).toEqual([
      'T-18',
      'T-19',
    ]);
    expect(r.passed).toBe(true);
  });

  it('the unavailable transport refuses every call with node_unavailable', async () => {
    await dt.unavailableTransportConformance(new UnavailableArtifactTransport(), site('site-a'));
  });
});

describe('the suite can fail: each broken transport is caught', () => {
  class Base extends InMemoryArtifactTransport {
    constructor() {
      super(LIMITS);
      this.onlySites(['site-a', 'site-b']);
    }
  }
  const failing = async (t: InMemoryArtifactTransport) =>
    (await dt.runArtifactTransportConformance(mkRig(t))).results
      .filter((r) => r.status === 'fail')
      .map((r) => r.id);

  it('a put that switches the live release (T-02)', async () => {
    class B extends Base {
      override async putRelease(s: dt.TransportSite, id: string, a: dt.TransportArtifact) {
        const r = await super.putRelease(s, id, a);
        await super.switchCurrent(s, id);
        return r;
      }
    }
    expect(await failing(new B())).toContain('T-02');
  });

  it('a read-back that echoes the sent hash instead of reading the node (T-18)', async () => {
    class B extends Base {
      private sent = new Map<string, string>();
      override async putRelease(s: dt.TransportSite, id: string, a: dt.TransportArtifact) {
        this.sent.set(id, a.hash);
        return super.putRelease(s, id, a);
      }
      override async readReleaseHash(s: dt.TransportSite, id: string) {
        return this.sent.get(id) ?? null;
      }
    }
    expect(await failing(new B())).toContain('T-18');
  });

  it('removing the live release is allowed (T-09)', async () => {
    class B extends Base {
      override async removeRelease(s: dt.TransportSite, id: string) {
        const live = await this.currentRelease(s);
        if (live === id) {
          await super.removeRelease(s, id).catch(() => undefined);
          return;
        }
        return super.removeRelease(s, id);
      }
    }
    expect(await failing(new B())).toContain('T-09');
  });

  it('releases shared across sites (T-16)', async () => {
    class B extends Base {
      override async hasRelease(_s: dt.TransportSite, id: string) {
        return (
          (await super.hasRelease(site('site-a'), id)) ||
          (await super.hasRelease(site('site-b'), id))
        );
      }
    }
    expect(await failing(new B())).toContain('T-16');
  });

  it('a different tree silently overwrites an existing release (T-05)', async () => {
    class B extends Base {
      override async putRelease(s: dt.TransportSite, id: string, a: dt.TransportArtifact) {
        await super.removeRelease(s, id).catch(() => undefined);
        return super.putRelease(s, id, a);
      }
    }
    expect(await failing(new B())).toContain('T-05');
  });

  it('a plain Error instead of a coded one (T-07)', async () => {
    class B extends Base {
      override async switchCurrent(s: dt.TransportSite, id: string) {
        if (!(await this.hasRelease(s, id))) throw new Error('nope');
        return super.switchCurrent(s, id);
      }
    }
    expect(await failing(new B())).toContain('T-07');
  });
});
