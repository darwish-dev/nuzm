/**
 * TEST DOUBLE: an in-memory simulated hosting node (sites, users, quotas, usage, certificates, encrypted per-site backups). It implements CommandExecutor so the
 * platform's own logic can be tested without a panel. It proves NOTHING about a real server or about HestiaCP (see `hestia/` for the product adapter and its tests).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { AcmeClient, BackupSink } from '../../ports';
import type { CommandExecutor, ExecContext, ExecResult } from './executor';

type FsType = 'file' | 'dir' | 'symlink';
interface FsNode {
  type: FsType;
  owner: string;
  group: string;
  mode: number;
  content?: string;
  target?: string;
}
interface MockSite {
  name: string;
  user: string;
  uid: number;
  runtime: string;
  domains: string[];
  suspended: boolean;
  limits: {
    diskMb: number;
    inodes: number;
    maxProcesses: number;
    memoryMb: number;
    bandwidthGbMonth: number;
  };
  token: string;
  credentialsRef: string;
  backupKeyRef: string;
  procs: number;
  cpuSeconds: number;
  smtpAttempts: number;
  processNames: string[];
  diskBytes: number;
  inodes: number;
  bandwidthBytes: number;
  db: { name: string; user: string };
  certs: { certId: string; notAfter: string; domains: string[] }[];
  tables: Map<string, string>;
}
export class Denied extends Error {
  constructor(
    readonly code:
      | 'EACCES'
      | 'ENOENT'
      | 'EDQUOT'
      | 'EAGAIN'
      | 'EPERM'
      | 'OPEN_BASEDIR'
      | 'DISABLED_FUNCTION'
      | 'DB_DENIED',
    msg: string,
  ) {
    super(`${code}: ${msg}`);
  }
}

const bit = (mode: number, who: 'u' | 'g' | 'o', op: 'r' | 'w' | 'x') => {
  const shift = who === 'u' ? 6 : who === 'g' ? 3 : 0;
  const m = op === 'r' ? 4 : op === 'w' ? 2 : 1;
  return (mode >> shift) & m;
};
const MAX_SYMLINKS = 8;
export const DISABLED_FUNCTIONS = [
  'exec',
  'passthru',
  'shell_exec',
  'system',
  'proc_open',
  'popen',
  'pcntl_exec',
  'dl',
  'putenv',
  'symlink',
  'link',
];

export interface MockNodeOptions {
  nodeId: string;
  region?: string;
  panelVersion?: string;
  runtimes?: string[];
  capacity?: { cpuMillicores: number; memoryMb: number; diskMb: number };
  /** secrets by vault ref (the agent resolves refs; the control plane never sees them) */
  secrets?: (ref: string) => Buffer | undefined;
  sink?: BackupSink;
  /** certificate authority the node talks to (a local ACME-style test server in CI) */
  acme?: AcmeClient;
  /** fault injection */
  faults?: { failNextCreateAfterEffect?: boolean; hangNext?: string[] };
}

export class SimNode implements CommandExecutor {
  readonly sites = new Map<string, MockSite>();
  readonly fs = new Map<string, FsNode>();
  readonly users = new Map<string, number>(); // name → uid
  readonly executed: { commandId: string; token: string }[] = [];
  private nextUid = 2000;
  private pids = 100;
  readonly procs = new Map<number, { owner: string; env: string }>();
  readonly faults: NonNullable<MockNodeOptions['faults']>;
  constructor(readonly opts: MockNodeOptions) {
    this.faults = opts.faults ?? {};
    this.users.set('root', 0);
    for (const d of [
      '/',
      '/home',
      '/tmp',
      '/etc',
      '/var',
      '/var/log',
      '/var/log/sites',
      '/var/spool',
      '/var/spool/cron',
      '/run',
      '/run/php',
      '/etc/nuzm-certs',
      '/etc/php',
      '/etc/php/pools',
      '/var/lib',
      '/var/lib/private-tmp',
      '/proc',
    ])
      this.fs.set(d, {
        type: 'dir',
        owner: 'root',
        group: 'root',
        mode:
          d === '/tmp'
            ? 0o1777
            : d === '/home' ||
                d === '/var/log/sites' ||
                d === '/var/spool/cron' ||
                d === '/etc/nuzm-certs' ||
                d === '/var/lib/private-tmp' ||
                d === '/run/php'
              ? 0o711
              : 0o755,
      });
    this.fs.set('/etc/passwd', {
      type: 'file',
      owner: 'root',
      group: 'root',
      mode: 0o644,
      content: 'root:x:0:0',
    });
    this.fs.set('/etc/shadow', {
      type: 'file',
      owner: 'root',
      group: 'shadow',
      mode: 0o640,
      content: 'root:$6$…',
    });
    this.fs.set('/etc/nuzm-agent-key', {
      type: 'file',
      owner: 'root',
      group: 'root',
      mode: 0o600,
      content: 'AGENT-PRIVATE-STATE',
    });
  }

  /* ───────── command execution (the contract the agent drives) ───────── */
  async execute(
    commandId: string,
    a: Record<string, unknown>,
    ctx: ExecContext,
  ): Promise<ExecResult> {
    this.executed.push({ commandId, token: ctx.idempotencyToken });
    const site = (a.site as string | undefined) ? this.sites.get(a.site as string) : undefined;
    switch (commandId) {
      case 'inventory':
        return { ok: true, result: this.inventory() };
      case 'probe':
        return { ok: true, result: this.probe() };
      case 'site.create':
        return this.createSite(a, ctx);
      case 'site.find':
        return { ok: true, result: site ? this.info(site) : null };
      case 'site.update':
        if (!site) return nf();
        if (a.limits) this.applyLimits(site, a.limits as MockSite['limits']);
        if (a.runtime) {
          if (!(this.opts.runtimes ?? DEFAULT_RUNTIMES).includes(a.runtime as string))
            return {
              ok: false,
              category: 'unsupported',
              message: 'runtime not offered by this node',
            };
          site.runtime = a.runtime as string;
        }
        return { ok: true, result: this.info(site) };
      case 'site.suspend':
        if (!site) return nf();
        site.suspended = true;
        return { ok: true, result: null };
      case 'site.resume':
        if (!site) return nf();
        site.suspended = false;
        return { ok: true, result: null };
      case 'site.delete':
        return this.deleteSite(a.site as string);
      case 'site.wipe.verify':
        return { ok: true, result: this.wipeReport(a.site as string) };
      case 'domain.bind':
        if (!site) return nf();
        if (
          [...this.sites.values()].some(
            (s) => s.name !== site.name && s.domains.includes(a.domain as string),
          )
        )
          return { ok: false, category: 'conflict', message: 'domain already bound on this node' };
        if (!site.domains.includes(a.domain as string)) site.domains.push(a.domain as string);
        return { ok: true, result: this.info(site) };
      case 'domain.unbind':
        if (!site) return nf();
        site.domains = site.domains.filter((d) => d !== a.domain);
        return { ok: true, result: this.info(site) };
      case 'cert.issue':
      case 'cert.install': {
        if (!site) return nf();
        const domains = a.domains as string[];
        if (domains.some((d) => !site.domains.includes(d)))
          return {
            ok: false,
            category: 'validation',
            message: 'a domain is not bound to the site',
          };
        let certId = createHash('sha256')
          .update(`${site.name}|${domains.join(',')}|${ctx.idempotencyToken}`)
          .digest('hex')
          .slice(0, 24);
        let notAfter = new Date(ctx.now.getTime() + 90 * 86_400_000).toISOString();
        if (this.opts.acme && commandId === 'cert.issue') {
          try {
            const r = await this.opts.acme.issue(domains, site.name);
            certId = r.certificateId;
            notAfter = r.notAfter;
          } catch (e) {
            const m = (e as Error).message;
            return {
              ok: false,
              category: /rate/i.test(m) ? 'rate_limit' : 'internal',
              message: m.slice(0, 120),
            };
          }
        }
        site.certs.push({ certId, notAfter, domains });
        this.fs.set(`/etc/nuzm-certs/${site.name}/privkey.pem`, {
          type: 'file',
          owner: 'root',
          group: site.user,
          mode: 0o640,
          content: 'PRIVATE-KEY-OF-' + site.name,
        });
        return { ok: true, result: { certId, notAfter, domains } };
      }
      case 'backup.create':
        return this.backup(site, a.backupId as string);
      case 'backup.restore':
        return this.restore(site, a);
      case 'usage.report':
        if (!site) return nf();
        return {
          ok: true,
          result: {
            observedAt: ctx.now.toISOString(),
            diskBytes: site.diskBytes,
            inodes: site.inodes,
            bandwidthBytesMonth: site.bandwidthBytes,
            cpuSeconds: site.cpuSeconds,
            processes: site.procs,
            smtpEgressAttempts: site.smtpAttempts,
            processNames: [...site.processNames],
          },
        };
      case 'quota.apply':
        if (!site) return nf();
        this.applyLimits(site, a.limits as MockSite['limits']);
        return { ok: true, result: null };
      case 'db.binding.apply':
        return {
          ok: false,
          category: 'unsupported',
          message: 'database bindings are provided by M08',
        };
      default:
        return { ok: false, category: 'unsupported', message: 'unknown command' };
    }
  }

  private inventory() {
    const cap = this.opts.capacity ?? { cpuMillicores: 4000, memoryMb: 8192, diskMb: 200_000 };
    return {
      panelVersion: this.opts.panelVersion ?? '1.9.4',
      capacity: cap,
      loadAvg1: 0.1 * this.sites.size,
      memoryUsedMb: 512 + 64 * this.sites.size,
      diskUsedMb:
        4000 + [...this.sites.values()].reduce((n, s) => n + Math.ceil(s.diskBytes / 1_048_576), 0),
      sites: this.sites.size,
      runtimes: this.opts.runtimes ?? DEFAULT_RUNTIMES,
      health: 'healthy',
    };
  }
  private probe() {
    const rt = this.opts.runtimes ?? DEFAULT_RUNTIMES;
    return {
      runtimes: rt,
      capabilities: [
        'hosting.site.create',
        'hosting.site.delete',
        'hosting.site.suspend',
        'hosting.site.find-by-token',
        'hosting.domain.bind',
        'hosting.cert.issue',
        'hosting.cert.install-custom',
        'hosting.backup.create',
        'hosting.backup.restore',
        'hosting.quota.apply',
        'hosting.usage.report',
      ],
    };
  }
  private info(s: MockSite) {
    return {
      name: s.name,
      systemUser: s.user,
      homePath: `/home/${s.name}`,
      runtime: s.runtime,
      domains: [...s.domains],
      suspended: s.suspended,
      limits: { ...s.limits },
    };
  }
  private applyLimits(s: MockSite, l: MockSite['limits']) {
    s.limits = { ...l };
  }

  private createSite(a: Record<string, unknown>, ctx: ExecContext): ExecResult {
    const name = a.site as string;
    const existing = this.sites.get(name);
    if (existing) {
      // the site name IS the token: the same token → adopt (idempotent); anything else is a conflict
      if (existing.token === ctx.idempotencyToken) return { ok: true, result: this.info(existing) };
      return { ok: false, category: 'conflict', message: 'a site with this name exists' };
    }
    const runtime = a.runtime as string;
    if (!(this.opts.runtimes ?? DEFAULT_RUNTIMES).includes(runtime))
      return {
        ok: false,
        category: 'unsupported',
        message: 'runtime not offered by this node (probe)',
      };
    const domain = a.domain as string;
    if ([...this.sites.values()].some((s) => s.domains.includes(domain)))
      return { ok: false, category: 'conflict', message: 'domain already bound on this node' };
    const user = `u${name.slice(2, 14)}`;
    const uid = this.nextUid++;
    this.users.set(user, uid);
    const l = a.limits as MockSite['limits'];
    const site: MockSite = {
      name,
      user,
      uid,
      runtime,
      domains: [domain],
      suspended: false,
      limits: { ...l },
      token: ctx.idempotencyToken,
      credentialsRef: a.credentialsRef as string,
      backupKeyRef: a.backupKeyRef as string,
      procs: 1,
      cpuSeconds: 0,
      smtpAttempts: 0,
      processNames: [],
      diskBytes: 0,
      inodes: 0,
      bandwidthBytes: 0,
      db: { name: `db_${name.slice(2, 14)}`, user: `dbu_${name.slice(2, 14)}` },
      certs: [],
      tables: new Map(),
    };
    this.sites.set(name, site);
    const home = `/home/${name}`;
    const mk = (p: string, n: FsNode) => this.fs.set(p, n);
    mk(home, { type: 'dir', owner: user, group: user, mode: 0o700 });
    for (const d of ['htdocs', 'logs', 'tmp', '.ssh'])
      mk(`${home}/${d}`, {
        type: 'dir',
        owner: user,
        group: user,
        mode: d === '.ssh' ? 0o700 : 0o750,
      });
    mk(`/var/lib/private-tmp/${name}`, { type: 'dir', owner: user, group: user, mode: 0o700 });
    mk(`/var/log/sites/${name}`, { type: 'dir', owner: 'root', group: user, mode: 0o750 });
    mk(`/var/log/sites/${name}/access.log`, {
      type: 'file',
      owner: 'root',
      group: user,
      mode: 0o640,
      content: '',
    });
    mk(`/var/spool/cron/${name}`, {
      type: 'file',
      owner: user,
      group: user,
      mode: 0o600,
      content: '',
    });
    mk(`/run/php/${name}.sock`, {
      type: 'file',
      owner: user,
      group: user,
      mode: 0o600,
      content: 'socket',
    });
    mk(`/etc/php/pools/${name}.conf`, {
      type: 'file',
      owner: 'root',
      group: 'root',
      mode: 0o644,
      content: `open_basedir=${home}:/var/lib/private-tmp/${name}\ndisable_functions=${DISABLED_FUNCTIONS.join(',')}`,
    });
    mk(`/etc/nuzm-certs/${name}`, { type: 'dir', owner: 'root', group: user, mode: 0o750 });
    this.procs.set(++this.pids, { owner: user, env: `SITE_SECRET_${name}=1` });
    this.sites.get(name)!.procs = 1;
    if (this.faults.failNextCreateAfterEffect) {
      this.faults.failNextCreateAfterEffect = false;
      // the EFFECT happened; the caller will see a timeout (injected at the transport) and must reconcile
    }
    return { ok: true, result: this.info(site) };
  }

  private deleteSite(name: string): ExecResult {
    const s = this.sites.get(name);
    if (!s) return { ok: true, result: this.wipeReport(name) }; // idempotent: already gone
    for (const k of [...this.fs.keys()])
      if (
        k.includes(`/${name}/`) ||
        k.endsWith(`/${name}`) ||
        k.endsWith(`/${name}.sock`) ||
        k.endsWith(`/${name}.conf`)
      )
        this.fs.delete(k);
    for (const [pid, p] of this.procs) if (p.owner === s.user) this.procs.delete(pid);
    this.users.delete(s.user);
    this.sites.delete(name);
    return { ok: true, result: this.wipeReport(name) };
  }
  private wipeReport(name: string) {
    const files = [...this.fs.keys()].filter(
      (k) =>
        k.includes(`/${name}/`) ||
        k.endsWith(`/${name}`) ||
        k.endsWith(`/${name}.sock`) ||
        k.endsWith(`/${name}.conf`),
    ).length;
    const s = this.sites.get(name);
    return {
      site: name,
      filesRemaining: files,
      databasesRemaining: s ? 1 : 0,
      usersRemaining: s ? 1 : 0,
      vhostsRemaining: s ? 1 : 0,
      certificatesRemaining: s ? s.certs.length : 0,
      cronEntriesRemaining: this.fs.has(`/var/spool/cron/${name}`) ? 1 : 0,
    };
  }

  /* ───────── backups: per-site AES-256-GCM, manifest of sha256, sink ───────── */
  private homeFiles(s: MockSite): [string, string][] {
    const pre = `/home/${s.name}/`;
    return [...this.fs.entries()]
      .filter(([p, n]) => p.startsWith(pre) && n.type === 'file')
      .map(([p, n]) => [p, n.content ?? '']);
  }
  private async backup(s: MockSite | undefined, backupId: string): Promise<ExecResult> {
    if (!s) return nf();
    const key = this.opts.secrets?.(s.backupKeyRef);
    if (!key || key.length !== 32)
      return {
        ok: false,
        category: 'validation',
        message: 'the backup key reference does not resolve',
      };
    if (!this.opts.sink) return { ok: false, category: 'unsupported', message: 'no backup sink' };
    const files = this.homeFiles(s);
    const manifest = files.map(([path, c]) => ({
      path,
      sha256: sha(c),
      bytes: Buffer.byteLength(c),
    }));
    const plain = Buffer.from(
      JSON.stringify({ files: Object.fromEntries(files), tables: Object.fromEntries(s.tables) }),
    );
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    const put = await this.opts.sink.put(this.opts.region ?? 'sa-test', s.name, backupId, enc);
    return {
      ok: true,
      result: {
        backupId,
        sizeBytes: enc.length,
        checksum: put.checksum,
        sinkRef: put.ref,
        manifest,
      },
    };
  }
  private async restore(s: MockSite | undefined, a: Record<string, unknown>): Promise<ExecResult> {
    if (!s) return nf();
    const key = this.opts.secrets?.(s.backupKeyRef);
    const sink = this.opts.sink;
    if (!key || !sink) return { ok: false, category: 'unsupported', message: 'no key or sink' };
    const ref = sinkRefOf(this.opts.region ?? 'sa-test', s.name, a.backupId as string);
    const data = await sink.get(ref);
    if (!data) return { ok: false, category: 'not_found', message: 'backup archive not found' };
    if (sha(data) !== a.checksum)
      return {
        ok: false,
        category: 'validation',
        message: 'archive checksum mismatch: the backup is corrupt',
      };
    let plain: Buffer;
    try {
      const d = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      d.setAuthTag(data.subarray(data.length - 16));
      plain = Buffer.concat([d.update(data.subarray(12, data.length - 16)), d.final()]);
    } catch {
      return { ok: false, category: 'validation', message: 'archive authentication failed' };
    }
    const parsed = JSON.parse(plain.toString()) as {
      files: Record<string, string>;
      tables: Record<string, string>;
    };
    const pre = `/home/${s.name}/`;
    for (const k of [...this.fs.keys()])
      if (k.startsWith(pre) && this.fs.get(k)!.type === 'file') this.fs.delete(k);
    for (const [p, c] of Object.entries(parsed.files))
      this.fs.set(p, { type: 'file', owner: s.user, group: s.user, mode: 0o640, content: c });
    s.tables = new Map(Object.entries(parsed.tables));
    const verified = Object.entries(parsed.files).every(
      ([p, c]) => sha(this.fs.get(p)?.content ?? '') === sha(c),
    );
    return { ok: true, result: { verified, checksum: a.checksum as string } };
  }

  /* ───────── attacker API ───────── */
  actor(siteName: string): SiteActor {
    const s = this.sites.get(siteName);
    if (!s) throw new Error(`no such site ${siteName}`);
    return new SiteActor(this, s);
  }
  /** Seed a file as a site (the owner writes into its own home). */
  seed(siteName: string, rel: string, content: string, mode = 0o640): void {
    const s = this.sites.get(siteName)!;
    const p = `/home/${siteName}/${rel}`;
    this.fs.set(p, { type: 'file', owner: s.user, group: s.user, mode, content });
    this.charge(s, Buffer.byteLength(content), 1);
  }
  charge(s: MockSite, bytes: number, inodes: number): void {
    if (s.diskBytes + bytes > s.limits.diskMb * 1_048_576)
      throw new Denied('EDQUOT', 'disk quota exceeded');
    if (s.inodes + inodes > s.limits.inodes) throw new Denied('EDQUOT', 'inode quota exceeded');
    s.diskBytes += bytes;
    s.inodes += inodes;
  }
  /** Names of sites currently on the node. */
  siteNames(): string[] {
    return [...this.sites.keys()];
  }
}
export const sinkRefOf = (region: string, site: string, backupId: string) =>
  `${region}/${site}/${backupId}`;
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const nf = (): ExecResult => ({ ok: false, category: 'not_found', message: 'no such site' });
export const DEFAULT_RUNTIMES = ['php:8.3', 'php:8.4', 'nodejs:22', 'static'];

/** Everything a hostile site owner can try. Every method enforces the node's permission model; a Denied error is the safe outcome. */
export class SiteActor {
  constructor(
    private readonly node: SimNode,
    private readonly site: MockSite,
  ) {}
  get user() {
    return this.site.user;
  }

  private mapTmp(path: string): string {
    // PrivateTmp: the site's /tmp is its own directory
    return path === '/tmp' || path.startsWith('/tmp/')
      ? `/var/lib/private-tmp/${this.site.name}${path.slice(4)}`
      : path;
  }
  private can(n: FsNode, op: 'r' | 'w' | 'x'): boolean {
    if (this.site.user === 'root') return true;
    if (n.owner === this.site.user) return bit(n.mode, 'u', op) > 0;
    if (n.group === this.site.user) return bit(n.mode, 'g', op) > 0;
    return bit(n.mode, 'o', op) > 0;
  }
  /** Resolve component by component: every directory needs x, symlinks are followed (bounded), `..` is applied after resolution. */
  private resolve(path: string, root = '/'): string {
    let parts = path.split('/').filter(Boolean);
    const out: string[] = [];
    let links = 0;
    const base = root === '/' ? '' : root.replace(/\/$/, '');
    while (parts.length) {
      const p = parts.shift()!;
      if (p === '.') continue;
      if (p === '..') {
        out.pop();
        continue;
      }
      const cur = base + '/' + [...out, p].join('/');
      const n = this.node.fs.get(this.mapTmp(cur));
      if (n?.type === 'symlink') {
        if (++links > MAX_SYMLINKS) throw new Denied('ENOENT', 'too many symlinks');
        const t = n.target!;
        if (t.startsWith('/')) {
          out.length = 0;
          parts = [...t.split('/').filter(Boolean), ...parts];
        } else parts = [...t.split('/').filter(Boolean), ...parts];
        continue;
      }
      // x on every directory that is traversed
      const dir =
        this.node.fs.get(this.mapTmp(base + '/' + out.join('/')) || '/') ?? this.node.fs.get('/')!;
      if (!this.can(dir, 'x'))
        throw new Denied('EACCES', `search permission denied on /${out.join('/')}`);
      out.push(p);
    }
    return base + '/' + out.join('/');
  }
  private node_(path: string, chroot?: string): { path: string; n: FsNode } {
    const real = this.mapTmp(this.resolve(path, chroot));
    const n = this.node.fs.get(real);
    if (!n) throw new Denied('ENOENT', path);
    return { path: real, n };
  }
  readFile(path: string, opts: { chroot?: boolean } = {}): string {
    const { n } = this.node_(path, opts.chroot ? `/home/${this.site.name}` : undefined);
    if (n.type !== 'file') throw new Denied('EACCES', 'not a file');
    if (!this.can(n, 'r')) throw new Denied('EACCES', path);
    return n.content ?? '';
  }
  writeFile(path: string, content: string, mode = 0o640): void {
    const real = this.mapTmp(this.resolve(path.slice(0, path.lastIndexOf('/')) || '/'));
    const dir = this.node.fs.get(real);
    if (!dir || !this.can(dir, 'w')) throw new Denied('EACCES', path);
    this.node.charge(this.site, Buffer.byteLength(content), 1);
    this.node.fs.set(real.replace(/\/$/, '') + path.slice(path.lastIndexOf('/')), {
      type: 'file',
      owner: this.site.user,
      group: this.site.user,
      mode,
      content,
    });
  }
  list(path: string): string[] {
    const { path: real, n } = this.node_(path);
    if (n.type !== 'dir' || !this.can(n, 'r')) throw new Denied('EACCES', path);
    const pre = real === '/' ? '/' : real + '/';
    return [
      ...new Set(
        [...this.node.fs.keys()]
          .filter((k) => k.startsWith(pre) && k !== real)
          .map((k) => k.slice(pre.length).split('/')[0]!),
      ),
    ];
  }
  symlink(target: string, linkPath: string): void {
    const parent = this.mapTmp(this.resolve(linkPath.slice(0, linkPath.lastIndexOf('/')) || '/'));
    const dir = this.node.fs.get(parent);
    if (!dir || !this.can(dir, 'w')) throw new Denied('EACCES', linkPath);
    this.node.charge(this.site, 0, 1);
    this.node.fs.set(this.mapTmp(linkPath), {
      type: 'symlink',
      owner: this.site.user,
      group: this.site.user,
      mode: 0o777,
      target,
    });
  }
  /** /proc with hidepid=2: only the caller's own processes are visible. */
  listProcesses(): number[] {
    return [...this.node.procs.entries()]
      .filter(([, p]) => p.owner === this.site.user)
      .map(([pid]) => pid);
  }
  readProcEnviron(pid: number): string {
    const p = this.node.procs.get(pid);
    if (!p || p.owner !== this.site.user) throw new Denied('EACCES', `/proc/${pid}/environ`);
    return p.env;
  }
  connectSocket(path: string): string {
    const { n } = this.node_(path);
    if (!this.can(n, 'w')) throw new Denied('EACCES', path);
    return n.content ?? '';
  }
  /** PHP runtime: file access is limited by open_basedir of the site's pool (realpath checked after symlink resolution). */
  phpInclude(path: string): string {
    const allowed = [`/home/${this.site.name}`, `/tmp`];
    const within = (p: string) => allowed.some((b) => p === b || p.startsWith(b + '/'));
    // PHP checks the lexically normalised path first, then the realpath (after symlinks): both must be inside open_basedir
    const lexical: string[] = [];
    for (const seg of path.split('/').filter(Boolean)) {
      if (seg === '..') lexical.pop();
      else if (seg !== '.') lexical.push(seg);
    }
    if (!within('/' + lexical.join('/')))
      throw new Denied('OPEN_BASEDIR', `/${lexical.join('/')} is not within the allowed path(s)`);
    const real = this.resolve(path);
    if (!within(real))
      throw new Denied('OPEN_BASEDIR', `${real} is not within the allowed path(s)`);
    return this.readFile(path);
  }
  phpCall(fn: string): void {
    if (this.site.runtime.startsWith('php') && DISABLED_FUNCTIONS.includes(fn.toLowerCase()))
      throw new Denied('DISABLED_FUNCTION', fn);
  }
  readCrontab(of: string): string {
    return this.readFile(`/var/spool/cron/${of}`);
  }
  readLog(of: string): string {
    return this.readFile(`/var/log/sites/${of}/access.log`);
  }
  readTlsKey(of: string): string {
    return this.readFile(`/etc/nuzm-certs/${of}/privkey.pem`);
  }
  /** SQL as the site's database user. Supports the few statements the isolation tests need. */
  dbQuery(sql: string): string[] | string {
    const s = sql.trim().replace(/\s+/g, ' ');
    const own = this.site.db.name;
    let m = /^SELECT \* FROM (\w+)\.(\w+)$/i.exec(s);
    if (m) {
      if (m[1] !== own)
        throw new Denied(
          'DB_DENIED',
          `SELECT command denied to user ${this.site.db.user} for database ${m[1]}`,
        );
      return this.site.tables.get(m[2]!) ?? '';
    }
    if (/^(SHOW DATABASES|SELECT schema_name FROM information_schema\.schemata)$/i.test(s))
      return ['information_schema', own];
    if (/^(GRANT|CREATE USER|DROP DATABASE|CREATE DATABASE)/i.test(s))
      throw new Denied('DB_DENIED', 'command denied');
    if (/^USE (\w+)$/i.test(s)) {
      const db = /^USE (\w+)$/i.exec(s)![1]!;
      if (db !== own) throw new Denied('DB_DENIED', `access denied for database ${db}`);
      return 'ok';
    }
    m = /^INSERT INTO (\w+)\.(\w+) VALUES '(.*)'$/i.exec(s);
    if (m) {
      if (m[1] !== own) throw new Denied('DB_DENIED', 'access denied');
      this.site.tables.set(m[2]!, m[3]!);
      return 'ok';
    }
    throw new Denied('DB_DENIED', 'unsupported statement in the simulation');
  }
  forkMany(n: number): number {
    const room = this.site.limits.maxProcesses - this.site.procs;
    const spawned = Math.min(n, Math.max(room, 0));
    this.site.procs += spawned;
    if (spawned < n)
      throw new Denied('EAGAIN', `process limit ${this.site.limits.maxProcesses} reached`);
    return spawned;
  }
  fillDisk(bytes: number): void {
    this.node.charge(this.site, bytes, 0);
  }
  fillInodes(n: number): void {
    this.node.charge(this.site, 0, n);
  }
}
