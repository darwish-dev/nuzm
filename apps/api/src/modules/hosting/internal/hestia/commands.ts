/**
 * The allow-list of HestiaCP commands the platform may run through Hestia's REST API (`POST https://<host>:8083/api/` with `hash`, `cmd`, `arg1..argN`, `returncode`).
 * Built ONLY from https://hestiacp.com/docs/reference/cli (read 2026-11-24): command names and ARGUMENT ORDER are the documented ones. A command that is not in
 * `HESTIA_COMMANDS` cannot be sent: there is no free-form command, no shell string and no argument that is not validated by its own pattern. Nothing from a browser
 * request ever becomes a command, a host or a credential.
 *
 * Return codes are the documented ones (https://hestiacp.com/docs/server-administration/rest-api).
 */
import type { ErrorCategory } from '../m05-contracts';

export type ArgKind =
  | 'user'
  | 'domain'
  | 'password'
  | 'email'
  | 'package'
  | 'template'
  | 'dbname'
  | 'flag' // `yes` | `no`
  | 'int'
  | 'backuparchive' // a Hestia backup archive name: `<user>.<timestamp>.tar`
  | 'backuptype' // the remote backup protocol of `v-list-backup-host`
  | 'dbtype'
  | 'docrootfile' // the two placeholder files Quick Install removes from a fresh docroot, and nothing else
  | 'phpbin' // the PHP CLI of a pinned version
  | 'wpbin' // the WP-CLI that `v-add-user-wp-cli` puts in the site user's home
  | 'wparg' // one WP-CLI argument: no space, quote, `$`, backtick, `;`, `|`, `&`, `<` or `>`
  | 'text'; // short free text without control characters (names)

const ARG: Record<ArgKind, RegExp> = {
  /** the on-node account name: `s-` + the token-derived part (the site name of the hosting contract) */
  user: /^s-[a-z0-9]{12,40}$/,
  domain: /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  password: /^[A-Za-z0-9!@#%^*_+=.:-]{16,64}$/,
  email: /^[^\s@,;'"`\\]{1,64}@[a-z0-9.-]{1,190}$/i,
  package: /^[A-Za-z0-9_.-]{1,40}$/,
  template: /^[A-Za-z0-9_.-]{1,60}$/,
  dbname: /^[a-z0-9_]{1,40}$/,
  flag: /^(yes|no)$/,
  int: /^[0-9]{1,6}$/,
  backuparchive: /^s-[a-z0-9]{12,40}\.[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}\.tar$/,
  backuptype: /^(sftp|ftp|rclone|local)$/,
  dbtype: /^(mysql|pgsql)$/,
  docrootfile:
    /^\/home\/s-[a-z0-9]{12,40}\/web\/(?=.{1,253}\/)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\/public_html\/(index\.html|robots\.txt)$/,
  phpbin: /^\/usr\/bin\/php[5-9]\.[0-9]{1,2}$/,
  wpbin: /^\/home\/s-[a-z0-9]{12,40}\/\.wp-cli\/wp$/,
  wparg: /^[A-Za-z0-9_.:/@=+,%-]{1,200}$/,
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this pattern refuses
  text: /^[^\x00-\x1f\x7f'"`\\$;|&<>]{1,100}$/,
};

export interface HestiaCommandDef {
  /** documented command name */
  cmd: string;
  /** the documented argument order; a trailing `?` marks an optional argument */
  args: { name: string; kind: ArgKind; optional?: boolean }[];
  mutating: boolean;
  /** a list command answers JSON when its last argument is `json` (documented: "all v-list-* calls support json, shell and plain") */
  json?: boolean;
}

const a = (name: string, kind: ArgKind, optional = false) => ({ name, kind, optional });
const def = (
  cmd: string,
  args: HestiaCommandDef['args'],
  mutating: boolean,
  json = false,
): HestiaCommandDef => ({ cmd, args, mutating, ...(json ? { json } : {}) });

const user = a('user', 'user');
const dom = a('domain', 'domain');

export const HESTIA_COMMANDS = {
  // reads (JSON)
  sysInfo: def('v-list-sys-info', [], false, true),
  backendTemplates: def('v-list-web-templates-backend', [], false, true),
  packages: def('v-list-user-packages', [], false, true),
  listUser: def('v-list-user', [user], false, true),
  listUsers: def('v-list-users', [], false, true),
  listWebDomains: def('v-list-web-domains', [user], false, true),
  listWebDomain: def('v-list-web-domain', [user, dom], false, true),
  sysPhp: def('v-list-sys-php', [], false, true),
  webDomainSsl: def('v-list-web-domain-ssl', [user, dom], false, true),
  // account lifecycle
  addUser: def(
    'v-add-user',
    [
      user,
      a('password', 'password'),
      a('email', 'email'),
      a('package', 'package'),
      a('name', 'text', true),
      a('lastName', 'text', true),
    ],
    true,
  ),
  deleteUser: def('v-delete-user', [user], true),
  suspendUser: def('v-suspend-user', [user, a('restart', 'flag', true)], true),
  unsuspendUser: def('v-unsuspend-user', [user, a('restart', 'flag', true)], true),
  changeUserPackage: def('v-change-user-package', [user, a('package', 'package')], true),
  // web
  addWebDomain: def(
    'v-add-web-domain',
    [user, dom, a('ip', 'text', true), a('restart', 'flag', true), a('aliases', 'text', true)],
    true,
  ),
  deleteWebDomain: def('v-delete-web-domain', [user, dom, a('restart', 'flag', true)], true),
  changeBackendTemplate: def(
    'v-change-web-domain-backend-tpl',
    [user, dom, a('template', 'template'), a('restart', 'flag', true)],
    true,
  ),
  // backups (https://hestiacp.com/docs/reference/cli: v-schedule-user-backup, v-list-user-backups, v-restore-user, v-delete-user-backup, v-list-backup-host).
  // `v-add-backup-host` is deliberately NOT here: it carries the backup host's password and is run locally by the node setup script (docs/runbooks/node-onboarding.md).
  // `v-schedule-user-restore` is deliberately NOT here either: its completion cannot be observed, `v-restore-user` answers when it is done.
  scheduleBackup: def('v-schedule-user-backup', [user], true),
  listBackups: def('v-list-user-backups', [user], false, true),
  deleteUserBackup: def('v-delete-user-backup', [user, a('backup', 'backuparchive')], true),
  restoreUser: def(
    'v-restore-user',
    [
      user,
      a('backup', 'backuparchive'),
      a('web', 'flag'),
      a('dns', 'flag'),
      a('mail', 'flag'),
      a('db', 'flag'),
      a('cron', 'flag'),
      a('udir', 'flag'),
      a('notify', 'flag', true),
    ],
    true,
  ),
  listBackupHost: def('v-list-backup-host', [a('type', 'backuptype')], false, true),
  listServices: def('v-list-sys-services', [], false, true),
  // databases and the WordPress install (Quick Install is panel PHP with no CLI/REST entry: it is reproduced from the same documented commands)
  listDatabases: def('v-list-databases', [user], false, true),
  addDatabase: def(
    'v-add-database',
    [
      user,
      a('database', 'dbname'),
      a('dbuser', 'dbname'),
      a('dbpass', 'password'),
      a('type', 'dbtype', true),
      a('host', 'text', true),
      a('charset', 'text', true),
    ],
    true,
  ),
  addWpCli: def('v-add-user-wp-cli', [user, a('update', 'flag', true)], true),
  deleteFsFile: def('v-delete-fs-file', [user, a('file', 'docrootfile')], true),
  changeWebTemplate: def(
    'v-change-web-domain-tpl',
    [user, dom, a('template', 'template'), a('restart', 'flag', true)],
    true,
  ),
  runWpCli: def(
    'v-run-cli-cmd',
    [
      user,
      a('php', 'phpbin'),
      a('wp', 'wpbin'),
      ...Array.from({ length: 16 }, (_, i) => a(`w${i + 1}`, 'wparg', i > 0)),
    ],
    true,
  ),
  // TLS (Let's Encrypt)
  addLetsEncrypt: def('v-add-letsencrypt-domain', [user, dom, a('aliases', 'text', true)], true),
} as const satisfies Record<string, HestiaCommandDef>;
export type HestiaCommandId = keyof typeof HESTIA_COMMANDS;

/** The documented return codes → our error categories (retryable per category). `E_LA` (server busy) and `E_CONNECT` are the transient ones. */
export const HESTIA_RETURN: Record<number, { name: string; category: ErrorCategory }> = {
  1: { name: 'E_ARGS', category: 'validation' },
  2: { name: 'E_INVALID', category: 'validation' },
  3: { name: 'E_NOTEXIST', category: 'not_found' },
  4: { name: 'E_EXISTS', category: 'conflict' },
  5: { name: 'E_SUSPENDED', category: 'conflict' },
  6: { name: 'E_UNSUSPENDED', category: 'conflict' },
  7: { name: 'E_INUSE', category: 'conflict' },
  8: { name: 'E_LIMIT', category: 'quota' },
  9: { name: 'E_PASSWORD', category: 'auth' },
  10: { name: 'E_FORBIDEN', category: 'auth' },
  11: { name: 'E_DISABLED', category: 'unsupported' },
  12: { name: 'E_PARSING', category: 'unknown' },
  13: { name: 'E_DISK', category: 'capacity' },
  14: { name: 'E_LA', category: 'capacity' },
  15: { name: 'E_CONNECT', category: 'provider_outage' },
  16: { name: 'E_FTP', category: 'provider_outage' },
  17: { name: 'E_DB', category: 'provider_outage' },
  18: { name: 'E_RDD', category: 'unknown' },
  19: { name: 'E_UPDATE', category: 'unknown' },
  20: { name: 'E_RESTART', category: 'provider_outage' },
  21: { name: 'E_BACKUP', category: 'unknown' },
};

export class HestiaArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HestiaArgError';
  }
}

/** Validates the arguments against the command's documented order and patterns and returns them as the positional `argN` list. Never echoes a value in an error. */
export function buildArgs(
  def: HestiaCommandDef,
  values: Record<string, string | undefined>,
): string[] {
  const out: string[] = [];
  let gap = false;
  for (const spec of def.args) {
    const v = values[spec.name];
    if (v === undefined || v === '') {
      if (!spec.optional) throw new HestiaArgError(`${def.cmd}: ${spec.name} is required`);
      gap = true;
      continue;
    }
    if (gap)
      throw new HestiaArgError(`${def.cmd}: ${spec.name} given after an omitted optional argument`);
    if (!ARG[spec.kind].test(v))
      throw new HestiaArgError(`${def.cmd}: ${spec.name} is not a valid ${spec.kind}`);
    out.push(v);
  }
  for (const k of Object.keys(values))
    if (!def.args.some((s) => s.name === k))
      throw new HestiaArgError(`${def.cmd}: unknown argument ${k}`);
  return out;
}
