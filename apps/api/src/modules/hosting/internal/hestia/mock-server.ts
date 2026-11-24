import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Local mock of a HestiaCP panel's REST API, shaped from the CLI reference and the output of Hestia's own `v-list-*` scripts (NOT VERIFIED against a real panel; the
 * return codes are the documented ones). It tests the adapter, the allow-list and the reconcile logic; it never produces vendor evidence.
 */
type Row = Record<string, string>;
interface MockMailbox {
  quota: string;
  password: string;
  aliases: Set<string>;
}
interface MockMailDomain {
  accounts: Map<string, MockMailbox>;
  webmail: string;
  dkimKey: string;
}
interface MockDomain {
  backend: string;
  ssl: boolean;
  notAfter: string | null;
  /** FTP accounts (Hestia prefixes the account: `<user>_<name>`) → path */
  ftp: Map<string, string>;
  /** HTTP-auth users */
  auth: Set<string>;
  accessLog: string[];
  errorLog: string[];
}
interface MockCronJob {
  min: string;
  hour: string;
  day: string;
  month: string;
  wday: string;
  command: string;
}
interface MockUser {
  name: string;
  password: string;
  pkg: string;
  suspended: boolean;
  domains: Map<string, MockDomain>;
  cron: Map<string, MockCronJob>;
  mail: Map<string, MockMailDomain>;
  sftpJail: boolean;
}
export interface HestiaMockControls {
  users: Map<string, MockUser>;
  /** every command received, in order (names only) */
  commands: string[];
  /** the access key the mock accepts */
  hash: string;
  /** fail the next `times` calls of `cmd`: `drop` = the connection dies before the effect, `drop-after` = after it, or a documented return code */
  inject(cmd: string, how: 'drop' | 'drop-after' | { code: number }, times?: number): void;
  packages: string[];
  phpVersions: string[];
  /** `v-list-sys-config` services of the node; an empty string = the service is not installed (documented hestia.conf keys) */
  config: { FTP_SYSTEM: string; MAIL_SYSTEM: string; IMAP_SYSTEM: string; WEBMAIL_SYSTEM: string };
}

export async function startHestiaMock(): Promise<{
  host: string;
  port: number;
  close(): Promise<void>;
  controls: HestiaMockControls;
}> {
  const users = new Map<string, MockUser>();
  const commands: string[] = [];
  const faults: { cmd: string; how: 'drop' | 'drop-after' | { code: number }; left: number }[] = [];
  const hash = 'ABCDEFGHIJKLMNOP:mock-secret-key-0123456789abcdef';
  const packages = ['default', 'nuzm-starter'];
  const phpVersions = ['8.2', '8.3'];
  const config = {
    FTP_SYSTEM: 'vsftpd',
    MAIL_SYSTEM: 'exim4',
    IMAP_SYSTEM: 'dovecot',
    WEBMAIL_SYSTEM: 'roundcube',
  };
  const fault = (cmd: string) => {
    const f = faults.find((x) => x.cmd === cmd && x.left > 0);
    if (!f) return null;
    f.left--;
    return f.how;
  };

  const domainRow = (d: string, v: MockDomain, suspended: boolean): Row => ({
    DOMAIN: d,
    BACKEND: v.backend,
    SSL: v.ssl ? 'yes' : 'no',
    SUSPENDED: suspended ? 'yes' : 'no',
    FTP_USER: [...v.ftp.keys()].join(':'),
    FTP_PATH: [...v.ftp.values()].join(':'),
    AUTH_USER: [...v.auth].join(':'),
  });

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = new URLSearchParams(body);
      const cmd = p.get('cmd') ?? '';
      const json = p.get('returncode') === 'no';
      const arg = (i: number) => p.get(`arg${i}`) ?? '';
      const reply = (code: number | unknown) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(
          typeof code === 'number'
            ? String(code)
            : typeof code === 'string'
              ? code
              : JSON.stringify(code),
        );
      };
      if (req.url !== '/api/' || req.method !== 'POST') return void res.writeHead(404).end();
      if (p.get('hash') !== hash) return void res.writeHead(401).end('Error: invalid access key');
      commands.push(cmd);
      const f = fault(cmd);
      if (f === 'drop') return void req.socket.destroy();
      if (f && typeof f === 'object') return reply(f.code);
      const after = f === 'drop-after';
      const out = (v: number | unknown) => (after ? req.socket.destroy() : reply(v));
      const u = (name: string) => users.get(name);
      const okOrCode = (code: number) => out(code);

      switch (cmd) {
        case 'v-list-sys-info':
          return out({
            sysinfo: {
              HOSTNAME: 'hosting-1.example.test',
              OS: 'Debian',
              VERSION: '12',
              ARCH: 'x86_64',
              HESTIA: '1.9.4',
              RELEASE: 'release',
              UPTIME: '120',
              LOADAVERAGE: '0.25 / 0.20 / 0.10',
            },
          });
        case 'v-list-sys-php':
          return out(phpVersions);
        case 'v-list-web-templates-backend':
          return out(['default', ...phpVersions.map((v) => `PHP-${v.replace('.', '_')}`)]);
        case 'v-list-user-packages':
          return out(Object.fromEntries(packages.map((k) => [k, { DISK_QUOTA: '1000' }])));
        case 'v-list-users':
          return out(
            Object.fromEntries([...users.keys()].map((k) => [k, { PACKAGE: users.get(k)!.pkg }])),
          );
        case 'v-add-user': {
          if (u(arg(1))) return okOrCode(4);
          if (!packages.includes(arg(4))) return okOrCode(3);
          users.set(arg(1), {
            name: arg(1),
            password: arg(2),
            pkg: arg(4),
            suspended: false,
            domains: new Map(),
            cron: new Map(),
            mail: new Map(),
            sftpJail: false,
          });
          return out(0);
        }
        case 'v-list-user': {
          const x = u(arg(1));
          if (!x) return reply(3);
          return out({
            [x.name]: {
              NAME: x.name,
              PACKAGE: x.pkg,
              HOME: `/home/${x.name}`,
              DISK_QUOTA: '1000',
              BANDWIDTH: '100',
              SUSPENDED: x.suspended ? 'yes' : 'no',
              U_DISK: '12',
              U_BANDWIDTH: '3',
              U_WEB_DOMAINS: String(x.domains.size),
              U_WEB_SSL: String([...x.domains.values()].filter((d) => d.ssl).length),
              U_DATABASES: '0',
              U_CRON_JOBS: String(x.cron.size),
              U_MAIL_DOMAINS: String(x.mail.size),
            } as Row,
          });
        }
        case 'v-delete-user':
          return u(arg(1)) ? (users.delete(arg(1)), out(0)) : okOrCode(3);
        case 'v-suspend-user': {
          const x = u(arg(1));
          if (!x) return okOrCode(3);
          if (x.suspended) return okOrCode(5);
          x.suspended = true;
          return out(0);
        }
        case 'v-unsuspend-user': {
          const x = u(arg(1));
          if (!x) return okOrCode(3);
          if (!x.suspended) return okOrCode(6);
          x.suspended = false;
          return out(0);
        }
        case 'v-change-user-package': {
          const x = u(arg(1));
          if (!x) return okOrCode(3);
          if (!packages.includes(arg(2))) return okOrCode(3);
          x.pkg = arg(2);
          return out(0);
        }
        case 'v-add-web-domain': {
          const x = u(arg(1));
          if (!x) return okOrCode(3);
          if ([...users.values()].some((o) => o.domains.has(arg(2)))) return okOrCode(4);
          x.domains.set(arg(2), {
            backend: 'default',
            ssl: false,
            notAfter: null,
            ftp: new Map(),
            auth: new Set(),
            accessLog: [],
            errorLog: [],
          });
          return out(0);
        }
        case 'v-list-web-domains': {
          const x = u(arg(1));
          if (!x) return reply(3);
          return out(
            Object.fromEntries([...x.domains].map(([d, v]) => [d, domainRow(d, v, x.suspended)])),
          );
        }
        case 'v-delete-web-domain': {
          const x = u(arg(1));
          return x?.domains.delete(arg(2)) ? out(0) : okOrCode(3);
        }
        case 'v-change-web-domain-backend-tpl': {
          const d = u(arg(1))?.domains.get(arg(2));
          if (!d) return okOrCode(3);
          if (
            arg(3) !== 'default' &&
            !phpVersions.some((v) => `PHP-${v.replace('.', '_')}` === arg(3))
          )
            return okOrCode(2);
          d.backend = arg(3);
          return out(0);
        }
        case 'v-add-letsencrypt-domain': {
          const d = u(arg(1))?.domains.get(arg(2));
          if (!d) return okOrCode(3);
          if (d.ssl) return okOrCode(4);
          d.ssl = true;
          d.notAfter = 'Feb 20 10:00:00 2027 GMT';
          return out(0);
        }
        case 'v-list-web-domain-ssl': {
          const d = u(arg(1))?.domains.get(arg(2));
          if (!d || !d.ssl) return reply(3);
          return out({
            [arg(2)]: {
              CRT: '-----BEGIN CERTIFICATE-----mock',
              KEY: 'MOCK-PRIVATE-KEY-MUST-NEVER-BE-STORED',
              NOT_AFTER: d.notAfter,
            },
          });
        }

        case 'v-list-web-domain': {
          const x = u(arg(1));
          const d = x?.domains.get(arg(2));
          if (!x || !d) return reply(3);
          return out({ [arg(2)]: domainRow(arg(2), d, x.suspended) });
        }
        case 'v-list-sys-config':
          return out({ config: { ...config, VERSION: '1.9.4' } });
        // ---- cron ----
        case 'v-list-cron-jobs': {
          const x = u(arg(1));
          if (!x) return reply(3);
          return out(
            Object.fromEntries(
              [...x.cron].map(([id, j]) => [
                id,
                {
                  JOB: id,
                  MIN: j.min,
                  HOUR: j.hour,
                  DAY: j.day,
                  MONTH: j.month,
                  WDAY: j.wday,
                  CMD: j.command,
                  SUSPENDED: 'no',
                },
              ]),
            ),
          );
        }
        case 'v-add-cron-job': {
          const x = u(arg(1));
          if (!x) return okOrCode(3);
          const id = arg(8) || String(Math.max(0, ...[...x.cron.keys()].map(Number)) + 1);
          if (x.cron.has(id)) return okOrCode(4);
          x.cron.set(id, {
            min: arg(2),
            hour: arg(3),
            day: arg(4),
            month: arg(5),
            wday: arg(6),
            command: arg(7),
          });
          return out(0);
        }
        case 'v-change-cron-job': {
          const j = u(arg(1))?.cron.get(arg(2));
          if (!j) return okOrCode(3);
          Object.assign(j, {
            min: arg(3),
            hour: arg(4),
            day: arg(5),
            month: arg(6),
            wday: arg(7),
            command: arg(8),
          });
          return out(0);
        }
        case 'v-delete-cron-job':
          return u(arg(1))?.cron.delete(arg(2)) ? out(0) : okOrCode(3);
        // ---- logs (plain text) ----
        case 'v-list-web-domain-accesslog':
        case 'v-list-web-domain-errorlog': {
          const d = u(arg(1))?.domains.get(arg(2));
          if (!d) return reply(3);
          const all = cmd.endsWith('accesslog') ? d.accessLog : d.errorLog;
          const n = Math.max(0, Number(arg(3)) || 0);
          return out(n === 0 ? '' : all.slice(-n).join('\n'));
        }
        // ---- FTP ----
        case 'v-add-web-domain-ftp': {
          if (!config.FTP_SYSTEM) return okOrCode(11);
          const d = u(arg(1))?.domains.get(arg(2));
          if (!d) return okOrCode(3);
          const name = `${arg(1)}_${arg(3)}`;
          if (d.ftp.has(name)) return okOrCode(4);
          d.ftp.set(name, arg(5) || '/public_html');
          return out(0);
        }
        case 'v-delete-web-domain-ftp': {
          const d = u(arg(1))?.domains.get(arg(2));
          return d?.ftp.delete(`${arg(1)}_${arg(3)}`) ? out(0) : okOrCode(3);
        }
        case 'v-change-web-domain-ftp-password': {
          const d = u(arg(1))?.domains.get(arg(2));
          return d?.ftp.has(`${arg(1)}_${arg(3)}`) ? out(0) : okOrCode(3);
        }
        // ---- HTTP auth ----
        case 'v-add-web-domain-httpauth': {
          const d = u(arg(1))?.domains.get(arg(2));
          if (!d) return okOrCode(3);
          if (d.auth.has(arg(3))) return okOrCode(4);
          d.auth.add(arg(3));
          return out(0);
        }
        case 'v-delete-web-domain-httpauth': {
          const d = u(arg(1))?.domains.get(arg(2));
          return d?.auth.delete(arg(3)) ? out(0) : okOrCode(3);
        }
        case 'v-add-user-sftp-jail': {
          const x = u(arg(1));
          if (!x) return okOrCode(3);
          x.sftpJail = true;
          return out(0);
        }
        // ---- mail ----
        case 'v-list-mail-domains': {
          const x = u(arg(1));
          if (!x) return reply(3);
          if (!config.MAIL_SYSTEM) return reply(11);
          return out(
            Object.fromEntries(
              [...x.mail].map(([d, m]) => [
                d,
                {
                  DOMAIN: d,
                  ACCOUNTS: String(m.accounts.size),
                  WEBMAIL: m.webmail,
                  DKIM: 'yes',
                  SUSPENDED: 'no',
                },
              ]),
            ),
          );
        }
        case 'v-list-mail-domain': {
          const m = u(arg(1))?.mail.get(arg(2));
          if (!m) return reply(3);
          return out({
            [arg(2)]: {
              DOMAIN: arg(2),
              ACCOUNTS: String(m.accounts.size),
              WEBMAIL: m.webmail,
              DKIM: 'yes',
              SUSPENDED: 'no',
            },
          });
        }
        case 'v-add-mail-domain': {
          if (!config.MAIL_SYSTEM) return okOrCode(11);
          const x = u(arg(1));
          if (!x) return okOrCode(3);
          if (!x.domains.has(arg(2))) return okOrCode(3);
          if (x.mail.has(arg(2))) return okOrCode(4);
          x.mail.set(arg(2), {
            accounts: new Map(),
            webmail: '',
            dkimKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmockdkimkey',
          });
          return out(0);
        }
        case 'v-delete-mail-domain':
          return u(arg(1))?.mail.delete(arg(2)) ? out(0) : okOrCode(3);
        case 'v-add-mail-domain-webmail': {
          const m = u(arg(1))?.mail.get(arg(2));
          if (!m) return okOrCode(3);
          if (!config.WEBMAIL_SYSTEM) return okOrCode(11);
          m.webmail = arg(3) || config.WEBMAIL_SYSTEM;
          return out(0);
        }
        case 'v-list-mail-domain-dkim': {
          const m = u(arg(1))?.mail.get(arg(2));
          if (!m) return reply(3);
          return out({ [arg(2)]: { PUBLIC_KEY: m.dkimKey } });
        }
        case 'v-list-mail-domain-dkim-dns': {
          const m = u(arg(1))?.mail.get(arg(2));
          if (!m) return reply(3);
          return out({
            dkim: {
              HOST: `mail._domainkey.${arg(2)}`,
              TYPE: 'TXT',
              VALUE: `v=DKIM1; k=rsa; p=${m.dkimKey}`,
            },
          });
        }
        case 'v-list-mail-accounts': {
          const m = u(arg(1))?.mail.get(arg(2));
          if (!m) return reply(3);
          return out(
            Object.fromEntries(
              [...m.accounts].map(([a, v]) => [
                a,
                {
                  ACCOUNT: a,
                  ALIAS: [...v.aliases].join(','),
                  QUOTA: v.quota,
                  U_DISK: '0',
                  SUSPENDED: 'no',
                },
              ]),
            ),
          );
        }
        case 'v-add-mail-account': {
          const m = u(arg(1))?.mail.get(arg(2));
          if (!m) return okOrCode(3);
          if (m.accounts.has(arg(3))) return okOrCode(4);
          m.accounts.set(arg(3), {
            quota: arg(5) || 'unlimited',
            password: arg(4),
            aliases: new Set(),
          });
          return out(0);
        }
        case 'v-delete-mail-account':
          return u(arg(1))?.mail.get(arg(2))?.accounts.delete(arg(3)) ? out(0) : okOrCode(3);
        case 'v-change-mail-account-password': {
          const a = u(arg(1))?.mail.get(arg(2))?.accounts.get(arg(3));
          if (!a) return okOrCode(3);
          a.password = arg(4);
          return out(0);
        }
        case 'v-change-mail-account-quota': {
          const a = u(arg(1))?.mail.get(arg(2))?.accounts.get(arg(3));
          if (!a) return okOrCode(3);
          a.quota = arg(4);
          return out(0);
        }
        case 'v-add-mail-account-alias': {
          const a = u(arg(1))?.mail.get(arg(2))?.accounts.get(arg(3));
          if (!a) return okOrCode(3);
          if (a.aliases.has(arg(4))) return okOrCode(4);
          a.aliases.add(arg(4));
          return out(0);
        }
        case 'v-delete-mail-account-alias': {
          const a = u(arg(1))?.mail.get(arg(2))?.accounts.get(arg(3));
          return a?.aliases.delete(arg(4)) ? out(0) : okOrCode(3);
        }
        default:
          return reply(json ? { error: 'unknown command' } : 1);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    host: '127.0.0.1',
    port,
    close: () => new Promise((r) => server.close(() => r())),
    controls: {
      users,
      commands,
      hash,
      packages,
      phpVersions,
      config,
      inject: (cmd, how, times = 1) => void faults.push({ cmd, how, left: times }),
    },
  };
}
