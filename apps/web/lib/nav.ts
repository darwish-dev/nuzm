import type { MessageKey } from '@nuzm/i18n';
import {
  buildNavFrom,
  currentCategoryOf,
  currentItemId,
  stripLocale,
  type NavCategory,
  type NavContext,
  type ResolvedCategory as BaseResolved,
  type ResolvedGroup as BaseGroup,
  type ResolvedItem as BaseItem,
} from '@nuzm/ui';

/**
 * The customer console's two-level navigation. Pure data and pure functions: which categories and items a member sees depends only
 * on their permissions, the organization's feature flags and its type, so it is unit-tested without a browser. Only screens that exist
 * are listed (a future concept is never shown as a finished feature). Every route keeps its existing path.
 */
export type CategoryId =
  | 'dashboard'
  | 'projects'
  | 'build'
  | 'automation'
  | 'marketplace'
  | 'cloud'
  | 'hosting'
  | 'domains'
  | 'data'
  | 'email'
  | 'finance'
  | 'organization'
  | 'account';

type Category = NavCategory<MessageKey, CategoryId>;

export const CATEGORIES: Category[] = [
  {
    id: 'dashboard',
    icon: 'dashboard',
    label: 'nc.cat.dashboard',
    title: 'nc.cat.dashboard',
    // the bell in the top bar opens the notifications as a pop-up; /notifications is its "view all" page (no tab of its own)
    roots: ['/notifications'],
    org: false,
    groups: [
      {
        id: 'main',
        items: [{ id: 'overview', label: 'nc.item.overview', href: '/', exact: true }],
      },
    ],
  },
  {
    id: 'projects',
    icon: 'projects',
    label: 'nc.cat.projects',
    title: 'nc.cat.projects',
    roots: ['/workspaces', '/projects'],
    org: true,
    // no rail icon: the organization icon in the top bar opens the workspaces, and these two tabs lead on to the projects
    noRail: true,
    groups: [
      {
        id: 'main',
        items: [
          { id: 'projects', label: 'nav.projects', href: '/projects', perm: ['project:read'] },
          {
            id: 'workspaces',
            label: 'nav.workspaces',
            href: '/workspaces',
            perm: ['workspace:read'],
          },
        ],
      },
    ],
  },
  {
    id: 'build',
    icon: 'code',
    label: 'nc.cat.build',
    title: 'nc.cat.build',
    roots: ['/builder', '/mobile', '/ai'],
    org: true,
    // not on the rail: the builder is opened from the floating "AI builder" card (its pages keep this category, so their section logic is unchanged)
    noRail: true,
    // the start screen is full screen with no tab bar: usage and credits open from the AI credits chip in the top bar (its page links to budgets)
    noTabs: true,
    groups: [
      {
        id: 'builder',
        items: [
          {
            id: 'builder',
            label: 'bld.nav.builder',
            href: '/builder/projects',
            perm: ['builder:read'],
            flag: 'ai.enabled',
          },
          // M10A: the web / full-stack app builder, only while its own flag is on for the organization
          {
            id: 'appbuilder',
            label: 'm10.nav.builder',
            href: '/builder/apps',
            perm: ['builder:read'],
            flag: 'app_builder.enabled',
          },
          {
            id: 'approvals',
            label: 'm10.nav.approvals',
            href: '/approvals',
            perm: ['ai:read'],
            flag: 'app_builder.enabled',
          },
          // M10B: the mobile builder shows only while its own flag is on (default off)
          {
            id: 'mobile',
            label: 'mobile.nav.mobile',
            href: '/mobile/new',
            perm: ['builder:read'],
            flag: 'mobile_builder.enabled',
            also: ['/mobile'],
          },
        ],
      },
      {
        id: 'ai',
        title: 'aiu.nav.ai',
        items: [
          {
            id: 'aiUsage',
            label: 'aiu.tab.usage',
            href: '/ai/usage',
            perm: ['ai:read'],
            flag: 'ai.enabled',
          },
          {
            id: 'aiBudgets',
            label: 'aiu.tab.budgets',
            href: '/ai/budgets',
            perm: ['ai:read'],
            flag: 'ai.enabled',
          },
        ],
      },
    ],
  },
  // M11: Workflows, Connectors and outbound Webhooks are one rail icon with three section tabs. Each tab shows only when its feature flag is on for
  // the organization and the member holds the permission.
  {
    id: 'automation',
    icon: 'workflow',
    label: 'm11.nav.automation',
    title: 'm11.nav.automation',
    roots: ['/automation', '/settings/webhooks'],
    org: true,
    groups: [
      {
        id: 'main',
        items: [
          {
            id: 'workflows',
            label: 'm11.nav.workflows',
            href: '/automation/workflows',
            perm: ['automation:read'],
            flag: 'automation.enabled',
            also: ['/automation/executions'],
          },
          {
            id: 'connectors',
            label: 'm11.nav.connectors',
            href: '/automation/connectors',
            perm: ['connector:manage'],
            flag: 'automation.enabled',
          },
          {
            id: 'webhooks',
            label: 'm11.nav.webhooks',
            href: '/settings/webhooks',
            perm: ['webhook:manage'],
            flag: 'automation.enabled',
          },
        ],
      },
    ],
  },
  {
    id: 'marketplace',
    icon: 'store',
    label: 'm11.nav.marketplace',
    title: 'm11.nav.marketplace',
    roots: ['/marketplace'],
    org: true,
    noTabs: true,
    groups: [
      {
        id: 'main',
        items: [
          {
            id: 'marketplace',
            label: 'm11.nav.marketplace',
            href: '/marketplace',
            perm: ['marketplace:read'],
            flag: 'marketplace.enabled',
          },
        ],
      },
    ],
  },
  {
    id: 'cloud',
    icon: 'cloud',
    label: 'nc.cat.cloud',
    title: 'nc.title.cloud',
    roots: ['/compute', '/resources', '/operations'],
    org: true,
    // Cloud servers is one page: no tab bar (Offers and regions, Resources and Operations are no longer offered here)
    noTabs: true,
    groups: [
      {
        id: 'infrastructure',
        title: 'nc.grp.infrastructure',
        items: [
          {
            id: 'instances',
            label: 'nc.item.instances',
            href: '/compute/instances',
            perm: ['compute:instance:read'],
            flag: 'cloud.provisioning',
          },
        ],
      },
    ],
  },
  {
    id: 'hosting',
    noTabs: true,
    icon: 'hosting',
    label: 'nc.cat.hosting',
    title: 'nc.cat.hosting',
    roots: ['/hosting'],
    org: true,
    groups: [
      {
        id: 'main',
        items: [
          {
            id: 'sites',
            label: 'host.title.sites',
            href: '/hosting/sites',
            perm: ['hosting:site:read'],
            flag: 'hosting.enabled',
          },
          {
            id: 'plans',
            label: 'host.title.plans',
            href: '/hosting/plans',
            perm: ['hosting:plan:read'],
            flag: 'hosting.enabled',
          },
        ],
      },
    ],
  },
  {
    id: 'domains',
    icon: 'domains',
    label: 'nc.cat.domains',
    title: 'nc.cat.domains',
    roots: ['/domains'],
    org: true,
    // no tabs: the domains page has "Get a new domain" and "Transfer a domain" buttons, the others a link back
    noTabs: true,
    groups: [
      {
        id: 'main',
        items: [
          {
            id: 'list',
            label: 'dom.tab.list',
            href: '/domains',
            perm: ['domain:read'],
            flag: 'domains.enabled',
            exact: true,
          },
          {
            id: 'search',
            label: 'dom.tab.search',
            href: '/domains/search',
            perm: ['domain:search'],
            flag: 'domains.enabled',
          },
          {
            id: 'transfers',
            label: 'dom.tab.transfers',
            href: '/domains/transfers',
            perm: ['domain:read'],
            flag: 'domains.enabled',
          },
        ],
      },
    ],
  },
  {
    id: 'data',
    icon: 'data',
    label: 'nc.cat.data',
    title: 'nc.cat.data',
    roots: ['/databases', '/storage'],
    org: true,
    groups: [
      {
        id: 'main',
        items: [
          {
            id: 'databases',
            label: 'm8.nav.databases',
            href: '/databases',
            perm: ['data:db:read'],
          },
          {
            id: 'storage',
            label: 'm8.nav.storage',
            href: '/storage/buckets',
            perm: ['data:storage:read'],
          },
        ],
      },
    ],
  },
  {
    id: 'email',
    icon: 'email',
    label: 'nc.cat.email',
    title: 'nc.cat.email',
    roots: ['/email'],
    org: true,
    groups: [
      {
        id: 'main',
        items: [
          {
            id: 'domains',
            label: 'm8.em.tab.domains',
            href: '/email/domains',
            perm: ['email:read'],
          },
          {
            id: 'mailboxes',
            label: 'm8.em.tab.mailboxes',
            href: '/email/mailboxes',
            perm: ['email:read'],
          },
          {
            id: 'messages',
            label: 'm8.em.tab.messages',
            href: '/email/messages',
            perm: ['email:read'],
          },
          {
            id: 'senders',
            label: 'm8.em.tab.senders',
            href: '/email/senders',
            perm: ['email:read'],
          },
          {
            id: 'templates',
            label: 'm8.em.tab.templates',
            href: '/email/templates',
            perm: ['email:read'],
          },
          {
            id: 'suppressions',
            label: 'm8.em.tab.suppressions',
            href: '/email/suppressions',
            perm: ['email:read'],
          },
        ],
      },
    ],
  },
  {
    id: 'finance',
    icon: 'finance',
    label: 'nc.cat.finance',
    title: 'nc.cat.finance',
    roots: ['/billing'],
    org: true,
    groups: [
      {
        id: 'billing',
        title: 'nc.grp.billing',
        items: [
          {
            id: 'overview',
            label: 'bill.tab.overview',
            href: '/billing',
            perm: ['billing:read'],
            exact: true,
          },
          // each of these is one tab whose page stacks the screens below it (their old routes redirect to its sections)
          {
            id: 'plansSubs',
            label: 'nc.item.plansSubs',
            href: '/billing/plans',
            perm: ['org:read', 'billing:read'],
            also: ['/billing/subscriptions'],
          },
          {
            id: 'usageQuotas',
            label: 'nc.item.usageQuotas',
            href: '/billing/usage',
            perm: ['usage:read'],
            also: ['/billing/quotas'],
          },
          {
            id: 'invoices',
            label: 'bill.tab.invoices',
            href: '/billing/invoices',
            perm: ['billing:read'],
            also: ['/billing/credit-notes'],
          },
          {
            id: 'payments',
            label: 'bill.tab.payments',
            href: '/billing/payments',
            perm: ['billing:read'],
            also: ['/billing/payment-methods', '/billing/wallet'],
          },
        ],
      },
      {
        id: 'control',
        title: 'nc.grp.control',
        items: [
          {
            id: 'limits',
            label: 'bill.tab.limits',
            href: '/billing/spending-limits',
            perm: ['billing:read'],
          },
          {
            id: 'approvals',
            label: 'bill.tab.approvals',
            href: '/billing/approvals',
            perm: ['spend:request'],
          },
          {
            id: 'ledger',
            label: 'bill.tab.ledger',
            href: '/billing/ledger',
            perm: ['billing:read'],
          },
          {
            id: 'taxProfile',
            label: 'bill.tab.taxProfile',
            href: '/billing/tax-profile',
            perm: ['billing:read'],
          },
        ],
      },
    ],
  },
  {
    id: 'organization',
    icon: 'organization',
    label: 'nc.cat.organization',
    title: 'nc.cat.organization',
    roots: ['/settings', '/audit-logs', '/privacy', '/agency', '/reseller', '/orgs'],
    org: true,
    // not on the rail: these are pages of the account menu, each stacking a group's screens as sections (the old routes redirect)
    menu: true,
    groups: [
      {
        id: 'organization',
        items: [
          {
            id: 'team',
            label: 'nc.grp.team',
            href: '/settings/team',
            perm: ['member:read', 'member:invite', 'apikey:read'],
          },
          {
            id: 'organization',
            label: 'nc.grp.organization',
            href: '/settings/organization',
            perm: ['org:update', 'audit:read'],
          },
          {
            id: 'privacy',
            label: 'nc.grp.privacy',
            href: '/privacy',
            perm: [
              'privacy:dsr:self',
              'privacy:consent:self',
              'privacy:export:manage',
              'privacy:residency:read',
            ],
          },
          // M12: enterprise SSO (flag `enterprise.sso`, default off; the API answers 404 while it is off)
          {
            id: 'sso',
            label: 'm12.nav.sso',
            href: '/settings/security/sso',
            perm: ['org:security'],
            flag: 'enterprise.sso',
          },
          {
            id: 'agency',
            label: 'nav.agency',
            href: '/agency',
            orgType: 'agency',
            flag: 'agency.enabled',
          },
          {
            id: 'reseller',
            label: 'nav.reseller',
            href: '/reseller',
            orgType: 'reseller',
            flag: 'reseller.enabled',
          },
          // M11: the client side of agency links and reseller relationships (the page handles each flag itself)
          {
            id: 'partners',
            label: 'm11.nav.partners',
            href: '/settings/partners',
            perm: ['partners:manage'],
          },
        ],
      },
    ],
  },
  {
    id: 'account',
    icon: 'user',
    label: 'nc.cat.account',
    title: 'nc.cat.account',
    roots: ['/account'],
    org: false,
    menu: true,
    groups: [
      {
        id: 'account',
        title: 'nc.grp.account',
        items: [
          // one page: profile, sessions and security are sections on it (the old routes redirect to their anchors)
          { id: 'profile', label: 'nc.item.profile', href: '/account' },
        ],
      },
    ],
  },
];

export type { NavContext };
export type ResolvedCategory = BaseResolved<MessageKey, CategoryId>;
export type ResolvedGroup = BaseGroup<MessageKey>;
export type ResolvedItem = BaseItem<MessageKey>;
export { currentItemId, stripLocale };

/** The categories this member may use, each with the items it shows. A category with nothing to show is left out. */
export const buildNav = (c: NavContext): ResolvedCategory[] => buildNavFrom(CATEGORIES, c);

/** Which category the page belongs to: the item with the longest match wins, then the category roots, else the dashboard. */
export const currentCategory = (cats: ResolvedCategory[], path: string): CategoryId =>
  currentCategoryOf(cats, path, 'dashboard');
