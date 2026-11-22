import { describe, expect, it } from 'vitest';
import {
  formatPlanPrice,
  groupOf,
  planFeatures,
  plansForService,
  runtimeKinds,
  type PublicPlan,
} from './public-service-plans';

const plan = (key: string, amountMinor: string, over: Partial<PublicPlan> = {}): PublicPlan => ({
  key,
  name: { ar: key, en: key },
  quotas: { diskMb: 20480, bandwidthGb: 200, dbCount: 5, sitesCount: 1 },
  runtimes: ['php:8.3', 'php:8.2', 'static'],
  price: { amountMinor, currency: 'SAR' },
  ...over,
});

describe('public service plans', () => {
  it('puts each plan family on its own page, cheapest first, and gives other pages none', () => {
    const all = [
      plan('web-premium', '9900'),
      plan('web-start', '2900'),
      plan('cloud-startup', '12900'),
      plan('agency-10', '29900'),
      plan('mystery', '100'),
    ];
    expect(plansForService('hosting', all).map((g) => g.group)).toEqual(['web', 'agency']);
    expect(plansForService('hosting', all)[0]!.plans.map((p) => p.key)).toEqual([
      'web-start',
      'web-premium',
    ]);
    expect(plansForService('cloud', all).flatMap((g) => g.plans.map((p) => p.key))).toEqual([
      'cloud-startup',
    ]);
    for (const slug of ['vps', 'domains', 'email', 'data', 'automation', 'ai-builder'])
      expect(plansForService(slug, all)).toEqual([]);
    expect(groupOf('mystery')).toBeNull();
    expect(groupOf('webapp-pro')).toBe('webapp');
  });

  it('formats integer minor units for the page language and shows the limits in words', () => {
    expect(formatPlanPrice('2900', 'SAR', 'en')).toMatch(/29/);
    expect(formatPlanPrice('2950', 'SAR', 'en')).toMatch(/29\.5/);
    expect(formatPlanPrice('9900', 'SAR', 'ar')).toMatch(/[٠-٩]/);
    expect(planFeatures(plan('web-start', '2900'), 'en')).toEqual([
      '1 website',
      '20 GB storage',
      '200 GB bandwidth a month',
      '5 databases',
    ]);
    expect(
      planFeatures(plan('web-start', '2900'), 'ar').every((f) => /\p{Script=Arabic}/u.test(f)),
    ).toBe(true);
    expect(runtimeKinds(['php:8.3', 'php:8.2', 'nodejs:20', 'static'])).toEqual([
      'PHP',
      'Node.js',
      'Static',
    ]);
  });
});
