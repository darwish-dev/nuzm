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
    roots: ['/notifications'],
    org: false,
    groups: [
      {
        id: 'main',
        items: [
          { id: 'overview', label: 'nc.item.overview', href: '/', exact: true },
          { id: 'notifications', label: 'nav.notifications', href: '/notifications' },
        ],
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
    id: 'cloud',
    icon: 'cloud',
    label: 'nc.cat.cloud',
    title: 'nc.title.cloud',
    roots: ['/compute', '/resources', '/operations'],
    org: true,
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
          {
            id: 'offers',
            label: 'nc.item.offers',
            href: '/compute/offers',
            perm: ['offers:read'],
            flag: 'cloud.provisioning',
          },
          { id: 'resources', label: 'nav.resources', href: '/resources', perm: ['resource:read'] },
          {
            id: 'operations',
            label: 'nav.operations',
            href: '/operations',
            perm: ['operation:read'],
          },
        ],
      },
    ],
  },
  {
    id: 'hosting',
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
          {
            id: 'plansSubs',
            label: 'nc.item.plansSubs',
            children: [
              { id: 'plans', label: 'bill.tab.plans', href: '/billing/plans', perm: ['org:read'] },
              {
                id: 'subscriptions',
                label: 'bill.tab.subscriptions',
                href: '/billing/subscriptions',
                perm: ['billing:read'],
              },
            ],
          },
          {
            id: 'usageQuotas',
            label: 'nc.item.usageQuotas',
            children: [
              {
                id: 'usage',
                label: 'bill.tab.usage',
                href: '/billing/usage',
                perm: ['usage:read'],
              },
              {
                id: 'quotas',
                label: 'bill.tab.quotas',
                href: '/billing/quotas',
                perm: ['usage:read'],
              },
            ],
          },
          {
            id: 'invoicesGroup',
            label: 'bill.tab.invoices',
            children: [
              {
                id: 'invoices',
                label: 'bill.tab.invoices',
                href: '/billing/invoices',
                perm: ['billing:read'],
              },
              {
                id: 'creditNotes',
                label: 'bill.tab.creditNotes',
                href: '/billing/credit-notes',
                perm: ['billing:read'],
              },
            ],
          },
          {
            id: 'paymentsGroup',
            label: 'bill.tab.payments',
            children: [
              {
                id: 'payments',
                label: 'bill.tab.payments',
                href: '/billing/payments',
                perm: ['billing:read'],
              },
              {
                id: 'methods',
                label: 'bill.tab.methods',
                href: '/billing/payment-methods',
                perm: ['billing:read'],
              },
              {
                id: 'wallet',
                label: 'bill.tab.wallet',
                href: '/billing/wallet',
                perm: ['billing:read'],
              },
            ],
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
    groups: [
      {
        id: 'team',
        title: 'nc.grp.team',
        items: [
          {
            id: 'members',
            label: 'nav.members',
            href: '/settings/members',
            perm: ['member:read'],
          },
          {
            id: 'invitations',
            label: 'nav.invitations',
            href: '/settings/invitations',
            perm: ['member:invite'],
          },
          {
            id: 'apikeys',
            label: 'nav.apiKeys',
            href: '/settings/api-keys',
            perm: ['apikey:read'],
          },
        ],
      },
      {
        id: 'organization',
        title: 'nc.grp.organization',
        items: [
          {
            id: 'settings',
            label: 'nav.orgSettings',
            href: '/settings/organization',
            perm: ['org:update'],
          },
          { id: 'audit', label: 'nav.audit', href: '/audit-logs', perm: ['audit:read'] },
        ],
      },
      {
        id: 'privacy',
        title: 'nc.grp.privacy',
        items: [
          {
            id: 'requests',
            label: 'pv.tab.requests',
            href: '/privacy/requests',
            perm: ['privacy:dsr:self'],
          },
          {
            id: 'consents',
            label: 'pv.tab.consents',
            href: '/privacy/consents',
            perm: ['privacy:consent:self'],
          },
          {
            id: 'exports',
            label: 'pv.tab.exports',
            href: '/privacy/exports',
            perm: ['privacy:export:manage'],
          },
          {
            id: 'residency',
            label: 'pv.tab.residency',
            href: '/settings/data-residency',
            perm: ['privacy:residency:read'],
          },
        ],
      },
      {
        id: 'portals',
        title: 'nc.grp.portals',
        items: [
          { id: 'agency', label: 'nav.agency', href: '/agency', orgType: 'agency' },
          { id: 'reseller', label: 'nav.reseller', href: '/reseller', orgType: 'reseller' },
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
    groups: [
      {
        id: 'account',
        title: 'nc.grp.account',
        items: [
          { id: 'profile', label: 'nc.item.profile', href: '/account', exact: true },
          { id: 'sessions', label: 'nav.sessions', href: '/account/sessions' },
          { id: 'mfa', label: 'nc.item.mfa', href: '/account/security/mfa' },
          { id: 'password', label: 'nav.password', href: '/account/security/password' },
          { id: 'recovery', label: 'nav.recovery', href: '/account/security/recovery-codes' },
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
