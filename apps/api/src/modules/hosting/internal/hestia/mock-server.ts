import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Local mock of a HestiaCP panel's REST API, shaped from the CLI reference and the output of Hestia's own `v-list-*` scripts (NOT VERIFIED against a real panel; the
 * return codes are the documented ones). It tests the adapter, the allow-list and the reconcile logic; it never produces vendor evidence.
 */
type Row = Record<string, string>;
interface MockUser {
  name: string;
  password: string;
  pkg: string;
  suspended: boolean;
  domains: Map<string, { backend: string; ssl: boolean; notAfter: string | null }>;
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
              U_CRON_JOBS: '0',
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
          x.domains.set(arg(2), { backend: 'default', ssl: false, notAfter: null });
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
    },
  };
}
