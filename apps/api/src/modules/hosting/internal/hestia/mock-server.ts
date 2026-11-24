import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Local mock of a HestiaCP panel's REST API, shaped from the CLI reference and the output of Hestia's own `v-list-*` scripts (NOT VERIFIED against a real panel; the
 * return codes are the documented ones). It tests the adapter, the allow-list and the reconcile logic; it never produces vendor evidence.
 */
type Row = Record<string, string>;
export type WpPhase = 'none' | 'unconfigured' | 'uninstalled' | 'installed';
export interface MockWp {
  phase: WpPhase;
  placeholders: Set<string>;
  posts: string[];
  adminUser?: string;
  adminPassword?: string;
  dbName?: string;
  template?: string;
}
interface MockDomain {
  backend: string;
  ssl: boolean;
  notAfter: string | null;
  wp: MockWp;
  tpl?: string;
}
interface MockUser {
  name: string;
  password: string;
  pkg: string;
  suspended: boolean;
  domains: Map<string, MockDomain>;
  databases: Map<string, { dbuser: string; password: string }>;
  wpCli: boolean;
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
  /** archives held on the node's /backup, per user */
  archives: Map<string, Map<string, Buffer>>;
  /** called when the node "uploads" an archive to its remote backup host (the test wires it to the off-server store) */
  onUpload: ((user: string, name: string, data: Buffer) => void) | null;
  /** keep the local copy after the upload (Hestia deletes it when a remote host is configured: NOT DOCUMENTED, so both are testable) */
  keepLocalCopy: boolean;
  /** `false`: `v-list-backup-host` finds no host */
  backupHostConfigured: boolean;
  /** `false`: the schedule command is accepted but nothing is ever produced (the queue is stuck) */
  backupQueueRuns: boolean;
  services: Record<string, string>;
  /** the web side of a domain as an HTTP probe would see it */
  siteState(domain: string): { answers: boolean; phase: WpPhase; adminPage: boolean };
  domainOf(domain: string): MockDomain | undefined;
  /** make `wp <sub …>` fail `times` times with a return code */
  failWp(sub: string, code: number, times?: number): void;
  /** forget every injected WP-CLI fault */
  clearWpFaults(): void;
  /** `wp <sub …>` is executed but the answer is lost (the effect happened) */
  dropWpAnswer(sub: string, times?: number): void;
  /** every WP-CLI invocation (sub-command words only: never arguments) */
  wpCalls: string[];
  /** stage an archive onto the node (what an ArchiveStager does) */
  stage(user: string, name: string, data: Buffer): void;
  /** restore calls received */
  restores: { user: string; backup: string }[];
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
  const archives = new Map<string, Map<string, Buffer>>();
  const wpFaults: { sub: string; how: 'code' | 'drop-after'; code: number; left: number }[] = [];
  const wpCalls: string[] = [];
  const restores: { user: string; backup: string }[] = [];
  const state = {
    onUpload: null as ((u: string, n: string, d: Buffer) => void) | null,
    keepLocalCopy: true,
    backupHostConfigured: true,
    backupQueueRuns: true,
    services: {
      nginx: 'running',
      apache2: 'running',
      mariadb: 'running',
      'php8.2-fpm': 'running',
      'php8.3-fpm': 'running',
    } as Record<string, string>,
  };
  let archiveSeq = 0;
  const newWp = (): MockWp => ({
    phase: 'none',
    placeholders: new Set(['index.html', 'robots.txt']),
    posts: [],
  });
  const domainOwner = (d: string) => {
    for (const u of users.values()) {
      const x = u.domains.get(d);
      if (x) return x;
    }
    return undefined;
  };
  const snapshotOf = (x: MockUser) =>
    Buffer.from(
      JSON.stringify({
        user: x.name,
        pkg: x.pkg,
        domains: [...x.domains].map(([d, v]) => [
          d,
          { ...v, wp: { ...v.wp, placeholders: [...v.wp.placeholders] } },
        ]),
        databases: [...x.databases],
      }),
    );
  const makeArchive = (x: MockUser) => {
    const n = ++archiveSeq;
    const name = `${x.name}.2026-11-24_03-${String(Math.floor(n / 60)).padStart(2, '0')}-${String(n % 60).padStart(2, '0')}.tar`;
    const data = snapshotOf(x);
    // the node keeps its own copy; with a remote host it uploads it (and, when `keepLocalCopy` is off, drops the local one)
    const mine = archives.get(x.name) ?? new Map<string, Buffer>();
    archives.set(x.name, mine);
    state.onUpload?.(x.name, name, data);
    if (state.keepLocalCopy) mine.set(name, data);
    return name;
  };
  const restoreFrom = (user: string, data: Buffer) => {
    const j = JSON.parse(data.toString('utf8')) as {
      pkg: string;
      domains: [
        string,
        MockDomain & { wp: Omit<MockWp, 'placeholders'> & { placeholders: string[] } },
      ][];
      databases: [string, { dbuser: string; password: string }][];
    };
    const x =
      users.get(user) ??
      ({
        name: user,
        password: randomBytes(12).toString('hex'),
        pkg: j.pkg,
        suspended: false,
        domains: new Map(),
        databases: new Map(),
        wpCli: false,
      } as MockUser);
    users.set(user, x);
    x.pkg = j.pkg;
    x.domains = new Map(
      j.domains.map(([d, v]) => [
        d,
        { ...v, wp: { ...v.wp, placeholders: new Set(v.wp.placeholders) } },
      ]),
    );
    x.databases = new Map(j.databases);
  };
  const wpFault = (sub: string) => {
    const f = wpFaults.find((q) => q.sub === sub && q.left > 0);
    if (!f) return null;
    f.left--;
    return f;
  };
  const packages = ['default', 'nuzm-starter'];
  const phpVersions = ['8.2', '8.3'];
  const fault = (cmd: string) => {
    const f = faults.find((x) => x.cmd === cmd && x.left > 0);
    if (!f) return null;
    f.left--;
    return f.how;
  };

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
        res.end(typeof code === 'number' ? String(code) : JSON.stringify(code));
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
            databases: new Map(),
            wpCli: false,
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
              U_DATABASES: String(x.databases.size),
              U_CRON_JOBS: '0',
            } as Row,
          });
        }
        case 'v-delete-user':
          return u(arg(1)) ? (users.delete(arg(1)), archives.delete(arg(1)), out(0)) : okOrCode(3);
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
          x.domains.set(arg(2), { backend: 'default', ssl: false, notAfter: null, wp: newWp() });
          return out(0);
        }
        case 'v-list-web-domains': {
          const x = u(arg(1));
          if (!x) return reply(3);
          return out(
            Object.fromEntries(
              [...x.domains].map(([d, v]) => [
                d,
                {
                  DOMAIN: d,
                  BACKEND: v.backend,
                  SSL: v.ssl ? 'yes' : 'no',
                  SUSPENDED: x.suspended ? 'yes' : 'no',
                },
              ]),
            ),
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
        case 'v-list-sys-services':
          return out(
            Object.fromEntries(
              Object.entries(state.services).map(([k, v]) => [
                k,
                { STATE: v, CPU: '0.0', MEM: '10', RTIME: '1' },
              ]),
            ),
          );
        case 'v-list-backup-host':
          return state.backupHostConfigured
            ? out({
                [`${arg(1)}.example.test`]: {
                  HOST: `${arg(1)}.example.test`,
                  TYPE: arg(1),
                  PATH: '/nuzm',
                },
              })
            : reply(json ? {} : 3);
        case 'v-schedule-user-backup': {
          const x = u(arg(1));
          if (!x) return okOrCode(3);
          if (state.backupQueueRuns) makeArchive(x);
          return out(0);
        }
        case 'v-list-user-backups': {
          const x = u(arg(1));
          if (!x) return reply(3);
          const mine = archives.get(x.name) ?? new Map<string, Buffer>();
          return out(
            Object.fromEntries(
              [...mine].map(([n, d]) => [
                n,
                {
                  SIZE: String(Math.max(1, Math.ceil(d.length / 1048576))),
                  TYPE: 'incremental',
                  RUNTIME: '1',
                  DATE: '2026-11-24',
                  TIME: '03:00:00',
                },
              ]),
            ),
          );
        }
        case 'v-delete-user-backup': {
          const m = archives.get(arg(1));
          return m?.delete(arg(2)) ? out(0) : okOrCode(3);
        }
        case 'v-restore-user': {
          const data = archives.get(arg(1))?.get(arg(2));
          restores.push({ user: arg(1), backup: arg(2) });
          if (!data) return okOrCode(3);
          restoreFrom(arg(1), data);
          return out(0);
        }
        case 'v-list-databases': {
          const x = u(arg(1));
          if (!x) return reply(3);
          return out(
            Object.fromEntries(
              [...x.databases].map(([n, v]) => [
                n,
                {
                  DATABASE: n,
                  DBUSER: v.dbuser,
                  HOST: 'localhost',
                  TYPE: 'mysql',
                  CHARSET: 'utf8mb4',
                  SUSPENDED: 'no',
                },
              ]),
            ),
          );
        }
        case 'v-add-database': {
          const x = u(arg(1));
          if (!x) return okOrCode(3);
          const full = `${x.name}_${arg(2)}`;
          if (x.databases.has(full)) return okOrCode(4);
          x.databases.set(full, { dbuser: `${x.name}_${arg(3)}`, password: arg(4) });
          return out(0);
        }
        case 'v-add-user-wp-cli': {
          const x = u(arg(1));
          if (!x) return okOrCode(3);
          x.wpCli = true;
          return out(0);
        }
        case 'v-delete-fs-file': {
          const m = /^\/home\/([^/]+)\/web\/([^/]+)\/public_html\/(.+)$/.exec(arg(2));
          const d = m && m[1] === arg(1) ? u(arg(1))?.domains.get(m[2]!) : undefined;
          return d?.wp.placeholders.delete(m![3]!) ? out(0) : okOrCode(3);
        }
        case 'v-change-web-domain-tpl': {
          const d = u(arg(1))?.domains.get(arg(2));
          if (!d) return okOrCode(3);
          if (arg(3) !== 'wordpress' && arg(3) !== 'default') return okOrCode(3);
          d.tpl = arg(3);
          return out(0);
        }
        case 'v-run-cli-cmd': {
          const x = u(arg(1));
          if (!x) return okOrCode(3);
          if (!x.wpCli || arg(3) !== `/home/${x.name}/.wp-cli/wp`) return okOrCode(3);
          const words: string[] = [];
          const opts = new Map<string, string>();
          for (let i = 4; p.get(`arg${i}`) !== null; i++) {
            const a = p.get(`arg${i}`)!;
            if (a.startsWith('--')) {
              const [k, ...v] = a.slice(2).split('=');
              opts.set(k!, v.join('='));
            } else words.push(a);
          }
          const sub = words.slice(0, 2).join(' ');
          wpCalls.push(sub);
          const wf = wpFault(sub);
          if (wf?.how === 'code') return okOrCode(wf.code);
          const path = opts.get('path') ?? '';
          const dm = new RegExp(`^/home/${x.name}/web/([^/]+)/public_html$`).exec(path);
          const dom = dm ? x.domains.get(dm[1]!) : undefined;
          const lose = wf?.how === 'drop-after';
          const done = (v: number) => (lose ? req.socket.destroy() : out(v));
          if (!dom) return okOrCode(3);
          const wp = dom.wp;
          if (sub === 'core download') {
            if (wp.phase !== 'none') return okOrCode(1);
            wp.phase = 'unconfigured';
            return done(0);
          }
          if (sub === 'config create') {
            if (wp.phase !== 'unconfigured') return okOrCode(1);
            const db = [...x.databases].find(
              ([n, v]) =>
                n === opts.get('dbname') &&
                v.dbuser === opts.get('dbuser') &&
                v.password === opts.get('dbpass'),
            );
            if (!db) return okOrCode(17);
            wp.dbName = db[0];
            wp.phase = 'uninstalled';
            return done(0);
          }
          if (sub === 'core install') {
            if (wp.phase !== 'uninstalled') return okOrCode(1);
            wp.adminUser = opts.get('admin_user');
            wp.adminPassword = opts.get('admin_password');
            wp.posts = ['Hello world!'];
            wp.phase = 'installed';
            return done(0);
          }
          if (sub === 'user update') {
            if (wp.phase !== 'installed') return okOrCode(1);
            wp.adminPassword = opts.get('user_pass');
            return done(0);
          }
          return okOrCode(1);
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
      inject: (cmd, how, times = 1) => void faults.push({ cmd, how, left: times }),
      archives,
      get onUpload() {
        return state.onUpload;
      },
      set onUpload(v) {
        state.onUpload = v;
      },
      get keepLocalCopy() {
        return state.keepLocalCopy;
      },
      set keepLocalCopy(v) {
        state.keepLocalCopy = v;
      },
      get backupHostConfigured() {
        return state.backupHostConfigured;
      },
      set backupHostConfigured(v) {
        state.backupHostConfigured = v;
      },
      get backupQueueRuns() {
        return state.backupQueueRuns;
      },
      set backupQueueRuns(v) {
        state.backupQueueRuns = v;
      },
      services: state.services,
      siteState: (domain) => {
        const d = domainOwner(domain);
        if (!d) return { answers: false, phase: 'none', adminPage: false };
        return { answers: true, phase: d.wp.phase, adminPage: d.wp.phase === 'installed' };
      },
      domainOf: (domain) => domainOwner(domain),
      failWp: (sub, code, times = 1) => void wpFaults.push({ sub, how: 'code', code, left: times }),
      dropWpAnswer: (sub, times = 1) =>
        void wpFaults.push({ sub, how: 'drop-after', code: 0, left: times }),
      clearWpFaults: () => void (wpFaults.length = 0),
      wpCalls,
      stage: (user, name, data) => {
        const m = archives.get(user) ?? new Map<string, Buffer>();
        archives.set(user, m);
        m.set(name, data);
      },
      restores,
    },
  };
}
