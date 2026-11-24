import { randomBytes } from 'node:crypto';
import {
  CONTRACT_VERSION,
  normalizedError,
  type AccountContext,
  type CapabilityState,
  type EvidenceKind,
  type HealthReport,
  type OperationResult,
  type RawEvidence,
} from '../m05-contracts';
import {
  HOSTING_CAPABILITIES,
  type CertRef,
  type HostingAdapter,
  type HostingCapabilityId,
  type HostingCapabilityReport,
  type NodeRef,
  type NodeState,
  type SiteInfo,
  type SiteLimits,
  type SiteRef,
  type SiteSpec,
  type SiteUsage,
  type SiteWipeReport,
  type VaultPort,
  type BackupRef,
  type BackupArchive,
  type BackupRequest,
  type BackupSink,
} from '../ports';
import type { HestiaClient, HestiaResult } from './client';
import type { HestiaCommandId } from './commands';

/**
 * HostingAdapter over HestiaCP's REST API, built ONLY from Hestia's CLI reference (https://hestiacp.com/docs/reference/cli) and the output of its own `v-list-*` scripts in
 * the official repository (read 2026-11-24). NOT VERIFIED against any node: nothing here has ever called a real panel (HG-06-01 equivalent: a human-run probe).
 *
 * The on-node account (a Hestia user) is the SITE: its name is the token-derived `s-<hex>` of the hosting contract, so `findByToken` is a plain `v-list-user` and a reconcile
 * after a timeout needs nothing else. Documented limits that are honoured, not hidden:
 *  - limits are Hestia PACKAGES: the node must already have the package (created at node setup); this adapter only assigns one (`packageFor`), so `quota.apply` is reported
 *    `unsupported` until a node proves its packages; no CPU/RAM guarantee is claimed;
 *  - custom certificates, databases (M08), Node.js/Python runtimes and reverse proxies are `unsupported` here (never faked);
 *  - BACKUPS (ADR-068): Hestia writes the archive and uploads it to the node's remote backup host (set at node setup with `v-add-backup-host`); the control plane never touches the node's disk, it
 *    schedules (`v-schedule-user-backup`), then waits for the archive to appear in the off-server store of the node's region and measures it there (size, sha256). Hestia documents no encryption of its
 *    archives and no return codes for the backup commands: the result is the archive in the store, not a code. Restores stage the archive on the node (an `ArchiveStager`, pending a live check of
 *    whether `v-restore-user` fetches from the remote host itself) and run `v-restore-user`, then compare the account with the snapshot taken at backup time.
 *  - the certificate expiry comes from `v-list-web-domain-ssl` (whose answer also carries the private key: it is parsed for `NOT_AFTER` and dropped, never stored or logged).
 */
type Tok = { idempotencyToken: string; operationId: string };

/** Copies one archive from the off-server store to the node's `/backup` (live implementation: SFTP as the restricted `nuzm-restore` account of the node; pending, see the runbook). */
export interface ArchiveStager {
  stage(
    node: NodeRef,
    siteName: string,
    archiveName: string,
    sinkRef: string,
  ): Promise<{ ok: boolean; detail?: string }>;
}

export interface HestiaAdapterOptions {
  vault: VaultPort;
  evidenceKind?: EvidenceKind;
  now?: () => Date;
  /** The Hestia package that carries a site's limits. The default is the package every Hestia installs. */
  packageFor?: (limits: SiteLimits, planKey?: string) => string;
  /** Account contact address (Hestia requires one); never a customer's. */
  contactEmailFor?: (account: string) => string;
  /** Where the node's archives go OFF the server: the store of the node's data region. Without it backup/restore are `unsupported`. */
  archives?: {
    sink: BackupSink;
    regionOf: (nodeId: string) => Promise<string | null>;
    /** how long one backup waits for its archive to appear (default 5 min), and how often it looks (default 15 s; an archive must be seen at the same size twice) */
    waitMs?: number;
    pollMs?: number;
  };
  /** Puts an archive from the off-server store onto the node (`/backup`) so `v-restore-user` can read it. Without it only archives already on the node can be restored. */
  stager?: ArchiveStager;
  /** `v-restore-user` is synchronous and long: its own deadline (default 15 min) */
  restoreDeadlineMs?: number;
  /** Physical capacity of the node's machine (from the compute provider): Hestia itself does not report it. */
  capacityOf?: (
    node: NodeRef,
  ) => Promise<{ cpuMillicores: number; memoryMb: number; diskMb: number } | null>;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown): string =>
  typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
const num = (v: unknown): number => {
  const n = Number(str(v));
  return Number.isFinite(n) ? n : 0;
};
const yes = (v: unknown) => str(v).toLowerCase() === 'yes';
/** `PHP-8_2` → `php:8.2` */
const phpRuntime = (tpl: string): string | null => {
  const m = /^PHP-(\d)_(\d{1,2})$/.exec(tpl);
  return m ? `php:${m[1]}.${m[2]}` : null;
};
const phpTemplate = (runtime: string): string | null => {
  const m = /^php:(\d)\.(\d{1,2})$/.exec(runtime);
  return m ? `PHP-${m[1]}_${m[2]}` : null;
};
const randomPassword = () => randomBytes(24).toString('base64url').replace(/[-_]/g, 'x'); // 32 chars, [A-Za-z0-9]

export class HestiaHostingAdapter implements HostingAdapter {
  readonly id = 'hestia-api';
  readonly kind = 'hosting' as const;
  readonly contractVersion = CONTRACT_VERSION;
  constructor(
    private readonly client: HestiaClient,
    private readonly o: HestiaAdapterOptions,
  ) {}

  private now() {
    return this.o.now?.() ?? new Date();
  }
  private ev(operation: string, summary: string): RawEvidence {
    return {
      kind: this.o.evidenceKind ?? 'live',
      capturedAt: this.now().toISOString(),
      operation,
      summary,
    };
  }
  private run(
    node: NodeRef,
    ctx: AccountContext,
    id: HestiaCommandId,
    values: Record<string, string | undefined>,
  ) {
    return this.client.run(node.nodeId, id, values, ctx.deadlineMs);
  }
  /** The failure of a command as an OperationResult (a lost answer on a mutating command is `uncertain`). */
  private fail<T>(op: string, r: Extract<HestiaResult, { ok: false }>): OperationResult<T> {
    return {
      status: r.uncertain ? 'uncertain' : 'failed',
      error: r.error,
      raw: this.ev(op, r.summary),
    };
  }

  // ---- probe / health / inventory ---------------------------------------------------------------------------------------------
  async probe(ctx: AccountContext, node: NodeRef): Promise<HostingCapabilityReport> {
    const all = Object.fromEntries(HOSTING_CAPABILITIES.map((c) => [c, 'unknown'])) as Record<
      HostingCapabilityId,
      CapabilityState
    >;
    const evidence: RawEvidence[] = [];
    const info = await this.run(node, ctx, 'sysInfo', {});
    evidence.push(this.ev('probe.sys-info', info.summary));
    let runtimes: string[] = [];
    if (info.ok) {
      const php = await this.run(node, ctx, 'sysPhp', {});
      evidence.push(this.ev('probe.sys-php', php.summary));
      const tpl = await this.run(node, ctx, 'backendTemplates', {});
      evidence.push(this.ev('probe.backend-templates', tpl.summary));
      const templates = tpl.ok && Array.isArray(tpl.data) ? (tpl.data as unknown[]).map(str) : [];
      // a PHP version is offered only when the node both has it installed AND has a backend template for it
      runtimes = templates.map(phpRuntime).filter((x): x is string => !!x);
      const installed =
        php.ok && Array.isArray(php.data) ? new Set((php.data as unknown[]).map(str)) : null;
      if (installed) runtimes = runtimes.filter((r) => installed.has(r.slice('php:'.length)));
      runtimes.push('static');
      for (const c of [
        'hosting.site.create',
        'hosting.site.delete',
        'hosting.site.suspend',
        'hosting.site.find-by-token',
        'hosting.domain.bind',
        'hosting.cert.issue',
        'hosting.usage.report',
      ] as const)
        all[c] = 'supported';
      // backups are offered only when the node proves a remote backup host (`v-list-backup-host`) AND the control plane has the off-server store of the node's region
      if (this.o.archives) {
        let host = false;
        for (const type of ['sftp', 'rclone', 'ftp'] as const) {
          const h = await this.run(node, ctx, 'listBackupHost', { type });
          evidence.push(this.ev(`probe.backup-host.${type}`, h.summary));
          if (h.ok && Object.keys(obj(h.data)).length > 0) {
            host = true;
            break;
          }
        }
        if (host) {
          all['hosting.backup.create'] = 'supported';
          if (this.o.stager) all['hosting.backup.restore'] = 'supported';
        }
      }
      for (const c of HOSTING_CAPABILITIES) if (all[c] === 'unknown') all[c] = 'unsupported';
      all['hosting.runtime.php'] = runtimes.some((r) => r.startsWith('php:'))
        ? 'supported'
        : 'unsupported';
      all['hosting.runtime.static'] = 'supported';
    }
    return { capabilities: all, runtimes, probedAt: this.now().toISOString(), evidence };
  }

  async health(ctx: AccountContext, node: NodeRef): Promise<HealthReport> {
    const t0 = Date.now();
    const r = await this.run(node, ctx, 'sysInfo', {});
    // the panel answering is not enough: its web and database services must run too (`v-list-sys-services`)
    const svc = r.ok ? await this.servicesHealth(node, ctx) : null;
    const state = r.ok
      ? (svc?.state ?? 'healthy')
      : r.error.category === 'auth'
        ? 'degraded'
        : r.uncertain || r.error.category === 'provider_outage'
          ? 'unhealthy'
          : 'unknown';
    return {
      state,
      checkedAt: this.now().toISOString(),
      latencyMs: Date.now() - t0,
      detail: r.ok ? svc?.detail : r.error.providerCode,
      evidence: [this.ev('health', r.summary)],
    };
  }

  /**
   * S04: a customer's VPS panel key is a READ-ONLY profile (the customer has root). Proof, not trust: `v-list-users` is NOT in that profile, so a panel that answers it
   * has a broader key than intended. Only meaningful after `health` showed the key itself works.
   */
  async verifyReadOnlyKey(
    ctx: AccountContext,
    node: NodeRef,
  ): Promise<'read_only' | 'too_broad' | 'unknown'> {
    const r = await this.run(node, ctx, 'listUsers', {});
    if (r.ok) return 'too_broad';
    return r.error.category === 'auth' ? 'read_only' : 'unknown';
  }

  async inventory(ctx: AccountContext, node: NodeRef): Promise<OperationResult<NodeState>> {
    const info = await this.run(node, ctx, 'sysInfo', {});
    if (!info.ok) return this.fail('inventory', info);
    const si = obj(obj(info.data).sysinfo);
    const users = await this.run(node, ctx, 'listUsers', {});
    const probe = await this.probe(ctx, node);
    const cap = (await this.o.capacityOf?.(node)) ?? { cpuMillicores: 0, memoryMb: 0, diskMb: 0 };
    // LOADAVERAGE is "1m / 5m / 15m"
    const la = Number(str(si.LOADAVERAGE).split('/')[0]?.trim());
    const siteCount = users.ok
      ? Object.keys(obj(users.data)).filter((u) => /^s-[a-z0-9]+$/.test(u)).length
      : 0;
    return {
      status: 'succeeded',
      data: {
        observedAt: this.now().toISOString(),
        panelVersion: str(si.HESTIA) || null,
        panelKind: 'hestia',
        health: await this.servicesHealth(node, ctx),
        capacity: cap,
        usage: {
          loadAvg1: Number.isFinite(la) ? la : 0,
          memoryUsedMb: 0,
          diskUsedMb: 0,
          sites: siteCount,
        },
        runtimes: probe.runtimes,
      },
      raw: this.ev('inventory', info.summary),
    };
  }

  /**
   * Web and database services must run before a node takes orders (`v-list-sys-services`: `STATE` per service). A node whose web or database service is down is `degraded` with the reason;
   * when the list cannot be read the result stays `healthy` (the sysinfo call already proved the panel answers) and the evidence says so.
   */
  private async servicesHealth(node: NodeRef, ctx: AccountContext): Promise<HealthReport> {
    const checkedAt = this.now().toISOString();
    const r = await this.run(node, ctx, 'listServices', {});
    if (!r.ok)
      return {
        state: 'healthy',
        checkedAt,
        evidence: [this.ev('services', `unread: ${r.summary}`)],
      };
    const svc = obj(r.data);
    const up = (n: string) => n in svc && str(obj(svc[n]).STATE) === 'running';
    const web = up('nginx') || up('apache2');
    const db = up('mariadb') || up('mysql');
    const down = Object.keys(svc).filter(
      (k) => /^php[0-9.]+-fpm$/.test(k) && str(obj(svc[k]).STATE) !== 'running',
    );
    const bad = [...(web ? [] : ['web']), ...(db ? [] : ['database']), ...down];
    return {
      state: bad.length ? 'degraded' : 'healthy',
      checkedAt,
      detail: bad.length ? `down: ${bad.join(',')}` : undefined,
      evidence: [this.ev('services', 'v-list-sys-services')],
    };
  }

  // ---- site lifecycle ---------------------------------------------------------------------------------------------------------
  private async lookup(
    node: NodeRef,
    ctx: AccountContext,
    name: string,
  ): Promise<
    { ok: true; user: Obj | null } | { ok: false; res: Extract<HestiaResult, { ok: false }> }
  > {
    const r = await this.run(node, ctx, 'listUser', { user: name });
    if (r.ok) return { ok: true, user: obj(obj(r.data)[name]) };
    if (r.error.category === 'not_found') return { ok: true, user: null };
    return { ok: false, res: r };
  }

  /**
   * Adds the domain to the site's account. `E_EXISTS` means the panel already has that domain: it counts as done ONLY when it is on THIS account (a retry after a lost
   * answer); on another account it is a genuine conflict and nothing is claimed.
   */
  private async ensureDomain(
    node: NodeRef,
    ctx: AccountContext,
    user: string,
    domain: string,
  ): Promise<{ ok: true } | Extract<HestiaResult, { ok: false }>> {
    const r = await this.run(node, ctx, 'addWebDomain', { user, domain });
    if (r.ok) return { ok: true };
    if (r.error.providerCode !== 'E_EXISTS') return r;
    const mine = await this.run(node, ctx, 'listWebDomains', { user });
    if (mine.ok && domain in obj(mine.data)) return { ok: true };
    return r;
  }

  async createSite(
    ctx: AccountContext,
    node: NodeRef,
    spec: SiteSpec & Tok,
  ): Promise<OperationResult<SiteRef>> {
    const existing = await this.lookup(node, ctx, spec.name);
    if (!existing.ok) return this.fail('createSite', existing.res);
    if (!existing.user) {
      // the password is generated here, stored under the site's credentials reference and sent once to the panel: it is never logged, audited or returned
      const password = randomPassword();
      await this.o.vault.put(spec.credentialsRef, JSON.stringify({ user: spec.name, password }));
      const add = await this.run(node, ctx, 'addUser', {
        user: spec.name,
        password,
        email: this.o.contactEmailFor?.(spec.name) ?? `${spec.name}@hosting.invalid`,
        package: this.o.packageFor?.(spec.limits, spec.planKey) ?? 'default',
      });
      if (!add.ok && add.error.providerCode !== 'E_EXISTS') return this.fail('createSite', add);
    }
    // the domain and the runtime are idempotent steps: a retry after a partial create finishes what is missing
    const dom = await this.ensureDomain(node, ctx, spec.name, spec.domain);
    if (!dom.ok) return this.fail('createSite', dom);
    const tpl = phpTemplate(spec.runtime);
    if (tpl) {
      const be = await this.run(node, ctx, 'changeBackendTemplate', {
        user: spec.name,
        domain: spec.domain,
        template: tpl,
      });
      if (!be.ok) return this.fail('createSite', be);
    }
    return {
      status: 'succeeded',
      providerRef: spec.name,
      data: { name: spec.name, systemUser: spec.name, homePath: `/home/${spec.name}` },
      raw: this.ev('createSite', 'v-add-user + v-add-web-domain'),
    };
  }

  async findByToken(
    ctx: AccountContext,
    node: NodeRef,
    siteName: string,
  ): Promise<OperationResult<SiteInfo | null>> {
    const u = await this.lookup(node, ctx, siteName);
    if (!u.ok) return this.fail('findByToken', u.res);
    if (!u.user)
      return {
        status: 'succeeded',
        data: null,
        raw: this.ev('findByToken', 'absent: v-list-user answered E_NOTEXIST'),
      };
    const doms = await this.run(node, ctx, 'listWebDomains', { user: siteName });
    if (!doms.ok) return this.fail('findByToken', doms);
    const domains = Object.keys(obj(doms.data));
    const first = obj(obj(doms.data)[domains[0] ?? '']);
    return {
      status: 'succeeded',
      data: {
        name: siteName,
        systemUser: siteName,
        homePath: str(u.user.HOME) || `/home/${siteName}`,
        runtime:
          phpRuntime(str(first.BACKEND)) ??
          (str(first.BACKEND).startsWith('PHP') ? 'php' : 'static'),
        domains,
        suspended: yes(u.user.SUSPENDED),
        limits: {
          diskMb: num(u.user.DISK_QUOTA),
          inodes: 0,
          maxProcesses: 0,
          memoryMb: 0,
          bandwidthGbMonth: num(u.user.BANDWIDTH),
        },
      },
      raw: this.ev('findByToken', 'v-list-user + v-list-web-domains'),
    };
  }

  async updateSite(
    ctx: AccountContext,
    node: NodeRef,
    siteName: string,
    patch: { limits?: SiteLimits; runtime?: string; domains?: string[]; planKey?: string },
    _t: Tok,
  ): Promise<OperationResult<SiteInfo>> {
    for (const d of patch.domains ?? []) {
      const r = await this.ensureDomain(node, ctx, siteName, d);
      if (!r.ok) return this.fail('updateSite', r);
    }
    if (patch.limits && this.o.packageFor) {
      const r = await this.run(node, ctx, 'changeUserPackage', {
        user: siteName,
        package: this.o.packageFor(patch.limits, patch.planKey),
      });
      if (!r.ok) return this.fail('updateSite', r);
    }
    const tpl = patch.runtime ? phpTemplate(patch.runtime) : null;
    if (tpl) {
      const doms = await this.run(node, ctx, 'listWebDomains', { user: siteName });
      if (!doms.ok) return this.fail('updateSite', doms);
      for (const d of Object.keys(obj(doms.data))) {
        const r = await this.run(node, ctx, 'changeBackendTemplate', {
          user: siteName,
          domain: d,
          template: tpl,
        });
        if (!r.ok) return this.fail('updateSite', r);
      }
    }
    const f = await this.findByToken(ctx, node, siteName);
    if (f.status !== 'succeeded' || !f.data)
      return f.status === 'succeeded'
        ? {
            status: 'failed',
            error: normalizedError(
              'not_found',
              'E_NOTEXIST',
              'the site does not exist on the node',
            ),
            raw: f.raw,
          }
        : (f as unknown as OperationResult<SiteInfo>);
    return { status: 'succeeded', data: f.data, raw: f.raw };
  }

  async suspendSite(
    ctx: AccountContext,
    node: NodeRef,
    siteName: string,
    _t: Tok,
  ): Promise<OperationResult<void>> {
    const r = await this.run(node, ctx, 'suspendUser', { user: siteName });
    if (!r.ok && r.error.providerCode !== 'E_SUSPENDED') return this.fail('suspendSite', r);
    return { status: 'succeeded', raw: this.ev('suspendSite', r.summary) };
  }
  async resumeSite(
    ctx: AccountContext,
    node: NodeRef,
    siteName: string,
    _t: Tok,
  ): Promise<OperationResult<void>> {
    const r = await this.run(node, ctx, 'unsuspendUser', { user: siteName });
    if (!r.ok && r.error.providerCode !== 'E_UNSUSPENDED') return this.fail('resumeSite', r);
    return { status: 'succeeded', raw: this.ev('resumeSite', r.summary) };
  }

  async deleteSite(
    ctx: AccountContext,
    node: NodeRef,
    siteName: string,
    _t: Tok,
  ): Promise<OperationResult<SiteWipeReport>> {
    const r = await this.run(node, ctx, 'deleteUser', { user: siteName });
    if (!r.ok && r.error.providerCode !== 'E_NOTEXIST') return this.fail('deleteSite', r);
    return this.verifyWipe(ctx, node, siteName);
  }

  /** `v-delete-user` removes the account with its web, database, mail and cron objects; the residual check is that the account is gone. */
  async verifyWipe(
    ctx: AccountContext,
    node: NodeRef,
    siteName: string,
  ): Promise<OperationResult<SiteWipeReport>> {
    const u = await this.lookup(node, ctx, siteName);
    if (!u.ok) return this.fail('verifyWipe', u.res);
    const left = u.user;
    return {
      status: 'succeeded',
      data: {
        site: siteName,
        filesRemaining: 0,
        databasesRemaining: left ? num(left.U_DATABASES) : 0,
        usersRemaining: left ? 1 : 0,
        vhostsRemaining: left ? num(left.U_WEB_DOMAINS) : 0,
        certificatesRemaining: left ? num(left.U_WEB_SSL) : 0,
        cronEntriesRemaining: left ? num(left.U_CRON_JOBS) : 0,
      },
      raw: this.ev('verifyWipe', 'v-list-user'),
    };
  }

  // ---- TLS ----------------------------------------------------------------------------------------------------------------------
  async issueCertificate(
    ctx: AccountContext,
    node: NodeRef,
    siteName: string,
    req: { domains: string[]; mode: 'managed' | 'custom'; customCertRef?: string },
    _t: Tok,
  ): Promise<OperationResult<CertRef>> {
    if (req.mode === 'custom')
      return {
        status: 'failed',
        error: normalizedError(
          'unsupported',
          'custom_cert',
          'installing a custom certificate is not supported by this adapter yet',
        ),
        raw: this.ev('issueCertificate', 'unsupported: custom'),
      };
    let notAfter: string | null = null;
    for (const d of req.domains) {
      const r = await this.run(node, ctx, 'addLetsEncrypt', { user: siteName, domain: d });
      if (!r.ok && r.error.providerCode !== 'E_EXISTS') return this.fail('issueCertificate', r);
      const ssl = await this.run(node, ctx, 'webDomainSsl', { user: siteName, domain: d });
      if (ssl.ok) {
        // the answer also carries CRT/KEY/CA: only the expiry is read, the rest is dropped here
        const after = str(obj(obj(ssl.data)[d]).NOT_AFTER);
        const t = Date.parse(after);
        if (Number.isFinite(t)) {
          const iso = new Date(t).toISOString();
          if (!notAfter || iso < notAfter) notAfter = iso;
        }
      }
    }
    if (!notAfter)
      return {
        status: 'uncertain',
        error: normalizedError(
          'unknown',
          'no_expiry',
          'the certificate was requested but its expiry could not be read',
        ),
        raw: this.ev('issueCertificate', 'v-add-letsencrypt-domain'),
      };
    return {
      status: 'succeeded',
      data: { certId: `le-${siteName}-${req.domains.length}`, notAfter, domains: req.domains },
      raw: this.ev('issueCertificate', 'v-add-letsencrypt-domain + v-list-web-domain-ssl'),
    };
  }

  // ---- backups (ADR-068) ----------------------------------------------------------------------------------------------------------
  private unsupported<T>(op: string, why: string): OperationResult<T> {
    return {
      status: 'failed',
      error: normalizedError('unsupported', op, why),
      raw: this.ev(op, 'unsupported'),
    };
  }
  private sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /** Archives of the account: the node's own list (Hestia) joined with what the off-server store holds. The store is the one that counts (it proves the upload finished). */
  async listBackups(
    ctx: AccountContext,
    node: NodeRef,
    siteName: string,
  ): Promise<OperationResult<BackupArchive[]>> {
    const a = this.o.archives;
    if (!a) return this.unsupported('listBackups', 'no off-server backup store is configured');
    const region = await a.regionOf(node.nodeId);
    if (!region) return this.unsupported('listBackups', 'the node has no data region');
    const onNode = await this.run(node, ctx, 'listBackups', { user: siteName });
    // an account that does not exist yet has no archives on the node: that is an empty list, not an error
    if (!onNode.ok && onNode.error.category !== 'not_found')
      return this.fail('listBackups', onNode);
    const out = new Map<string, BackupArchive>();
    if (onNode.ok)
      for (const [name, v] of Object.entries(obj(onNode.data)))
        out.set(name, { name, sizeBytes: Math.round(num(obj(v).SIZE) * 1024 * 1024) || null }); // Hestia lists sizes in megabytes
    for (const x of (await a.sink.list?.(region, siteName)) ?? [])
      out.set(x.name, { name: x.name, sizeBytes: x.sizeBytes });
    return {
      status: 'succeeded',
      data: [...out.values()].sort((x, y) => x.name.localeCompare(y.name)),
      raw: this.ev('listBackups', 'v-list-user-backups + the off-server store'),
    };
  }

  async deleteBackup(
    ctx: AccountContext,
    node: NodeRef,
    siteName: string,
    archiveName: string,
  ): Promise<OperationResult<void>> {
    const r = await this.run(node, ctx, 'deleteUserBackup', {
      user: siteName,
      backup: archiveName,
    });
    if (!r.ok && r.error.providerCode !== 'E_NOTEXIST') return this.fail('deleteBackup', r);
    return { status: 'succeeded', raw: this.ev('deleteBackup', 'v-delete-user-backup') };
  }

  async backup(
    ctx: AccountContext,
    node: NodeRef,
    siteName: string,
    t: BackupRequest,
  ): Promise<OperationResult<BackupRef>> {
    const a = this.o.archives;
    if (!a?.sink.stat || !a.sink.refOf)
      return this.unsupported('backup', 'no off-server backup store is configured');
    const region = await a.regionOf(node.nodeId);
    if (!region) return this.unsupported('backup', 'the node has no data region');
    const first = await this.listBackups(ctx, node, siteName);
    if (first.status !== 'succeeded' || !first.data)
      return first as unknown as OperationResult<BackupRef>;
    const known = new Set(t.known ?? first.data.map((x) => x.name));
    const fresh = () => first.data!.filter((x) => !known.has(x.name));
    if (fresh().length === 0 && t.scheduleAllowed !== false) {
      // the schedule is sent ONCE per backup row (the service records it before the call): a retry only waits
      const r = await this.run(node, ctx, 'scheduleBackup', { user: siteName });
      if (!r.ok) return this.fail('backup', r);
    }
    const deadline = Date.now() + (a.waitMs ?? 300_000);
    const every = a.pollMs ?? 15_000;
    let last: { name: string; size: number } | null = null;
    for (;;) {
      const l = await this.listBackups(ctx, node, siteName);
      if (l.status !== 'succeeded' || !l.data) return l as unknown as OperationResult<BackupRef>;
      const cands = l.data
        .filter((x) => !known.has(x.name))
        .sort((x, y) => y.name.localeCompare(x.name));
      for (const c of cands) {
        const ref = a.sink.refOf(region, siteName, c.name);
        const st = await a.sink.stat(ref);
        if (!st) continue; // still on the node, not uploaded yet
        // stable size across two looks = the upload finished (an SFTP target shows a file while it is written)
        if (last && last.name === c.name && last.size === st.sizeBytes)
          return this.finishBackup(ctx, node, siteName, t, c.name, ref, st);
        last = { name: c.name, size: st.sizeBytes };
      }
      if (Date.now() + every > deadline)
        return {
          status: 'failed',
          error: normalizedError(
            'provider_outage',
            'archive_missing',
            'the archive did not appear in the off-server store in time',
          ),
          raw: this.ev('backup', 'v-schedule-user-backup sent; no new archive in the store'),
        };
      await this.sleep(every);
    }
  }

  private async finishBackup(
    ctx: AccountContext,
    node: NodeRef,
    siteName: string,
    t: BackupRequest,
    archiveName: string,
    sinkRef: string,
    st: { sizeBytes: number; sha256: string },
  ): Promise<OperationResult<BackupRef>> {
    // what the account holds NOW is the reference the restore is later compared with (domains and databases); a read failure only means there is no snapshot
    const doms = await this.run(node, ctx, 'listWebDomains', { user: siteName });
    const user = await this.lookup(node, ctx, siteName);
    const snapshot =
      doms.ok && user.ok && user.user
        ? { domains: Object.keys(obj(doms.data)).sort(), databases: num(user.user.U_DATABASES) }
        : undefined;
    return {
      status: 'succeeded',
      providerRef: archiveName,
      data: {
        backupId: t.backupId ?? t.operationId,
        sizeBytes: st.sizeBytes,
        checksum: st.sha256,
        sinkRef,
        archiveName,
        encrypted: false,
        manifest: [{ path: archiveName, sha256: st.sha256, bytes: st.sizeBytes }],
        ...(snapshot ? { snapshot } : {}),
      },
      raw: this.ev(
        'backup',
        'v-schedule-user-backup + archive found and measured in the off-server store',
      ),
    };
  }

  async restore(
    ctx: AccountContext,
    node: NodeRef,
    siteName: string,
    backup: BackupRef,
    _t: Tok,
  ): Promise<OperationResult<{ verified: boolean; checksum: string }>> {
    const a = this.o.archives;
    if (!a?.sink.stat)
      return this.unsupported('restore', 'no off-server backup store is configured');
    if (!backup.archiveName || !backup.sinkRef)
      return this.unsupported('restore', 'the backup has no panel archive to restore');
    // 1. integrity BEFORE anything on the node is touched
    const st = await a.sink.stat(backup.sinkRef);
    if (!st)
      return {
        status: 'failed',
        error: normalizedError(
          'not_found',
          'archive_gone',
          'the archive is not in the off-server store',
        ),
        raw: this.ev('restore', 'absent in the store'),
      };
    if (st.sha256 !== backup.checksum)
      return {
        status: 'failed',
        error: normalizedError(
          'validation',
          'checksum',
          'the archive does not match its recorded checksum',
        ),
        raw: this.ev('restore', 'checksum mismatch: nothing was restored'),
      };
    // 2. the archive must be in the node's /backup (documented): already there, or staged
    const onNode = await this.run(node, ctx, 'listBackups', { user: siteName });
    const present = onNode.ok && backup.archiveName in obj(onNode.data);
    if (!present) {
      if (!this.o.stager)
        return this.unsupported(
          'restore',
          'the archive is not on the node and no stager is configured to copy it there',
        );
      const s = await this.o.stager.stage(node, siteName, backup.archiveName, backup.sinkRef);
      if (!s.ok)
        return {
          status: 'failed',
          error: normalizedError(
            'provider_outage',
            'stage',
            s.detail ?? 'the archive could not be staged on the node',
          ),
          raw: this.ev('restore', 'staging failed'),
        };
    }
    // 3. v-restore-user answers when it is done; a lost answer is `uncertain` (the verification below, or the reconciler, settles it)
    const r = await this.client.run(
      node.nodeId,
      'restoreUser',
      {
        user: siteName,
        backup: backup.archiveName,
        web: 'yes',
        dns: 'no',
        mail: 'yes',
        db: 'yes',
        cron: 'yes',
        udir: 'yes',
        notify: 'no',
      },
      this.o.restoreDeadlineMs ?? 900_000,
    );
    if (!r.ok) {
      const settled = r.uncertain ? await this.compare(ctx, node, siteName, backup) : null;
      if (!settled?.verified) return this.fail('restore', r);
    }
    // 4. the account is compared with the snapshot taken when the archive was made
    const v = await this.compare(ctx, node, siteName, backup);
    if (!v.verified)
      return {
        status: 'failed',
        error: normalizedError('unknown', 'restore_unverified', v.reason),
        raw: this.ev('restore', `v-restore-user ran but ${v.reason}`),
      };
    return {
      status: 'succeeded',
      data: { verified: true, checksum: st.sha256 },
      raw: this.ev('restore', 'v-restore-user + account compared with the backup snapshot'),
    };
  }

  private async compare(
    ctx: AccountContext,
    node: NodeRef,
    siteName: string,
    backup: BackupRef,
  ): Promise<{ verified: boolean; reason: string }> {
    const u = await this.lookup(node, ctx, siteName);
    if (!u.ok || !u.user)
      return { verified: false, reason: 'the account is not on the node after the restore' };
    const doms = await this.run(node, ctx, 'listWebDomains', { user: siteName });
    if (!doms.ok)
      return { verified: false, reason: "the account's domains cannot be read after the restore" };
    const have = new Set(Object.keys(obj(doms.data)));
    const missing = (backup.snapshot?.domains ?? []).filter((d) => !have.has(d));
    if (missing.length)
      return {
        verified: false,
        reason: `${missing.length} domain(s) of the backup are missing after the restore`,
      };
    if (backup.snapshot && num(u.user.U_DATABASES) < backup.snapshot.databases)
      return { verified: false, reason: 'fewer databases than the backup held after the restore' };
    return { verified: true, reason: 'ok' };
  }

  // ---- usage ----------------------------------------------------------------------------------------------------------------------
  async usage(
    ctx: AccountContext,
    node: NodeRef,
    siteName: string,
  ): Promise<OperationResult<SiteUsage>> {
    const u = await this.lookup(node, ctx, siteName);
    if (!u.ok) return this.fail('usage', u.res);
    if (!u.user)
      return {
        status: 'failed',
        error: normalizedError('not_found', 'E_NOTEXIST', 'the site does not exist on the node'),
        raw: this.ev('usage', 'absent'),
      };
    return {
      status: 'succeeded',
      data: {
        observedAt: this.now().toISOString(),
        diskBytes: Math.round(num(u.user.U_DISK) * 1024 * 1024), // Hestia reports megabytes
        inodes: 0,
        bandwidthBytesMonth: Math.round(num(u.user.U_BANDWIDTH) * 1024 * 1024),
        cpuSeconds: 0,
        processes: 0,
      },
      raw: this.ev('usage', 'v-list-user'),
    };
  }
}
