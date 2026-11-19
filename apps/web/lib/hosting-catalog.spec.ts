import { describe, expect, it } from 'vitest';
import {
  compareValue,
  methodInfo,
  runtimesFor,
  typeOfPlan,
  typesWithPlans,
  type CatalogPlan,
} from './hosting-catalog';

const plan = (
  key: string,
  diskMb: number,
  over: Partial<CatalogPlan['quotas']> = {},
  runtimes = ['php:8.3', 'static'],
): CatalogPlan => ({
  id: key,
  key,
  name: { ar: key, en: key },
  quotas: { diskMb, inodes: 2_000_000, bandwidthGb: 100, dbCount: 5, sitesCount: 10, ...over },
  runtimes,
  price: null,
});

describe('hosting types', () => {
  it('reads the type from the plan key, and an unprefixed key is plain web hosting', () => {
    expect(typeOfPlan('cloud-pro')).toBe('cloud');
    expect(typeOfPlan('webapp-start')).toBe('webapp');
    expect(typeOfPlan('agency-50')).toBe('agency');
    expect(typeOfPlan('demo-starter')).toBe('web');
    expect(typeOfPlan('')).toBe('web');
  });
  it('groups plans by type in a fixed order, smallest plan first, and leaves out types with no plan', () => {
    const g = typesWithPlans([
      plan('cloud-pro', 200_000),
      plan('web-business', 50_000),
      plan('web-start', 10_000),
      plan('cloud-start', 100_000),
    ]);
    expect(g.map((x) => x.type)).toEqual(['web', 'cloud']);
    expect(g[0]!.plans.map((p) => p.key)).toEqual(['web-start', 'web-business']);
    expect(g[1]!.plans.map((p) => p.key)).toEqual(['cloud-start', 'cloud-pro']);
  });
});

describe('plan comparison values', () => {
  it('reads limits from the plan quotas and runtimes from its runtime list', () => {
    const p = plan('web-start', 10_240, { maxProcesses: 40 });
    expect(compareValue(p, 'storage')).toEqual({ kind: 'text', value: '10 GB' });
    expect(compareValue(p, 'files')).toEqual({ kind: 'text', value: '2M' });
    expect(compareValue(p, 'processes')).toEqual({ kind: 'text', value: '40' });
    expect(compareValue(p, 'php')).toEqual({ kind: 'yes' });
    expect(compareValue(p, 'nodejs')).toEqual({ kind: 'no' });
  });
  it('a limit the plan does not state is unknown, not a guess', () => {
    expect(compareValue(plan('web-start', 1024), 'processes')).toEqual({ kind: 'unknown' });
  });
});

describe('ways to add a website', () => {
  it('a method uses the plan runtimes of its family; WordPress is not available yet; AI has no runtime', () => {
    const p = plan('web-start', 1024, {}, ['php:8.3', 'php:8.2', 'nodejs:20', 'static']);
    expect(runtimesFor(methodInfo('php'), p)).toEqual(['php:8.3', 'php:8.2']);
    expect(runtimesFor(methodInfo('nodejs'), p)).toEqual(['nodejs:20']);
    expect(runtimesFor(methodInfo('static'), p)).toEqual(['static']);
    expect(runtimesFor(methodInfo('ai'), p)).toEqual([]);
    expect(methodInfo('wordpress').available).toBe(false);
    expect(runtimesFor(methodInfo('nodejs'), plan('web-start', 1024))).toEqual([]);
  });
});
