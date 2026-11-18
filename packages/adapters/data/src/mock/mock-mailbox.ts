import {
  MAILBOX_CAPABILITIES,
  completeCapabilities,
  type MailboxCapabilityId,
} from '../contracts/capabilities';
import type { RequiredDnsRecord, UsageWindow } from '../contracts/common';
import type {
  MailDomainStatus,
  MailboxAdapter,
  MailboxInspection,
  MailboxRef,
  MailboxSpec,
  MailboxUsageRow,
  ProvisionedMailbox,
} from '../contracts/mailbox';
import type {
  AccountContext,
  DataCatalogSnapshot,
  HealthReport,
  OperationResult,
} from '../upstream';
import { MockCore, sha256, type Clock } from './core';

type Caps = Partial<Record<MailboxCapabilityId, 'supported' | 'unsupported' | 'unknown'>>;
const ALL_SUPPORTED = Object.fromEntries(
  MAILBOX_CAPABILITIES.map((c) => [c, 'supported']),
) as Record<MailboxCapabilityId, 'supported'>;
interface Mbx {
  ref: string;
  token: string;
  address: string;
  domain: string;
  quotaMb: number;
  aliases: Set<string>;
  state: MailboxInspection['state'];
  storageBytes: number;
}

/** In-memory `MailboxAdapter`. NOT VERIFIED (mock): no mailbox provider is selected (D-09). */
export class MockMailboxAdapter extends MockCore implements MailboxAdapter {
  readonly id = 'mock-mailbox';
  readonly kind = 'mailbox' as const;
  readonly contractVersion = '1.0.0';
  private readonly boxes = new Map<string, Mbx>();
  private readonly byToken = new Map<string, string>();
  private readonly domainState = new Map<string, MailDomainStatus['state']>();
  private seq = 0;
  constructor(
    clock: Clock,
    private caps: Caps = ALL_SUPPORTED,
  ) {
    super(clock);
  }
  setCapabilities(p: Caps) {
    this.caps = { ...this.caps, ...p };
  }
  private sup(id: MailboxCapabilityId) {
    return this.caps[id] === 'supported';
  }
  billableCount() {
    return [...this.boxes.values()].filter((b) => b.state !== 'deleted').length;
  }
  billableByToken(t: string) {
    const r = this.byToken.get(t);
    return r && this.boxes.get(r)?.state !== 'deleted' ? 1 : 0;
  }
  markDomain(domain: string, state: MailDomainStatus['state']) {
    this.domainState.set(domain, state);
  }
  setStorage(ref: string, bytes: number) {
    this.boxes.get(ref)!.storageBytes = bytes;
  }
  private records(domain: string): RequiredDnsRecord[] {
    const h = sha256(domain).slice(0, 10);
    return [
      {
        type: 'TXT',
        name: `_nuzm-verify.${domain}`,
        value: `nuzm-verification=${h}`,
        purpose: 'ownership',
        required: true,
      },
      {
        type: 'MX',
        name: domain,
        value: 'mx1.mock.invalid',
        priority: 10,
        purpose: 'mx',
        required: true,
      },
      {
        type: 'MX',
        name: domain,
        value: 'mx2.mock.invalid',
        priority: 20,
        purpose: 'mx',
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
        name: `mock._domainkey.${domain}`,
        value: `mock.dkim.${h}.mock.invalid`,
        purpose: 'dkim',
        required: true,
      },
      {
        type: 'TXT',
        name: `_dmarc.${domain}`,
        value: 'v=DMARC1; p=none',
        purpose: 'dmarc',
        required: false,
      },
    ];
  }
  private dom(domain: string): MailDomainStatus {
    return {
      domain,
      state: this.domainState.get(domain) ?? 'pending',
      requiredRecords: this.records(domain),
      checkedAt: this.iso(),
    };
  }
  async probe(_ctx: AccountContext) {
    return {
      capabilities: completeCapabilities(MAILBOX_CAPABILITIES, this.caps),
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
      regions: [],
      plans: [
        {
          planRef: 'mock-mailbox-5g',
          providerRegionId: null,
          attributes: { quotaMb: 5120 },
          availability: 'available',
          price: { amountMinor: '500', currency: 'SAR', period: 'month' },
        },
      ],
      evidence: [this.ev('catalog', 'mock catalog')],
    };
  }
  dnsRequirements(
    _ctx: AccountContext,
    domain: string,
  ): Promise<OperationResult<MailDomainStatus>> {
    return this.reading('dnsRequirements', () =>
      this.sup('mailbox.dns-requirements')
        ? this.ok('dnsRequirements', 'records', this.dom(domain))
        : this.fail(
            'dnsRequirements',
            'unsupported',
            'UNSUPPORTED',
            'dns requirements are not supported',
          ),
    );
  }
  checkDomain(_ctx: AccountContext, domain: string): Promise<OperationResult<MailDomainStatus>> {
    return this.reading('checkDomain', () => this.ok('checkDomain', 'checked', this.dom(domain)));
  }
  provisionMailbox(
    _ctx: AccountContext,
    req: MailboxSpec & { idempotencyToken: string },
  ): Promise<OperationResult<ProvisionedMailbox>> {
    return this.mutating('provisionMailbox', () => {
      if (!this.sup('mailbox.provision'))
        return this.fail(
          'provisionMailbox',
          'unsupported',
          'UNSUPPORTED',
          'mailboxes are not supported',
        );
      const prior = this.byToken.get(req.idempotencyToken);
      const address = `${req.localPart}@${req.domain}`;
      if (prior) {
        const b = this.boxes.get(prior)!;
        return this.ok(
          'provisionMailbox',
          'replay',
          { providerRef: b.ref, address: b.address, passwordSetup: this.setup(b.ref) },
          b.ref,
          'accepted',
        );
      }
      if ([...this.boxes.values()].some((b) => b.address === address && b.state !== 'deleted'))
        return this.fail('provisionMailbox', 'conflict', 'EXISTS', 'the mailbox already exists');
      if (this.domainState.get(req.domain) !== 'verified')
        return this.fail(
          'provisionMailbox',
          'validation',
          'DOMAIN_NOT_VERIFIED',
          'the domain is not verified',
        );
      const ref = `mockmbx-${(++this.seq).toString().padStart(4, '0')}`;
      this.boxes.set(ref, {
        ref,
        token: req.idempotencyToken,
        address,
        domain: req.domain,
        quotaMb: req.quotaMb,
        aliases: new Set(),
        state: 'active',
        storageBytes: 0,
      });
      this.byToken.set(req.idempotencyToken, ref);
      return this.ok(
        'provisionMailbox',
        'created',
        { providerRef: ref, address, passwordSetup: this.setup(ref) },
        ref,
        'accepted',
      );
    });
  }
  private setup(ref: string): ProvisionedMailbox['passwordSetup'] {
    return this.sup('mailbox.reset-link')
      ? {
          kind: 'reset_link',
          url: `https://mail.mock.invalid/reset/${sha256(ref).slice(0, 24)}`,
          expiresAt: new Date(this.clock.now() + 86_400_000).toISOString(),
        }
      : { kind: 'one_time_secret', secret: `mock-secret-${sha256(ref).slice(0, 20)}` };
  }
  findByToken(_ctx: AccountContext, token: string): Promise<OperationResult<MailboxRef | null>> {
    return this.reading('findByToken', () => {
      const r = this.byToken.get(token);
      const b = r ? this.boxes.get(r) : undefined;
      return this.ok(
        'findByToken',
        b && b.state !== 'deleted' ? 'found' : 'absent',
        b && b.state !== 'deleted' ? { providerRef: b.ref } : null,
      );
    });
  }
  inspectMailbox(_ctx: AccountContext, ref: string): Promise<OperationResult<MailboxInspection>> {
    return this.reading('inspectMailbox', () => {
      const b = this.boxes.get(ref);
      if (!b) return this.fail('inspectMailbox', 'not_found', 'NOT_FOUND', 'no such mailbox');
      return this.ok('inspectMailbox', 'inspected', {
        providerRef: ref,
        address: b.address,
        state: b.state,
        quotaMb: b.quotaMb,
        aliases: [...b.aliases],
        observedAt: this.iso(),
      });
    });
  }
  addAlias(
    _ctx: AccountContext,
    ref: string,
    alias: string,
    _t: string,
  ): Promise<OperationResult<void>> {
    return this.mutating('addAlias', () => {
      if (!this.sup('mailbox.alias'))
        return this.fail('addAlias', 'unsupported', 'UNSUPPORTED', 'aliases are not supported');
      const b = this.boxes.get(ref);
      if (!b || b.state === 'deleted')
        return this.fail('addAlias', 'not_found', 'NOT_FOUND', 'no such mailbox');
      b.aliases.add(alias);
      return this.ok('addAlias', 'alias added');
    });
  }
  removeAlias(_ctx: AccountContext, ref: string, alias: string): Promise<OperationResult<void>> {
    return this.mutating('removeAlias', () => {
      this.boxes.get(ref)?.aliases.delete(alias);
      return this.ok('removeAlias', 'alias removed');
    });
  }
  setQuota(
    _ctx: AccountContext,
    ref: string,
    quotaMb: number,
    _t: string,
  ): Promise<OperationResult<void>> {
    return this.mutating('setQuota', () => {
      if (!this.sup('mailbox.quota'))
        return this.fail('setQuota', 'unsupported', 'UNSUPPORTED', 'quotas are not supported');
      const b = this.boxes.get(ref);
      if (!b) return this.fail('setQuota', 'not_found', 'NOT_FOUND', 'no such mailbox');
      b.quotaMb = quotaMb;
      return this.ok('setQuota', 'quota set');
    });
  }
  suspendMailbox(_ctx: AccountContext, ref: string): Promise<OperationResult<void>> {
    return this.mutating('suspendMailbox', () => {
      if (!this.sup('mailbox.suspend'))
        return this.fail(
          'suspendMailbox',
          'unsupported',
          'UNSUPPORTED',
          'suspension is not supported',
        );
      const b = this.boxes.get(ref);
      if (!b) return this.fail('suspendMailbox', 'not_found', 'NOT_FOUND', 'no such mailbox');
      b.state = 'suspended';
      return this.ok('suspendMailbox', 'suspended');
    });
  }
  deleteMailbox(_ctx: AccountContext, ref: string, _t: string): Promise<OperationResult<void>> {
    return this.mutating('deleteMailbox', () => {
      if (!this.sup('mailbox.delete'))
        return this.fail(
          'deleteMailbox',
          'unsupported',
          'UNSUPPORTED',
          'deletion is not supported',
        );
      const b = this.boxes.get(ref);
      if (b) b.state = 'deleted';
      return this.ok('deleteMailbox', 'deleted');
    });
  }
  usage(_ctx: AccountContext, _w: UsageWindow): Promise<OperationResult<MailboxUsageRow[]>> {
    return this.reading('usage', () =>
      this.ok(
        'usage',
        'usage',
        [...this.boxes.values()]
          .filter((b) => b.state !== 'deleted')
          .map((b) => ({
            providerRef: b.ref,
            storageBytes: this.sup('mailbox.usage.storage') ? b.storageBytes : null,
          })),
      ),
    );
  }
}
