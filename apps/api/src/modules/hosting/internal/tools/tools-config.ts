/**
 * Limits of the S05 site tools. Every number is a PROPOSAL (owner decision pending, like the other hosting limits) read from the environment; a plan can override the
 * per-site counts with the same-named keys in its `quotas` (`cronJobs`, `ftpAccounts`, `protectionUsers`, `mailboxes`, `mailAliasesPerMailbox`, `mailboxQuotaMb`, `uploadMb`).
 * A plan with no `mailboxes` key sells no business email (default 0): mail is never available by accident.
 */
export interface ToolsConfig {
  defaults: {
    cronJobs: number;
    ftpAccounts: number;
    protectionUsers: number;
    mailboxes: number;
    mailAliasesPerMailbox: number;
    mailboxQuotaMb: number;
    uploadMb: number;
  };
  /** the platform ceiling of one upload: the raw-body parser of the API is 64 MiB */
  maxUploadMb: number;
  maxEditBytes: number;
  maxDownloadBytes: number;
  listMax: number;
  recursiveDeleteMax: number;
  logLinesDefault: number;
  logLinesMax: number;
  logBytesMax: number;
  minCronIntervalMinutes: number;
  sftpPort: number;
  sftpTimeoutMs: number;
  panelDeadlineMs: number;
  /** the mail client settings of a Hestia node (exim/dovecot defaults; NOT VERIFIED on a real node) */
  mailPorts: { imapSsl: number; imapStartTls: number; smtpSsl: number; smtpStartTls: number };
  /** the platform default site suffix: no mail is ever hosted on it */
  defaultDomainSuffix: string;
}
export function loadToolsConfig(env: NodeJS.ProcessEnv = process.env): ToolsConfig {
  const n = (k: string, d: number) => {
    const v = env[k] === undefined ? d : Number(env[k]);
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  return {
    defaults: {
      cronJobs: n('HOSTING_TOOLS_CRON_JOBS', 5),
      ftpAccounts: n('HOSTING_TOOLS_FTP_ACCOUNTS', 2),
      protectionUsers: n('HOSTING_TOOLS_PROTECTION_USERS', 3),
      mailboxes: n('HOSTING_TOOLS_MAILBOXES', 0),
      mailAliasesPerMailbox: n('HOSTING_TOOLS_MAIL_ALIASES', 5),
      mailboxQuotaMb: n('HOSTING_TOOLS_MAILBOX_QUOTA_MB', 1024),
      uploadMb: n('HOSTING_TOOLS_UPLOAD_MB', 25),
    },
    maxUploadMb: Math.min(n('HOSTING_TOOLS_MAX_UPLOAD_MB', 60), 60),
    maxEditBytes: n('HOSTING_TOOLS_MAX_EDIT_BYTES', 1_048_576),
    maxDownloadBytes: n('HOSTING_TOOLS_MAX_DOWNLOAD_BYTES', 52_428_800),
    listMax: n('HOSTING_TOOLS_LIST_MAX', 1000),
    recursiveDeleteMax: n('HOSTING_TOOLS_RECURSIVE_DELETE_MAX', 5000),
    logLinesDefault: n('HOSTING_TOOLS_LOG_LINES', 100),
    logLinesMax: n('HOSTING_TOOLS_LOG_LINES_MAX', 500),
    logBytesMax: n('HOSTING_TOOLS_LOG_BYTES_MAX', 262_144),
    minCronIntervalMinutes: Math.max(1, n('HOSTING_TOOLS_MIN_CRON_INTERVAL_MINUTES', 5)),
    sftpPort: n('HOSTING_SFTP_PORT', 22),
    sftpTimeoutMs: n('HOSTING_SFTP_TIMEOUT_MS', 15_000),
    panelDeadlineMs: n('HOSTING_TOOLS_PANEL_DEADLINE_MS', 30_000),
    mailPorts: { imapSsl: 993, imapStartTls: 143, smtpSsl: 465, smtpStartTls: 587 },
    defaultDomainSuffix: env.HOSTING_DEFAULT_DOMAIN_SUFFIX ?? 'sites.nuzm.invalid',
  };
}
export const TOOLS_CONFIG = Symbol('HOSTING_TOOLS_CONFIG');
