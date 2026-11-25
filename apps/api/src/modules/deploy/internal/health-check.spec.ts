import { describe, expect, it } from 'vitest';
import { halfStates, recoverToLastGood, waitUntilHealthy, watchDuringSwitch } from './health-check';
import {
  HostingTargetPublisher,
  InMemoryArtifactTransport,
  InMemoryHostingSiteOps,
} from './hosting-target';
import { SIMULATED_STAGING_TARGET } from './targets';
import { syntheticApp } from './rehearsal';
import type { TargetSite } from './ports';

const site: TargetSite = {
  id: 'hc-site',
  name: 'hc',
  status: 'active',
  runtime: 'static',
  dataRegion: 'local',
  domain: null,
};
const policy = { paths: ['/', '/about/'], attempts: 4, delayMs: 10, requiredConsecutive: 2 };
const noSleep = async () => undefined;

describe('waitUntilHealthy', () => {
  it('two consecutive all-200 rounds are healthy', async () => {
    const v = await waitUntilHealthy(async () => 200, policy, noSleep);
    expect(v).toMatchObject({ healthy: true, rounds: 2 });
  });
  it('a site that needs a moment (503 then 200) becomes healthy, and the waits happen', async () => {
    let n = 0;
    const waits: number[] = [];
    const v = await waitUntilHealthy(
      async () => (n++ < 2 ? 503 : 200),
      policy,
      async (ms) => void waits.push(ms),
    );
    expect(v.healthy).toBe(true);
    expect(waits.length).toBeGreaterThan(0);
  });
  it('one 200 between failures is NOT stable', async () => {
    const seq = [200, 200, 503, 503, 200, 200, 503, 503];
    let i = 0;
    const v = await waitUntilHealthy(
      async () => seq[i++ % seq.length]!,
      { ...policy, attempts: 3 },
      noSleep,
    );
    expect(v.healthy).toBe(false);
  });
  it('a throwing probe or a status 0 never counts as a pass and the reason names the pages', async () => {
    const v = await waitUntilHealthy(
      async (p) => {
        if (p === '/about/') throw new Error('tls');
        return 200;
      },
      policy,
      noSleep,
    );
    expect(v.healthy).toBe(false);
    expect(v.reason).toContain('/about/=0');
  });
  it('refuses a policy with no path or no attempt', async () => {
    await expect(
      waitUntilHealthy(async () => 200, { ...policy, paths: [] }, noSleep),
    ).rejects.toThrow();
    await expect(
      waitUntilHealthy(async () => 200, { ...policy, attempts: 0 }, noSleep),
    ).rejects.toThrow();
  });
});

describe('watchDuringSwitch / halfStates', () => {
  it('a clean switch has no bad sample', async () => {
    const w = await watchDuringSwitch(
      async () => 200,
      async () => undefined,
      { parallel: 3, perWorker: 5 },
    );
    expect(w).toMatchObject({ switched: true, clean: true });
    expect(w.samples).toBeGreaterThanOrEqual(15);
  });
  it('a window with a missing root IS caught (a probe that fails while the switch runs)', async () => {
    let switching = false;
    const w = await watchDuringSwitch(
      async () => (switching ? 502 : 200),
      async () => {
        switching = true;
        await new Promise((r) => setTimeout(r, 5));
        switching = false;
      },
      { parallel: 2, perWorker: 30 },
    );
    expect(w.clean).toBe(false);
    expect(halfStates(w.sequence).length).toBeGreaterThan(0);
  });
  it('a switch that throws is reported as not switched, never clean', async () => {
    const w = await watchDuringSwitch(
      async () => 200,
      async () => {
        throw new Error('panel');
      },
      { perWorker: 2 },
    );
    expect(w.switched).toBe(false);
    expect(w.clean).toBe(false);
  });
  it('halfStates: 404 before the first 200 is expected, 404 after a 200 or any 5xx/0 is not', () => {
    expect(halfStates([404, 404, 200, 200])).toEqual([]);
    expect(halfStates([404, 200, 404])).toEqual([404]);
    expect(halfStates([502, 200])).toEqual([502]);
    expect(halfStates([0, 200])).toEqual([0]);
  });
});

describe('recoverToLastGood', () => {
  const setup = async () => {
    const transport = new InMemoryArtifactTransport();
    const pub = new HostingTargetPublisher(
      new InMemoryHostingSiteOps(),
      transport,
      SIMULATED_STAGING_TARGET,
    );
    const a1 = syntheticApp(1);
    await pub.stage(site, a1, 'release-0001');
    await pub.activate(site, 'release-0001');
    return { transport, pub, a1 };
  };
  it('release 1 still serving: nothing to do, the failed staged release is discarded', async () => {
    const { pub, a1, transport } = await setup();
    await pub.stage(site, syntheticApp(2), 'release-0002');
    const r = await recoverToLastGood(pub, site, a1, 'release-0002');
    expect(r).toMatchObject({ action: 'none_needed', failedReleaseDiscarded: true });
    expect(r.servedAfter).toBe(a1.hash);
    expect(await transport.hasRelease(site, 'release-0002')).toBe(false);
  });
  it('the bad release went live: recovery switches back to the retained release without a new upload', async () => {
    const { pub, a1, transport } = await setup();
    const a2 = syntheticApp(2);
    await pub.stage(site, a2, 'release-0002');
    await pub.activate(site, 'release-0002');
    const puts = transport.puts;
    const r = await recoverToLastGood(pub, site, a1, 'release-0002');
    expect(r.action).toBe('switched_back');
    expect(r.servedAfter).toBe(a1.hash);
    expect(transport.puts).toBe(puts);
    expect(r.failedReleaseDiscarded).toBe(true);
  });
  it('the last good release was pruned: recovery uploads it again and verifies by hash', async () => {
    const { pub, a1, transport } = await setup();
    const a2 = syntheticApp(2);
    await pub.stage(site, a2, 'release-0002');
    await pub.activate(site, 'release-0002');
    await transport.removeRelease(site, 'release-0001');
    const r = await recoverToLastGood(pub, site, a1, 'release-0002');
    expect(r.action).toBe('reuploaded');
    expect(r.servedAfter).toBe(a1.hash);
  });
  it('a recovery that cannot work says so and never throws', async () => {
    const { pub } = await setup();
    const other = syntheticApp(7);
    (pub.transport as InMemoryArtifactTransport).failNextPut = true;
    const r = await recoverToLastGood(pub, site, other, null);
    expect(r.action).toBe('failed');
  });
});
