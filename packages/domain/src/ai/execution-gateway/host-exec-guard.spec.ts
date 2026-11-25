import { afterEach, describe, expect, it } from 'vitest';
import {
  assertHostExecAllowed,
  assertHostProcessAllowed,
  HostExecRefused,
  setHostExecAuditor,
  templateOrigin,
  TemplateOriginProof,
  type HostExecDecision,
} from './host-exec-guard';

const ENV = { NODE_ENV: 'test', NUZM_LOCAL_DEV_EXEC: '1' };
afterEach(() => setHostExecAuditor(() => undefined));

describe('host execution guard (default deny)', () => {
  it('allows only: not production, explicit opt-in, and a server-minted template proof', () => {
    expect(() =>
      assertHostExecAllowed('local-dev-sandbox', templateOrigin('webapp-preview'), ENV),
    ).not.toThrow();
  });
  it.each([
    ['production', { ...ENV, NODE_ENV: 'production' }, templateOrigin('x1'), ['production']],
    ['no opt-in', { NODE_ENV: 'test' }, templateOrigin('x1'), ['opt_in_missing']],
    [
      'opt-in not exactly 1',
      { ...ENV, NUZM_LOCAL_DEV_EXEC: 'true' },
      templateOrigin('x1'),
      ['opt_in_missing'],
    ],
    ['no origin', ENV, undefined, ['origin_not_template']],
    ['origin "model"', ENV, 'model', ['origin_not_template']],
    ['origin "customer"', ENV, 'customer', ['origin_not_template']],
    ['the string "template"', ENV, 'template', ['origin_not_template']],
    [
      'a JSON-shaped template origin (what a request body could carry)',
      ENV,
      JSON.parse('{"kind":"template","templateId":"webapp-preview"}'),
      ['origin_not_template'],
    ],
    [
      "a forged object with the proof's shape",
      ENV,
      { templateId: 'webapp-preview' },
      ['origin_not_template'],
    ],
    [
      'everything wrong',
      { NODE_ENV: 'production' },
      'model',
      ['production', 'opt_in_missing', 'origin_not_template'],
    ],
  ])('refuses %s', (_n, env, origin, reasons) => {
    try {
      assertHostExecAllowed('live-preview', origin, env);
      throw new Error('was allowed');
    } catch (e) {
      expect(e).toBeInstanceOf(HostExecRefused);
      expect((e as HostExecRefused).reasons).toEqual(reasons);
    }
  });
  it('a proof cannot be constructed directly or from text, and ids are validated', () => {
    // @ts-expect-error the constructor is private
    expect(() => new TemplateOriginProof('x')).not.toThrow(); // (TypeScript forbids it; a plain `new` at runtime still yields a real instance, which only server code can reach)
    expect(() => templateOrigin('../etc')).toThrow('template_id_invalid');
    expect(() => templateOrigin('')).toThrow();
  });
  it('every decision is audited, refusals too; a throwing auditor does not change the outcome', () => {
    const seen: HostExecDecision[] = [];
    setHostExecAuditor((d) => seen.push(d));
    assertHostExecAllowed('mobile-local-build', templateOrigin('flutter-core'), ENV);
    expect(() => assertHostExecAllowed('mobile-local-build', 'model', ENV)).toThrow(
      HostExecRefused,
    );
    expect(seen).toEqual([
      { path: 'mobile-local-build', allowed: true, reasons: [], templateId: 'flutter-core' },
      { path: 'mobile-local-build', allowed: false, reasons: ['origin_not_template'] },
    ]);
    setHostExecAuditor(() => {
      throw new Error('sink down');
    });
    expect(() => assertHostExecAllowed('live-preview', 'customer', ENV)).toThrow(HostExecRefused);
    expect(() =>
      assertHostExecAllowed('live-preview', templateOrigin('webapp-preview'), ENV),
    ).not.toThrow();
  });
});

describe('host process guard (git plumbing: no origin rule)', () => {
  it('needs only not-production and the explicit opt-in, and is audited', () => {
    const seen: HostExecDecision[] = [];
    setHostExecAuditor((d) => seen.push(d));
    expect(() => assertHostProcessAllowed('git-store', ENV)).not.toThrow();
    expect(() =>
      assertHostProcessAllowed('git-store', { NODE_ENV: 'production', NUZM_LOCAL_DEV_EXEC: '1' }),
    ).toThrow(HostExecRefused);
    expect(() => assertHostProcessAllowed('git-store', { NODE_ENV: 'test' })).toThrow(
      HostExecRefused,
    );
    expect(seen.map((d) => d.reasons)).toEqual([[], ['production'], ['opt_in_missing']]);
  });
});
