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
 *  - backups, custom certificates, databases (M08), Node.js/Python runtimes and reverse proxies are `unsupported` here (later sprints; never faked);
 *  - the certificate expiry comes from `v-list-web-domain-ssl` (whose answer also carries the private key: it is parsed for `NOT_AFTER` and dropped, never stored or logged).
 */
type Tok = { idempotencyToken: string; operationId: string };

export interface HestiaAdapterOptions {
  vault: VaultPort;
  evidenceKind?: EvidenceKind;
  now?: () => Date;
  /** The Hestia package that carries a site's limits. The default is the package every Hestia installs. */
  packageFor?: (limits: SiteLimits) => string;
  /** Account contact address (Hestia requires one); never a customer's. */
  contactEmailFor?: (account: string) => string;
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
    const state = r.ok
      ? 'healthy'
      : r.error.category === 'auth'
        ? 'degraded'
        : r.uncertain || r.error.category === 'provider_outage'
          ? 'unhealthy'
          : 'unknown';
    return {
      state,
      checkedAt: this.now().toISOString(),
      latencyMs: Date.now() - t0,
      detail: r.ok ? undefined : r.error.providerCode,
      evidence: [this.ev('health', r.summary)],
    };
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
        health: { state: 'healthy', checkedAt: this.now().toISOString() },
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
        package: this.o.packageFor?.(spec.limits) ?? 'default',
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
    patch: { limits?: SiteLimits; runtime?: string; domains?: string[] },
    _t: Tok,
  ): Promise<OperationResult<SiteInfo>> {
    for (const d of patch.domains ?? []) {
      const r = await this.ensureDomain(node, ctx, siteName, d);
      if (!r.ok) return this.fail('updateSite', r);
    }
    if (patch.limits && this.o.packageFor) {
      const r = await this.run(node, ctx, 'changeUserPackage', {
        user: siteName,
        package: this.o.packageFor(patch.limits),
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

  // ---- backups: a later sprint (off-server backup host + restore tests) --------------------------------------------------------------
  async backup(): Promise<OperationResult<BackupRef>> {
    return {
      status: 'failed',
      error: normalizedError(
        'unsupported',
        'backup',
        'backups are not supported by this adapter yet',
      ),
      raw: this.ev('backup', 'unsupported'),
    };
  }
  async restore(): Promise<OperationResult<{ verified: boolean; checksum: string }>> {
    return {
      status: 'failed',
      error: normalizedError(
        'unsupported',
        'restore',
        'restore is not supported by this adapter yet',
      ),
      raw: this.ev('restore', 'unsupported'),
    };
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
