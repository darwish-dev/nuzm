import { describe, expect, it } from 'vitest';
import { planFromText } from '../planning';
import { envVarNames, prepareDeployment, type Evidence } from './deployment';

const good: Evidence = {
  reviewErrors: 0,
  reviewWarnings: 1,
  buildPassed: true,
  testsPassed: true,
  origin: 'REAL',
};
const files = new Map([
  [
    'src/a.ts',
    'const k = process.env.STRIPE_KEY; const p = process.env.PORT; const e = import.meta.env.VITE_API_URL;',
  ],
  ['README.md', 'process.env.IGNORED_IN_DOCS'],
  ['src/b.ts', 'process.env.stripe_key; process.env.A'],
]);

describe('deployment preparation', () => {
  it('reads environment variable NAMES from code only, leaves out the platform ones, sorts and dedupes', () => {
    expect(envVarNames(files)).toEqual(['STRIPE_KEY', 'VITE_API_URL']);
  });
  it('is ready only with passing review, build, tests and REAL evidence', () => {
    const plan = planFromText('An online store with a cart and checkout');
    expect(prepareDeployment(files, plan, good)).toMatchObject({
      readiness: 'ready',
      blockers: [],
      target: 'node-web',
    });
    const sim = prepareDeployment(files, plan, { ...good, origin: 'MOCK' });
    expect(sim.readiness).toBe('needs_attention');
    expect(sim.blockers).toEqual(['simulated_evidence']);
    const bad = prepareDeployment(files, plan, {
      ...good,
      reviewErrors: 2,
      buildPassed: false,
      testsPassed: false,
    });
    expect(bad.blockers).toEqual(['review_errors', 'build_not_passed', 'tests_not_passed']);
  });
  it('picks a target by product type and never carries a value', () => {
    expect(
      prepareDeployment(new Map(), planFromText('A simple landing page for my cafe'), good).target,
    ).toBe('static-site');
    expect(
      prepareDeployment(new Map(), planFromText('A REST API for inventory with endpoints'), good)
        .target,
    ).toBe('node-api');
    expect(JSON.stringify(prepareDeployment(files, planFromText('webapp'), good))).not.toContain(
      'sk_',
    );
  });
});
