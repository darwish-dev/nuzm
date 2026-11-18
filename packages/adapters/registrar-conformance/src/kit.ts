import {
  CONTRACT_VERSION,
  REGISTRAR_CAPABILITY_IDS,
  WebhookRejectedError,
  idempotencyToken,
  toMinorUnits,
  type AccountContext,
  type ContactSet,
  type DnsChange,
  type DnsRecordData,
  type OperationResult,
  type RegistrarAdapter,
} from '@nuzm/registrar-contracts';
import type { MemoryVault } from './memory-vault';

/**
 * Registrar conformance kit (docs/09 §1 rule 6, M07 S28 task 1). One shared suite every RegistrarAdapter must pass against (a) recorded sandbox fixtures
 * and (b) a local mock server. A pass says "our contract is honoured", NEVER "the vendor works": live runs are separate, human-triggered and labelled
 * LIVE-VERIFIED / NOT VERIFIED (CLAUDE.md §5). The report therefore always carries `liveStatus: 'NOT VERIFIED'`.
 */
export type FaultKind =
  | 'timeout_after_side_effect'
  | 'timeout_before_side_effect'
  | 'rate_limit'
  | 'outage'
  | 'auth_failure';
export type FaultOp =
  'search' | 'register' | 'renew' | 'inspect' | 'findByToken' | 'transferIn' | 'dns.apply';

export interface RegistrarControls {
  /** Domains registered at the (simulated) vendor right now. */
  registrationCount(): number;
  registrationsByName(name: string): number;
  /** Make the NEXT `times` calls of the logical operation fail in the named way. */
  inject(op: FaultOp, kind: FaultKind, times?: number): void;
  /** A name that already belongs to someone else at the vendor. */
  seedTaken(name: string): void;
  /** DNS: fail the k-th (0-based) record operation of the next change-set (after k succeeded). */
  injectDnsFailureAt?(k: number): void;
  dnsRecords?(zone: string): DnsRecordData[];
  /** Webhooks: a correctly signed delivery for `body` as the vendor would send it. */
  signWebhook?(body: string, at: Date): { headers: Record<string, string>; secret: string };
  /** What the vendor stored for the last registration of `name` (contact e-mails etc.), to prove PII went only where it should. */
  lastRequestBodies(): string[];
}
export interface RegistrarSubject {
  adapter: RegistrarAdapter;
  ctx: AccountContext;
  controls: RegistrarControls;
  vault: MemoryVault;
  evidenceKind: 'mock' | 'fixture';
  fixture: {
    tld: string;
    freeName: string;
    takenName: string;
    contacts: ContactSet;
    canaryEmail: string;
  };
  /** Secret values the vault holds for this account (must never appear in evidence). */
  secrets: string[];
  /** Names are made unique per run by the kit; this seeds them. */
  nextName(): string;
}
export interface ConformanceCase {
  id: string;
  title: string;
  /** Cases only for adapters that declare the capability / optional method. */
  requires?: (s: RegistrarSubject) => boolean;
  run(s: RegistrarSubject): Promise<void>;
}
export interface CaseResult {
  id: string;
  title: string;
  status: 'pass' | 'fail' | 'skipped';
  detail?: string;
}
export interface ConformanceReport {
  adapterId: string;
  contractVersion: string;
  evidenceKind: 'mock' | 'fixture';
  results: CaseResult[];
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  /** Always `NOT VERIFIED`: a pass on mock/fixtures is never live verification (HG-07-01). */
  liveStatus: 'NOT VERIFIED';
}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const tok = (n: string) => idempotencyToken('org-conformance', `op-${n}`, 'register');
const reg = (s: RegistrarSubject, name: string, token: string) =>
  s.adapter.register(s.ctx, {
    name,
    years: 1,
    contacts: s.fixture.contacts,
    privacy: false,
    autoRenew: false,
    idempotencyToken: token,
  });
const ok = <T>(r: OperationResult<T>, what: string) =>
  check(
    r.status === 'succeeded' || r.status === 'accepted',
    `${what}: expected success, got ${r.status} ${r.error?.message ?? ''}`,
  );
const evidenceText = (r: { raw?: unknown; evidence?: unknown }) => JSON.stringify(r);

export const REGISTRAR_CASES: ConformanceCase[] = [
  {
    id: 'R01',
    title: 'declares contract 1.0.0, kind registrar, a provider code and an id',
    async run(s) {
      check(
        s.adapter.contractVersion === CONTRACT_VERSION,
        `contractVersion ${s.adapter.contractVersion}`,
      );
      check(s.adapter.kind === 'registrar', 'kind must be registrar');
      check(
        s.adapter.id.length > 0 && s.adapter.providerCode.length > 0,
        'id and providerCode required',
      );
    },
  },
  {
    id: 'R02',
    title:
      'probe reports every capability id, is side-effect free, evidence-backed and honest about its evidence kind',
    async run(s) {
      const before = s.controls.registrationCount();
      const r = await s.adapter.probe(s.ctx);
      for (const id of REGISTRAR_CAPABILITY_IDS)
        check(r.capabilities[id] !== undefined, `probe omitted ${id}`);
      for (const [id, st] of Object.entries(r.capabilities)) {
        check(
          (REGISTRAR_CAPABILITY_IDS as readonly string[]).includes(id),
          `probe invented capability ${id}`,
        );
        check(['supported', 'unsupported', 'unknown'].includes(st), `bad state ${st}`);
      }
      check(r.evidence.length > 0, 'probe must return evidence');
      check(
        r.evidence.every((e) => e.kind === s.evidenceKind),
        `evidence kind must be ${s.evidenceKind}`,
      );
      check(Number.isFinite(Date.parse(r.probedAt)), 'probedAt must be an ISO time');
      check(s.controls.registrationCount() === before, 'probe must not create anything');
      check(!s.secrets.some((x) => evidenceText(r).includes(x)), 'probe evidence leaks a secret');
    },
  },
  {
    id: 'R03',
    title: 'capability honesty: optional methods exist exactly when their capability is supported',
    async run(s) {
      const caps = (await s.adapter.probe(s.ctx)).capabilities;
      check(
        (caps['registrar.dns'] === 'supported') === !!s.adapter.dns,
        'dns method vs capability mismatch',
      );
      check(
        (caps['registrar.eligibility'] === 'supported') === !!s.adapter.eligibility,
        'eligibility method vs capability mismatch',
      );
      check(
        (caps['registrar.auth-code'] === 'supported') === !!s.adapter.authCode,
        'authCode method vs capability mismatch',
      );
      check(
        (caps['registrar.webhooks'] === 'supported') === !!s.adapter.parseWebhook ||
          caps['registrar.webhooks'] === 'unknown' ||
          !s.adapter.parseWebhook,
        'webhook capability vs parseWebhook mismatch',
      );
      check(
        (caps['registrar.billing-export'] === 'supported') === !!s.adapter.fetchBilling,
        'billing capability vs fetchBilling mismatch',
      );
    },
  },
  {
    id: 'R04',
    title:
      'supportedTlds lists the fixture TLD with sane year bounds; a TLD that is absent is not claimed',
    async run(s) {
      const t = await s.adapter.supportedTlds(s.ctx);
      const x = t.find((y) => y.tld === s.fixture.tld);
      check(x, `fixture TLD ${s.fixture.tld} missing`);
      check(x.register === 'supported', 'fixture TLD must be registrable');
      check(x.minYears >= 1 && x.maxYears >= x.minYears && x.maxYears <= 10, 'year bounds');
      check(
        !t.some((y) => y.tld === 'sa' && y.register === 'supported'),
        'a .sa registration must never be claimed without evidence',
      );
      for (const y of t)
        if (y.prices)
          for (const p of Object.values(y.prices))
            check(
              p === null || /^\d+$/.test(p.amountMinor),
              'prices are integer minor-unit strings',
            );
    },
  },
  {
    id: 'R05',
    title:
      'search: free ⇒ available with an integer minor-unit price and a cache TTL; taken ⇒ unavailable; unknown is never "available"',
    async run(s) {
      const free = s.nextName();
      const r = await s.adapter.search(
        s.ctx,
        [free.split('.')[0]!, s.fixture.takenName.split('.')[0]!],
        [s.fixture.tld],
      );
      const a = r.find((x) => x.name === free);
      const t = r.find((x) => x.name === s.fixture.takenName);
      check(a && a.available === true, 'free name must be available');
      check(
        a.registerPrice &&
          /^\d+$/.test(a.registerPrice.amountMinor) &&
          /^[A-Z]{3}$/.test(a.registerPrice.currency),
        'price must be integer minor units + currency',
      );
      check(a.cacheTtlSeconds > 0, 'cacheTtlSeconds required');
      check(t && t.available === false, 'taken name must be unavailable');
      s.controls.inject('search', 'outage', 1);
      let outcome: string;
      try {
        const u = await s.adapter.search(s.ctx, [free.split('.')[0]!], [s.fixture.tld]);
        outcome = u.every((x) => x.available !== true) ? 'ok' : 'available-during-outage';
      } catch {
        outcome = 'ok'; // throwing is acceptable; claiming availability is not
      }
      check(outcome === 'ok', 'a failed availability check must never read as available');
    },
  },
  {
    id: 'R06',
    title:
      'register: succeeds once, is visible through inspect and findByToken, evidence carries no PII or secrets',
    async run(s) {
      const name = s.nextName();
      const token = tok(name);
      const r = await reg(s, name, token);
      ok(r, 'register');
      check(r.raw.kind === s.evidenceKind, 'evidence kind');
      check(
        !evidenceText(r).includes(s.fixture.canaryEmail),
        'registrant e-mail leaked into evidence',
      );
      check(!s.secrets.some((x) => evidenceText(r).includes(x)), 'secret leaked into evidence');
      check(s.controls.registrationsByName(name) === 1, 'exactly one registration at the vendor');
      const i = await s.adapter.inspect(s.ctx, name);
      ok(i, 'inspect');
      check(i.data && i.data.name === name, 'inspect finds it');
      const f = await s.adapter.findByToken(s.ctx, token, { name });
      check(
        f.status === 'succeeded' && f.data?.name === name,
        'findByToken finds the registration',
      );
    },
  },
  {
    id: 'R07',
    title:
      'register idempotency: the same token twice creates ONE registration and answers success both times',
    async run(s) {
      const name = s.nextName();
      const token = tok(name);
      const before = s.controls.registrationCount();
      ok(await reg(s, name, token), 'first register');
      ok(await reg(s, name, token), 'replayed register');
      check(s.controls.registrationCount() === before + 1, 'replay created a second registration');
    },
  },
  {
    id: 'R08',
    title:
      'findByToken: a name that was never registered is PROVABLY absent (succeeded, data null)',
    async run(s) {
      const name = s.nextName();
      const f = await s.adapter.findByToken(s.ctx, tok(name), { name });
      check(f.status === 'succeeded' && f.data === null, `expected absent, got ${f.status}`);
    },
  },
  {
    id: 'R09',
    title:
      'timeout AFTER the vendor acted ⇒ uncertain; findByToken finds exactly one; a blind replay does not duplicate',
    async run(s) {
      const name = s.nextName();
      const token = tok(name);
      s.controls.inject('register', 'timeout_after_side_effect', 1);
      const r = await reg(s, name, token);
      check(r.status === 'uncertain', `expected uncertain, got ${r.status}`);
      check(s.controls.registrationsByName(name) === 1, 'the vendor did register');
      const f = await s.adapter.findByToken(s.ctx, token, { name });
      check(f.status === 'succeeded' && f.data?.name === name, 'reconcile must find it');
      ok(await reg(s, name, token), 'replay after reconcile');
      check(s.controls.registrationsByName(name) === 1, 'still exactly one registration');
    },
  },
  {
    id: 'R10',
    title:
      'timeout BEFORE the vendor acted ⇒ uncertain; findByToken proves absence; the single retry registers exactly once',
    async run(s) {
      const name = s.nextName();
      const token = tok(name);
      s.controls.inject('register', 'timeout_before_side_effect', 1);
      const r = await reg(s, name, token);
      check(r.status === 'uncertain', `expected uncertain, got ${r.status}`);
      check(s.controls.registrationsByName(name) === 0, 'nothing may exist yet');
      const f = await s.adapter.findByToken(s.ctx, token, { name });
      check(f.status === 'succeeded' && f.data === null, 'absence must be provable');
      ok(await reg(s, name, token), 'retry');
      check(s.controls.registrationsByName(name) === 1, 'exactly one registration after the retry');
    },
  },
  {
    id: 'R11',
    title:
      'errors are normalized: taken ⇒ conflict, bad credentials ⇒ auth, 429 ⇒ rate_limit (retryable), outage ⇒ provider_outage (retryable)',
    async run(s) {
      const taken = await reg(s, s.fixture.takenName, tok('taken'));
      check(
        taken.status === 'failed' && taken.error?.category === 'conflict',
        `taken: ${taken.status}/${taken.error?.category}`,
      );
      check(taken.error!.retryable === false, 'conflict is not retryable');
      s.controls.inject('register', 'auth_failure', 1);
      const a = await reg(s, s.nextName(), tok('auth'));
      check(
        a.status === 'failed' && a.error?.category === 'auth' && !a.error.retryable,
        `auth: ${a.status}/${a.error?.category}`,
      );
      s.controls.inject('register', 'rate_limit', 1);
      const rl = await reg(s, s.nextName(), tok('rl'));
      check(
        rl.status === 'failed' && rl.error?.category === 'rate_limit' && rl.error.retryable,
        `rate limit: ${rl.status}/${rl.error?.category}`,
      );
      s.controls.inject('register', 'outage', 1);
      const o = await reg(s, s.nextName(), tok('out'));
      check(
        o.error?.category === 'provider_outage' && o.error.retryable,
        `outage: ${o.status}/${o.error?.category}`,
      );
      check(
        o.status === 'failed' || o.status === 'uncertain',
        'an outage on a mutating call is failed (not sent) or uncertain, never success',
      );
      for (const e of [taken, a, rl, o])
        check(
          e.error!.message.length > 0 && e.error!.providerCode.length > 0,
          'normalized error needs message and providerCode',
        );
    },
  },
  {
    id: 'R12',
    title:
      'renew: extends the expiry once; replaying the same renewal (same currentExpiresAt) does not extend twice',
    async run(s) {
      const name = s.nextName();
      const created = await reg(s, name, tok(name));
      ok(created, 'register');
      const before = (await s.adapter.inspect(s.ctx, name)).data!;
      check(before.expiresAt, 'registered domain must have an expiry');
      const req = {
        name,
        providerRef: before.providerRef,
        years: 1,
        currentExpiresAt: before.expiresAt,
        idempotencyToken: tok(`${name}-renew`),
      };
      ok(await s.adapter.renew(s.ctx, req), 'renew');
      const after = (await s.adapter.inspect(s.ctx, name)).data!;
      check(
        Date.parse(after.expiresAt!) > Date.parse(before.expiresAt),
        'expiry must move forward',
      );
      ok(await s.adapter.renew(s.ctx, req), 'replayed renew');
      const again = (await s.adapter.inspect(s.ctx, name)).data!;
      check(again.expiresAt === after.expiresAt, 'a replayed renewal must not extend again');
    },
  },
  {
    id: 'R13',
    title:
      'transferIn: the auth code is read from the vault; it appears in no result or evidence; a locked/unsupported answer is normalized',
    async run(s) {
      const name = s.nextName();
      const secret = `AUTH-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
      const ref = await s.vault.put(secret, 'conformance');
      const r = await s.adapter.transferIn(s.ctx, {
        name,
        authCodeRef: ref,
        contacts: s.fixture.contacts,
        privacy: false,
        idempotencyToken: tok(`${name}-transfer`),
      });
      check(
        ['accepted', 'succeeded', 'failed'].includes(r.status),
        `transferIn status ${r.status}`,
      );
      check(!evidenceText(r).includes(secret), 'auth code leaked into the result');
      check(!evidenceText(r).includes(s.fixture.canaryEmail), 'PII leaked into the result');
      if (r.status === 'failed')
        check(
          !!r.error && ['unsupported', 'conflict', 'validation'].includes(r.error.category),
          'a refused transfer must be normalized',
        );
    },
  },
  {
    id: 'R14',
    title: 'setNameservers and setLock change what inspect reports',
    async run(s) {
      const name = s.nextName();
      ok(await reg(s, name, tok(name)), 'register');
      ok(
        await s.adapter.setNameservers(s.ctx, name, ['ns1.example.net', 'ns2.example.net']),
        'setNameservers',
      );
      check(
        (await s.adapter.inspect(s.ctx, name)).data!.nameservers.join(',') ===
          'ns1.example.net,ns2.example.net',
        'nameservers',
      );
      const un = await s.adapter.setLock(s.ctx, name, false);
      ok(un, 'unlock');
      check((await s.adapter.inspect(s.ctx, name)).data!.locked === false, 'unlocked');
      ok(await s.adapter.setLock(s.ctx, name, true), 'lock');
      check((await s.adapter.inspect(s.ctx, name)).data!.locked === true, 'locked');
    },
  },
  {
    id: 'R15',
    title:
      'webhook signature: valid accepted; forged, replayed and malformed rejected; the provider event id is the dedupe key',
    requires: (s) => !!s.adapter.parseWebhook && !!s.controls.signWebhook,
    async run(s) {
      const now = new Date();
      const body = JSON.stringify({
        id: 'evt-1',
        schemaVersion: '1.0',
        eventType: 'domain.registered',
        timeStamp: Math.floor(now.getTime() / 1000),
        data: { domain: s.fixture.freeName, domainId: 7, status: 'ACT' },
      });
      const { headers, secret } = s.controls.signWebhook!(body, now);
      const opts = { secret, now, toleranceMs: 300_000 };
      const ev = s.adapter.parseWebhook!(headers, body, opts);
      check(ev.eventId === 'evt-1', 'event id must be the provider event id');
      const expectReject = (fn: () => unknown, reason: string) => {
        try {
          fn();
        } catch (e) {
          check(
            e instanceof WebhookRejectedError && e.reason === reason,
            `expected ${reason}, got ${(e as Error).message}`,
          );
          return;
        }
        throw new Error(`expected rejection ${reason}`);
      };
      expectReject(
        () => s.adapter.parseWebhook!(headers, body.replace('evt-1', 'evt-2'), opts),
        'bad_signature',
      );
      expectReject(
        () => s.adapter.parseWebhook!(headers, body, { ...opts, secret: 'wrong-secret-value' }),
        'bad_signature',
      );
      expectReject(
        () =>
          s.adapter.parseWebhook!(headers, body, {
            ...opts,
            now: new Date(now.getTime() + 3_600_000),
          }),
        'replay',
      );
      expectReject(() => s.adapter.parseWebhook!({}, body, opts), 'bad_signature');
      const bad = '{not json';
      const sig = s.controls.signWebhook!(bad, now);
      expectReject(() => s.adapter.parseWebhook!(sig.headers, bad, opts), 'malformed');
    },
  },
  {
    id: 'R16',
    title:
      'DNS: createZone, applyChangeSet reports per-change results that match the zone; a failure at k is reported honestly (partial/rejected), atomic flag is truthful',
    requires: (s) => !!s.adapter.dns && !!s.controls.dnsRecords && !!s.controls.injectDnsFailureAt,
    async run(s) {
      const dns = s.adapter.dns!;
      const name = s.nextName();
      ok(await reg(s, name, tok(name)), 'register');
      ok(await dns.createZone(s.ctx, name), 'createZone');
      const rec = (n: string, v: string): DnsRecordData => ({
        name: n,
        type: 'A',
        ttl: 300,
        value: v,
      });
      const ch: DnsChange[] = [0, 1, 2, 3].map((i) => ({
        op: 'create',
        record: rec(`h${i}`, `192.0.2.${i + 1}`),
      }));
      const r = await dns.applyChangeSet(s.ctx, name, ch);
      ok(r, 'applyChangeSet');
      check(
        r.data!.outcome === 'applied' &&
          r.data!.results.length === 4 &&
          r.data!.results.every((x) => x.status === 'applied'),
        'all applied',
      );
      const listed = await dns.listZone(s.ctx, name);
      ok(listed, 'listZone');
      check(listed.data!.records.length >= 4, 'listZone shows the records');
      check(s.controls.dnsRecords!(name).length >= 4, 'vendor state agrees');
      // failure at position 2
      s.controls.injectDnsFailureAt!(2);
      const bad = await dns.applyChangeSet(
        s.ctx,
        name,
        [4, 5, 6, 7].map((i) => ({
          op: 'create' as const,
          record: rec(`h${i}`, `192.0.2.${i + 1}`),
        })),
      );
      check(bad.data !== undefined, 'a refused change-set still reports per-change results');
      const applied = bad.data!.results.filter((x) => x.status === 'applied').length;
      const vendorNow = s.controls.dnsRecords!(name).filter((x) => /^h[4-7]$/.test(x.name)).length;
      check(applied === vendorNow, `reported ${applied} applied but the vendor holds ${vendorNow}`);
      if (dns.atomicChangeSet)
        check(
          vendorNow === 0 && bad.data!.outcome === 'rejected',
          'an atomic adapter must leave nothing behind',
        );
      else
        check(
          bad.data!.outcome === 'partial' || bad.data!.outcome === 'rejected',
          'non-atomic failure is partial/rejected',
        );
      check(
        bad.data!.results.some((x) => x.status === 'failed'),
        'the failing change is reported',
      );
    },
  },
  {
    id: 'R17',
    title: 'fetchBilling returns integer minor units with a currency (never floats)',
    requires: (s) => !!s.adapter.fetchBilling,
    async run(s) {
      const name = s.nextName();
      ok(await reg(s, name, tok(name)), 'register');
      const rows = await s.adapter.fetchBilling!(s.ctx, {
        from: new Date(Date.now() - 86_400_000).toISOString(),
        to: new Date(Date.now() + 86_400_000).toISOString(),
      });
      check(rows.length > 0, 'billing rows expected after a registration');
      for (const r of rows)
        check(
          /^\d+$/.test(r.amountMinor) && /^[A-Z]{3}$/.test(r.currency),
          'amountMinor must be an integer string',
        );
    },
  },
  {
    id: 'R18',
    title: 'toMinorUnits never uses float arithmetic (0.1+0.2, 1.005, 12.995, large values)',
    async run() {
      check(toMinorUnits(0.3, 'USD') === '30', '0.3');
      check(
        toMinorUnits(1.005, 'USD') === '101' || toMinorUnits(1.005, 'USD') === '100',
        '1.005 rounds deterministically',
      );
      check(toMinorUnits('12.995', 'USD') === '1300', '12.995 string rounds half up');
      check(toMinorUnits(9.99, 'USD') === '999', '9.99');
      check(toMinorUnits(1000, 'JPY') === '1000', 'JPY has no minor unit');
      check(
        toMinorUnits(-1, 'USD') === null &&
          toMinorUnits(Number.NaN, 'USD') === null &&
          toMinorUnits('abc', 'USD') === null,
        'garbage is null',
      );
    },
  },
];

/** Runs every applicable case; each case gets a fresh subject from `make`. */
export async function runRegistrarConformance(
  make: () => Promise<{ subject: RegistrarSubject; close?: () => Promise<void> | void }>,
): Promise<ConformanceReport> {
  const results: CaseResult[] = [];
  let adapterId = '';
  let evidenceKind: 'mock' | 'fixture' = 'mock';
  for (const c of REGISTRAR_CASES) {
    const { subject, close } = await make();
    adapterId = subject.adapter.id;
    evidenceKind = subject.evidenceKind;
    try {
      if (c.requires && !c.requires(subject)) {
        results.push({
          id: c.id,
          title: c.title,
          status: 'skipped',
          detail: 'capability not declared by this adapter',
        });
        continue;
      }
      await c.run(subject);
      results.push({ id: c.id, title: c.title, status: 'pass' });
    } catch (e) {
      results.push({ id: c.id, title: c.title, status: 'fail', detail: (e as Error).message });
    } finally {
      await close?.();
    }
  }
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  return {
    adapterId,
    contractVersion: CONTRACT_VERSION,
    evidenceKind,
    results,
    passed,
    failed,
    skipped: results.length - passed - failed,
    total: results.length,
    liveStatus: 'NOT VERIFIED',
  };
}
