import type { IconName } from '@nuzm/ui';
import type { MessageKey } from '@nuzm/i18n';

/**
 * The website tools of the HestiaCP plan (S05). Each is built on a documented Hestia command (cron `v-add-cron-job`, logs `v-list-web-domain-accesslog`/`errorlog`, FTP accounts
 * `v-add-web-domain-ftp`, password protection `v-add-web-domain-httpauth`, PHP `v-change-web-domain-backend-tpl`, mail `v-add-mail-account`; the file manager is SFTP into the site
 * root) and works against the mock panel in the API tests. Whether a tool is open for THIS website, role, plan, panel version and connection is decided by the API
 * (`GET /v1/hosting/sites/{id}/tools`): the page only shows that answer. Every tool is NOT VERIFIED until a human-run probe on a real node.
 */
export type ToolId = 'files' | 'cron' | 'logs' | 'ftp' | 'protection' | 'php' | 'mail';
export type ToolReason =
  'role' | 'site_state' | 'connection' | 'panel_version' | 'panel_service' | 'plan';
export interface SiteTool {
  id: ToolId;
  icon: IconName;
  title: MessageKey;
  desc: MessageKey;
  /** the sub-path under /hosting/sites/{id} */
  path: string;
}
export const SITE_TOOLS: SiteTool[] = [
  {
    id: 'files',
    icon: 'projects',
    title: 'host.card.files',
    desc: 'host.card.files.desc',
    path: 'files',
  },
  {
    id: 'cron',
    icon: 'calendar',
    title: 'host.card.cron',
    desc: 'host.card.cron.desc',
    path: 'cron',
  },
  { id: 'php', icon: 'panel', title: 'host.card.php', desc: 'host.card.php.desc', path: 'php' },
  { id: 'logs', icon: 'list', title: 'host.card.logs', desc: 'host.card.logs.desc', path: 'logs' },
  { id: 'ftp', icon: 'key', title: 'host.card.access', desc: 'host.card.access.desc', path: 'ftp' },
  {
    id: 'protection',
    icon: 'shield',
    title: 'host.card.security',
    desc: 'host.card.security.desc',
    path: 'protection',
  },
  { id: 'mail', icon: 'mail', title: 'host.card.mail', desc: 'host.card.mail.desc', path: 'mail' },
];
export const REASON_KEY: Record<ToolReason, MessageKey> = {
  role: 'ht.reason.role',
  site_state: 'ht.reason.site_state',
  connection: 'ht.reason.connection',
  panel_version: 'ht.reason.panel_version',
  panel_service: 'ht.reason.panel_service',
  plan: 'ht.reason.plan',
};
