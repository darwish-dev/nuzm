import type { MessageKey } from '@nuzm/i18n';
import type { IconName } from '@nuzm/ui';

/** The customer's service catalogue: one card on the dashboard per area, shown only when the member may open it. */
export interface Service {
  id: string;
  icon: IconName;
  href: string;
  /** Permission needed (any one of these). */
  perm: string[];
  label: MessageKey;
  desc: MessageKey;
  /** Shown only while this feature flag is on for the organization. */
  flag?: string;
}

export const SERVICES: Service[] = [
  {
    id: 'workspaces',
    icon: 'projects',
    href: '/workspaces',
    perm: ['workspace:read'],
    label: 'nav.workspaces',
    desc: 'home.svc.workspaces',
  },
  {
    id: 'projects',
    icon: 'projects',
    href: '/projects',
    perm: ['project:read'],
    label: 'nav.projects',
    desc: 'home.svc.projects',
  },
  {
    id: 'resources',
    icon: 'cloud',
    href: '/resources',
    perm: ['resource:read'],
    label: 'nav.resources',
    desc: 'home.svc.resources',
  },
  {
    id: 'hosting',
    icon: 'hosting',
    href: '/hosting/sites',
    perm: ['hosting:site:read'],
    label: 'nav.hosting',
    desc: 'home.svc.hosting',
    flag: 'hosting.enabled',
  },
  {
    id: 'domains',
    icon: 'domains',
    href: '/domains',
    perm: ['domain:read'],
    label: 'nav.domains',
    desc: 'home.svc.domains',
    flag: 'domains.enabled',
  },
  {
    id: 'builder',
    icon: 'panel',
    href: '/builder/projects',
    perm: ['builder:read'],
    label: 'bld.nav.builder',
    desc: 'bld.home.desc',
    flag: 'ai.enabled',
  },
  {
    id: 'databases',
    icon: 'data',
    href: '/databases',
    perm: ['data:db:read'],
    label: 'm8.nav.databases',
    desc: 'home.svc.databases',
  },
  {
    id: 'storage',
    icon: 'data',
    href: '/storage/buckets',
    perm: ['data:storage:read'],
    label: 'm8.nav.storage',
    desc: 'home.svc.storage',
  },
  {
    id: 'email',
    icon: 'email',
    href: '/email/domains',
    perm: ['email:read'],
    label: 'm8.nav.email',
    desc: 'home.svc.email',
  },
  {
    id: 'compute',
    icon: 'cloud',
    href: '/compute/instances',
    perm: ['compute:instance:read'],
    label: 'm05.web.nav.instances',
    desc: 'home.svc.compute',
    flag: 'cloud.provisioning',
  },
  {
    id: 'ai',
    icon: 'pulse',
    href: '/ai/usage',
    perm: ['ai:read'],
    label: 'aiu.nav.ai',
    desc: 'home.svc.ai',
    flag: 'ai.enabled',
  },
  {
    id: 'billing',
    icon: 'finance',
    href: '/billing',
    perm: ['billing:read', 'usage:read'],
    label: 'nav.billing',
    desc: 'home.svc.billing',
  },
  {
    id: 'privacy',
    icon: 'shield',
    href: '/privacy#requests',
    perm: ['privacy:dsr:self'],
    label: 'nav.privacy',
    desc: 'home.svc.privacy',
  },
  {
    id: 'members',
    icon: 'organization',
    href: '/settings/team#members',
    perm: ['member:read'],
    label: 'nav.members',
    desc: 'home.svc.members',
  },
  {
    id: 'apikeys',
    icon: 'key',
    href: '/settings/team#apikeys',
    perm: ['apikey:read'],
    label: 'nav.apiKeys',
    desc: 'home.svc.apikeys',
  },
  {
    id: 'audit',
    icon: 'organization',
    href: '/settings/organization#audit',
    perm: ['audit:read'],
    label: 'nav.audit',
    desc: 'home.svc.audit',
  },
];

/** Billing falls back to the usage page for a member who may see usage but not invoices. */
export function visibleServices(
  can: (p: string) => boolean,
  flagOn: (flag: string) => boolean,
): Service[] {
  return SERVICES.filter((s) => s.perm.some(can) && (!s.flag || flagOn(s.flag))).map((s) =>
    s.id === 'billing' && !can('billing:read') ? { ...s, href: '/billing/usage' } : s,
  );
}

/** Flags are stored as `true` or `{ enabled: true }` (the hosting guard accepts both); anything else is off. */
export const flagEnabled = (flags: unknown, key: string): boolean => {
  const v = (flags as Record<string, unknown> | null | undefined)?.[key];
  return (
    v === true ||
    (typeof v === 'object' && v !== null && (v as { enabled?: unknown }).enabled === true)
  );
};
