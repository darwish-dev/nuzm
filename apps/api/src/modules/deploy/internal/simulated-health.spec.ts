import { describe, expect, it } from 'vitest';
import { SimulatedHealthProbe, type HealthProbeLike } from './simulated-health';

const real = (): HealthProbeLike & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    async check(url: string) {
      calls.push(url);
      return { ok: false, status: null, detail: 'real probe' };
    },
  };
};

describe('SimulatedHealthProbe (local reference only)', () => {
  it('answers 200 for the stand-in publisher .invalid names, labelled SIMULATED, without any request', async () => {
    const inner = real();
    const r = await new SimulatedHealthProbe(inner).check('https://crm.sites.nuzm.invalid/health');
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(r.detail).toContain('SIMULATED');
    expect(inner.calls).toEqual([]);
  });
  it('sends every other URL to the real probe unchanged (its SSRF rules still apply)', async () => {
    const inner = real();
    const p = new SimulatedHealthProbe(inner);
    for (const u of [
      'https://example.sa/health',
      'http://169.254.169.254/latest',
      'https://invalid.example.com/', // a name that merely contains "invalid"
      'https://x.invalid.evil.com/',
      'not a url',
    ])
      expect((await p.check(u)).detail).toBe('real probe');
    expect(inner.calls).toHaveLength(5);
  });
});
