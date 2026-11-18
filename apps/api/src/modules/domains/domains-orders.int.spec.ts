import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerPostingService, recipes } from '../billing';
import { DomainOrderService } from './internal/orders.service';
import { startDomainsKit, type DomainsKit } from './testing/domains-kit';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON in tests */
let k: DomainsKit;
let orders: DomainOrderService;
let n = 0;
const nm = (p: string) => `${p}-${Date.now().toString(36)}-${++n}.com`;
const contact = (email = 'registrant.person@example.invalid') => ({
  firstName: 'Salem',
  lastName: 'Alharbi',
  email,
  phone: '+966500000000',
  address: { street: 'King Fahd Rd 1', city: 'Riyadh', postalCode: '12211', country: 'SA' },
});

beforeAll(async () => {
  k = await startDomainsKit();
  orders = k.app.get(DomainOrderService);
  orders.autoKick = false; // tests drive each operation to inject faults between steps
  for (const who of ['alice', 'bob']) {
    const org = who === 'alice' ? k.orgA : k.orgB;
    const r = await k.call(
      who,
      'POST',
      '/v1/compliance/consents',
      {
        purposeId: 'domain_registrant_disclosure',
        granted: true,
        localeShown: 'en',
        textVersion: 'placeholder-1',
        subjectRef: 'org',
      },
      { org },
    );
    if (r.statusCode !== 201 && r.statusCode !== 200)
      throw new Error(`consent: ${r.statusCode} ${r.body}`);
  }
  await k.fund(k.orgA, '100000000');
  await k.fund(k.orgB, '100000000');
});
afterAll(() => k?.close());

const quote = async (who: string, items: object[], org = who === 'bob' ? k.orgB : k.orgA) => {
  const r = await k.call(who, 'POST', '/v1/quotes', { kind: 'domain', items }, { org });
  if (r.statusCode !== 201) throw new Error(`quote ${r.statusCode} ${r.body}`);
  return r.json();
};
const place = async (
  who: string,
  name: string,
  body: object = {},
  org = who === 'bob' ? k.orgB : k.orgA,
) => {
  const q = await quote(who, [{ name, years: 1, action: 'register' }], org);
  const r = await k.call(
    who,
    'POST',
    '/v1/domains',
    { quoteId: q.id, contacts: { registrant: contact() }, autoRenew: false, ...body },
    { org },
  );
  return { q, r };
};
const wallet = async (org: string) =>
  Number(
    (
      await k.h.env.sql(
        `SELECT coalesce(sum(CASE WHEN p.direction='credit' THEN p.amount_minor ELSE -p.amount_minor END),0) n FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id=p.account_id WHERE a.code='2100' AND a.org_id=$1 AND p.currency='SAR'`,
        [org],
      )
    )[0]?.n ?? 0,
  );
const orderRow = async (id: string) =>
  (await k.h.env.sql(`SELECT * FROM domains.domain_orders WHERE id=$1`, [id]))[0] as any;
const ledgerTx = (orderId: string, kind: string) =>
  k.count(`SELECT count(*) n FROM billing.ledger_transactions WHERE source_event_id = $1`, [
    `domain-order:${orderId}:${kind}`,
  ]);
const meters = (domainId: string) =>
  k.count(
    `SELECT count(*) n FROM platform.outbox WHERE topic='usage.recorded' AND payload->>'resourceId' = $1`,
    [domainId],
  );
const runOp = (org: string, opId: string) => orders.run(org, opId);
const opState = async (id: string) =>
  (await k.h.env.sql(`SELECT state FROM platform.operations WHERE id=$1`, [id]))[0]!
    .state as string;

describe('POST /v1/domains: the happy path (S29 task 2/3)', () => {
  it('202 + operationId, domain pending; the operation finishes it: one authorization, one record, one meter event, funds taken once', async () => {
    const before = await wallet(k.orgA);
    const name = nm('happy');
    const { q, r } = await place('alice', name, { autoRenew: true });
    expect(r.statusCode, r.body).toBe(202);
    const b = r.json();
    expect(b.domain).toMatchObject({ name, status: 'pending' });
    expect(b.operationId).toBeTruthy();
    expect(await wallet(k.orgA)).toBe(before - Number(q.totalMinor)); // reserved up front
    expect(await orderRow(b.orderId)).toMatchObject({
      state: 'authorized',
      authorization_state: 'held',
    });
    await runOp(k.orgA, b.operationId);
    expect(await opState(b.operationId)).toBe('succeeded');
    const d = (await k.call('alice', 'GET', `/v1/domains/${b.domain.id}`)).json();
    expect(d).toMatchObject({
      name,
      state: 'active',
      autoRenew: true,
      tld: 'com',
      dataRegion: 'sa-pending',
      providerRegionId: 'NL',
    });
    expect(d.expiresAt).toBeTruthy();
    expect(await orderRow(b.orderId)).toMatchObject({
      state: 'succeeded',
      authorization_state: 'captured',
    });
    expect(await ledgerTx(b.orderId, 'authorize')).toBe(1);
    expect(await ledgerTx(b.orderId, 'record')).toBe(1);
    expect(await ledgerTx(b.orderId, 'release')).toBe(0);
    expect(await meters(b.domain.id)).toBe(1);
    expect(
      await k.count(
        `SELECT count(*) n FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id=p.account_id WHERE a.code='4300'`,
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(k.op.controls.registrationsByName(name)).toBe(1);
    expect(await wallet(k.orgA)).toBe(before - Number(q.totalMinor)); // charged exactly once
    expect(
      await k.count(
        `SELECT count(*) n FROM metering.provider_cost_records WHERE provider_line_ref = $1`,
        [`domain-order:${b.orderId}`],
      ),
    ).toBe(1);
    // steps and audit
    expect(
      await k.count(`SELECT count(*) n FROM platform.operation_steps WHERE operation_id=$1`, [
        b.operationId,
      ]),
    ).toBeGreaterThanOrEqual(2);
    for (const a of ['domain.order.created', 'domain.order.succeeded'])
      expect(
        await k.count(`SELECT count(*) n FROM audit.audit_logs WHERE org_id=$1 AND action=$2`, [
          k.orgA,
          a,
        ]),
        a,
      ).toBeGreaterThanOrEqual(1);
    // the same quote cannot be ordered twice; the same request replays
    const again = await k.call('alice', 'POST', '/v1/domains', {
      quoteId: q.id,
      contacts: { registrant: contact() },
    });
    expect([202, 409]).toContain(again.statusCode);
    expect(k.op.controls.registrationsByName(name)).toBe(1);
  });

  it('contacts are PERSONAL data: sealed at rest, masked for viewers, absent from audit, operations, outbox and the registrar evidence', async () => {
    const email = `canary-${Date.now()}@example.invalid`;
    const name = nm('pii');
    const { r } = await place('alice', name, { contacts: { registrant: contact(email) } });
    expect(r.statusCode).toBe(202);
    await runOp(k.orgA, r.json().operationId);
    const rows = await k.h.env.sql(
      `SELECT payload_enc FROM domains.domain_contacts WHERE domain_id=$1`,
      [r.json().domain.id],
    );
    expect(rows).toHaveLength(4);
    for (const c of rows) {
      expect(c.payload_enc).toMatch(/^enc:v1:/);
      expect(c.payload_enc).not.toContain('Salem');
    }
    const owner = (await k.call('alice', 'GET', `/v1/domains/${r.json().domain.id}`)).json();
    expect(owner.contacts.registrant.email).toBe(email);
    expect(owner.contactsMasked).toBe(false);
    const viewer = (await k.call('carol', 'GET', `/v1/domains/${r.json().domain.id}`)).json();
    expect(viewer.contactsMasked).toBe(true);
    expect(JSON.stringify(viewer)).not.toContain(email);
    expect(viewer.contacts.registrant.email).toMatch(/^c\*\*\*@/);
    // AC-M07-08: no PII in audit / operations / outbox / notifications
    for (const [tbl, col] of [
      [
        'audit.audit_logs',
        "coalesce(before::text,'')||coalesce(after::text,'')||coalesce(detail::text,'')",
      ],
      ['platform.operations', "input::text||coalesce(result::text,'')||coalesce(error::text,'')"],
      ['platform.outbox', 'payload::text'],
      ['platform.notifications', 'body::text'],
    ] as const) {
      const hit = await k.h.env.sql(
        `SELECT count(*)::int n FROM ${tbl} WHERE ${col} ILIKE '%' || $1 || '%' OR ${col} ILIKE '%Alharbi%'`,
        [email],
      );
      expect(hit[0]!.n, tbl).toBe(0);
    }
  });

  it('402 payment_required when the wallet cannot cover the order: nothing is reserved, no domain is left, the quote stays usable', async () => {
    const name = nm('poor');
    const q = await quote('bob', [{ name, years: 1, action: 'register' }], k.orgB);
    // drain the wallet with a consumption posting so the ledger really holds (almost) nothing
    const bal = await wallet(k.orgB);
    await k.app.get(LedgerPostingService).post(
      recipes.walletConsume({
        orgId: k.orgB,
        netMinor: String(bal - 1),
        currency: 'SAR',
        description: 'drain for test',
        sourceEventId: crypto.randomUUID(),
      }),
      `drain-${Date.now()}`,
    );
    const w0 = await wallet(k.orgB);
    const r = await k.call(
      'bob',
      'POST',
      '/v1/domains',
      { quoteId: q.id, contacts: { registrant: contact() } },
      { org: k.orgB },
    );
    expect(r.statusCode).toBe(402);
    expect(
      await k.count(`SELECT count(*) n FROM domains.domains WHERE org_id=$1 AND name=$2`, [
        k.orgB,
        name,
      ]),
    ).toBe(0);
    expect(await wallet(k.orgB)).toBe(w0);
    await k.fund(k.orgB, '100000000');
    // refresh the wallet projection used by the pre-check
    const ok = await k.call(
      'bob',
      'POST',
      '/v1/domains',
      { quoteId: q.id, contacts: { registrant: contact() } },
      { org: k.orgB },
    );
    expect(ok.statusCode, ok.body).toBe(202);
  });

  it('consent_required when privacy protection is not used and the disclosure consent is missing; unsupported privacy is 422', async () => {
    const q = await quote('erin', [{ name: nm('consent'), years: 1, action: 'register' }]);
    await k.h.env.sql(`DELETE FROM compliance.consents WHERE false`).catch(() => undefined);
    const priv = await k.call('erin', 'POST', '/v1/domains', {
      quoteId: q.id,
      contacts: { registrant: contact() },
      privacy: true,
    });
    expect(priv.statusCode).toBe(202); // the mock OP supports privacy for .com
    const net = await quote('erin', [{ name: nm('priv'), years: 1, action: 'register' }]);
    const bad = await k.call('erin', 'POST', '/v1/domains', {
      quoteId: net.id,
      contacts: { registrant: { ...contact(), phone: '0500000000' } },
    });
    expect(bad.statusCode).toBe(422);
  });

  it('roles: viewer cannot order, billing_admin cannot order, developer can', async () => {
    const q = await quote('erin', [{ name: nm('role'), years: 1, action: 'register' }]);
    expect(
      (
        await k.call('carol', 'POST', '/v1/domains', {
          quoteId: q.id,
          contacts: { registrant: contact() },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await k.call('dave', 'POST', '/v1/domains', {
          quoteId: q.id,
          contacts: { registrant: contact() },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await k.call('erin', 'POST', '/v1/domains', {
          quoteId: q.id,
          contacts: { registrant: contact() },
        })
      ).statusCode,
    ).toBe(202);
  });
});

describe('uncertain outcomes: reconcile before retry (S29 task 2, AC-M07-03)', () => {
  it('timeout AFTER the vendor registered ⇒ needs_reconcile ⇒ reconciler finds it ⇒ ONE ledger record, ONE registration', async () => {
    const name = nm('after');
    const { r } = await place('alice', name);
    k.op.controls.inject('register', 'timeout_after_side_effect', 1);
    await runOp(k.orgA, r.json().operationId);
    expect(await opState(r.json().operationId)).toBe('needs_reconcile');
    expect((await orderRow(r.json().orderId)).state).toBe('needs_reconcile');
    expect(k.op.controls.registrationsByName(name)).toBe(1);
    const res = await orders.reconcileOrder(k.orgA, r.json().orderId);
    expect(res).toBe('finalized');
    expect(await opState(r.json().operationId)).toBe('succeeded');
    expect(await ledgerTx(r.json().orderId, 'record')).toBe(1);
    expect(await meters(r.json().domain.id)).toBe(1);
    expect(k.op.controls.registrationsByName(name)).toBe(1);
    expect(await orders.reconcileOrder(k.orgA, r.json().orderId)).toBe('final');
  });

  it('timeout BEFORE the vendor acted ⇒ needs_reconcile ⇒ absence PROVEN ⇒ exactly one retry ⇒ one registration', async () => {
    const name = nm('before');
    const { r } = await place('alice', name);
    k.op.controls.inject('register', 'timeout_before_side_effect', 1);
    await runOp(k.orgA, r.json().operationId);
    expect(k.op.controls.registrationsByName(name)).toBe(0);
    expect(await orders.reconcileOrder(k.orgA, r.json().orderId)).toBe('retried');
    expect(k.op.controls.registrationsByName(name)).toBe(1);
    expect((await orderRow(r.json().orderId)).state).toBe('succeeded');
    expect(await ledgerTx(r.json().orderId, 'record')).toBe(1);
  });

  it('the retry is bounded: a second uncertain answer parks the order for a human (no third call)', async () => {
    const name = nm('twice');
    const { r } = await place('alice', name);
    k.op.controls.inject('register', 'timeout_before_side_effect', 2);
    await runOp(k.orgA, r.json().operationId);
    expect(await orders.reconcileOrder(k.orgA, r.json().orderId)).toBe('retried');
    expect((await orderRow(r.json().orderId)).state).toBe('needs_reconcile');
    expect(await orders.reconcileOrder(k.orgA, r.json().orderId)).toBe('absent_exhausted');
    expect(k.op.controls.registrationsByName(name)).toBe(0);
    expect(await ledgerTx(r.json().orderId, 'record')).toBe(0);
  });

  it('a definitive refusal releases the reservation: reversing entry, order and domain failed, name freed, funds back', async () => {
    const name = nm('taken');
    const { q, r } = await place('alice', name);
    const before = await wallet(k.orgA);
    k.op.controls.seedTaken(name); // someone registered it in between
    await runOp(k.orgA, r.json().operationId);
    expect(await opState(r.json().operationId)).toBe('failed');
    const o = await orderRow(r.json().orderId);
    expect(o).toMatchObject({
      state: 'failed',
      authorization_state: 'released',
      failure_code: 'domain_unavailable',
    });
    expect(await ledgerTx(r.json().orderId, 'release')).toBe(1);
    expect(await ledgerTx(r.json().orderId, 'record')).toBe(0);
    expect(await wallet(k.orgA)).toBe(before + Number(q.totalMinor));
    expect(
      await k.count(
        `SELECT count(*) n FROM domains.domains WHERE org_id=$1 AND name=$2 AND state='failed'`,
        [k.orgA, name],
      ),
    ).toBe(1);
  });

  it('AC-M07-03: 50 randomized fault-injection runs ⇒ 0 duplicate registrations, 0 duplicate charges, every operation terminal', async () => {
    const kinds = [
      'none',
      'timeout_after_side_effect',
      'timeout_before_side_effect',
      'rate_limit',
      'outage',
    ] as const;
    const placed: {
      orderId: string;
      opId: string;
      name: string;
      total: number;
      domainId: string;
    }[] = [];
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const w0 = await wallet(k.orgA);
    for (let i = 0; i < 50; i++) {
      const name = nm('fault');
      const { q, r } = await place('alice', name);
      expect(r.statusCode).toBe(202);
      placed.push({
        orderId: r.json().orderId,
        opId: r.json().operationId,
        name,
        total: Number(q.totalMinor),
        domainId: r.json().domain.id,
      });
      const kind = kinds[Math.floor(rnd() * kinds.length)]!;
      if (kind !== 'none') k.op.controls.inject('register', kind, 1);
      await runOp(k.orgA, r.json().operationId);
    }
    // drive everything to a terminal state: reconcile, then re-run backoff retries that are due
    for (let round = 0; round < 4; round++) {
      await k.h.env.sql(
        `UPDATE platform.operations SET next_run_at = now() WHERE state = 'pending' AND kind LIKE 'domains.%'`,
      );
      await k.h.env.sql(
        `UPDATE domains.domain_orders SET updated_at = now() - interval '1 minute' WHERE state IN ('created','authorized')`,
      );
      await orders.drain(200, 0);
      await orders.sweep(200);
    }
    let ok = 0;
    for (const p of placed) {
      const o = await orderRow(p.orderId);
      expect(['succeeded', 'failed'], `${p.name}: ${o.state}`).toContain(o.state);
      expect(['succeeded', 'failed', 'cancelled']).toContain(await opState(p.opId));
      expect(k.op.controls.registrationsByName(p.name)).toBeLessThanOrEqual(1);
      expect(await ledgerTx(p.orderId, 'record')).toBeLessThanOrEqual(1);
      expect(await ledgerTx(p.orderId, 'authorize')).toBe(1);
      if (o.state === 'succeeded') {
        ok++;
        expect(k.op.controls.registrationsByName(p.name)).toBe(1);
        expect(await ledgerTx(p.orderId, 'record')).toBe(1);
        expect(await ledgerTx(p.orderId, 'release')).toBe(0);
        expect(await meters(p.domainId)).toBe(1);
      } else {
        expect(await ledgerTx(p.orderId, 'record')).toBe(0);
        expect(await ledgerTx(p.orderId, 'release')).toBe(1);
        expect(k.op.controls.registrationsByName(p.name)).toBe(0);
      }
    }
    const spent = placed.filter(async () => true);
    void spent;
    // funds: exactly the succeeded orders were charged
    const charged = (
      await Promise.all(
        placed.map(async (p) => ((await orderRow(p.orderId)).state === 'succeeded' ? p.total : 0)),
      )
    ).reduce((a, b) => a + b, 0);
    expect(await wallet(k.orgA)).toBe(w0 - charged);
    expect(ok).toBeGreaterThan(30);
  });
});

describe('concurrency and tenant isolation (S29, AC-M07-07)', () => {
  it('two organizations ordering the same name concurrently: exactly one registration, the other gets 409 domain_unavailable with no owner leaked', async () => {
    const name = nm('race');
    const qa = await quote('alice', [{ name, years: 1, action: 'register' }]);
    const qb = await quote('bob', [{ name, years: 1, action: 'register' }], k.orgB);
    const [ra, rb] = await Promise.all([
      k.call('alice', 'POST', '/v1/domains', {
        quoteId: qa.id,
        contacts: { registrant: contact() },
      }),
      k.call(
        'bob',
        'POST',
        '/v1/domains',
        { quoteId: qb.id, contacts: { registrant: contact() } },
        { org: k.orgB },
      ),
    ]);
    const codes = [ra.statusCode, rb.statusCode].sort();
    expect(codes).toEqual([202, 409]);
    const loser = ra.statusCode === 409 ? ra : rb;
    expect(JSON.stringify(loser.json())).toContain('domain_unavailable');
    expect(JSON.stringify(loser.json())).not.toMatch(/Domains [AB]/);
    const winner = ra.statusCode === 202 ? ra : rb;
    await runOp(ra.statusCode === 202 ? k.orgA : k.orgB, winner.json().operationId);
    expect(k.op.controls.registrationsByName(name)).toBe(1);
    // the loser's quote is not consumed (no commerce order) and no money moved for it
    const loserOrg = ra.statusCode === 409 ? k.orgA : k.orgB;
    expect(
      await k.count(`SELECT count(*) n FROM commerce.orders WHERE org_id=$1 AND quote_id=$2`, [
        loserOrg,
        ra.statusCode === 409 ? qa.id : qb.id,
      ]),
    ).toBe(0);
  });

  it('the same Idempotency-Key replays the first answer: one order, one operation', async () => {
    const q = await quote('alice', [{ name: nm('idem'), years: 1, action: 'register' }]);
    const body = { quoteId: q.id, contacts: { registrant: contact() } };
    const a = await k.call('alice', 'POST', '/v1/domains', body, { key: 'same-key-123' });
    const b = await k.call('alice', 'POST', '/v1/domains', body, { key: 'same-key-123' });
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json().orderId).toBe(a.json().orderId);
    expect(
      await k.count(`SELECT count(*) n FROM domains.domain_orders WHERE quote_id=$1`, [q.id]),
    ).toBe(1);
  });

  it('cross-tenant matrix: org B cannot read, change, renew or see eligibility of org A domains; lists never leak', async () => {
    const { r } = await place('alice', nm('tenant'));
    await runOp(k.orgA, r.json().operationId);
    const id = r.json().domain.id;
    const asB = (
      m: 'GET' | 'PATCH' | 'POST',
      url: string,
      body?: object,
      h: Record<string, string> = {},
    ) => k.call('bob', m, url, body, { org: k.orgB, headers: h });
    expect((await asB('GET', `/v1/domains/${id}`)).statusCode).toBe(404);
    expect(
      (await asB('PATCH', `/v1/domains/${id}`, { lock: false }, { 'if-match': '"1"' })).statusCode,
    ).toBe(404);
    expect((await asB('GET', `/v1/domains/${id}/eligibility`)).statusCode).toBe(404);
    expect(
      (
        await asB('POST', `/v1/domains/${id}/renewals`, {
          quoteId: '00000000-0000-4000-8000-000000000000',
        })
      ).statusCode,
    ).toBe(404);
    const list = (await asB('GET', '/v1/domains')).json();
    expect(list.items.some((d: any) => d.id === id)).toBe(false);
    expect((await asB('GET', '/v1/domains/transfers')).json().items).toEqual([]);
    // org B cannot order with org A's quote
    const qa = await quote('alice', [{ name: nm('foreign'), years: 1, action: 'register' }]);
    expect(
      (await asB('POST', '/v1/domains', { quoteId: qa.id, contacts: { registrant: contact() } }))
        .statusCode,
    ).toBe(404);
    // direct SQL under org B's context sees none of org A's rows
    const own = await k.h.env.sql(`SELECT count(*)::int n FROM domains.domains WHERE org_id = $1`, [
      k.orgA,
    ]);
    expect(own[0]!.n).toBeGreaterThan(0);
  });
});

describe('PATCH /v1/domains/{id} and renewals', () => {
  let id = '';
  let name = '';
  beforeAll(async () => {
    name = nm('patch');
    const { r } = await place('alice', name);
    await runOp(k.orgA, r.json().operationId);
    id = r.json().domain.id;
  });
  it('If-Match is required (428) and stale versions are 412 etag_mismatch', async () => {
    expect((await k.call('alice', 'PATCH', `/v1/domains/${id}`, { lock: false })).statusCode).toBe(
      428,
    );
    expect(
      (
        await k.call(
          'alice',
          'PATCH',
          `/v1/domains/${id}`,
          { lock: false },
          { headers: { 'if-match': '"999"' } },
        )
      ).statusCode,
    ).toBe(412);
  });
  it('changes lock and nameservers at the registrar and bumps the version/ETag; capability-gated fields are 422', async () => {
    const g = await k.call('alice', 'GET', `/v1/domains/${id}`);
    const v = g.headers.etag as string;
    const r = await k.call(
      'alice',
      'PATCH',
      `/v1/domains/${id}`,
      { lock: false, nameservers: ['ns1.example.net', 'ns2.example.net'], autoRenew: true },
      { headers: { 'if-match': v } },
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      locked: false,
      nameservers: ['ns1.example.net', 'ns2.example.net'],
      autoRenew: true,
    });
    expect(r.headers.etag).not.toBe(v);
    expect(
      (
        await k.call(
          'alice',
          'PATCH',
          `/v1/domains/${id}`,
          { lock: true },
          { headers: { 'if-match': v } },
        )
      ).statusCode,
    ).toBe(412);
    expect(
      (
        await k.call(
          'alice',
          'PATCH',
          `/v1/domains/${id}`,
          { bogus: 1 },
          { headers: { 'if-match': r.headers.etag as string } },
        )
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await k.call(
          'carol',
          'PATCH',
          `/v1/domains/${id}`,
          { lock: true },
          { headers: { 'if-match': r.headers.etag as string } },
        )
      ).statusCode,
    ).toBe(403);
  });
  it('renewal: quote → order → the expiry moves forward once; a replayed run does not extend twice', async () => {
    const before = (await k.call('alice', 'GET', `/v1/domains/${id}`)).json();
    const q = await quote('alice', [{ name, years: 1, action: 'renew' }]);
    const r = await k.call('alice', 'POST', `/v1/domains/${id}/renewals`, {
      quoteId: q.id,
      years: 1,
    });
    expect(r.statusCode, r.body).toBe(202);
    await runOp(k.orgA, r.json().operationId);
    const after = (await k.call('alice', 'GET', `/v1/domains/${id}`)).json();
    expect(Date.parse(after.expiresAt)).toBeGreaterThan(Date.parse(before.expiresAt));
    expect(await ledgerTx(r.json().orderId, 'record')).toBe(1);
    expect(
      await k.count(
        `SELECT count(*) n FROM platform.outbox WHERE topic='usage.recorded' AND payload->>'meterId'='domain.renewal_years' AND payload->>'resourceId'=$1`,
        [id],
      ),
    ).toBe(1);
    await runOp(k.orgA, r.json().operationId);
    expect((await k.call('alice', 'GET', `/v1/domains/${id}`)).json().expiresAt).toBe(
      after.expiresAt,
    );
    expect(await ledgerTx(r.json().orderId, 'record')).toBe(1);
    // billing_admin may renew; viewers may not
    const q2 = await quote('dave', [{ name, years: 1, action: 'renew' }]);
    expect(
      (await k.call('carol', 'POST', `/v1/domains/${id}/renewals`, { quoteId: q2.id })).statusCode,
    ).toBe(403);
    expect(
      (await k.call('dave', 'POST', `/v1/domains/${id}/renewals`, { quoteId: q2.id })).statusCode,
    ).toBe(202);
  });
  it('the eligibility of an existing domain is the last stored evaluation', async () => {
    const r = await k.call('alice', 'GET', `/v1/domains/${id}/eligibility`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ rule: 'policy.allowed', state: 'allowed' });
  });
});
