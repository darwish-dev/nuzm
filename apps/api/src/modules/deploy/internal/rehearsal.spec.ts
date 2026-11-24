import { describe, expect, it } from 'vitest';
import { runStagingRehearsal, syntheticApp } from './rehearsal';
import { UnavailableArtifactTransport, InMemoryArtifactTransport } from './hosting-target';
import type { StagingTarget } from './targets';

const real = (over: Partial<StagingTarget> = {}): StagingTarget => ({
  id: 'hosting:staging-1',
  kind: 'static_hosting',
  provider: 'hosting_panel',
  verification: 'NOT VERIFIED',
  region: 'sa-riyadh',
  previewDomain: 'nuzm-staging.example',
  approvalRef: 'HG-05:owner-2026-12-01',
  evidenceRef: null,
  ...over,
});

describe('staging rehearsal of a synthetic app', () => {
  it('simulated: every step passes and every label says SIMULATED, never verified', async () => {
    const r = await runStagingRehearsal();
    expect(r.status).toBe('PASS');
    expect(r.steps.map((s) => s.id)).toEqual([
      'gate',
      'preview',
      'ssl',
      'env',
      'release1',
      'recovery',
      'cancel',
      'rollback',
      'isolation',
    ]);
    expect(r.steps.every((s) => s.status === 'PASS' && s.label === 'SIMULATED')).toBe(true);
    expect(r.conclusion).toMatch(/SIMULATED.*NOT VERIFIED.*HG-05 and HG-06 are open/);
    expect(JSON.stringify(r)).not.toMatch(/LIVE-VERIFIED/);
  });

  it('is deterministic: the same synthetic app hashes the same, another release differs', () => {
    expect(syntheticApp(1).hash).toBe(syntheticApp(1).hash);
    expect(syntheticApp(1).hash).not.toBe(syntheticApp(2).hash);
  });

  it('real mode without the owner approval is BLOCKED, deploys nothing and never reports a pass', async () => {
    const transport = new InMemoryArtifactTransport();
    const r = await runStagingRehearsal({
      mode: 'real',
      target: real({ approvalRef: null }),
      transport,
    });
    expect(r.status).toBe('BLOCKED');
    expect(r.steps).toHaveLength(1);
    expect(r.conclusion).toMatch(/BLOCKED.*HG-05.*Nothing was deployed/);
    expect(transport.puts).toBe(0);
  });

  it('real mode with approval but no upload path is BLOCKED with that exact reason (no silent fallback to simulated)', async () => {
    const r = await runStagingRehearsal({
      mode: 'real',
      target: real(),
      transport: new UnavailableArtifactTransport(),
    });
    expect(r.status).toBe('BLOCKED');
    expect(r.conclusion).toMatch(/no artifact upload path/);
    const none = await runStagingRehearsal({ mode: 'real', target: real() });
    expect(none.status).toBe('BLOCKED');
  });

  it('real mode needs a preview domain separate from the console and API (ADR-060)', async () => {
    const r1 = await runStagingRehearsal({
      mode: 'real',
      target: real({ previewDomain: null }),
      transport: new InMemoryArtifactTransport(),
    });
    expect(r1.status).toBe('BLOCKED');
    const r2 = await runStagingRehearsal({
      mode: 'real',
      target: real({ previewDomain: 'preview.nuzm.sa' }),
      transport: new InMemoryArtifactTransport(),
      protectedDomains: ['console.nuzm.sa'],
    });
    expect(r2.status).toBe('FAIL');
    expect(r2.steps.find((s) => s.id === 'preview')?.detail).toMatch(/ADR-060/);
  });

  it('a transport that corrupts what it stores fails at release 1 and the result is not a pass', async () => {
    const t = new InMemoryArtifactTransport();
    t.corruptNextPut = true;
    // a target with an in-memory transport under real mode is only possible in a test; the integrity read-back must catch it
    const r = await runStagingRehearsal({
      mode: 'real',
      target: real({ verification: 'NOT VERIFIED' }),
      transport: t,
    });
    expect(r.status).toBe('FAIL');
    expect(r.steps.at(-1)?.id).toBe('release1');
  });

  it('a simulated rehearsal refuses to run on a real target', async () => {
    const r = await runStagingRehearsal({ mode: 'simulated', target: real() });
    expect(r.status).toBe('BLOCKED');
  });
});
