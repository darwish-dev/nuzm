import { describe, expect, it } from 'vitest';
import { loadAiConfig } from '../../../ai';
import { SimulatedHealthProbe } from '../../../deploy';
import { healthProbeFor } from './health-probe-factory';

const never = async (): Promise<string[]> => {
  throw new Error('resolve must not be needed for a .invalid name');
};

describe('healthProbeFor', () => {
  it('production configuration never yields the simulated probe, even with AI_LOCAL_REFERENCE=true', async () => {
    const cfg = loadAiConfig({
      NODE_ENV: 'production',
      AI_LOCAL_REFERENCE: 'true',
    } as NodeJS.ProcessEnv);
    expect(cfg.localReference).toBe(false);
    const probe = healthProbeFor(cfg, never);
    expect(probe).not.toBeInstanceOf(SimulatedHealthProbe);
    // the real probe refuses a name it cannot resolve: nothing pretends a .invalid site is healthy
    const r = await probe.check('https://site.sites.nuzm.invalid/');
    expect(r.ok).toBe(false);
    expect(r.detail).not.toMatch(/SIMULATED/);
  });
  it('the local reference (non-production) answers SIMULATED only for .invalid and passes everything else to the real probe', async () => {
    const cfg = loadAiConfig({
      NODE_ENV: 'development',
      AI_LOCAL_REFERENCE: 'true',
    } as NodeJS.ProcessEnv);
    expect(cfg.localReference).toBe(true);
    const probe = healthProbeFor(cfg, async () => ['10.0.0.1']);
    expect(probe).toBeInstanceOf(SimulatedHealthProbe);
    const sim = await probe.check('https://x.sites.nuzm.invalid/');
    expect(sim).toMatchObject({ ok: true, status: 200 });
    expect(sim.detail).toMatch(/SIMULATED/);
    // a private address is still refused by the real probe's SSRF rules
    const real = await probe.check('https://internal.example/');
    expect(real.ok).toBe(false);
  });
  it('no flag, no simulation', () => {
    expect(healthProbeFor({ localReference: false }, never)).not.toBeInstanceOf(
      SimulatedHealthProbe,
    );
  });
});
