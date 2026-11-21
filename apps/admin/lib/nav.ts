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
export type AdminCategoryId =
  'orgs' | 'finance' | 'compliance' | 'infra' | 'ai' | 'aik' | 'platform' | 'ops';
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
    id: 'ai',
    icon: 'code',
    label: 'aia.nav.ai',
    title: 'aia.nav.ai',
    roots: ['/ai'],
    org: false,
    groups: [
      {
        id: 'main',
        items: [
          {
            id: 'models',
            label: 'aia.title',
            href: '/ai/model-providers',
            ...read('admin:ai:read'),
          },
          { id: 'runs', label: 'aia.tab.runs', href: '/ai/runs', ...read('admin:ai:read') },
          {
            id: 'quality',
            label: 'aia.tab.quality',
            href: '/ai/quality',
            ...read('admin:ai:read'),
          },
          { id: 'skills', label: 'aia.tab.skills', href: '/ai/skills', ...read('admin:ai:read') },
        ],
      },
    ],
  },
  {
    // AI Intelligence Center (ADR-065): the staff-managed library the AI Builder starts from. Items appear here as their slices ship.
    id: 'aik',
    icon: 'sparkle',
    label: 'kn.cat',
    title: 'kn.cat',
    roots: ['/ai-intelligence'],
    org: false,
    groups: [
      {
        id: 'main',
        items: [
          {
            id: 'library',
            label: 'kn.nav.library',
            href: '/ai-intelligence/library',
            ...read('admin:ai_knowledge:read'),
          },
          {
            id: 'search',
            label: 'kr.nav',
            href: '/ai-intelligence/search',
            ...read('admin:ai_knowledge:read'),
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
    roots: ['/audit-logs', '/feature-flags', '/marketplace', '/programs', '/automation'],
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
      // M11: marketplace moderation, agencies and resellers, automation abuse (BLOCKED states where the list routes are not approved yet: SCR-M11-05)
      {
        id: 'm11',
        title: 'm11.nav.admin.group',
        items: [
          {
            id: 'moderation',
            label: 'm11.nav.admin.moderation',
            href: '/marketplace/moderation',
            perm: ['admin:marketplace'],
          },
          {
            id: 'programs',
            label: 'm11.nav.admin.programs',
            href: '/programs',
            perm: ['admin:org:read', 'admin:programs'],
          },
          {
            id: 'automationAbuse',
            label: 'm11.nav.admin.abuse',
            href: '/automation/abuse',
            perm: ['admin:automation', 'admin:ops'],
          },
        ],
      },
    ],
  },
  // M12: operations (health, incidents, alerts, DR) and governance (access reviews, policies, audit retention)
  {
    id: 'ops',
    icon: 'dashboard',
    label: 'm12.nav.admin.ops',
    title: 'm12.nav.admin.ops',
    roots: [
      '/operations',
      '/incidents',
      '/alerts',
      '/provider-incidents',
      '/recovery-exercises',
      '/launch',
      '/support',
      '/access-reviews',
      '/policies',
      '/audit',
    ],
    org: false,
    groups: [
      {
        id: 'ops',
        title: 'm12.nav.admin.ops',
        items: [
          {
            id: 'health',
            label: 'm12.tab.health',
            href: '/operations/health',
            ...read('admin:ops:read'),
          },
          {
            id: 'incidents',
            label: 'm12.tab.incidents',
            href: '/incidents',
            ...read('admin:ops:read'),
          },
          { id: 'alerts', label: 'm12.tab.alerts', href: '/alerts', ...read('admin:ops:read') },
          {
            id: 'providerIncidents',
            label: 'm12.tab.providerIncidents',
            href: '/provider-incidents',
            ...read('admin:ops:read'),
          },
          {
            id: 'exercises',
            label: 'm12.tab.exercises',
            href: '/recovery-exercises',
            ...read('admin:ops:read'),
          },
          { id: 'launch', label: 'm12.tab.launch', href: '/launch', ...read('admin:ops:read') },
          {
            id: 'handbook',
            label: 'm12.tab.handbook',
            href: '/support/handbook',
            ...read('admin:ops:read'),
          },
        ],
      },
      {
        id: 'gov',
        title: 'm12.nav.admin.gov',
        items: [
          {
            id: 'reviews',
            label: 'm12.tab.reviews',
            href: '/access-reviews',
            ...read('admin:security:manage'),
          },
          {
            id: 'policies',
            label: 'm12.tab.policies',
            href: '/policies',
            ...read('admin:compliance:read'),
          },
          {
            id: 'retention',
            label: 'm12.tab.retention',
            href: '/audit/retention',
            ...read('admin:compliance:read'),
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
