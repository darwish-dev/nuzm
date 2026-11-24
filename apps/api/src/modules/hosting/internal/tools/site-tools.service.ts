import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import { planOffersRuntime } from '../plans.service';
import { checkCronSchedule, type CronFields } from './cron-schedule';
import { ToolContext, obj, str, type ToolNode, type ToolSite } from './tool-context';

/**
 * The website tools that run on the panel: cron, logs, FTP accounts, password protection, PHP version, and the capability report that says which of them work for a given
 * website, role, plan, panel version and connection state. Every call re-derives the site and its account from the caller's organization; every list is read back from the
 * panel (the panel is the truth, nothing is cached here). NOT VERIFIED against a real Hestia node: only the mock panel (`hestia/mock-server.ts`) answers these commands.
 */
export type ToolId = 'files' | 'cron' | 'logs' | 'ftp' | 'protection' | 'php' | 'mail';
export type ToolReason =
  'role' | 'site_state' | 'connection' | 'panel_version' | 'panel_service' | 'plan';
export interface ToolCapability {
  id: ToolId;
  state: 'available' | 'unavailable';
  reason?: ToolReason;
  /** plan limits and bounds of the tool the screens show */
  limits?: Record<string, number>;
  /** for PHP: the versions the node offers that the plan allows */
  versions?: string[];
  /** every tool is NOT VERIFIED until a human-run probe on a real node (docs/runbooks/node-onboarding.md) */
  verification: 'not_verified';
}
export interface ToolsReport {
  panel: { version: string | null; connection: 'connected' | 'not_configured' | 'unhealthy' };
  tools: ToolCapability[];
}

/** Which permission opens a tool, which optional panel service it needs and the first panel version known to carry it (null = the documentation names none: no gate is claimed). */
const CATALOG: Record<
  ToolId,
  {
    permission: string;
    service?: 'ftp' | 'mail';
    minPanelVersion: string | null;
  }
> = {
  files: { permission: 'hosting:files:read', minPanelVersion: null },
  cron: { permission: 'hosting:cron:manage', minPanelVersion: null },
  logs: { permission: 'hosting:logs:read', minPanelVersion: null },
  ftp: { permission: 'hosting:ftp:manage', service: 'ftp', minPanelVersion: null },
  protection: { permission: 'hosting:protection:manage', minPanelVersion: null },
  php: { permission: 'hosting:site:update', minPanelVersion: null },
  mail: { permission: 'hosting:mail:read', service: 'mail', minPanelVersion: null },
};
const versionAtLeast = (have: string | null, min: string): boolean => {
  if (!have) return false;
  const a = have.split('.').map((x) => parseInt(x, 10) || 0);
  const b = min.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
};

export interface CronJob extends CronFields {
  id: string;
  command: string;
}
export interface FtpAccount {
  domain: string;
  user: string;
  path: string;
}
export interface ProtectionUser {
  domain: string;
  user: string;
}
const CRON_COMMAND = /^[\x20-\x7e]{1,512}$/;
const MAX_LINE = 2000;

export class SiteToolsService {
  constructor(
    private readonly ctx: ToolContext,
    private readonly audit: AuditSink,
  ) {}

  /* ───────────── capabilities ───────────── */
  nodeState(node: ToolNode | null): ToolsReport['panel']['connection'] {
    if (!node || !node.panelConfigured || node.status === 'retired') return 'not_configured';
    return node.health === 'healthy' ? 'connected' : 'unhealthy';
  }

  async capabilities(
    orgId: string,
    siteId: string,
    perms: ReadonlySet<string>,
  ): Promise<ToolsReport> {
    const site = await this.ctx.site(orgId, siteId, false);
    const node = await this.ctx.node(site.nodeId);
    const connection = this.nodeState(node);
    const cfg = this.ctx.cfg;
    const mailboxes = this.ctx.limit(site, 'mailboxes');
    const tools = (Object.keys(CATALOG) as ToolId[]).map((id): ToolCapability => {
      const def = CATALOG[id];
      const base = { id, verification: 'not_verified' as const };
      const no = (reason: ToolReason): ToolCapability => ({
        ...base,
        state: 'unavailable',
        reason,
      });
      if (!perms.has(def.permission)) return no('role');
      if (site.status !== 'active') return no('site_state');
      if (connection !== 'connected') return no('connection');
      if (def.minPanelVersion && !versionAtLeast(node!.panelVersion, def.minPanelVersion))
        return no('panel_version');
      if (def.service && !node!.services?.[def.service]) return no('panel_service');
      if (id === 'mail' && !node!.services?.imap) return no('panel_service');
      switch (id) {
        case 'files':
          return {
            ...base,
            state: 'available',
            limits: {
              uploadMb: Math.min(this.ctx.limit(site, 'uploadMb'), cfg.maxUploadMb),
              editBytes: cfg.maxEditBytes,
              downloadBytes: cfg.maxDownloadBytes,
            },
          };
        case 'cron': {
          const n = this.ctx.limit(site, 'cronJobs');
          return n === 0
            ? no('plan')
            : {
                ...base,
                state: 'available',
                limits: { jobs: n, minIntervalMinutes: cfg.minCronIntervalMinutes },
              };
        }
        case 'logs':
          return {
            ...base,
            state: 'available',
            limits: { linesDefault: cfg.logLinesDefault, linesMax: cfg.logLinesMax },
          };
        case 'ftp': {
          const n = this.ctx.limit(site, 'ftpAccounts');
          return n === 0 ? no('plan') : { ...base, state: 'available', limits: { accounts: n } };
        }
        case 'protection': {
          const n = this.ctx.limit(site, 'protectionUsers');
          return n === 0 ? no('plan') : { ...base, state: 'available', limits: { users: n } };
        }
        case 'php': {
          const versions = node!.runtimes.filter(
            (r) => r.startsWith('php:') && planOffersRuntime(site.plan, r),
          );
          return versions.length === 0 ? no('plan') : { ...base, state: 'available', versions };
        }
        case 'mail':
          return mailboxes === 0
            ? no('plan')
            : {
                ...base,
                state: 'available',
                limits: {
                  mailboxes,
                  aliasesPerMailbox: this.ctx.limit(site, 'mailAliasesPerMailbox'),
                  mailboxQuotaMb: this.ctx.limit(site, 'mailboxQuotaMb'),
                },
              };
      }
    });
    return {
      panel: { version: node?.panelVersion ?? null, connection },
      tools,
    };
  }

  /** The gate of a tool call: the tool must be available for this site (connection, panel service and plan), whatever the screen shows. The permission itself is the route's. */
  async need(site: ToolSite, id: ToolId): Promise<ToolNode> {
    const node = await this.ctx.node(site.nodeId);
    const def = CATALOG[id];
    if (this.nodeState(node) !== 'connected')
      throw new ProblemException('service_unavailable', 'the node is not connected right now');
    if (def.minPanelVersion && !versionAtLeast(node!.panelVersion, def.minPanelVersion))
      throw new ProblemException(
        'unsupported_capability',
        'the node runs a panel version that does not provide this tool',
      );
    if (def.service && !node!.services?.[def.service])
      throw new ProblemException(
        'unsupported_capability',
        'this node does not provide that service',
      );
    return node!;
  }

  private rec(
    orgId: string,
    userId: string,
    siteId: string,
    action: `${string}.${string}.${string}`,
    detail: Record<string, unknown>,
  ) {
    return this.audit.record({
      action,
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'hosting_site', id: siteId },
      outcome: 'success',
      detail,
    });
  }

  /* ───────────── cron ───────────── */
  private async cronJobs(site: ToolSite): Promise<CronJob[]> {
    const d = obj(await this.ctx.run(site, 'listCronJobs', { user: site.account }));
    return Object.entries(d).map(([id, v]) => {
      const j = obj(v);
      return {
        id,
        min: str(j.MIN),
        hour: str(j.HOUR),
        day: str(j.DAY),
        month: str(j.MONTH),
        wday: str(j.WDAY),
        command: str(j.CMD),
      };
    });
  }
  async listCron(orgId: string, siteId: string) {
    const site = await this.ctx.site(orgId, siteId);
    await this.need(site, 'cron');
    return { items: await this.cronJobs(site), limit: this.ctx.limit(site, 'cronJobs') };
  }
  private cronInput(body: Record<string, unknown>): CronFields & { command: string } {
    const f = {} as Record<string, string>;
    for (const k of ['min', 'hour', 'day', 'month', 'wday'] as const) {
      const v = body[k];
      if (typeof v !== 'string' || !/^[0-9*,/-]{1,40}$/.test(v))
        throw new ProblemException('validation_failed', `${k} is not a valid cron field`);
      f[k] = v;
    }
    const problem = checkCronSchedule(
      f as unknown as CronFields,
      this.ctx.cfg.minCronIntervalMinutes,
    );
    if (problem === 'invalid_field')
      throw new ProblemException('validation_failed', 'the schedule is not a valid cron schedule');
    if (problem === 'too_frequent')
      throw new ProblemException(
        'validation_failed',
        `a job may run at most once every ${this.ctx.cfg.minCronIntervalMinutes} minutes`,
      );
    const command = typeof body.command === 'string' ? body.command.trim() : '';
    if (!CRON_COMMAND.test(command))
      throw new ProblemException(
        'validation_failed',
        'the command must be one line of printable characters (at most 512)',
      );
    return { ...(f as unknown as CronFields), command };
  }
  async addCron(orgId: string, userId: string, siteId: string, body: Record<string, unknown>) {
    const site = await this.ctx.site(orgId, siteId);
    await this.need(site, 'cron');
    const input = this.cronInput(body);
    return this.ctx.lock(orgId, siteId, async () => {
      const jobs = await this.cronJobs(site);
      if (jobs.length >= this.ctx.limit(site, 'cronJobs'))
        throw new ProblemException('quota_exceeded', 'the plan allows no more scheduled jobs');
      const id = String(Math.max(0, ...jobs.map((j) => Number(j.id) || 0)) + 1);
      const r = await this.ctx.attempt(site, 'addCronJob', {
        user: site.account,
        ...input,
        job: id,
      });
      if (!r.ok) {
        // a lost answer: the job is there with exactly this command, or it is not (reconcile before any retry)
        if (r.uncertain) {
          const now = await this.cronJobs(site).catch(() => []);
          if (!now.some((j) => j.id === id && j.command === input.command))
            throw this.ctx.problem(r);
        } else throw this.ctx.problem(r);
      }
      await this.rec(orgId, userId, siteId, 'hosting.cron.created', { job: id });
      return { id, ...input };
    });
  }
  async changeCron(
    orgId: string,
    userId: string,
    siteId: string,
    job: string,
    body: Record<string, unknown>,
  ) {
    if (!/^[0-9]{1,6}$/.test(job)) throw new ProblemException('not_found', 'job not found');
    const site = await this.ctx.site(orgId, siteId);
    await this.need(site, 'cron');
    const input = this.cronInput(body);
    return this.ctx.lock(orgId, siteId, async () => {
      if (!(await this.cronJobs(site)).some((j) => j.id === job))
        throw new ProblemException('not_found', 'job not found');
      const r = await this.ctx.attempt(site, 'changeCronJob', {
        user: site.account,
        job,
        ...input,
      });
      if (!r.ok) {
        if (r.uncertain) {
          const now = await this.cronJobs(site).catch(() => []);
          if (!now.some((j) => j.id === job && j.command === input.command))
            throw this.ctx.problem(r);
        } else throw this.ctx.problem(r);
      }
      await this.rec(orgId, userId, siteId, 'hosting.cron.updated', { job });
      return { id: job, ...input };
    });
  }
  async deleteCron(orgId: string, userId: string, siteId: string, job: string) {
    if (!/^[0-9]{1,6}$/.test(job)) throw new ProblemException('not_found', 'job not found');
    const site = await this.ctx.site(orgId, siteId);
    await this.need(site, 'cron');
    await this.ctx.lock(orgId, siteId, async () => {
      if (!(await this.cronJobs(site)).some((j) => j.id === job))
        throw new ProblemException('not_found', 'job not found');
      const r = await this.ctx.attempt(site, 'deleteCronJob', { user: site.account, job });
      if (!r.ok) {
        // a lost answer on a delete: when the job is gone, the delete happened; anything else is an error (a job that vanished meanwhile is a 404)
        const now = r.uncertain ? await this.cronJobs(site).catch(() => null) : null;
        const gone = now !== null && !now.some((j) => j.id === job);
        if (!gone) throw this.ctx.problem(r);
      }
      await this.rec(orgId, userId, siteId, 'hosting.cron.deleted', { job });
    });
  }

  /* ───────────── logs ───────────── */
  async logs(orgId: string, siteId: string, q: { domain?: string; kind?: string; lines?: string }) {
    const kind = q.kind ?? 'error';
    if (kind !== 'access' && kind !== 'error')
      throw new ProblemException('validation_failed', 'kind must be access or error');
    const cfg = this.ctx.cfg;
    let lines = cfg.logLinesDefault;
    if (q.lines !== undefined) {
      if (!/^[0-9]{1,4}$/.test(q.lines) || Number(q.lines) < 1 || Number(q.lines) > cfg.logLinesMax)
        throw new ProblemException(
          'validation_failed',
          `lines must be a number from 1 to ${cfg.logLinesMax}`,
        );
      lines = Number(q.lines);
    }
    const site = await this.ctx.site(orgId, siteId);
    await this.need(site, 'logs');
    const { domain } = await this.ctx.pickDomain(site, q.domain);
    const raw = await this.ctx.run(site, kind === 'access' ? 'accessLog' : 'errorLog', {
      user: site.account,
      domain,
      lines: String(lines),
    });
    let text = typeof raw === 'string' ? raw : '';
    let truncated = false;
    if (Buffer.byteLength(text) > cfg.logBytesMax) {
      text = text.slice(-cfg.logBytesMax);
      truncated = true;
    }
    // the panel is asked for N lines; the answer is cut to N again (a panel that sends more is not trusted) and every line to a bounded length, controls removed
    let out = text
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => l.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, MAX_LINE)); // eslint-disable-line no-control-regex
    if (out.length > lines) {
      out = out.slice(-lines);
      truncated = true;
    }
    return { domain, kind, lines: out, truncated, requested: lines };
  }

  /* ───────────── FTP accounts ───────────── */
  private async domainRows(site: ToolSite): Promise<Record<string, Record<string, unknown>>> {
    const d = obj(await this.ctx.run(site, 'listWebDomains', { user: site.account }));
    return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, obj(v)]));
  }
  private ftpOf(rows: Record<string, Record<string, unknown>>, only?: string): FtpAccount[] {
    const out: FtpAccount[] = [];
    for (const [domain, r] of Object.entries(rows)) {
      if (only && domain !== only) continue;
      const users = str(r.FTP_USER).split(':').filter(Boolean);
      const paths = str(r.FTP_PATH).split(':');
      users.forEach((user, i) => out.push({ domain, user, path: paths[i] || '/public_html' }));
    }
    return out;
  }
  async listFtp(orgId: string, siteId: string) {
    const site = await this.ctx.site(orgId, siteId);
    await this.need(site, 'ftp');
    return {
      items: this.ftpOf(await this.domainRows(site)),
      limit: this.ctx.limit(site, 'ftpAccounts'),
    };
  }
  async addFtp(orgId: string, userId: string, siteId: string, body: Record<string, unknown>) {
    const name = str(body.name);
    const password = str(body.password);
    const path = body.path === undefined ? undefined : str(body.path);
    if (!/^[a-z0-9_]{3,24}$/.test(name))
      throw new ProblemException(
        'validation_failed',
        'name must be 3-24 lowercase letters, digits or _',
      );
    if (!/^[A-Za-z0-9!@#%^*_+=.:-]{12,64}$/.test(password))
      throw new ProblemException(
        'validation_failed',
        'the password must be 12-64 characters from the allowed set',
      );
    if (path !== undefined && !/^(?!.*\.\.)\/[A-Za-z0-9._/-]{0,200}$/.test(path))
      throw new ProblemException(
        'validation_failed',
        'the path must start with / and stay inside the domain',
      );
    const site = await this.ctx.site(orgId, siteId);
    await this.need(site, 'ftp');
    const { domain } = await this.ctx.pickDomain(
      site,
      typeof body.domain === 'string' ? body.domain : undefined,
    );
    return this.ctx.lock(orgId, siteId, async () => {
      const before = this.ftpOf(await this.domainRows(site));
      if (before.length >= this.ctx.limit(site, 'ftpAccounts'))
        throw new ProblemException('quota_exceeded', 'the plan allows no more FTP accounts');
      const r = await this.ctx.attempt(site, 'addFtp', {
        user: site.account,
        domain,
        ftpUser: name,
        password,
        path,
      });
      // the account name the panel really made is read back (Hestia derives it from the site account); the password is never kept
      const after = this.ftpOf(await this.domainRows(site)).filter((a) => a.domain === domain);
      const known = new Set(before.filter((a) => a.domain === domain).map((a) => a.user));
      const made = after.find((a) => !known.has(a.user));
      if (!r.ok && !(r.uncertain && made)) throw this.ctx.problem(r);
      if (!made)
        throw new ProblemException(
          'service_unavailable',
          'the account could not be confirmed on the node',
        );
      await this.rec(orgId, userId, siteId, 'hosting.ftp.created', { domain, user: made.user });
      return made;
    });
  }
  private async ftpAccount(site: ToolSite, domain: string, user: string): Promise<FtpAccount> {
    const a = this.ftpOf(await this.domainRows(site), domain).find((x) => x.user === user);
    if (!a) throw new ProblemException('not_found', 'FTP account not found');
    return a;
  }
  /** `user` is the full account name as listed (`<site account>_<name>`); the panel command takes the short name. */
  private short(site: ToolSite, full: string): string {
    return full.startsWith(`${site.account}_`) ? full.slice(site.account.length + 1) : full;
  }
  async changeFtpPassword(
    orgId: string,
    userId: string,
    siteId: string,
    domain: string,
    user: string,
    password: string,
  ) {
    if (!/^[A-Za-z0-9!@#%^*_+=.:-]{12,64}$/.test(password))
      throw new ProblemException(
        'validation_failed',
        'the password must be 12-64 characters from the allowed set',
      );
    const site = await this.ctx.site(orgId, siteId);
    await this.need(site, 'ftp');
    await this.ctx.pickDomain(site, domain);
    await this.ftpAccount(site, domain, user);
    await this.ctx.run(site, 'changeFtpPassword', {
      user: site.account,
      domain,
      ftpUser: this.short(site, user),
      password,
    });
    await this.rec(orgId, userId, siteId, 'hosting.ftp.password_changed', { domain, user });
  }
  async deleteFtp(orgId: string, userId: string, siteId: string, domain: string, user: string) {
    const site = await this.ctx.site(orgId, siteId);
    await this.need(site, 'ftp');
    await this.ctx.pickDomain(site, domain);
    await this.ftpAccount(site, domain, user);
    await this.ctx.run(site, 'deleteFtp', {
      user: site.account,
      domain,
      ftpUser: this.short(site, user),
    });
    await this.rec(orgId, userId, siteId, 'hosting.ftp.deleted', { domain, user });
  }

  /* ───────────── password protection (HTTP auth) ───────────── */
  private protectionOf(
    rows: Record<string, Record<string, unknown>>,
    only?: string,
  ): ProtectionUser[] {
    const out: ProtectionUser[] = [];
    for (const [domain, r] of Object.entries(rows)) {
      if (only && domain !== only) continue;
      for (const user of str(r.AUTH_USER).split(':').filter(Boolean)) out.push({ domain, user });
    }
    return out;
  }
  async listProtection(orgId: string, siteId: string) {
    const site = await this.ctx.site(orgId, siteId);
    await this.need(site, 'protection');
    const rows = await this.domainRows(site);
    return {
      items: this.protectionOf(rows),
      domains: Object.keys(rows),
      limit: this.ctx.limit(site, 'protectionUsers'),
    };
  }
  async addProtection(
    orgId: string,
    userId: string,
    siteId: string,
    body: Record<string, unknown>,
  ) {
    const user = str(body.user);
    const password = str(body.password);
    if (!/^[a-z0-9_]{3,24}$/.test(user))
      throw new ProblemException(
        'validation_failed',
        'user must be 3-24 lowercase letters, digits or _',
      );
    if (!/^[A-Za-z0-9!@#%^*_+=.:-]{12,64}$/.test(password))
      throw new ProblemException(
        'validation_failed',
        'the password must be 12-64 characters from the allowed set',
      );
    const site = await this.ctx.site(orgId, siteId);
    await this.need(site, 'protection');
    const { domain } = await this.ctx.pickDomain(
      site,
      typeof body.domain === 'string' ? body.domain : undefined,
    );
    return this.ctx.lock(orgId, siteId, async () => {
      const rows = await this.domainRows(site);
      const all = this.protectionOf(rows);
      if (all.length >= this.ctx.limit(site, 'protectionUsers'))
        throw new ProblemException('quota_exceeded', 'the plan allows no more protection users');
      const r = await this.ctx.attempt(site, 'addHttpAuth', {
        user: site.account,
        domain,
        authUser: user,
        password,
      });
      if (!r.ok) {
        const now = r.uncertain
          ? this.protectionOf(await this.domainRows(site).catch(() => ({})), domain)
          : [];
        if (!now.some((x) => x.user === user)) throw this.ctx.problem(r);
      }
      await this.rec(orgId, userId, siteId, 'hosting.protection.user_added', { domain, user });
      return { domain, user };
    });
  }
  async deleteProtection(
    orgId: string,
    userId: string,
    siteId: string,
    domain: string,
    user: string,
  ) {
    const site = await this.ctx.site(orgId, siteId);
    await this.need(site, 'protection');
    await this.ctx.pickDomain(site, domain);
    if (!this.protectionOf(await this.domainRows(site), domain).some((x) => x.user === user))
      throw new ProblemException('not_found', 'protection user not found');
    await this.ctx.run(site, 'deleteHttpAuth', { user: site.account, domain, authUser: user });
    await this.rec(orgId, userId, siteId, 'hosting.protection.user_removed', { domain, user });
  }
}
