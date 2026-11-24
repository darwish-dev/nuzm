import { createHash } from 'node:crypto';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import type { MailDns } from './dns';
import type { SiteToolsService } from './site-tools.service';
import { ToolContext, obj, str, type ToolNode, type ToolSite } from './tool-context';

/**
 * Business email for a website, within the plan's mailbox quota: mailboxes, password and quota changes, aliases, the webmail link, the IMAP/SMTP settings and read-only
 * DNS checks (MX, SPF, DKIM, DMARC, the mail host and PTR).
 *
 * Records are NEVER written by this service: a customer who already has mail somewhere else keeps those records; moving the mail to Nuzm is the customer publishing the
 * records shown here. Mailboxes live on the panel (the site's own Hestia account); the plan quota is counted from the panel under the per-site lock. NOT VERIFIED against a
 * real Hestia node: only the mock panel and the DNS test double have answered these calls; sending and receiving with external providers has not been tested.
 */
const MAIL_PASSWORD = /^[A-Za-z0-9!@#%^*_+=.:-]{12,64}$/;
const LOCAL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export interface Mailbox {
  domain: string;
  name: string;
  address: string;
  /** MB, null = unlimited */
  quotaMb: number | null;
  usedMb: number;
  aliases: string[];
}
export type DnsState = 'ok' | 'missing' | 'mismatch' | 'external';
export interface DnsCheck {
  id: 'mx' | 'spf' | 'dkim' | 'dmarc' | 'mail_host' | 'webmail_host' | 'ptr';
  state: DnsState;
  /** the record to publish when the mail moves to Nuzm */
  expected: { type: string; name: string; value: string } | null;
  found: string[];
}
const ref = (address: string) => createHash('sha256').update(address).digest('hex').slice(0, 12);

export class MailService {
  constructor(
    private readonly ctx: ToolContext,
    private readonly tools: SiteToolsService,
    private readonly audit: AuditSink,
    private readonly dns: MailDns,
  ) {}

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
  private async prepare(
    orgId: string,
    siteId: string,
  ): Promise<{ site: ToolSite; node: ToolNode }> {
    const site = await this.ctx.site(orgId, siteId);
    const node = await this.tools.need(site, 'mail');
    if (this.ctx.limit(site, 'mailboxes') === 0)
      throw new ProblemException(
        'unsupported_capability',
        'the plan does not include business email',
      );
    if (!node.services?.imap)
      throw new ProblemException('unsupported_capability', 'this node does not provide mailboxes');
    return { site, node };
  }
  /** Mail is hosted only on the customer's own domains of this site, never on the platform's placeholder domain. */
  private eligible(domains: string[]) {
    const suffix = `.${this.ctx.cfg.defaultDomainSuffix}`;
    return domains.filter((d) => !d.endsWith(suffix));
  }
  private async mailDomains(site: ToolSite): Promise<string[]> {
    return Object.keys(obj(await this.ctx.run(site, 'listMailDomains', { user: site.account })));
  }
  private async accounts(site: ToolSite, domain: string): Promise<Mailbox[]> {
    const d = obj(await this.ctx.run(site, 'listMailAccounts', { user: site.account, domain }));
    return Object.entries(d).map(([name, v]) => {
      const a = obj(v);
      const q = Number(str(a.QUOTA));
      return {
        domain,
        name,
        address: `${name}@${domain}`,
        quotaMb: Number.isFinite(q) && str(a.QUOTA) !== '' ? q : null,
        usedMb: Number(str(a.U_DISK)) || 0,
        aliases: str(a.ALIAS).split(',').filter(Boolean),
      };
    });
  }
  private async allMailboxes(site: ToolSite): Promise<Mailbox[]> {
    const out: Mailbox[] = [];
    for (const d of await this.mailDomains(site)) out.push(...(await this.accounts(site, d)));
    return out;
  }

  /* ───────────── overview and settings ───────────── */
  async overview(orgId: string, siteId: string) {
    const { site, node } = await this.prepare(orgId, siteId);
    const all = await this.ctx.domains(site);
    const enabled = await this.mailDomains(site);
    const mailboxes: Mailbox[] = [];
    for (const d of enabled) mailboxes.push(...(await this.accounts(site, d)));
    const p = this.ctx.cfg.mailPorts;
    return {
      limits: {
        mailboxes: this.ctx.limit(site, 'mailboxes'),
        aliasesPerMailbox: this.ctx.limit(site, 'mailAliasesPerMailbox'),
        mailboxQuotaMb: this.ctx.limit(site, 'mailboxQuotaMb'),
      },
      used: mailboxes.length,
      domains: this.eligible(all).map((d) => ({ domain: d, enabled: enabled.includes(d) })),
      mailboxes,
      webmail: node.services?.webmail ?? null,
      settings: enabled.map((d) => ({
        domain: d,
        webmailUrl: node.services?.webmail ? `https://webmail.${d}/` : null,
        imap: { host: `mail.${d}`, ssl: p.imapSsl, startTls: p.imapStartTls },
        smtp: { host: `mail.${d}`, ssl: p.smtpSsl, startTls: p.smtpStartTls },
        username: 'the full email address',
        verification: 'not_verified' as const,
      })),
    };
  }

  /* ───────────── domain ───────────── */
  async enableDomain(orgId: string, userId: string, siteId: string, body: Record<string, unknown>) {
    const { site, node } = await this.prepare(orgId, siteId);
    const requested = str(body.domain);
    const all = await this.ctx.domains(site);
    if (!this.eligible(all).includes(requested))
      throw new ProblemException(
        'not_found',
        'the domain is not one of the website domains that can host mail',
      );
    return this.ctx.lock(orgId, siteId, async () => {
      const r = await this.ctx.attempt(site, 'addMailDomain', {
        user: site.account,
        domain: requested,
      });
      let created = true;
      if (!r.ok) {
        if (r.error.providerCode === 'E_EXISTS') created = false;
        else if (!(
          r.uncertain &&
          (await this.mailDomains(site).catch((): string[] => [])).includes(requested)
        ))
          throw this.ctx.problem(r);
      }
      let webmail = false;
      if (node.services?.webmail) {
        const w = await this.ctx.attempt(site, 'addMailWebmail', {
          user: site.account,
          domain: requested,
        });
        webmail = w.ok || (!w.ok && w.error.providerCode === 'E_EXISTS');
      }
      if (created)
        await this.rec(orgId, userId, siteId, 'hosting.mail.domain_enabled', { domain: requested });
      return { domain: requested, created, webmail };
    });
  }

  /* ───────────── mailboxes ───────────── */
  private checkPassword(p: unknown): string {
    if (typeof p !== 'string' || !MAIL_PASSWORD.test(p))
      throw new ProblemException(
        'validation_failed',
        'the password must be 12-64 characters from the allowed set',
      );
    return p;
  }
  private checkQuota(site: ToolSite, v: unknown): number {
    const max = this.ctx.limit(site, 'mailboxQuotaMb');
    if (v === undefined) return max;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max)
      throw new ProblemException(
        'validation_failed',
        `the quota must be a whole number of MB from 1 to ${max}`,
      );
    return v;
  }
  async createMailbox(
    orgId: string,
    userId: string,
    siteId: string,
    body: Record<string, unknown>,
  ) {
    const { site } = await this.prepare(orgId, siteId);
    const name = str(body.name).toLowerCase();
    if (!LOCAL.test(name))
      throw new ProblemException('validation_failed', 'the mailbox name is not valid');
    const password = this.checkPassword(body.password);
    const quota = this.checkQuota(site, body.quotaMb);
    const domain = str(body.domain);
    return this.ctx.lock(orgId, siteId, async () => {
      if (!(await this.mailDomains(site)).includes(domain))
        throw new ProblemException('not_found', 'mail is not enabled for this domain');
      const all = await this.allMailboxes(site);
      if (all.some((m) => m.domain === domain && m.name === name))
        throw new ProblemException('conflict', 'this mailbox exists');
      if (all.length >= this.ctx.limit(site, 'mailboxes'))
        throw new ProblemException('quota_exceeded', 'the plan allows no more mailboxes');
      const r = await this.ctx.attempt(site, 'addMailAccount', {
        user: site.account,
        domain,
        account: name,
        password,
        quota: String(quota),
      });
      if (!r.ok) {
        const there = r.uncertain
          ? (await this.accounts(site, domain).catch((): Mailbox[] => [])).some(
              (m) => m.name === name,
            )
          : false;
        if (!there) throw this.ctx.problem(r);
      }
      await this.rec(orgId, userId, siteId, 'hosting.mail.mailbox_created', {
        domain,
        ref: ref(`${name}@${domain}`),
        quotaMb: quota,
      });
      return { domain, name, address: `${name}@${domain}`, quotaMb: quota };
    });
  }
  private async mailbox(site: ToolSite, domain: string, name: string): Promise<Mailbox> {
    if (!LOCAL.test(name)) throw new ProblemException('not_found', 'mailbox not found');
    if (!(await this.ctx.domains(site)).includes(domain))
      throw new ProblemException('not_found', 'mailbox not found');
    const list = await this.accounts(site, domain).catch((e) => {
      if (e instanceof ProblemException && e.code === 'not_found')
        throw new ProblemException('not_found', 'mailbox not found');
      throw e;
    });
    const m = list.find((x) => x.name === name);
    if (!m) throw new ProblemException('not_found', 'mailbox not found');
    return m;
  }
  async changePassword(
    orgId: string,
    userId: string,
    siteId: string,
    domain: string,
    name: string,
    body: Record<string, unknown>,
  ) {
    const { site } = await this.prepare(orgId, siteId);
    const password = this.checkPassword(body.password);
    await this.mailbox(site, domain, name);
    await this.ctx.run(site, 'changeMailPassword', {
      user: site.account,
      domain,
      account: name,
      password,
    });
    await this.rec(orgId, userId, siteId, 'hosting.mail.mailbox_password_changed', {
      domain,
      ref: ref(`${name}@${domain}`),
    });
  }
  async changeQuota(
    orgId: string,
    userId: string,
    siteId: string,
    domain: string,
    name: string,
    body: Record<string, unknown>,
  ) {
    const { site } = await this.prepare(orgId, siteId);
    if (body.quotaMb === undefined)
      throw new ProblemException('validation_failed', 'quotaMb is required');
    const quota = this.checkQuota(site, body.quotaMb);
    await this.mailbox(site, domain, name);
    await this.ctx.run(site, 'changeMailQuota', {
      user: site.account,
      domain,
      account: name,
      quota: String(quota),
    });
    await this.rec(orgId, userId, siteId, 'hosting.mail.mailbox_quota_changed', {
      domain,
      ref: ref(`${name}@${domain}`),
      quotaMb: quota,
    });
    return { quotaMb: quota };
  }
  async deleteMailbox(orgId: string, userId: string, siteId: string, domain: string, name: string) {
    const { site } = await this.prepare(orgId, siteId);
    await this.ctx.lock(orgId, siteId, async () => {
      await this.mailbox(site, domain, name);
      await this.ctx.run(site, 'deleteMailAccount', { user: site.account, domain, account: name });
      await this.rec(orgId, userId, siteId, 'hosting.mail.mailbox_deleted', {
        domain,
        ref: ref(`${name}@${domain}`),
      });
    });
  }
  async addAlias(
    orgId: string,
    userId: string,
    siteId: string,
    domain: string,
    name: string,
    body: Record<string, unknown>,
  ) {
    const { site } = await this.prepare(orgId, siteId);
    const alias = str(body.alias).toLowerCase();
    if (!LOCAL.test(alias))
      throw new ProblemException('validation_failed', 'the alias is not valid');
    return this.ctx.lock(orgId, siteId, async () => {
      const m = await this.mailbox(site, domain, name);
      if (m.aliases.length >= this.ctx.limit(site, 'mailAliasesPerMailbox'))
        throw new ProblemException(
          'quota_exceeded',
          'the plan allows no more aliases for this mailbox',
        );
      if ((await this.accounts(site, domain)).some((x) => x.name === alias))
        throw new ProblemException('conflict', 'this address is already a mailbox');
      await this.ctx.run(site, 'addMailAlias', {
        user: site.account,
        domain,
        account: name,
        alias,
      });
      await this.rec(orgId, userId, siteId, 'hosting.mail.alias_added', {
        domain,
        ref: ref(`${name}@${domain}`),
      });
      return { alias, address: `${alias}@${domain}` };
    });
  }
  async deleteAlias(
    orgId: string,
    userId: string,
    siteId: string,
    domain: string,
    name: string,
    alias: string,
  ) {
    const { site } = await this.prepare(orgId, siteId);
    const m = await this.mailbox(site, domain, name);
    if (!m.aliases.includes(alias)) throw new ProblemException('not_found', 'alias not found');
    await this.ctx.run(site, 'deleteMailAlias', {
      user: site.account,
      domain,
      account: name,
      alias,
    });
    await this.rec(orgId, userId, siteId, 'hosting.mail.alias_removed', {
      domain,
      ref: ref(`${name}@${domain}`),
    });
  }

  /* ───────────── DNS checks (read only) ───────────── */
  async dnsCheck(orgId: string, siteId: string, domain: string) {
    const { site, node } = await this.prepare(orgId, siteId);
    if (!this.eligible(await this.ctx.domains(site)).includes(domain))
      throw new ProblemException('not_found', 'the domain is not part of this site');
    const enabled = (await this.mailDomains(site)).includes(domain);
    // the mail server's address: where the node's own name points (the platform's knowledge of its server, not a customer input)
    const ips = node.panelHost ? await this.dns.a(node.panelHost) : [];
    const ip = ips[0] ?? null;
    let dkimKey: string | null = null;
    if (enabled) {
      // the expected DKIM key as the panel reports it; a shape that cannot be read is "not compared", never guessed
      const r = await this.ctx.attempt(site, 'listMailDkimDns', { user: site.account, domain });
      if (r.ok) dkimKey = /p=([A-Za-z0-9+/=]{20,})/.exec(JSON.stringify(r.data))?.[1] ?? null;
    }
    const mailHost = `mail.${domain}`;
    const checks: DnsCheck[] = [];
    const mx = await this.dns.mx(domain);
    const mxOurs = mx.some((m) => m.exchange === mailHost);
    checks.push({
      id: 'mx',
      // an MX that points somewhere else is an EXTERNAL mail service: it is kept and reported, never called a failure
      state: mxOurs ? 'ok' : mx.length ? 'external' : 'missing',
      expected: { type: 'MX', name: '@', value: `10 ${mailHost}` },
      found: mx.map((m) => `${m.priority} ${m.exchange}`),
    });
    const mailA = await this.dns.a(mailHost);
    checks.push({
      id: 'mail_host',
      state: !mailA.length ? 'missing' : ip && mailA.includes(ip) ? 'ok' : 'mismatch',
      expected: ip ? { type: 'A', name: 'mail', value: ip } : null,
      found: mailA,
    });
    const webA = await this.dns.a(`webmail.${domain}`);
    checks.push({
      id: 'webmail_host',
      state: !webA.length ? 'missing' : ip && webA.includes(ip) ? 'ok' : 'mismatch',
      expected: ip ? { type: 'A', name: 'webmail', value: ip } : null,
      found: webA,
    });
    const spf = (await this.dns.txt(domain)).filter((t) => t.toLowerCase().startsWith('v=spf1'));
    checks.push({
      id: 'spf',
      state: !spf.length
        ? 'missing'
        : ip && spf.some((t) => t.includes(`ip4:${ip}`))
          ? 'ok'
          : mx.length && !mxOurs
            ? 'external'
            : 'mismatch',
      expected: ip ? { type: 'TXT', name: '@', value: `v=spf1 a mx ip4:${ip} ~all` } : null,
      found: spf,
    });
    const dk = (await this.dns.txt(`mail._domainkey.${domain}`)).filter((t) =>
      t.startsWith('v=DKIM1'),
    );
    checks.push({
      id: 'dkim',
      state: !dk.length
        ? 'missing'
        : dkimKey && !dk.some((t) => t.replace(/\s+/g, '').includes(dkimKey!))
          ? mx.length && !mxOurs
            ? 'external'
            : 'mismatch'
          : 'ok',
      expected: dkimKey
        ? { type: 'TXT', name: 'mail._domainkey', value: `v=DKIM1; k=rsa; p=${dkimKey}` }
        : null,
      found: dk.map((t) => t.slice(0, 120)),
    });
    const dm = (await this.dns.txt(`_dmarc.${domain}`)).filter((t) => t.startsWith('v=DMARC1'));
    checks.push({
      id: 'dmarc',
      state: dm.length ? 'ok' : 'missing',
      expected: {
        type: 'TXT',
        name: '_dmarc',
        value: 'v=DMARC1; p=quarantine; sp=quarantine; adkim=s; aspf=s;',
      },
      found: dm,
    });
    // PTR: only when the mail server is this one; forward-confirmed (the name the address points back to must resolve to the same address)
    let ptr: DnsCheck;
    if (!ip) ptr = { id: 'ptr', state: 'missing', expected: null, found: [] };
    else {
      const names = await this.dns.reverse(ip);
      let confirmed = false;
      for (const n of names) if ((await this.dns.a(n)).includes(ip)) confirmed = true;
      ptr = {
        id: 'ptr',
        state: !names.length ? 'missing' : confirmed ? 'ok' : 'mismatch',
        expected: { type: 'PTR', name: ip, value: mailHost },
        found: names,
      };
    }
    // the reverse name belongs to the server's provider account, not to the customer's zone: it is asked only while the mail runs here
    if (!mxOurs) ptr = { ...ptr, state: ptr.state === 'ok' ? 'ok' : 'external' };
    checks.push(ptr);
    return {
      domain,
      mailEnabled: enabled,
      mailHostingMoved: mxOurs,
      serverIp: ip,
      checks,
      note: 'records are only read here; existing external mail records are kept',
      verification: 'not_verified' as const,
    };
  }
}
