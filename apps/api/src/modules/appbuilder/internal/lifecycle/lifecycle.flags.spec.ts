import { describe, expect, it } from 'vitest';
import { decideRealPath, REAL_PATH_APPROVALS, type RealPathFacts } from './lifecycle.flags';

const approvals = REAL_PATH_APPROVALS.map((a) => ({
  id: a.id,
  ref: 'docs/parallel/OWNER-APPROVAL-PACK.md#x',
  recordedAt: '2026-11-24',
}));
const ok = (): RealPathFacts => ({
  flag: { enabled: true, approvals },
  modelFlagOn: true,
  gatewayPresent: true,
  buildPort: { origin: 'REAL' },
});

describe('the real path refuses with a specific code and never falls back to the simulation', () => {
  it('is admitted only when every piece is present and the port is REAL', () => {
    expect(decideRealPath(ok())).toEqual({
      ok: true,
      gates: ['approvals', 'model_generation', 'gateway', 'real_build_port'],
    });
  });
  it('flag off or a bare `true` without recorded approvals: real_path_approval_missing', () => {
    expect(decideRealPath({ ...ok(), flag: null })).toMatchObject({
      ok: false,
      code: 'real_path_approval_missing',
      detail: ['flag_off'],
    });
    expect(decideRealPath({ ...ok(), flag: true })).toMatchObject({
      ok: false,
      code: 'real_path_approval_missing',
    });
    expect(decideRealPath({ ...ok(), flag: { enabled: false, approvals } })).toMatchObject({
      ok: false,
      code: 'real_path_approval_missing',
    });
  });
  it('names the approvals that are missing, one by one', () => {
    const r = decideRealPath({
      ...ok(),
      flag: { enabled: true, approvals: approvals.filter((a) => a.id !== 'D-21' && a.id !== 'D5') },
    });
    expect(r).toMatchObject({ ok: false, code: 'real_path_approval_missing' });
    expect((r as { detail: string[] }).detail.sort()).toEqual(['D-21', 'D5']);
    // a reference without a date, or an empty reference, is no approval
    const bad = approvals.map((a, i) =>
      i === 0 ? { ...a, ref: '' } : i === 1 ? { ...a, recordedAt: 'not a date' } : a,
    );
    expect(
      (decideRealPath({ ...ok(), flag: { enabled: true, approvals: bad } }) as { detail: string[] })
        .detail,
    ).toHaveLength(2);
  });
  it('each missing component has its own code', () => {
    expect(decideRealPath({ ...ok(), modelFlagOn: false })).toMatchObject({
      code: 'model_generation_off',
    });
    expect(decideRealPath({ ...ok(), gatewayPresent: false })).toMatchObject({
      code: 'model_unavailable',
    });
    expect(decideRealPath({ ...ok(), buildPort: null })).toMatchObject({
      code: 'real_runtime_unavailable',
    });
  });
  it('a MOCK build port (the local reference mode, or the compiler twin) is refused as simulated, never accepted as real', () => {
    expect(decideRealPath({ ...ok(), buildPort: { origin: 'MOCK' } })).toMatchObject({
      ok: false,
      code: 'real_runtime_simulated',
      detail: ['MOCK'],
    });
  });
});
