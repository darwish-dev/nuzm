import { describe, expect, it } from 'vitest';
import {
  ADMIN_CATEGORIES,
  buildAdminNav,
  currentAdminCategory,
  currentItemId,
  stripLocale,
} from './nav';

const all = () => true;
const ids = (cats: ReturnType<typeof buildAdminNav>) => cats.map((c) => c.id);

describe('admin navigation', () => {
  it('a staff member with every permission sees every category', () => {
    expect(ids(buildAdminNav(all))).toEqual([
      'orgs',
      'finance',
      'compliance',
      'infra',
      'ai',
      'platform',
      'ops',
    ]);
  });

  it('shows only what the roles allow and drops empty categories', () => {
    const can = (p: string) => p === 'admin:compliance:read';
    const cats = buildAdminNav(can);
    // admin:compliance:read also opens the M12 governance page (policy versions)
    expect(ids(cats)).toEqual(['compliance', 'ops']);
    expect(cats[0]!.home).toBe('/compliance/controls');
    expect(cats[0]!.groups.flatMap((g) => g.items.map((i) => i.id))).toEqual([
      'controls',
      'evidence',
      'validations',
      'breach',
      'ropa',
      'retention',
      'transfer',
    ]);
  });

  it('a finance role sees billing but not the reports without the reports permission', () => {
    const can = (p: string) => p === 'admin:billing:read';
    const fin = buildAdminNav(can).find((c) => c.id === 'finance')!;
    const items = fin.groups.flatMap((g) => g.items.map((i) => i.id));
    expect(items).toContain('ledger');
    expect(items).not.toContain('reports');
  });

  it('nobody with no platform permission gets any category', () => {
    expect(buildAdminNav(() => false)).toEqual([]);
  });

  it('puts every admin route in the right category', () => {
    const cats = buildAdminNav(all);
    const cases: [string, string][] = [
      ['/organizations', 'orgs'],
      ['/users', 'orgs'],
      ['/billing/zatca/submissions', 'finance'],
      ['/billing/reconciliations/9', 'finance'],
      ['/compliance/breach-cases', 'compliance'],
      ['/providers/accounts/3', 'infra'],
      ['/finance/provider-costs', 'infra'],
      ['/cloud/operations', 'infra'],
      ['/hosting/nodes/1', 'infra'],
      ['/data/providers', 'infra'],
      ['/domains/abc', 'infra'],
      ['/ai/runs', 'ai'],
      ['/audit-logs', 'platform'],
      ['/feature-flags', 'platform'],
    ];
    for (const [path, want] of cases)
      expect([path, currentAdminCategory(cats, path)]).toEqual([path, want]);
  });

  it('highlights the longest match, with the registry and the e-invoicing overview only on their own page', () => {
    const cats = buildAdminNav(all);
    const infra = cats.find((c) => c.id === 'infra')!;
    expect(currentItemId(infra, '/providers')).toBe('registry');
    expect(currentItemId(infra, '/providers/routing')).toBe('routing');
    const fin = cats.find((c) => c.id === 'finance')!;
    expect(currentItemId(fin, '/billing/zatca')).toBe('zatca');
    expect(currentItemId(fin, '/billing/zatca/submissions')).toBe('submissions');
  });

  it('strips the locale and every item id is unique per category', () => {
    expect(stripLocale('/ar/users', 'ar')).toBe('/users');
    for (const c of ADMIN_CATEGORIES) {
      const seen = new Set<string>();
      for (const g of c.groups)
        for (const i of g.items) {
          expect(seen.has(i.id)).toBe(false);
          seen.add(i.id);
        }
    }
  });
});
