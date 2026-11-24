import { HESTIA_COMMANDS } from './commands';

/**
 * Hestia PACKAGES carry a site's limits (ADR-067: limits are packages, assigned with `v-change-user-package`). One package per plan, named `nz-<plan key>` and created on every node by
 * `infra/hosting/node-setup.sh` with `v-add-user-package <file> <name>` (`v-add-user-package TMPFILE PACKAGE [REWRITE]`, https://hestiacp.com/docs/reference/cli).
 * The keys below are those of the `default.pkg` Hestia ships (`/usr/local/hestia/data/packages/default.pkg`); the node setup compares them with the node's own file before it writes anything.
 * Nothing here promises CPU or memory: Hestia packages have no such limit, so none is claimed (master prompt S03 §2).
 */
export const PACKAGE_PREFIX = 'nz-';
export const packageName = (planKey: string): string => `${PACKAGE_PREFIX}${planKey}`;
const PACKAGE_NAME = /^[A-Za-z0-9_.-]{1,40}$/;

export interface PlanForPackage {
  key: string;
  quotas: {
    diskMb: number;
    bandwidthGb: number;
    dbCount: number;
    sitesCount: number;
    backupCount?: number;
    mailAccounts?: number;
  };
}
export interface HestiaPackageFile {
  plan: string;
  name: string;
  /** the content of the `.pkg` file */
  file: string;
}

/** The `.pkg` text of a plan. Throws when the plan key cannot make a valid package name (the plan must be renamed first: no silent truncation). */
export function renderPackage(
  plan: PlanForPackage,
  ns = 'ns1.nuzm.invalid,ns2.nuzm.invalid',
): HestiaPackageFile {
  const name = packageName(plan.key);
  if (!PACKAGE_NAME.test(name))
    throw new Error(`plan key ${plan.key} does not make a valid Hestia package name`);
  const n = (v: number) => String(Math.max(0, Math.floor(v)));
  const lines: [string, string][] = [
    ['WEB_TEMPLATE', 'default'],
    ['BACKEND_TEMPLATE', 'default'],
    ['PROXY_TEMPLATE', 'default'],
    ['DNS_TEMPLATE', 'default'],
    ['WEB_DOMAINS', n(plan.quotas.sitesCount)],
    ['WEB_ALIASES', n(Math.max(5, plan.quotas.sitesCount * 5))],
    ['DNS_DOMAINS', '0'], // DNS is Nuzm's (M07), never the node's
    ['DNS_RECORDS', '0'],
    ['MAIL_DOMAINS', plan.quotas.mailAccounts ? n(plan.quotas.sitesCount) : '0'],
    ['MAIL_ACCOUNTS', n(plan.quotas.mailAccounts ?? 0)],
    ['RATE_LIMIT', '200'],
    ['DATABASES', n(plan.quotas.dbCount)],
    ['CRON_JOBS', '10'],
    ['DISK_QUOTA', n(plan.quotas.diskMb)], // megabytes
    ['BANDWIDTH', n(plan.quotas.bandwidthGb * 1024)], // megabytes
    ['NS', ns],
    ['SHELL', 'nologin'], // a hosting account never gets a shell (SFTP is chrooted by the file manager sprint)
    ['BACKUPS', n(plan.quotas.backupCount ?? 7)],
  ];
  return { plan: plan.key, name, file: lines.map(([k, v]) => `${k}='${v}'`).join('\n') + '\n' };
}

/**
 * The Hestia access-key PROFILE of the platform (`/usr/local/hestia/data/api/<profile>`, https://hestiacp.com/docs/server-administration/rest-api: `ROLE` and a comma-separated
 * `COMMANDS`): exactly the allow-list of `commands.ts`, so the key on the node cannot do more than the adapter can ask. Generated, and a test fails when the committed file drifts.
 * NOTE `v-run-cli-cmd` lets the holder run a command as a site user: keep the node's access key on the platform's IP allow-list only.
 */
export function renderAccessProfile(): string {
  const cmds = [...new Set(Object.values(HESTIA_COMMANDS).map((d) => d.cmd))].sort();
  return `ROLE='admin'\nCOMMANDS='${cmds.join(',')}'\n`;
}
