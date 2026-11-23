import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  buildNav,
  currentCategory,
  currentItemId,
  stripLocale,
  type NavContext,
} from './nav';

const all = (over: Partial<NavContext> = {}): NavContext => ({
  can: () => true,
  flag: () => true,
  hasOrg: true,
  orgType: 'customer',
  ...over,
});
const ids = (c: ReturnType<typeof buildNav>) => c.map((x) => x.id);

describe('categories', () => {
  it('an owner with every flag sees every rail category (and the profile one for the avatar)', () => {
    expect(ids(buildNav(all()))).toEqual([
      'dashboard',
      'projects',
      'build',
      'automation',
      'marketplace',
      'cloud',
      'hosting',
      'domains',
      'data',
      'email',
      'finance',
      'organization',
      'account',
    ]);
  });

  it('flagged capabilities disappear with their flag, and a category left empty with them', () => {
    const nav = buildNav(all({ flag: () => false }));
    expect(ids(nav)).not.toContain('hosting');
    expect(ids(nav)).not.toContain('domains');
    expect(ids(nav)).not.toContain('cloud'); // Cloud servers is one page behind the provisioning flag: nothing is left without it
  });

  it('cloud servers is one page with no tab bar: no offers, resources or operations tabs', () => {
    const cloud = buildNav(all()).find((c) => c.id === 'cloud')!;
    expect(cloud.noTabs).toBe(true);
    expect(cloud.groups.flatMap((g) => g.items.map((i) => i.id))).toEqual(['instances']);
  });

  it('a member without an organization only gets the dashboard and the profile', () => {
    expect(ids(buildNav(all({ hasOrg: false })))).toEqual(['dashboard', 'account']);
  });

  it('shows only what permissions allow and hides empty categories', () => {
    const can = (p: string) => p === 'data:db:read';
    expect(ids(buildNav(all({ can })))).toEqual(['dashboard', 'data', 'account']);
    const data = buildNav(all({ can })).find((c) => c.id === 'data')!;
    expect(data.groups[0]!.items.map((i) => i.id)).toEqual(['databases']);
    expect(data.home).toBe('/databases');
  });

  it('the organization and the account are account-menu categories, the organization as stacked pages', () => {
    const nav = buildNav(all());
    expect(nav.filter((c) => c.menu).map((c) => c.id)).toEqual(['organization', 'account']);
    const org = nav.find((c) => c.id === 'organization')!;
    expect(org.groups.flatMap((g) => g.items.map((i) => i.href))).toEqual([
      '/settings/team',
      '/settings/organization',
      '/privacy',
      '/settings/security/sso', // M12 (flag enterprise.sso)
      '/settings/partners', // M11: the client side of agency links and reseller relationships
    ]);
    // any one permission of a stacked page's screens lists it
    const only = (p: string) =>
      buildNav(all({ can: (x) => x === p }))
        .find((c) => c.id === 'organization')
        ?.groups.flatMap((g) => g.items.map((i) => i.id));
    expect(only('apikey:read')).toEqual(['team']);
    expect(only('audit:read')).toEqual(['organization']);
    expect(only('privacy:residency:read')).toEqual(['privacy']);
  });

  it('the portals appear only for the matching organization type', () => {
    const items = (t: string) =>
      buildNav(all({ orgType: t }))
        .find((c) => c.id === 'organization')!
        .groups.flatMap((g) => g.items.map((i) => i.id));
    expect(items('agency')).toContain('agency');
    expect(items('agency')).not.toContain('reseller');
    expect(items('customer')).not.toContain('agency');
  });

  it('finance shows each former dropdown as one tab whose page stacks its screens', () => {
    const fin = buildNav(all()).find((c) => c.id === 'finance')!;
    const items = fin.groups[0]!.items;
    expect(items.some((i) => i.children)).toBe(false);
    expect(items.map((i) => [i.id, i.href])).toEqual([
      ['overview', '/billing'],
      ['plansSubs', '/billing/plans'],
      ['usageQuotas', '/billing/usage'],
      ['invoices', '/billing/invoices'],
      ['payments', '/billing/payments'],
    ]);
  });

  it('a group whose pages are all hidden is not shown', () => {
    const can = (p: string) => p === 'usage:read';
    const fin = buildNav(all({ can })).find((c) => c.id === 'finance')!;
    expect(fin.groups[0]!.items.map((i) => i.id)).toEqual(['usageQuotas']);
    expect(fin.home).toBe('/billing/usage');
  });

  it('every item path exists as a customer route name and ids are unique per category', () => {
    for (const c of CATEGORIES) {
      const seen = new Set<string>();
      const walk = (xs: { id: string; href?: string; children?: unknown[] }[]) =>
        xs.forEach((x) => {
          expect(seen.has(x.id)).toBe(false);
          seen.add(x.id);
          if (x.href) expect(x.href.startsWith('/')).toBe(true);
          if (x.children) walk(x.children as never);
        });
      walk(c.groups.flatMap((g) => g.items));
    }
  });
});

describe('current page', () => {
  const nav = buildNav(all());
  const cat = (p: string) => currentCategory(nav, p);

  it('strips the locale', () => {
    expect(stripLocale('/console', 'en')).toBe('/');
    expect(stripLocale('/billing/invoices?x=1', 'ar')).toBe('/billing/invoices');
    expect(stripLocale('', 'en')).toBe('/');
  });

  it('puts every route in the right category', () => {
    const cases: [string, string][] = [
      ['/', 'dashboard'],
      ['/notifications', 'dashboard'],
      ['/projects', 'projects'],
      ['/workspaces', 'projects'],
      ['/builder/projects', 'build'],
      ['/builder/new', 'build'],
      ['/ai/usage', 'build'],
      ['/ai/budgets', 'build'],
      ['/automation/workflows', 'automation'],
      ['/automation/workflows/new', 'automation'],
      ['/automation/executions/e1', 'automation'],
      ['/automation/connectors', 'automation'],
      ['/settings/webhooks', 'automation'],
      ['/marketplace', 'marketplace'],
      ['/marketplace/purchases', 'marketplace'],
      ['/compute/instances/abc/metrics', 'cloud'],
      ['/resources', 'cloud'],
      ['/hosting/sites/1/ssl', 'hosting'],
      ['/domains/checkout', 'domains'],
      ['/domains/1/dns', 'domains'],
      ['/databases/1/backups', 'data'],
      ['/storage/buckets/new', 'data'],
      ['/email/mailboxes', 'email'],
      ['/billing', 'finance'],
      ['/billing/checkout/q1', 'finance'],
      ['/billing/credit-notes/9', 'finance'],
      ['/settings/members', 'organization'],
      ['/privacy/requests/new', 'organization'],
      ['/audit-logs', 'organization'],
      ['/account/sessions', 'account'],
      ['/account', 'account'],
      ['/something-new', 'dashboard'],
    ];
    for (const [p, want] of cases) expect([p, cat(p)]).toEqual([p, want]);
  });

  it('highlights the longest matching item, and the overview only on its own page', () => {
    const fin = nav.find((c) => c.id === 'finance')!;
    expect(currentItemId(fin, '/billing')).toBe('overview');
    expect(currentItemId(fin, '/billing/invoices/5')).toBe('invoices');
    // the detail pages of a stacked screen highlight the tab of the page it now lives on
    expect(currentItemId(fin, '/billing/payment-methods/add')).toBe('payments');
    expect(currentItemId(fin, '/billing/credit-notes/9')).toBe('invoices');
    expect(currentItemId(fin, '/billing/subscriptions/3')).toBe('plansSubs');
    expect(currentItemId(fin, '/billing/checkout/q1')).toBeNull();
    const dom = nav.find((c) => c.id === 'domains')!;
    expect(currentItemId(dom, '/domains')).toBe('list');
    expect(currentItemId(dom, '/domains/search')).toBe('search');
    expect(currentItemId(dom, '/domains/abc')).toBeNull();
  });
});

describe('build category', () => {
  it('is not on the rail (the floating AI builder card opens it) but keeps its pages and tabs logic', () => {
    const c = buildNav(all()).find((x) => x.id === 'build')!;
    expect(c.noRail).toBe(true);
    expect(c.groups.flatMap((g) => g.items.map((i) => i.href))).toContain('/builder/projects');
  });
});

describe('projects category', () => {
  it('has no rail icon (the top-bar organization icon opens it) but keeps its Projects and Workspaces tabs', () => {
    const c = buildNav(all()).find((x) => x.id === 'projects')!;
    expect(c.noRail).toBe(true);
    expect(c.noTabs).toBeUndefined();
    expect(c.groups.flatMap((g) => g.items.map((i) => i.href))).toEqual([
      '/projects',
      '/workspaces',
    ]);
  });
});

describe('build category', () => {
  it('holds the builders, usage and credits, and budgets (the templates, web-app, approvals and mobile entries only with their flags on)', () => {
    const b = buildNav(all()).find((c) => c.id === 'build')!;
    expect(b.groups.flatMap((g) => g.items.map((i) => i.href))).toEqual([
      '/builder/projects',
      '/builder/templates',
      '/builder/apps',
      '/approvals',
      '/mobile/new',
      '/ai/usage',
      '/ai/budgets',
    ]);
    // full-screen start page: no section tab bar (usage and budgets link to each other on their own pages)
    expect(b.noTabs).toBe(true);
  });
  it('the templates entry shows only while knowledge.customer_templates is on for the organization', () => {
    const hrefs = (ctx: NavContext) =>
      buildNav(ctx)
        .find((c) => c.id === 'build')!
        .groups.flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs(all({ flag: (k) => k === 'ai.enabled' }))).not.toContain('/builder/templates');
    expect(
      hrefs(all({ flag: (k) => k === 'ai.enabled' || k === 'knowledge.customer_templates' })),
    ).toContain('/builder/templates');
  });
});

describe('automation category', () => {
  it('is one rail section whose tabs are workflows, connectors and webhooks', () => {
    const a = buildNav(all()).find((c) => c.id === 'automation')!;
    expect(a.groups.flatMap((g) => g.items.map((i) => i.href))).toEqual([
      '/automation/workflows',
      '/automation/connectors',
      '/settings/webhooks',
    ]);
    expect(a.noTabs).toBeUndefined();
    expect(currentItemId(a, '/automation/executions/e1')).toBe('workflows');
    expect(currentItemId(a, '/settings/webhooks')).toBe('webhooks');
  });
});

describe('M11 entries', () => {
  const hrefs = (ctx: NavContext) =>
    buildNav(ctx)
      .filter((c) => ['automation', 'marketplace'].includes(c.id))
      .flatMap((c) => c.groups.flatMap((g) => g.items.map((i) => i.href)));
  it('automation and marketplace entries are hidden while their flags are off', () => {
    const h = hrefs(all({ flag: (k) => k === 'ai.enabled' }));
    expect(h.some((x) => x?.startsWith('/automation') || x === '/marketplace')).toBe(false);
  });
  it('each entry needs its own flag and permission', () => {
    const h = hrefs(all({ flag: (k) => k === 'marketplace.enabled' }));
    expect(h).toContain('/marketplace');
    expect(h).not.toContain('/automation/workflows');
    const none = hrefs(all({ can: (p) => p === 'marketplace:read' }));
    expect(none).toContain('/marketplace');
    expect(none).not.toContain('/settings/webhooks');
  });
});

describe('M10A app builder entries', () => {
  const hrefs = (ctx: NavContext) =>
    buildNav(ctx)
      .find((c) => c.id === 'build')!
      .groups.flatMap((g) => g.items.map((i) => i.href));
  it('the App builder and Approvals entries need the app_builder.enabled flag', () => {
    const off = hrefs(all({ flag: (k) => k === 'ai.enabled' }));
    expect(off).toContain('/builder/projects');
    expect(off).not.toContain('/builder/apps');
    expect(off).not.toContain('/approvals');
    const on = hrefs(all({ flag: (k) => k === 'ai.enabled' || k === 'app_builder.enabled' }));
    expect(on).toContain('/builder/apps');
    expect(on).toContain('/approvals');
  });
  it('they need their permissions too, and the web-app screens belong to the build category', () => {
    const noApprove = hrefs(all({ can: (p) => p === 'builder:read' }));
    expect(noApprove).toContain('/builder/apps');
    expect(noApprove).not.toContain('/approvals');
    const nav = buildNav(all());
    expect(currentCategory(nav, '/builder/apps')).toBe('build');
    expect(currentCategory(nav, '/approvals')).toBe('build');
    const build = nav.find((c) => c.id === 'build')!;
    expect(currentItemId(build, '/builder/apps')).toBe('appbuilder');
    expect(currentItemId(build, '/approvals')).toBe('approvals');
    expect(currentItemId(build, '/builder/projects/abc/spec')).toBe('builder');
  });
});

describe('M10B mobile builder entry', () => {
  const hrefs = (ctx: NavContext) =>
    buildNav(ctx)
      .find((c) => c.id === 'build')
      ?.groups.flatMap((g) => g.items.map((i) => i.href)) ?? [];
  it('shows only while mobile_builder.enabled is on and the member can read the builder', () => {
    expect(hrefs(all({ flag: (k) => k === 'ai.enabled' }))).not.toContain('/mobile/new');
    expect(hrefs(all({ flag: (k) => k === 'mobile_builder.enabled' }))).toContain('/mobile/new');
    expect(hrefs(all({ can: () => false, flag: () => true }))).not.toContain('/mobile/new');
  });
  it('the dashboard card follows the same flag', async () => {
    const { visibleServices } = await import('./services');
    const ids = (flagOn: (f: string) => boolean) =>
      visibleServices(() => true, flagOn).map((s) => s.id);
    expect(ids(() => true)).toContain('mobile');
    expect(ids((f) => f !== 'mobile_builder.enabled')).not.toContain('mobile');
  });
});
