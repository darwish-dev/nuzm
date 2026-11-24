import type { IconName } from '@nuzm/ui';
import type { MessageKey } from '@nuzm/i18n';

/**
 * Website tools that are planned but not wired yet. Each has a documented HestiaCP way (cron `v-add-cron-job`, logs `v-list-web-domain-accesslog`/`errorlog`, FTP accounts
 * `v-add-web-domain-ftp`, password-protected domains `v-add-web-domain-httpauth`, PHP version `v-change-web-domain-backend-tpl`; the file manager is SFTP into the site root),
 * and each is built, tested and enabled in its own sprint (the file manager, cron, logs, FTP, protection and PHP tools are S05 of the HestiaCP plan). Until a tool works against
 * a real service it is listed as coming soon, never faked.
 */
export interface PlannedTool {
  icon: IconName;
  title: MessageKey;
  desc: MessageKey;
}
export const PLANNED_TOOLS: PlannedTool[] = [
  { icon: 'projects', title: 'host.card.files', desc: 'host.card.files.desc' },
  { icon: 'calendar', title: 'host.card.cron', desc: 'host.card.cron.desc' },
  { icon: 'panel', title: 'host.card.php', desc: 'host.card.php.desc' },
  { icon: 'list', title: 'host.card.logs', desc: 'host.card.logs.desc' },
  { icon: 'key', title: 'host.card.access', desc: 'host.card.access.desc' },
  { icon: 'shield', title: 'host.card.security', desc: 'host.card.security.desc' },
];
