import { MAILBOX_CAPABILITIES, type MailboxCapabilityId } from '../contracts/capabilities';
import type { MailboxAdapter } from '../contracts/mailbox';
import { idempotencyToken, type CapabilityState } from '../upstream';
import {
  check,
  commonCases,
  expectOk,
  expectUnsupported,
  noSecret,
  type CommonControls,
  type CommonSubject,
  type ConformanceCase,
} from './kit';

export interface MailboxControls extends CommonControls {
  billableByToken(token: string): number;
  setCapabilities(p: Partial<Record<MailboxCapabilityId, CapabilityState>>): void;
  markDomain(domain: string, state: 'pending' | 'verified' | 'failed'): void;
  setStorage(ref: string, bytes: number): void;
}
export interface MailboxSubject extends CommonSubject<MailboxAdapter, MailboxControls> {
  adapter: MailboxAdapter;
  fixture: { domain: string };
}
const tok = (n: string) => idempotencyToken('org-conformance', `op-${n}`, 'mailbox');
const spec = (s: MailboxSubject, local: string) => ({
  domain: s.fixture.domain,
  localPart: local,
  quotaMb: 2048,
  tags: { 'nuzm-org': 'conformance' },
});
const make = async (s: MailboxSubject, local: string, n = local) => {
  s.controls.markDomain(s.fixture.domain, 'verified');
  const r = expectOk(
    await s.adapter.provisionMailbox(s.ctx, { ...spec(s, local), idempotencyToken: tok(n) }),
    'provision',
  );
  return { ref: r.providerRef ?? r.data!.providerRef, r };
};

export const MAILBOX_CASES: ConformanceCase<MailboxSubject>[] = [
  ...commonCases<MailboxAdapter, MailboxControls, MailboxSubject>('mailbox', MAILBOX_CAPABILITIES),
  {
    id: 'M01',
    title:
      'dnsRequirements returns MX, SPF, DKIM and ownership records declaratively, plus DMARC guidance (p=none start)',
    async run(s) {
      const d = expectOk(await s.adapter.dnsRequirements(s.ctx, s.fixture.domain), 'dns').data!;
      const purposes = new Set(d.requiredRecords.map((r) => r.purpose));
      for (const p of ['ownership', 'mx', 'spf', 'dkim', 'dmarc'] as const)
        check(purposes.has(p), `missing ${p}`);
      check(
        d.requiredRecords
          .filter((r) => r.type === 'MX')
          .every((r) => typeof r.priority === 'number'),
        'MX records carry a priority',
      );
      check(
        d.requiredRecords.find((r) => r.purpose === 'dmarc')?.value.includes('p=none') === true,
        'DMARC guidance starts at p=none',
      );
      check(d.state === 'pending', 'a new domain is pending');
    },
  },
  {
    id: 'M02',
    title:
      'provisioning needs a verified domain (failed/validation otherwise) and is idempotent per token',
    async run(s) {
      const bad = await s.adapter.provisionMailbox(s.ctx, {
        ...spec(s, 'early'),
        idempotencyToken: tok('m02x'),
      });
      check(
        bad.status === 'failed' && bad.error?.category === 'validation',
        'unverified domain refused',
      );
      const a = await make(s, 'alice', 'm02');
      const b = expectOk(
        await s.adapter.provisionMailbox(s.ctx, {
          ...spec(s, 'alice'),
          idempotencyToken: tok('m02'),
        }),
        'replay',
      );
      check(
        (b.providerRef ?? b.data?.providerRef) === a.ref && s.controls.billableCount() === 1,
        'one mailbox',
      );
    },
  },
  {
    id: 'M03',
    title:
      'timeout after the side effect is uncertain; findByToken reconciles; the retry creates nothing new',
    async run(s) {
      s.controls.markDomain(s.fixture.domain, 'verified');
      s.controls.inject('provisionMailbox', 'timeout_after_side_effect');
      const r = await s.adapter.provisionMailbox(s.ctx, {
        ...spec(s, 'bob'),
        idempotencyToken: tok('m03'),
      });
      check(r.status === 'uncertain', 'uncertain');
      check((await s.adapter.findByToken(s.ctx, tok('m03'))).data?.providerRef, 'found');
      expectOk(
        await s.adapter.provisionMailbox(s.ctx, {
          ...spec(s, 'bob'),
          idempotencyToken: tok('m03'),
        }),
        'retry',
      );
      check(s.controls.billableCount() === 1, 'one mailbox');
    },
  },
  {
    id: 'M04',
    title:
      'password setup is a reset link or a one-time secret; the secret never appears in evidence; the same address twice is a conflict',
    async run(s) {
      const { r } = await make(s, 'carol');
      const ps = r.data!.passwordSetup;
      check(
        ps.kind === 'reset_link' || ps.kind === 'one_time_secret',
        'a password setup path is required',
      );
      if (ps.kind === 'one_time_secret') noSecret(r, [ps.secret], 'provisionMailbox');
      const dup = await s.adapter.provisionMailbox(s.ctx, {
        ...spec(s, 'carol'),
        idempotencyToken: tok('m04-other'),
      });
      check(
        dup.status === 'failed' && dup.error?.category === 'conflict',
        'duplicate address is a conflict',
      );
    },
  },
  {
    id: 'M05',
    title: 'without reset-link support the adapter falls back to a one-time secret',
    async run(s) {
      s.controls.setCapabilities({
        'mailbox.reset-link': 'unsupported',
        'mailbox.one-time-secret': 'supported',
      });
      const { r } = await make(s, 'dave');
      check(r.data!.passwordSetup.kind === 'one_time_secret', 'one-time secret fallback');
    },
  },
  {
    id: 'M06',
    title: 'aliases: add and remove; quota: set; unsupported capabilities are failed/unsupported',
    async run(s) {
      const { ref } = await make(s, 'erin');
      expectOk(await s.adapter.addAlias(s.ctx, ref, 'sales', tok('m06a')), 'alias');
      check(
        expectOk(await s.adapter.inspectMailbox(s.ctx, ref), 'inspect').data!.aliases.includes(
          'sales',
        ),
        'alias present',
      );
      expectOk(await s.adapter.removeAlias(s.ctx, ref, 'sales'), 'remove alias');
      expectOk(await s.adapter.setQuota(s.ctx, ref, 4096, tok('m06q')), 'quota');
      check(
        expectOk(await s.adapter.inspectMailbox(s.ctx, ref), 'inspect').data!.quotaMb === 4096,
        'quota changed',
      );
      s.controls.setCapabilities({
        'mailbox.alias': 'unsupported',
        'mailbox.quota': 'unsupported',
      });
      expectUnsupported(await s.adapter.addAlias(s.ctx, ref, 'x', tok('m06b')), 'alias');
      expectUnsupported(await s.adapter.setQuota(s.ctx, ref, 1, tok('m06c')), 'quota');
    },
  },
  {
    id: 'M07',
    title: 'delete is idempotent and the mailbox is no longer billable',
    async run(s) {
      const { ref } = await make(s, 'frank');
      expectOk(await s.adapter.deleteMailbox(s.ctx, ref, tok('m07')), 'delete');
      expectOk(await s.adapter.deleteMailbox(s.ctx, ref, tok('m07')), 'delete again');
      check(s.controls.billableCount() === 0, 'not billable');
      check((await s.adapter.findByToken(s.ctx, tok('frank'))).data === null, 'not found');
    },
  },
  {
    id: 'M08',
    title:
      'usage: storage is reported per mailbox or null when the provider cannot report it (never estimated)',
    async run(s) {
      const { ref } = await make(s, 'gina');
      s.controls.setStorage(ref, 12345);
      const u = expectOk(
        await s.adapter.usage(s.ctx, { from: '2026-11-18T00:00:00Z', to: '2026-11-19T00:00:00Z' }),
        'usage',
      ).data!;
      check(u.find((x) => x.providerRef === ref)?.storageBytes === 12345, 'exact storage');
      s.controls.setCapabilities({ 'mailbox.usage.storage': 'unsupported' });
      const u2 = expectOk(
        await s.adapter.usage(s.ctx, { from: '2026-11-18T00:00:00Z', to: '2026-11-19T00:00:00Z' }),
        'usage',
      ).data!;
      check(u2.find((x) => x.providerRef === ref)?.storageBytes === null, 'null, not an estimate');
    },
  },
];
