import type { MessageKey } from '@nuzm/i18n';
import {
  buildNavFrom,
  currentCategoryOf,
  currentItemId,
  stripLocale,
  type NavCategory,
  type NavContext,
  type ResolvedCategory as BaseResolved,
} from '@nuzm/ui';

/**
 * The admin console's two-level navigation (same model as the customer console). Items are the existing admin screens and their
 * platform permissions; a staff member only sees what their roles allow. Routes are unchanged.
 */
export type AdminCategoryId = 'orgs' | 'finance' | 'compliance' | 'infra' | 'platform';
type Category = NavCategory<MessageKey, AdminCategoryId>;

const read = (perm: string) => ({ perm: [perm] });

export const ADMIN_CATEGORIES: Category[] = [
  {
    id: 'orgs',
    icon: 'organization',
    label: 'anc.cat.orgs',
    title: 'anc.cat.orgs',
    roots: ['/organizations', '/users'],
    org: false,
    groups: [
      {
        id: 'main',
        items: [
          {
            id: 'orgs',
            label: 'nav.admin.orgs',
            href: '/organizations',
            ...read('admin:org:read'),
          },
          { id: 'users', label: 'nav.admin.users', href: '/users', ...read('admin:user:read') },
        ],
      },
    ],
  },
  {
    id: 'finance',
    icon: 'finance',
    label: 'anc.cat.finance',
    title: 'nav.admin.billing',
    roots: ['/billing'],
    org: false,
    groups: [
      {
        id: 'billing',
        title: 'anc.grp.billing',
        items: [
          {
            id: 'ledger',
            label: 'abill.tab.ledger',
            href: '/billing/ledger',
            ...read('admin:billing:read'),
          },
          {
            id: 'invoices',
            label: 'abill.tab.invoices',
            href: '/billing/invoices',
            ...read('admin:billing:read'),
          },
          {
            id: 'payments',
            label: 'abill.tab.payments',
            href: '/billing/payments',
            ...read('admin:billing:read'),
          },
          {
            id: 'refunds',
            label: 'abill.tab.refunds',
            href: '/billing/refunds',
            ...read('admin:billing:read'),
          },
          {
            id: 'adjustments',
            label: 'abill.tab.adjustments',
            href: '/billing/adjustments',
            ...read('admin:billing:read'),
          },
          {
            id: 'dunning',
            label: 'abill.tab.dunning',
            href: '/billing/dunning',
            ...read('admin:billing:read'),
          },
        ],
      },
      {
        id: 'catalogue',
        title: 'anc.grp.catalogue',
        items: [
          {
            id: 'books',
            label: 'abill.tab.books',
            href: '/billing/price-books',
            ...read('admin:billing:read'),
          },
          {
            id: 'plans',
            label: 'abill.tab.plans',
            href: '/billing/plans',
            ...read('admin:billing:read'),
          },
          {
            id: 'meters',
            label: 'abill.tab.meters',
            href: '/billing/meters',
            ...read('admin:billing:read'),
          },
        ],
      },
      {
        id: 'control',
        title: 'anc.grp.control',
        items: [
          {
            id: 'recon',
            label: 'abill.tab.reconciliations',
            href: '/billing/reconciliations',
            ...read('admin:billing:read'),
          },
          {
            id: 'zatca',
            label: 'abill.tab.zatca',
            href: '/billing/zatca',
            exact: true,
            ...read('admin:billing:read'),
          },
          {
            id: 'submissions',
            label: 'abill.tab.submissions',
            href: '/billing/zatca/submissions',
            ...read('admin:billing:read'),
          },
          {
            id: 'reports',
            label: 'abill.tab.reports',
            href: '/billing/revenue-reports',
            ...read('admin:reports:read'),
          },
        ],
      },
    ],
  },
  {
    id: 'compliance',
    icon: 'shield',
    label: 'anc.cat.compliance',
    title: 'nav.admin.compliance',
    roots: ['/compliance'],
    org: false,
    groups: [
      {
        id: 'main',
        items: [
          {
            id: 'controls',
            label: 'cmp.tab.controls',
            href: '/compliance/controls',
            ...read('admin:compliance:read'),
          },
          {
            id: 'evidence',
            label: 'cmp.tab.evidence',
            href: '/compliance/evidence',
            ...read('admin:compliance:read'),
          },
          {
            id: 'validations',
            label: 'cmp.tab.validations',
            href: '/compliance/validations',
            ...read('admin:compliance:read'),
          },
          {
            id: 'breach',
            label: 'cmp.tab.breach',
            href: '/compliance/breach-cases',
            ...read('admin:compliance:read'),
          },
        ],
      },
      {
        id: 'records',
        title: 'anc.grp.records',
        items: [
          {
            id: 'ropa',
            label: 'cmp.tab.ropa',
            href: '/compliance/ropa',
            ...read('admin:compliance:read'),
          },
          {
            id: 'retention',
            label: 'cmp.tab.retention',
            href: '/compliance/retention',
            ...read('admin:compliance:read'),
          },
          {
            id: 'transfer',
            label: 'cmp.tab.transfer',
            href: '/compliance/transfer-assessments',
            ...read('admin:compliance:read'),
          },
        ],
      },
    ],
  },
  {
    id: 'infra',
    icon: 'cloud',
    label: 'anc.cat.infra',
    title: 'anc.cat.infra',
    roots: ['/providers', '/cloud', '/finance', '/hosting', '/data', '/domains'],
    org: false,
    groups: [
      {
        id: 'providers',
        title: 'anc.grp.providers',
        items: [
          {
            id: 'registry',
            label: 'm05.adm.tab.registry',
            href: '/providers',
            exact: true,
            ...read('admin:provider:read'),
          },
          {
            id: 'accounts',
            label: 'm05.adm.tab.accounts',
            href: '/providers/accounts',
            ...read('admin:provider:read'),
          },
          {
            id: 'routing',
            label: 'm05.adm.tab.routing',
            href: '/providers/routing',
            ...read('admin:provider:read'),
          },
          {
            id: 'live',
            label: 'm05.adm.tab.liveVerification',
            href: '/providers/live-verification',
            ...read('admin:provider:read'),
          },
          {
            id: 'resources',
            label: 'm05.adm.tab.resources',
            href: '/cloud/resources',
            ...read('admin:provider:read'),
          },
          {
            id: 'operations',
            label: 'm05.adm.tab.operations',
            href: '/cloud/operations',
            ...read('admin:provider:read'),
          },
          {
            id: 'costs',
            label: 'm05.adm.tab.costs',
            href: '/finance/provider-costs',
            ...read('admin:provider:read'),
          },
        ],
      },
      {
        id: 'hosting',
        title: 'nav.admin.hosting',
        items: [
          {
            id: 'nodes',
            label: 'host.admin.nodes',
            href: '/hosting/nodes',
            ...read('admin:hosting:read'),
          },
          {
            id: 'sites',
            label: 'host.admin.sites',
            href: '/hosting/sites',
            ...read('admin:hosting:read'),
          },
          {
            id: 'abuse',
            label: 'host.admin.abuse',
            href: '/hosting/abuse',
            ...read('admin:hosting:read'),
          },
          {
            id: 'agents',
            label: 'host.admin.agents',
            href: '/hosting/agents',
            ...read('admin:hosting:read'),
          },
        ],
      },
      {
        id: 'data',
        title: 'anc.grp.data',
        items: [
          {
            id: 'dataProviders',
            label: 'm8.nav.admin.providers',
            href: '/data/providers',
            ...read('admin:data:read'),
          },
        ],
      },
      {
        id: 'domains',
        title: 'nav.admin.domains',
        items: [
          {
            id: 'registrars',
            label: 'dom.admin.reg.title',
            href: '/domains/registrars',
            ...read('admin:domains:read'),
          },
          {
            id: 'orders',
            label: 'dom.admin.orders.title',
            href: '/domains/orders',
            ...read('admin:domains:read'),
          },
          {
            id: 'domrecon',
            label: 'dom.admin.recon.title',
            href: '/domains/reconciliation',
            ...read('admin:domains:read'),
          },
        ],
      },
    ],
  },
  {
    id: 'platform',
    icon: 'dashboard',
    label: 'anc.cat.platform',
    title: 'anc.cat.platform',
    roots: ['/audit-logs', '/feature-flags'],
    org: false,
    groups: [
      {
        id: 'main',
        items: [
          {
            id: 'audit',
            label: 'nav.admin.audit',
            href: '/audit-logs',
            ...read('admin:audit:read'),
          },
          {
            id: 'flags',
            label: 'nav.admin.flags',
            href: '/feature-flags',
            ...read('admin:flags:manage'),
          },
        ],
      },
    ],
  },
];

export type ResolvedAdminCategory = BaseResolved<MessageKey, AdminCategoryId>;
export type { NavContext };
export { currentItemId, stripLocale };

/** The categories this staff member's roles allow, each with its items. */
export const buildAdminNav = (can: (p: string) => boolean): ResolvedAdminCategory[] =>
  buildNavFrom(ADMIN_CATEGORIES, { can, flag: () => true, hasOrg: true });

export const currentAdminCategory = (
  cats: ResolvedAdminCategory[],
  path: string,
): AdminCategoryId => currentCategoryOf(cats, path, cats[0]?.id ?? 'orgs');
