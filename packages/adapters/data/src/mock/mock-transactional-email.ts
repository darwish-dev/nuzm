import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  TRANSACTIONAL_EMAIL_CAPABILITIES,
  completeCapabilities,
  type TransactionalEmailCapabilityId,
} from '../contracts/capabilities';
import type { RequiredDnsRecord, UsageWindow } from '../contracts/common';
import {
  WebhookSignatureError,
  type EmailDomainStatus,
  type EmailUsage,
  type OutboundMessage,
  type ProviderSuppression,
  type SentMessage,
  type TransactionalEmailAdapter,
  type VerifiedEmailEvent,
} from '../contracts/transactional-email';
import type {
  AccountContext,
  DataCatalogSnapshot,
  HealthReport,
  OperationResult,
} from '../upstream';
import { MockCore, sha256, type Clock } from './core';

type Caps = Partial<
  Record<TransactionalEmailCapabilityId, 'supported' | 'unsupported' | 'unknown'>
>;
const ALL_SUPPORTED = Object.fromEntries(
  TRANSACTIONAL_EMAIL_CAPABILITIES.map((c) => [c, 'supported']),
) as Record<TransactionalEmailCapabilityId, 'supported'>;
export const MOCK_WEBHOOK_SECRET = 'mock-webhook-secret-not-a-real-secret';
export const MOCK_WEBHOOK_WINDOW_SECONDS = 300;

/** In-memory `TransactionalEmailAdapter`. No real send ever happens; the "provider" counts what it accepted so replay tests can assert ONE provider call. */
export class MockTransactionalEmailAdapter extends MockCore implements TransactionalEmailAdapter {
  readonly id = 'mock-transactional-email';
  readonly kind = 'transactional-email' as const;
  readonly contractVersion = '1.0.0';
  private readonly domains = new Map<
    string,
    { ref: string; domain: string; state: EmailDomainStatus['state'] }
  >();
  private readonly sent = new Map<string, SentMessage & { message: OutboundMessage }>();
  private readonly suppressions = new Map<string, ProviderSuppression>();
  private seq = 0;
  /** Number of messages the provider actually accepted (what would be billed). */
  providerAccepted = 0;
  constructor(
    clock: Clock,
    private caps: Caps = ALL_SUPPORTED,
  ) {
    super(clock);
  }
  setCapabilities(p: Caps) {
    this.caps = { ...this.caps, ...p };
  }
  private sup(id: TransactionalEmailCapabilityId) {
    return this.caps[id] === 'supported';
  }
  billableCount() {
    return this.providerAccepted;
  }
  billableByToken(t: string) {
    return this.sent.has(t) ? 1 : 0;
  }
  /** Test control: the provider has seen the DNS records. */
  markDomain(ref: string, state: EmailDomainStatus['state']) {
    for (const d of this.domains.values()) if (d.ref === ref) d.state = state;
  }
  sentMessage(key: string) {
    return this.sent.get(key)?.message;
  }
  /** Test control: build a correctly signed webhook delivery (the provider side). */
  signWebhook(
    events: VerifiedEmailEvent[],
    at: Date = new Date(this.clock.now()),
    secret = MOCK_WEBHOOK_SECRET,
  ) {
    const rawBody = JSON.stringify({ events });
    const t = Math.floor(at.getTime() / 1000);
    const v1 = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
    return {
      headers: { 'x-mock-signature': `t=${t},v1=${v1}` } as Record<string, string>,
      rawBody,
    };
  }
  private records(domain: string, ref: string): RequiredDnsRecord[] {
    const h = sha256(ref).slice(0, 10);
    return [
      {
        type: 'TXT',
        name: `_nuzm-verify.${domain}`,
        value: `nuzm-verification=${h}`,
        purpose: 'ownership',
        required: true,
      },
      {
        type: 'TXT',
        name: domain,
        value: 'v=spf1 include:spf.mock.invalid ~all',
        purpose: 'spf',
        required: true,
      },
      {
        type: 'CNAME',
        name: `s1._domainkey.${domain}`,
        value: `s1.dkim.${h}.mock.invalid`,
        purpose: 'dkim',
        required: true,
      },
      {
        type: 'CNAME',
        name: `s2._domainkey.${domain}`,
        value: `s2.dkim.${h}.mock.invalid`,
        purpose: 'dkim',
        required: true,
      },
      {
        type: 'CNAME',
        name: `bounce.${domain}`,
        value: 'rp.mock.invalid',
        purpose: 'return-path',
        required: false,
      },
    ];
  }
  private status(d: {
    ref: string;
    domain: string;
    state: EmailDomainStatus['state'];
  }): EmailDomainStatus {
    return {
      providerRef: d.ref,
      domain: d.domain,
      state: d.state,
      requiredRecords: this.records(d.domain, d.ref),
      checkedAt: this.iso(),
    };
  }
  async probe(_ctx: AccountContext) {
    return {
      capabilities: completeCapabilities(TRANSACTIONAL_EMAIL_CAPABILITIES, this.caps),
      evidence: [this.ev('probe', 'mock')],
      probedAt: this.iso(),
    };
  }
  async health(_ctx: AccountContext): Promise<HealthReport> {
    return {
      state: 'healthy',
      checkedAt: this.iso(),
      detail: 'mock',
      evidence: [this.ev('health', 'mock')],
    };
  }
  async catalog(_ctx: AccountContext): Promise<DataCatalogSnapshot> {
    return {
      takenAt: this.iso(),
      regions: [
        {
          providerRegionId: 'mock-eu-1',
          countryCode: 'IE',
          verifiedAt: null,
          evidence: [this.ev('catalog', 'mock processing location, never verified')],
        },
      ],
      plans: [
        {
          planRef: 'mock-transactional',
          providerRegionId: 'mock-eu-1',
          attributes: {},
          availability: 'available',
          price: { amountMinor: '1', currency: 'SAR', period: 'month' },
        },
      ],
      evidence: [this.ev('catalog', 'mock catalog')],
    };
  }
  verifyDomain(
    _ctx: AccountContext,
    domain: string,
    token: string,
  ): Promise<OperationResult<EmailDomainStatus>> {
    return this.mutating('verifyDomain', () => {
      if (!this.sup('email.domain-verification'))
        return this.fail(
          'verifyDomain',
          'unsupported',
          'UNSUPPORTED',
          'domain verification is not supported',
        );
      let d = this.domains.get(domain);
      if (!d) {
        d = {
          ref: `mockdom-${(++this.seq).toString().padStart(4, '0')}`,
          domain,
          state: 'pending',
        };
        this.domains.set(domain, d);
      }
      void token;
      return this.ok('verifyDomain', 'registered', this.status(d), d.ref);
    });
  }
  checkDomain(_ctx: AccountContext, ref: string): Promise<OperationResult<EmailDomainStatus>> {
    return this.reading('checkDomain', () => {
      const d = [...this.domains.values()].find((x) => x.ref === ref);
      return d
        ? this.ok('checkDomain', 'checked', this.status(d), ref)
        : this.fail('checkDomain', 'not_found', 'NOT_FOUND', 'no such domain');
    });
  }
  send(
    _ctx: AccountContext,
    message: OutboundMessage,
    key: string,
  ): Promise<OperationResult<SentMessage>> {
    return this.mutating('send', () => {
      if (!this.sup('email.send'))
        return this.fail('send', 'unsupported', 'UNSUPPORTED', 'sending is not supported');
      const prev = this.sent.get(key);
      if (prev)
        return this.ok(
          'send',
          'replay: no second send',
          { providerMessageRef: prev.providerMessageRef, acceptedAt: prev.acceptedAt },
          prev.providerMessageRef,
        );
      const fromDomain = message.from.split('@')[1] ?? '';
      const d = this.domains.get(fromDomain);
      if (!d || d.state !== 'verified')
        return this.fail(
          'send',
          'validation',
          'DOMAIN_NOT_VERIFIED',
          'the sender domain is not verified at the provider',
        );
      const m: SentMessage = {
        providerMessageRef: `mockmsg-${sha256(key).slice(0, 16)}`,
        acceptedAt: this.iso(),
      };
      this.sent.set(key, { ...m, message });
      this.providerAccepted++;
      return this.ok('send', 'accepted', m, m.providerMessageRef, 'accepted');
    });
  }
  findByToken(_ctx: AccountContext, key: string): Promise<OperationResult<SentMessage | null>> {
    return this.reading('findByToken', () => {
      const s = this.sent.get(key);
      return this.ok(
        'findByToken',
        s ? 'found' : 'absent',
        s ? { providerMessageRef: s.providerMessageRef, acceptedAt: s.acceptedAt } : null,
      );
    });
  }
  parseWebhook(
    headers: Record<string, string | undefined>,
    rawBody: string,
    now: Date,
  ): VerifiedEmailEvent[] {
    const h = headers['x-mock-signature'];
    const m = h ? /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(h) : null;
    if (!m)
      throw new WebhookSignatureError('invalid_signature', 'missing or malformed signature header');
    const want = createHmac('sha256', MOCK_WEBHOOK_SECRET)
      .update(`${m[1]}.${rawBody}`)
      .digest('hex');
    const a = Buffer.from(m[2]!);
    const w = Buffer.from(want);
    if (a.length !== w.length || !timingSafeEqual(a, w))
      throw new WebhookSignatureError('invalid_signature');
    if (Math.abs(now.getTime() / 1000 - Number(m[1])) > MOCK_WEBHOOK_WINDOW_SECONDS)
      throw new WebhookSignatureError('replay_window');
    let body: { events?: VerifiedEmailEvent[] };
    try {
      body = JSON.parse(rawBody) as { events?: VerifiedEmailEvent[] };
    } catch {
      throw new WebhookSignatureError('malformed');
    }
    if (!Array.isArray(body.events)) throw new WebhookSignatureError('malformed');
    return body.events;
  }
  listSuppressions(
    _ctx: AccountContext,
    since?: string,
  ): Promise<OperationResult<ProviderSuppression[]>> {
    return this.reading('listSuppressions', () => {
      if (!this.sup('email.suppression-sync'))
        return this.fail(
          'listSuppressions',
          'unsupported',
          'UNSUPPORTED',
          'suppression sync is not supported',
        );
      return this.ok(
        'listSuppressions',
        'listed',
        [...this.suppressions.values()].filter((s) => !since || s.since >= since),
      );
    });
  }
  addSuppression(
    _ctx: AccountContext,
    address: string,
    reason: ProviderSuppression['reason'],
  ): Promise<OperationResult<void>> {
    return this.mutating('addSuppression', () => {
      this.suppressions.set(address.toLowerCase(), {
        address: address.toLowerCase(),
        reason,
        since: this.iso(),
      });
      return this.ok('addSuppression', 'added');
    });
  }
  removeSuppression(_ctx: AccountContext, address: string): Promise<OperationResult<void>> {
    return this.mutating('removeSuppression', () => {
      this.suppressions.delete(address.toLowerCase());
      return this.ok('removeSuppression', 'removed');
    });
  }
  usage(_ctx: AccountContext, _w: UsageWindow): Promise<OperationResult<EmailUsage>> {
    return this.reading('usage', () => {
      if (!this.sup('email.usage'))
        return this.fail('usage', 'unsupported', 'UNSUPPORTED', 'usage is not supported');
      return this.ok('usage', 'usage', {
        accepted: this.providerAccepted,
        delivered: null,
        bounced: null,
        complaints: null,
      });
    });
  }
}
