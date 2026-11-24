import { describe, expect, it } from 'vitest';
import {
  CONTENT_ACCESS_DEFAULT,
  CONTENT_OPERATIONS,
  EXECUTION_METERS,
  costClassesOf,
  decideContentAccess,
  decideExecutionStart,
  parseContentAccess,
  type StartFacts,
} from './index';

describe('O-9 billing_admin content access', () => {
  it('the default equals today: allowed', () => {
    expect(CONTENT_ACCESS_DEFAULT).toBe('allow');
    expect(parseContentAccess(undefined)).toBe('allow');
    expect(parseContentAccess(null)).toBe('allow');
    for (const role of ['owner', 'admin', 'billing_admin', 'developer', 'viewer'])
      expect(decideContentAccess(role, 'allow')).toEqual({ allowed: true });
  });
  it('deny affects billing_admin only', () => {
    expect(decideContentAccess('billing_admin', 'deny')).toEqual({
      allowed: false,
      code: 'billing_admin_content_denied',
    });
    for (const role of ['owner', 'admin', 'developer', 'viewer', 'custom'])
      expect(decideContentAccess(role, 'deny')).toEqual({ allowed: true });
  });
  it('a stored value that is present but not understood reads as deny (never wider than intended)', () => {
    expect(parseContentAccess({ mode: 'deny' })).toBe('deny');
    expect(parseContentAccess({ mode: 'allow' })).toBe('allow');
    expect(parseContentAccess({ mode: 'maybe' })).toBe('deny');
    expect(parseContentAccess('x')).toBe('deny');
    expect(parseContentAccess(['allow'])).toBe('deny');
    expect(parseContentAccess(true)).toBe('deny');
  });
  it('names the five builder-tools reads and the content routes of the S07 audit, each once', () => {
    expect(new Set(CONTENT_OPERATIONS).size).toBe(CONTENT_OPERATIONS.length);
    expect([...CONTENT_OPERATIONS].slice(0, 5)).toEqual([
      'review',
      'symbols',
      'imports',
      'components',
      'memory',
    ]);
    for (const op of [
      'version_diff',
      'file_content',
      'file_search',
      'previews',
      'forms',
      'form_submissions',
      'cms',
      'instructions',
      'test_runs',
      'claude_code',
      'template_workspace',
      'generation_plan',
      'deployment',
      'deployment_logs',
    ])
      expect(CONTENT_OPERATIONS).toContain(op);
  });
});

const facts = (o: Partial<StartFacts> = {}): StartFacts => ({
  separationEnabled: true,
  residencyAllowed: true,
  platformCeilingOk: true,
  aiCreditMinor: 0,
  buildQuota: { allowed: true, measured: true },
  ...o,
});

describe('inference cost vs execution cost', () => {
  it('classifies the purposes', () => {
    expect(costClassesOf('release_build')).toEqual({ inference: false, execution: true });
    expect(costClassesOf('inference_only')).toEqual({ inference: true, execution: false });
  });
  it('legacy (switch off): every start needs AI credit, exactly as today', () => {
    for (const p of ['release_build', 'user_sandbox', 'ai_run_build'] as const) {
      expect(decideExecutionStart(p, facts({ separationEnabled: false }))).toMatchObject({
        allowed: false,
        code: 'budget_required',
        gate: 'ai_wallet',
      });
      expect(
        decideExecutionStart(p, facts({ separationEnabled: false, aiCreditMinor: 5 })),
      ).toMatchObject({ allowed: true });
    }
  });
  it('separated: a release build with an empty AI wallet starts on the build allowance, and is metered', () => {
    const d = decideExecutionStart('release_build', facts());
    expect(d).toMatchObject({ allowed: true });
    if (d.allowed) {
      expect(d.gates).toEqual(['residency', 'platform_ceiling', 'build_allowance']);
      expect(d.mustMeter).toEqual([...EXECUTION_METERS]);
    }
  });
  it('separated: the execution is still hard-gated by the build allowance, residency and the platform ceilings', () => {
    expect(
      decideExecutionStart(
        'release_build',
        facts({ buildQuota: { allowed: false, measured: true } }),
      ),
    ).toMatchObject({ allowed: false, code: 'quota_exceeded', gate: 'build_allowance' });
    expect(decideExecutionStart('ai_run_build', facts({ residencyAllowed: false }))).toMatchObject({
      allowed: false,
      code: 'residency_denied',
    });
    expect(decideExecutionStart('user_sandbox', facts({ platformCeilingOk: false }))).toMatchObject(
      { allowed: false, code: 'sandbox_quota_exceeded' },
    );
  });
  it('separated: an unmeasured allowance is admitted only because the platform ceilings bound it, and it says so', () => {
    const d = decideExecutionStart(
      'release_build',
      facts({ buildQuota: { allowed: true, measured: false } }),
    );
    expect(d).toMatchObject({ allowed: true });
    if (d.allowed) expect(d.gates).toContain('build_allowance_unmeasured');
    expect(
      decideExecutionStart(
        'release_build',
        facts({ buildQuota: { allowed: true, measured: false }, platformCeilingOk: false }),
      ),
    ).toMatchObject({ allowed: false });
  });
  it('inference still needs the AI wallet, whatever the switch says, and meters no execution', () => {
    expect(decideExecutionStart('inference_only', facts())).toMatchObject({
      allowed: false,
      code: 'budget_required',
    });
    const d = decideExecutionStart('inference_only', facts({ aiCreditMinor: 1 }));
    expect(d).toMatchObject({ allowed: true });
    if (d.allowed) expect(d.mustMeter).toEqual([]);
  });
  it('there is no allowed decision without metering for an execution', () => {
    for (const sep of [true, false])
      for (const p of ['release_build', 'user_sandbox', 'ai_run_build'] as const) {
        const d = decideExecutionStart(p, facts({ separationEnabled: sep, aiCreditMinor: 1 }));
        expect(d.allowed && d.mustMeter.length).toBeGreaterThan(0);
      }
  });
});
