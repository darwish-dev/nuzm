import { describe, expect, it } from 'vitest';
import {
  formatMinorRate,
  hostingGroups,
  serverGroups,
  usageGroups,
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

  it('turns the published data into plan tabs: hosting families, server sizes and usage rates', () => {
    const g = hostingGroups(
      'hosting',
      [plan('web-start', '2900'), plan('webapp-start', '4900'), plan('cloud-startup', '12900')],
      'en',
    );
    expect(g.map((x) => x.id)).toEqual(['web', 'webapp']);
    expect(g[0]!.cards[0]!.runs!.map((r) => r.on)).toEqual([true, false, false, true]);

    const servers = serverGroups(
      [
        {
          vcpu: 2,
          memoryMb: 4096,
          diskGb: 80,
          bandwidth: '3 TB',
          price: { amountMinor: '14220', currency: 'SAR' },
          regions: ['gcc', 'in_kingdom'],
        },
      ],
      'en',
    );
    expect(servers[0]!.cards[0]).toMatchObject({ name: '2 vCPU', sub: '4 GB memory · 80 GB disk' });
    expect(servers[0]!.cards[0]!.price).toMatch(/142\.2/);
    expect(servers[0]!.cards[0]!.features.at(-1)).toContain('Inside the Kingdom');
    expect(serverGroups([], 'en')).toEqual([]);

    const usage = {
      currency: 'SAR',
      items: [
        {
          meterId: 'email.transactional_messages',
          model: 'flat' as const,
          unitPriceMinor: '0.1',
          tiers: null,
          includedAllowance: '1000',
        },
        {
          meterId: 'ai.credits_consumed',
          model: 'flat' as const,
          unitPriceMinor: '1',
          tiers: null,
          includedAllowance: '0',
        },
        {
          meterId: 'network.egress_gb',
          model: 'graduated' as const,
          unitPriceMinor: null,
          tiers: [
            { upTo: '100', unitPriceMinor: '0' },
            { upTo: null, unitPriceMinor: '2' },
          ],
          includedAllowance: '0',
        },
      ],
    };
    expect(usageGroups('email', usage, 'en')[0]!.cards[0]!.price).toMatch(/1\.00/); // SAR 1 per 1,000 messages
    expect(usageGroups('ai-builder', usage, 'ar')[0]!.cards[0]!.name).toMatch(/\p{Script=Arabic}/u);
    expect(usageGroups('data', usage, 'en')[0]!.cards.map((c) => c.key)).toEqual(['egress']);
    expect(usageGroups('automation', usage, 'en')).toEqual([]);
    expect(formatMinorRate('0.1', 'SAR', 'en')).toMatch(/0\.001/);
  });
});
