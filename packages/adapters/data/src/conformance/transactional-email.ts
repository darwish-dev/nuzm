import {
  TRANSACTIONAL_EMAIL_CAPABILITIES,
  type TransactionalEmailCapabilityId,
} from '../contracts/capabilities';
import {
  WebhookSignatureError,
  type OutboundMessage,
  type TransactionalEmailAdapter,
  type VerifiedEmailEvent,
} from '../contracts/transactional-email';
import { idempotencyToken, type CapabilityState } from '../upstream';
import {
  check,
  commonCases,
  expectOk,
  expectUnsupported,
  type CommonControls,
  type CommonSubject,
  type ConformanceCase,
} from './kit';

export interface EmailControls extends CommonControls {
  billableByToken(token: string): number;
  setCapabilities(p: Partial<Record<TransactionalEmailCapabilityId, CapabilityState>>): void;
  markDomain(ref: string, state: 'pending' | 'verified' | 'failed'): void;
  signWebhook(
    events: VerifiedEmailEvent[],
    at?: Date,
  ): { headers: Record<string, string>; rawBody: string };
  now(): Date;
}
export interface EmailSubject extends CommonSubject<TransactionalEmailAdapter, EmailControls> {
  adapter: TransactionalEmailAdapter;
  fixture: { domain: string };
}
const key = (n: string) => idempotencyToken('org-conformance', `op-${n}`, 'send');
const msg = (s: EmailSubject, local = 'noreply'): OutboundMessage => ({
  from: `${local}@${s.fixture.domain}`,
  to: ['someone@recipient.example'],
  subject: 'Hello',
  html: '<p>Hi</p>',
  tags: { 'nuzm-org': 'conformance' },
});
const verified = async (s: EmailSubject) => {
  const d = expectOk(
    await s.adapter.verifyDomain(s.ctx, s.fixture.domain, key('dom')),
    'verifyDomain',
  ).data!;
  s.controls.markDomain(d.providerRef, 'verified');
  return d;
};
const ev = (id: string, type: VerifiedEmailEvent['type'] = 'delivered'): VerifiedEmailEvent => ({
  providerEventId: id,
  type,
  providerMessageRef: 'm1',
  recipient: 'someone@recipient.example',
  occurredAt: '2026-11-18T08:00:00.000Z',
  payload: {},
});

export const EMAIL_CASES: ConformanceCase<EmailSubject>[] = [
  ...commonCases<TransactionalEmailAdapter, EmailControls, EmailSubject>(
    'transactional-email',
    TRANSACTIONAL_EMAIL_CAPABILITIES,
  ),
  {
    id: 'E01',
    title:
      'verifyDomain is idempotent and returns the required records declaratively (ownership, SPF, DKIM)',
    async run(s) {
      const a = expectOk(
        await s.adapter.verifyDomain(s.ctx, s.fixture.domain, key('e01')),
        'verifyDomain',
      ).data!;
      const b = expectOk(
        await s.adapter.verifyDomain(s.ctx, s.fixture.domain, key('e01')),
        'again',
      ).data!;
      check(a.providerRef === b.providerRef, 'same domain, same provider ref');
      const purposes = new Set(a.requiredRecords.map((r) => r.purpose));
      for (const p of ['ownership', 'spf', 'dkim'] as const)
        check(purposes.has(p), `missing ${p} record`);
      check(
        a.requiredRecords.every((r) => r.name.endsWith(s.fixture.domain) && r.value.length > 0),
        'records are for this domain',
      );
      check(a.state === 'pending', 'a new domain is pending');
    },
  },
  {
    id: 'E02',
    title: 'checkDomain reflects verification; an unknown domain is not_found',
    async run(s) {
      const d = await verified(s);
      check(
        expectOk(await s.adapter.checkDomain(s.ctx, d.providerRef), 'check').data!.state ===
          'verified',
        'verified',
      );
      const r = await s.adapter.checkDomain(s.ctx, 'no-such-ref');
      check(r.status === 'failed' && r.error?.category === 'not_found', 'not_found');
    },
  },
  {
    id: 'E03',
    title:
      'a send from an unverified domain is refused by the provider adapter (failed/validation) and bills nothing',
    async run(s) {
      expectOk(await s.adapter.verifyDomain(s.ctx, s.fixture.domain, key('e03')), 'verifyDomain');
      const r = await s.adapter.send(s.ctx, msg(s), key('e03m'));
      check(
        r.status === 'failed' && r.error?.category === 'validation',
        'unverified domain refused',
      );
      check(s.controls.billableCount() === 0, 'nothing accepted');
    },
  },
  {
    id: 'E04',
    title: 'send is idempotent per key: a replay makes NO second provider send',
    async run(s) {
      await verified(s);
      const a = expectOk(await s.adapter.send(s.ctx, msg(s), key('e04')), 'send').data!;
      const b = expectOk(await s.adapter.send(s.ctx, msg(s), key('e04')), 'replay').data!;
      check(a.providerMessageRef === b.providerMessageRef, 'same provider ref');
      check(
        s.controls.billableCount() === 1 && s.controls.billableByToken(key('e04')) === 1,
        'one provider-accepted message',
      );
    },
  },
  {
    id: 'E05',
    title:
      'a timeout after acceptance is uncertain; findByToken proves it; the retry sends nothing new. A timeout before acceptance is proven absent.',
    async run(s) {
      await verified(s);
      s.controls.inject('send', 'timeout_after_side_effect');
      const r = await s.adapter.send(s.ctx, msg(s), key('e05'));
      check(r.status === 'uncertain', 'uncertain');
      check(
        (await s.adapter.findByToken(s.ctx, key('e05'))).data !== null,
        'found: it was accepted',
      );
      expectOk(await s.adapter.send(s.ctx, msg(s), key('e05')), 'retry');
      check(s.controls.billableCount() === 1, 'one send');
      s.controls.inject('send', 'timeout_before_side_effect');
      const r2 = await s.adapter.send(s.ctx, msg(s), key('e05b'));
      check(
        r2.status === 'uncertain' &&
          (await s.adapter.findByToken(s.ctx, key('e05b'))).data === null,
        'absent',
      );
    },
  },
  {
    id: 'E06',
    title: 'parseWebhook accepts a correctly signed payload inside the replay window',
    async run(s) {
      const { headers, rawBody } = s.controls.signWebhook(
        [ev('evt-1'), ev('evt-2', 'bounce_hard')],
        s.controls.now(),
      );
      const out = s.adapter.parseWebhook(headers, rawBody, s.controls.now());
      check(
        out.length === 2 && out[0]!.providerEventId === 'evt-1' && out[1]!.type === 'bounce_hard',
        'events parsed',
      );
    },
  },
  {
    id: 'E07',
    title:
      'parseWebhook rejects: no signature, a forged signature, a tampered body, a replay outside the window, malformed JSON',
    async run(s) {
      const now = s.controls.now();
      const good = s.controls.signWebhook([ev('evt-3')], now);
      const reason = (fn: () => unknown): string => {
        try {
          fn();
        } catch (e) {
          if (e instanceof WebhookSignatureError) return e.reason;
          throw e;
        }
        return 'accepted';
      };
      check(
        reason(() => s.adapter.parseWebhook({}, good.rawBody, now)) === 'invalid_signature',
        'missing signature',
      );
      const forged = Object.fromEntries(
        Object.entries(good.headers).map(([k, v]) => [k, v.replace(/v1=[0-9a-f]{4}/, 'v1=0000')]),
      );
      check(
        reason(() => s.adapter.parseWebhook(forged, good.rawBody, now)) === 'invalid_signature',
        'forged signature',
      );
      check(
        reason(() =>
          s.adapter.parseWebhook(good.headers, good.rawBody.replace('evt-3', 'evt-X'), now),
        ) === 'invalid_signature',
        'tampered body',
      );
      const old = s.controls.signWebhook([ev('evt-4')], new Date(now.getTime() - 3_600_000));
      check(
        reason(() => s.adapter.parseWebhook(old.headers, old.rawBody, now)) === 'replay_window',
        'replay window',
      );
    },
  },
  {
    id: 'E08',
    title:
      'suppression sync lists provider suppressions; without the capability it is failed/unsupported',
    async run(s) {
      await s.adapter.addSuppression?.(s.ctx, 'Bad@Recipient.example', 'bounce_hard');
      const l = expectOk(await s.adapter.listSuppressions(s.ctx), 'list').data!;
      check(
        l.some((x) => x.address === 'bad@recipient.example' && x.reason === 'bounce_hard'),
        'addresses are normalized to lower case',
      );
      s.controls.setCapabilities({ 'email.suppression-sync': 'unsupported' });
      expectUnsupported(await s.adapter.listSuppressions(s.ctx), 'list');
    },
  },
  {
    id: 'E09',
    title: 'an outage on send is a definitive, retryable failure; nothing is accepted',
    async run(s) {
      await verified(s);
      s.controls.inject('send', 'outage');
      const r = await s.adapter.send(s.ctx, msg(s), key('e09'));
      check(r.status === 'failed' && r.error?.retryable === true, 'retryable failure');
      check(s.controls.billableCount() === 0, 'nothing accepted');
    },
  },
  {
    id: 'E10',
    title:
      'usage reports provider-accepted counts or null (never estimated); unsupported usage is failed/unsupported',
    async run(s) {
      await verified(s);
      expectOk(await s.adapter.send(s.ctx, msg(s), key('e10')), 'send');
      const u = expectOk(
        await s.adapter.usage(s.ctx, { from: '2026-11-18T00:00:00Z', to: '2026-11-19T00:00:00Z' }),
        'usage',
      ).data!;
      check(u.accepted === 1, 'one accepted');
      for (const v of [u.delivered, u.bounced, u.complaints])
        check(v === null || Number.isInteger(v), 'integer or null');
      s.controls.setCapabilities({ 'email.usage': 'unsupported' });
      expectUnsupported(
        await s.adapter.usage(s.ctx, { from: '2026-11-18T00:00:00Z', to: '2026-11-19T00:00:00Z' }),
        'usage',
      );
    },
  },
];
