import { describe, expect, it } from 'vitest';
import { publicPlan, type PlanRow } from './internal/plans.service';

const row = (over: Partial<PlanRow> = {}): PlanRow => ({
  id: '0190c0de-0000-7000-8000-000000000001',
  key: 'web-start',
  status: 'active',
  appKind: 'none',
  quotas: {
    diskMb: 20480,
    inodes: 400000,
    bandwidthGb: 200,
    dbCount: 5,
    sitesCount: 1,
    maxProcesses: 30,
  },
  runtimes: ['php:8.3', 'static'],
  reservation: { cpu_millicores: 250, memory_mb: 512, disk_mb: 5120 },
  priceMinor: '2900',
  currency: 'SAR',
  placeholder: false,
  nameAr: 'البداية',
  nameEn: 'Start',
  ...over,
});

describe('publicPlan', () => {
  it('shows limits and the price only: no id, inodes, reservation or regions', () => {
    expect(publicPlan(row())).toEqual({
      key: 'web-start',
      name: { ar: 'البداية', en: 'Start' },
      quotas: { diskMb: 20480, bandwidthGb: 200, dbCount: 5, sitesCount: 1 },
      runtimes: ['php:8.3', 'static'],
      price: { amountMinor: '2900', currency: 'SAR' },
    });
  });

  it('never publishes a draft, a retired plan, a placeholder price or a plan with no price', () => {
    expect(publicPlan(row({ status: 'draft' }))).toBeNull();
    expect(publicPlan(row({ status: 'retired' }))).toBeNull();
    expect(publicPlan(row({ placeholder: true }))).toBeNull();
    expect(publicPlan(row({ priceMinor: null }))).toBeNull();
  });
});
