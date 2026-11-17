import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { MockPsp, PaymentService, looksLikeCardNumber } from './index';
import { INTENT_TRANSITIONS, type IntentStatus } from './internal/payment-state';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
type Row = Record<string, any>;

const PAN = ['4242', '4242', '4242', '4242'].join(''); // built at runtime: the repository scanner must never see a card number in the source
const RETURN = 'http://127.0.0.1:3000/en/billing/payment-return';
const h = new Harness();
let app: App;
let orgA = '';
let orgB = '';
let orgC = '';
const ids: Record<string, string> = {};
const jars: Record<string, Record<string, string>> = {};
const M: Record<string, string> = {};
let invSeq = 0;

const call = (
  who: string,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  body?: object,
  org = orgA,
  extra: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    headers: {
      cookie: cookieHeader(jars[who]!),
      'x-csrf-token': jars[who]!.nuzm_csrf ?? '',
      'x-nuzm-org': org,
      'idempotency-key': `k-${Math.random()}`,
      ...extra,
    },
    ...(body ? { payload: body } : {}),
  });
const mock = () => app.get(MockPsp);
const hook = (raw: string, headers: Record<string, string>) =>
  app.inject({ method: 'POST', url: '/v1/webhooks/payments/mock', headers, payload: raw });
const mk = async (who: string, name: string) =>
  (
    await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { cookie: cookieHeader(jars[who]!), 'x-csrf-token': jars[who]!.nuzm_csrf! },
      payload: { name },
    })
  ).json().id as string;
const count = async (q: string, p: unknown[] = []) => Number((await h.env.sql(q, p))[0]!.n);

/** A payable invoice written directly (the invoice service has its own tests): total in minor units, nothing paid. */
const invoice = async (org: string, total: number, status = 'open', paid = 0) => {
  const id = crypto.randomUUID();
  const n = ++invSeq;
  await h.env.sql(
    `INSERT INTO invoicing.invoices (id, org_id, entity_id, series, number, number_text, status, environment, currency, period_start, period_end, issued_at, due_at, source_key, subtotal_minor, tax_minor, total_minor, paid_minor, buyer, seller)
     SELECT $1, $2, id, 'PY', $3::bigint, 'PY-' || $3::text, $4, 'sandbox', 'SAR', '2026-11-01', '2026-11-30', now(), now(), $5, $6, 0, $6, $7, '{"legalName":{"ar":"x","en":"x"},"vatNumber":null,"buyerType":"b2c"}', '{"legalName":{"ar":"x","en":"x"},"vatNumber":null,"placeholder":true}' FROM invoicing.billing_entities LIMIT 1`,
    [id, org, n, status, `pay-fixture-${n}`, total, paid],
  );
  return id;
};
const pay = (who: string, invoiceId: string, methodId?: string, extra: object = {}, org = orgA) =>
  call(
    who,
    'POST',
    '/v1/billing/payments',
    { invoiceId, returnUrl: RETURN, ...(methodId ? { paymentMethodId: methodId } : {}), ...extra },
    org,
  );
const addMethod = async (who: string, token: string, org = orgA) => {
  const r = await call(
    who,
    'POST',
    '/v1/billing/payment-methods',
    { provider: 'mock', setupToken: token },
    org,
  );
  expect(r.statusCode, token).toBe(201);
  return r.json().id as string;
};
const invoiceRow = async (id: string) =>
  (
    await h.env.sql(`SELECT status, paid_minor::text paid FROM invoicing.invoices WHERE id = $1`, [
      id,
    ])
  )[0]!;
const ledgerFor = (paymentId: string) =>
  h.env.sql(
    `SELECT a.code, p.direction, p.amount_minor::text amt, a.subledger_key FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id = p.account_id JOIN billing.ledger_transactions t ON t.id = p.transaction_id WHERE t.idempotency_key = $1 ORDER BY a.code`,
    [`payment:${paymentId}:capture`],
  ) as Promise<Row[]>;
const merchantRef = async (paymentId: string) =>
  (
    await h.env.sql(`SELECT merchant_reference r FROM payments.payment_intents WHERE id = $1`, [
      paymentId,
    ])
  )[0]!.r as string;

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  for (const n of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank']) {
    ids[n] = await h.createUser(n);
    jars[n] = await h.sessionFor(app, ids[n]!);
    await h.elevate(jars[n]!);
  }
  orgA = await mk('alice', 'Pay A');
  orgB = await mk('bob', 'Pay B');
  orgC = await mk('frank', 'Pay C');
  for (const [u, role] of [
    ['carol', 'viewer'],
    ['dave', 'billing_admin'],
    ['erin', 'developer'],
  ] as const)
    await h.env.sql(
      `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, $3)`,
      [orgA, ids[u], role],
    );
  M.success = await addMethod('alice', 'tok_mock_success_a1');
  M.decline = await addMethod('alice', 'tok_mock_decline_b1');
  M.threeds = await addMethod('alice', 'tok_mock_3ds_c1');
  M.timeout = await addMethod('alice', 'tok_mock_timeout_d1');
  M.processing = await addMethod('alice', 'tok_mock_processing_e1');
  await addMethod('frank', 'tok_mock_timeout_f1', orgC); // org C: the timeout-only organization of the 1,000-run test
});
afterAll(() => h.close());

describe('payment methods (tokens only)', () => {
  it('saves a method from a PSP setup token: brand, last4, expiry only; the first one is the default', async () => {
    const list = (await call('dave', 'GET', '/v1/billing/payment-methods')).json().items as Row[];
    expect(list).toHaveLength(5);
    expect(list[0]).toMatchObject({
      provider: 'mock',
      brand: 'visa',
      last4: '4242',
      status: 'active',
      isDefault: true,
      expiring: false,
    });
    expect(list.filter((m) => m.isDefault)).toHaveLength(1);
    expect(Object.keys(list[0]!).sort()).toEqual([
      'brand',
      'createdAt',
      'expMonth',
      'expYear',
      'expiring',
      'id',
      'isDefault',
      'last4',
      'provider',
      'status',
    ]);
    expect(list.find((m) => m.id === M.decline)).toMatchObject({ last4: '0002', isDefault: false });
  });

  it('refuses card data in ANY form with 422 pan_not_allowed and stores nothing', async () => {
    const before = await count(
      `SELECT count(*)::int n FROM payments.payment_methods WHERE org_id = $1`,
      [orgA],
    );
    const bodies: object[] = [
      { provider: 'mock', setupToken: 'tok_mock_success_z9', number: PAN },
      { provider: 'mock', setupToken: 'tok_mock_success_z9', cardNumber: PAN, expMonth: 12 },
      { provider: 'mock', setupToken: 'tok_mock_success_z9', card: { pan: PAN } },
      { provider: 'mock', setupToken: PAN },
      {
        provider: 'mock',
        setupToken: 'tok_mock_success_z9',
        note: `my card is ${PAN.replace(/(.{4})/g, '$1 ').trim()}`,
      },
      { provider: 'mock', setupToken: 'tok_mock_success_z9', cvv: '123' },
      { provider: PAN, setupToken: 'tok_mock_success_z9' },
    ];
    for (const b of bodies) {
      const r = await call('alice', 'POST', '/v1/billing/payment-methods', b);
      expect(r.statusCode, JSON.stringify(b).replace(PAN, 'PAN')).toBe(422);
      expect(r.json().code).toBe('pan_not_allowed');
      expect(r.body).not.toContain(PAN); // the problem body never echoes the card number
    }
    expect(
      await count(`SELECT count(*)::int n FROM payments.payment_methods WHERE org_id = $1`, [orgA]),
    ).toBe(before);
  });

  it('validates the token and the provider; a duplicate card is refused; the PSP can refuse a token', async () => {
    expect(
      (
        await call('alice', 'POST', '/v1/billing/payment-methods', {
          provider: 'mock',
          setupToken: 'not-a-token',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await call('alice', 'POST', '/v1/billing/payment-methods', {
          provider: 'nope',
          setupToken: 'tok_mock_success_q1',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await call('alice', 'POST', '/v1/billing/payment-methods', {
          provider: 'mock',
          setupToken: 'tok_mock_expired',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await call('alice', 'POST', '/v1/billing/payment-methods', { provider: 'mock' })).statusCode,
    ).toBe(422);
    // a setup token is single-use; the same physical card (same fingerprint) cannot be saved twice
    expect(
      (
        await call('alice', 'POST', '/v1/billing/payment-methods', {
          provider: 'mock',
          setupToken: 'tok_mock_success_a1',
        })
      ).statusCode,
    ).toBe(422);
    const dup = await call('alice', 'POST', '/v1/billing/payment-methods', {
      provider: 'mock',
      setupToken: 'tok_mock_timeout_a1',
    });
    expect([dup.statusCode, dup.json().code]).toEqual([409, 'conflict']);
    expect(
      (
        await call('alice', 'POST', '/v1/billing/payments', {
          invoiceId: await invoice(orgA, 100),
          returnUrl: RETURN,
          paymentMethodId: M.success,
        })
      ).json().status,
    ).toBe('succeeded'); // the original card still works
  });

  it('only billing managers add or remove; readers list; viewers and developers are refused', async () => {
    expect(
      (
        await call('dave', 'POST', '/v1/billing/payment-methods', {
          provider: 'mock',
          setupToken: 'tok_mock_success_dv1',
        })
      ).statusCode,
    ).toBe(201);
    expect((await call('carol', 'GET', '/v1/billing/payment-methods')).statusCode).toBe(403);
    expect((await call('erin', 'GET', '/v1/billing/payment-methods')).statusCode).toBe(403);
    expect(
      (
        await call('erin', 'POST', '/v1/billing/payment-methods', {
          provider: 'mock',
          setupToken: 'tok_mock_success_er1',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await call('erin', 'DELETE', `/v1/billing/payment-methods/${M.success}`)).statusCode,
    ).toBe(403);
    const dv = (
      (await call('dave', 'GET', '/v1/billing/payment-methods')).json().items as Row[]
    ).find(
      (m) =>
        m.last4 === '4242' &&
        !m.isDefault &&
        m.id !== M.threeds &&
        m.id !== M.timeout &&
        m.id !== M.processing,
    )!;
    expect((await call('dave', 'DELETE', `/v1/billing/payment-methods/${dv.id}`)).statusCode).toBe(
      204,
    );
  });

  it('default switching keeps exactly one default; removing the default promotes the newest other; a removed method is gone', async () => {
    const set = await call('alice', 'POST', `/v1/billing/payment-methods/${M.decline}/default`);
    expect(set.json()).toMatchObject({ id: M.decline, isDefault: true });
    expect(
      ((await call('alice', 'GET', '/v1/billing/payment-methods')).json().items as Row[])
        .filter((m) => m.isDefault)
        .map((m) => m.id),
    ).toEqual([M.decline]);
    expect(
      (await call('alice', 'POST', `/v1/billing/payment-methods/${M.success}/default`)).json()
        .isDefault,
    ).toBe(true);
    const extra = await addMethod('alice', 'tok_mock_success_x5');
    await call('alice', 'POST', `/v1/billing/payment-methods/${extra}/default`);
    expect((await call('alice', 'DELETE', `/v1/billing/payment-methods/${extra}`)).statusCode).toBe(
      204,
    );
    const now = (await call('alice', 'GET', '/v1/billing/payment-methods')).json().items as Row[];
    expect(now.filter((m) => m.isDefault)).toHaveLength(1); // promoted
    expect(now.map((m) => m.id)).not.toContain(extra);
    await call('alice', 'POST', `/v1/billing/payment-methods/${M.success}/default`); // back to the success card
    expect(
      (await call('alice', 'POST', `/v1/billing/payment-methods/${extra}/default`)).statusCode,
    ).toBe(404);
    expect((await call('alice', 'DELETE', `/v1/billing/payment-methods/${extra}`)).statusCode).toBe(
      404,
    );
  });

  it('is tenant isolated and the database refuses anything card-like or any edit of a stored method', async () => {
    expect(
      (await call('bob', 'GET', '/v1/billing/payment-methods', undefined, orgB)).json().items,
    ).toEqual([]);
    expect(
      (await call('bob', 'DELETE', `/v1/billing/payment-methods/${M.success}`, undefined, orgB))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await call(
          'bob',
          'POST',
          `/v1/billing/payment-methods/${M.success}/default`,
          undefined,
          orgB,
        )
      ).statusCode,
    ).toBe(404);
    const acct = (await h.env.sql(`SELECT id FROM payments.psp_accounts LIMIT 1`))[0]!.id;
    const ins = (token: string, fp: string, last4 = '4242') =>
      h.env.sql(
        `INSERT INTO payments.payment_methods (id, org_id, psp_account_id, token_ref, brand, last4, exp_month, exp_year, fingerprint) VALUES (gen_random_uuid(), '${orgA}', '${acct}', '${token}', 'visa', '${last4}', 12, 2030, '${fp}')`,
      );
    await expect(ins(PAN, 'fp_12345678')).rejects.toThrow(/check/i); // a card number as a token
    await expect(ins('pm_ok_12345', PAN)).rejects.toThrow(/check/i); // a card number as a fingerprint
    await expect(ins('pm_ok_12345', 'fp_12345678', '42')).rejects.toThrow(/check/i);
    await expect(
      h.env.sql(`UPDATE payments.payment_methods SET brand = 'amex' WHERE id = '${M.success}'`),
    ).rejects.toThrow(/immutable/);
    await expect(
      h.env.sql(`DELETE FROM payments.payment_methods WHERE id = '${M.success}'`),
    ).rejects.toThrow(/never deleted/);
    await expect(h.env.sql(`TRUNCATE payments.payment_methods CASCADE`)).rejects.toThrow();
  });
});

describe('paying an invoice', () => {
  it('success: the payment captures, the invoice is paid, the ledger holds Dr 1100 / Cr 1200, and a second payment is refused', async () => {
    const inv = await invoice(orgA, 11_500);
    const r = await pay('alice', inv, M.success);
    expect(r.statusCode).toBe(201);
    const p = r.json();
    expect(p).toMatchObject({
      status: 'succeeded',
      amountMinor: '11500',
      capturedMinor: '11500',
      currency: 'SAR',
      invoiceId: inv,
      failureCode: null,
      nextAction: null,
    });
    expect(await invoiceRow(inv)).toMatchObject({ status: 'paid', paid: '11500' });
    expect(await ledgerFor(p.id)).toEqual([
      { code: '1100', direction: 'debit', amt: '11500', subledger_key: 'mock-sandbox' },
      { code: '1200', direction: 'credit', amt: '11500', subledger_key: null },
    ]);
    expect(
      await count(
        `SELECT count(*)::int n FROM platform.outbox WHERE org_id = $1 AND topic = 'payment.succeeded' AND payload->>'paymentId' = $2`,
        [orgA, p.id],
      ),
    ).toBe(1);
    expect((await pay('alice', inv, M.success)).statusCode).toBe(409);
    const attempts = await h.env.sql(
      `SELECT seq, status FROM payments.payment_attempts WHERE intent_id = $1`,
      [p.id],
    );
    expect(attempts).toEqual([{ seq: 1, status: 'succeeded' }]);
  });

  it('uses the default method when none is named; no method at all is 422 payment_method_required', async () => {
    const inv = await invoice(orgA, 500);
    expect((await pay('alice', inv)).json().status).toBe('succeeded'); // default = the success card
    const none = await invoice(orgB, 500);
    const r = await pay('bob', none, undefined, {}, orgB);
    expect([r.statusCode, r.json().code]).toEqual([422, 'payment_method_required']);
  });

  it('a decline fails the payment without touching the invoice or the ledger; the customer can then try again', async () => {
    const inv = await invoice(orgA, 2_000);
    const p = (await pay('alice', inv, M.decline)).json();
    expect(p).toMatchObject({ status: 'failed', failureCode: 'card_declined', capturedMinor: '0' });
    expect(await invoiceRow(inv)).toMatchObject({ status: 'open', paid: '0' });
    expect(await ledgerFor(p.id)).toEqual([]);
    const retry = (await pay('alice', inv, M.success)).json();
    expect(retry.status).toBe('succeeded');
    expect(retry.id).not.toBe(p.id);
    expect(await invoiceRow(inv)).toMatchObject({ status: 'paid' });
  });

  it('3-D Secure: requires_action with a redirect; the signed webhook completes it; a repeated webhook changes nothing', async () => {
    const inv = await invoice(orgA, 7_000);
    const p = (await pay('alice', inv, M.threeds)).json();
    expect(p).toMatchObject({ status: 'requires_action', nextAction: { type: 'redirect' } });
    expect(p.nextAction.url).toContain('mock-psp');
    expect((await call('alice', 'GET', `/v1/billing/payments/${p.id}`)).json().status).toBe(
      'requires_action',
    ); // still waiting
    const ev = mock().complete(await merchantRef(p.id));
    const first = await hook(ev.rawBody, ev.headers);
    expect([first.statusCode, first.json().outcome]).toEqual([200, 'processed']);
    expect((await call('alice', 'GET', `/v1/billing/payments/${p.id}`)).json()).toMatchObject({
      status: 'succeeded',
      capturedMinor: '7000',
      nextAction: null,
    });
    expect(await invoiceRow(inv)).toMatchObject({ status: 'paid', paid: '7000' });
    expect((await hook(ev.rawBody, ev.headers)).json().outcome).toBe('duplicate');
    expect((await ledgerFor(p.id)).length).toBe(2);
  });

  it('a payment the PSP is still processing answers 202 and is completed by the webhook', async () => {
    const inv = await invoice(orgA, 900);
    const r = await pay('alice', inv, M.processing);
    expect(r.statusCode).toBe(202);
    const p = r.json();
    expect(p.status).toBe('processing');
    const ev = mock().complete(await merchantRef(p.id));
    expect((await hook(ev.rawBody, ev.headers)).json().outcome).toBe('processed');
    expect((await call('alice', 'GET', `/v1/billing/payments/${p.id}`)).json().status).toBe(
      'succeeded',
    );
  });

  it('psp_timeout_reconciles_before_retry: the lost answer is adopted, the customer is never charged twice', async () => {
    const inv = await invoice(orgA, 3_300);
    const r = await pay('alice', inv, M.timeout);
    expect(r.statusCode).toBe(202);
    const p = r.json();
    expect(p.status).toBe('processing');
    expect(
      (
        await h.env.sql(`SELECT status FROM payments.payment_attempts WHERE intent_id = $1`, [p.id])
      ).map((a) => a.status),
    ).toEqual(['uncertain']);
    const ref = await merchantRef(p.id);
    expect(mock().chargeCount(ref)).toBe(1); // the PSP did charge
    const retry = await pay('alice', inv, M.timeout); // the customer clicks "pay" again with a new Idempotency-Key
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ id: p.id, status: 'succeeded' }); // the existing payment, now known to be paid
    expect(mock().chargeCount(ref)).toBe(1);
    expect(mock().duplicateCharges).toBe(0);
    expect(await invoiceRow(inv)).toMatchObject({ status: 'paid', paid: '3300' });
    expect((await ledgerFor(p.id)).length).toBe(2);
    expect(
      await count(`SELECT count(*)::int n FROM payments.payment_intents WHERE invoice_id = $1`, [
        inv,
      ]),
    ).toBe(1);
  });

  it('a PSP with NO record of an uncertain payment gets exactly one new attempt (the first never arrived)', async () => {
    const inv = await invoice(orgA, 410);
    const p = (await pay('alice', inv, M.processing)).json(); // 202 processing
    const ref = await merchantRef(p.id);
    (mock() as any).payments.delete(ref); // the PSP "lost" it: no record of the reference
    const after = (await call('alice', 'GET', `/v1/billing/payments/${p.id}`)).json(); // reconcile → no record → one fresh attempt
    expect(after.status).toBe('processing');
    expect(
      (
        await h.env.sql(
          `SELECT seq FROM payments.payment_attempts WHERE intent_id = $1 ORDER BY seq`,
          [p.id],
        )
      ).map((a) => a.seq),
    ).toEqual([1, 2]);
  });

  it('pays in parts: partially_paid then paid; more than is owed is refused', async () => {
    const inv = await invoice(orgA, 10_000);
    expect((await pay('alice', inv, M.success, { amount: '10001' })).statusCode).toBe(422);
    expect((await pay('alice', inv, M.success, { amount: '4000' })).json().status).toBe(
      'succeeded',
    );
    expect(await invoiceRow(inv)).toMatchObject({ status: 'partially_paid', paid: '4000' });
    expect((await pay('alice', inv, M.success, { amount: '6001' })).statusCode).toBe(422);
    expect((await pay('alice', inv, M.success)).json().amountMinor).toBe('6000'); // default = what is still owed
    expect(await invoiceRow(inv)).toMatchObject({ status: 'paid', paid: '10000' });
  });

  it('validates: card data, return URL origin, payable invoice states, foreign invoices, unsupported targets, roles', async () => {
    const inv = await invoice(orgA, 1_000);
    expect((await pay('alice', inv, M.success, { cardNumber: PAN })).json().code).toBe(
      'pan_not_allowed',
    );
    expect(
      (await pay('alice', inv, M.success, { returnUrl: 'https://evil.example/steal' })).statusCode,
    ).toBe(422);
    expect((await pay('alice', inv, M.success, { returnUrl: 'not a url' })).statusCode).toBe(422);
    expect(
      (
        await call('alice', 'POST', '/v1/billing/payments', {
          invoiceId: inv,
          returnUrl: RETURN,
          quoteId: crypto.randomUUID(),
        })
      ).statusCode,
    ).toBe(422);
    expect((await pay('alice', 'not-a-uuid', M.success)).statusCode).toBe(422);
    expect((await pay('alice', crypto.randomUUID(), M.success)).statusCode).toBe(404);
    expect((await pay('alice', await invoice(orgA, 100, 'void'))).statusCode).toBe(409);
    expect((await pay('alice', await invoice(orgA, 100, 'paid', 100))).statusCode).toBe(409);
    expect((await pay('bob', inv, undefined, {}, orgB)).statusCode).toBe(404); // another organization's invoice
    expect((await pay('erin', inv, M.success)).statusCode).toBe(403);
    expect((await pay('carol', inv, M.success)).statusCode).toBe(403);
    expect((await pay('alice', inv, crypto.randomUUID())).statusCode).toBe(404); // unknown method
    expect(await invoiceRow(inv)).toMatchObject({ status: 'open' });
  });

  it('a method with a payment in progress cannot be removed', async () => {
    const m = await addMethod('alice', 'tok_mock_3ds_rm1');
    const p = (await pay('alice', await invoice(orgA, 800), m)).json();
    expect(p.status).toBe('requires_action');
    expect((await call('alice', 'DELETE', `/v1/billing/payment-methods/${m}`)).statusCode).toBe(
      409,
    );
    mock().complete(await merchantRef(p.id), 'failed');
    expect((await call('alice', 'GET', `/v1/billing/payments/${p.id}`)).json().status).toBe(
      'failed',
    );
    expect((await call('alice', 'DELETE', `/v1/billing/payment-methods/${m}`)).statusCode).toBe(
      204,
    );
  });

  it('lists payments newest first with filters; is tenant isolated', async () => {
    const list = (await call('dave', 'GET', '/v1/billing/payments?limit=3')).json();
    expect(list.items).toHaveLength(3);
    expect(list.nextCursor).toBeTruthy();
    expect((await call('dave', 'GET', '/v1/billing/payments?status=bogus')).statusCode).toBe(422);
    const failed = (await call('dave', 'GET', '/v1/billing/payments?status=failed')).json()
      .items as Row[];
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((p) => p.status === 'failed')).toBe(true);
    const some = list.items[0].id;
    expect(
      (await call('bob', 'GET', `/v1/billing/payments/${some}`, undefined, orgB)).statusCode,
    ).toBe(404);
    expect(
      (await call('bob', 'GET', '/v1/billing/payments', undefined, orgB)).json().items,
    ).toEqual([]);
    expect((await call('carol', 'GET', '/v1/billing/payments')).statusCode).toBe(403);
  });
});

describe('webhooks', () => {
  const fresh = async (token = M.threeds) => {
    const p = (await pay('alice', await invoice(orgA, 1_500), token)).json();
    return { p, ref: await merchantRef(p.id) };
  };

  it('rejects a bad signature, a tampered body, a replay and malformed input; unknown providers are 404', async () => {
    const { ref } = await fresh();
    const ev = mock().signedEvent('payment.succeeded', ref);
    expect(
      (
        await hook(ev.rawBody, {
          'content-type': 'application/json',
          'x-mock-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`,
        })
      ).statusCode,
    ).toBe(401);
    expect((await hook(ev.rawBody.replace('succeeded', 'failed'), ev.headers)).statusCode).toBe(
      401,
    );
    expect((await hook(ev.rawBody, { 'content-type': 'application/json' })).statusCode).toBe(401);
    const old = mock().signedEvent('payment.succeeded', ref, new Date(), {
      signAt: new Date(Date.now() - 10 * 60_000),
    });
    expect((await hook(old.rawBody, old.headers)).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/webhooks/payments/unknown',
          headers: ev.headers,
          payload: ev.rawBody,
        })
      ).statusCode,
    ).toBe(404);
    const junk = 'not json';
    expect(
      (
        await hook(junk, {
          'content-type': 'application/json',
          'x-mock-signature': mock().sign(junk, new Date()),
        })
      ).statusCode,
    ).toBe(422); // the body parser refuses non-JSON first
    expect(
      await count(`SELECT count(*)::int n FROM payments.psp_events WHERE event_id = $1`, [
        JSON.parse(ev.rawBody).id,
      ]),
    ).toBe(0); // nothing stored for a rejected delivery
  });

  it('AC-M03-02: the same event delivered 100 times in parallel has exactly one ledger effect', async () => {
    const { p, ref } = await fresh();
    const ev = mock().complete(ref);
    const res = await Promise.all(Array.from({ length: 100 }, () => hook(ev.rawBody, ev.headers)));
    expect(res.every((r) => r.statusCode === 200)).toBe(true);
    const outcomes = res.map((r) => r.json().outcome);
    expect(outcomes.filter((o) => o === 'processed')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(99);
    expect((await ledgerFor(p.id)).length).toBe(2);
    expect(
      await count(
        `SELECT count(*)::int n FROM invoicing.invoice_payment_applications WHERE payment_id = $1`,
        [p.id],
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*)::int n FROM platform.outbox WHERE topic = 'payment.succeeded' AND payload->>'paymentId' = $1`,
        [p.id],
      ),
    ).toBe(1);
    expect(
      await count(`SELECT count(*)::int n FROM payments.psp_events WHERE event_id = $1`, [
        JSON.parse(ev.rawBody).id,
      ]),
    ).toBe(1);
  });

  it('a second event for the same business fact (different event id) is ignored: still one ledger effect', async () => {
    const { p, ref } = await fresh();
    const a = mock().complete(ref);
    await hook(a.rawBody, a.headers);
    const b = mock().signedEvent('payment.succeeded', ref, new Date(), { id: 'evt_again_1' });
    expect((await hook(b.rawBody, b.headers)).json().outcome).toBe('ignored');
    expect((await ledgerFor(p.id)).length).toBe(2);
  });

  it('webhook_out_of_order: an older "failed" arriving after "succeeded" changes nothing', async () => {
    const { p, ref } = await fresh();
    const t2 = new Date(Date.now() - 1_000);
    const ok = mock().complete(ref, 'succeeded', t2);
    const late = mock().signedEvent('payment.failed', ref, new Date(), {
      createdAt: new Date(t2.getTime() - 5_000),
      failureCode: 'card_declined',
    });
    expect((await hook(ok.rawBody, ok.headers)).json().outcome).toBe('processed');
    expect((await hook(late.rawBody, late.headers)).json().outcome).toBe('ignored');
    expect((await call('alice', 'GET', `/v1/billing/payments/${p.id}`)).json()).toMatchObject({
      status: 'succeeded',
      failureCode: null,
    });
    expect((await ledgerFor(p.id)).length).toBe(2);
  });

  it('a "succeeded" arriving after a recorded failure is an anomaly for finance, never an automatic reversal', async () => {
    const { p, ref } = await fresh();
    const failed = mock().signedEvent('payment.failed', ref, new Date(), {
      createdAt: new Date(Date.now() - 9_000),
      failureCode: 'authentication_failed',
    });
    const later = mock().signedEvent('payment.succeeded', ref, new Date(), {
      createdAt: new Date(Date.now() - 1_000),
    });
    expect((await hook(failed.rawBody, failed.headers)).json().outcome).toBe('processed');
    expect((await hook(later.rawBody, later.headers)).json().outcome).toBe('failed');
    expect((await call('alice', 'GET', `/v1/billing/payments/${p.id}`)).json().status).toBe(
      'failed',
    );
    expect(
      (
        await h.env.sql(`SELECT status, error FROM payments.psp_events WHERE event_id = $1`, [
          JSON.parse(later.rawBody).id,
        ])
      )[0],
    ).toMatchObject({ status: 'failed', error: 'succeeded_after_terminal_failure' });
    expect((await ledgerFor(p.id)).length).toBe(0);
  });

  it('an amount that does not match the intent is not captured; an unknown reference is acknowledged and ignored', async () => {
    const { p, ref } = await fresh();
    const bad = mock().signedEvent('payment.succeeded', ref, new Date(), { amountMinor: '1' });
    expect((await hook(bad.rawBody, bad.headers)).json().outcome).toBe('failed');
    expect((await call('alice', 'GET', `/v1/billing/payments/${p.id}`)).json().status).toBe(
      'requires_action',
    );
    expect((await ledgerFor(p.id)).length).toBe(0);
    const unknown = mock().signedEvent(
      'payment.succeeded',
      'nuzm_pi_00000000-0000-4000-8000-000000000000',
    );
    const r = await hook(unknown.rawBody, unknown.headers);
    expect([r.statusCode, r.json().outcome]).toEqual([200, 'ignored']);
  });

  it('stores only a whitelist of the event, never extra fields that could carry card data; tenant sessions cannot read events', async () => {
    const { ref } = await fresh();
    const ev = mock().signedEvent('payment.requires_action', ref, new Date(), {
      id: 'evt_extra_1',
    });
    const body = JSON.parse(ev.rawBody);
    body.data.card = { number: PAN, cvv: '123' };
    body.extra = PAN;
    const raw = JSON.stringify(body);
    expect(
      (
        await hook(raw, {
          'content-type': 'application/json',
          'x-mock-signature': mock().sign(raw, new Date()),
        })
      ).statusCode,
    ).toBe(200);
    const stored = (
      await h.env.sql(`SELECT payload FROM payments.psp_events WHERE event_id = 'evt_extra_1'`)
    )[0]!.payload as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual([
      'amountMinor',
      'currency',
      'failureCode',
      'id',
      'merchantReference',
      'pspPaymentRef',
      'type',
    ]);
    expect(JSON.stringify(stored)).not.toContain(PAN);
    expect(
      (
        await h.env.app.withOrg(orgA, (c) =>
          c.query(`SELECT count(*)::int n FROM payments.psp_events`),
        )
      ).rows[0]!.n,
    ).toBe(0); // the table is closed to tenant scopes
  });

  it('processPending re-runs an event that was stored but not processed', async () => {
    const { p, ref } = await fresh();
    const ev = mock().complete(ref);
    const parsed = JSON.parse(ev.rawBody);
    await h.env.sql(
      `INSERT INTO payments.psp_events (id, psp, event_id, type, org_id, intent_id, event_at, payload, status) VALUES (gen_random_uuid(), 'mock', $1, 'payment.succeeded', $2, $3, now(), $4, 'received')`,
      [
        parsed.id,
        orgA,
        p.id,
        JSON.stringify({
          id: parsed.id,
          type: 'payment.succeeded',
          merchantReference: ref,
          pspPaymentRef: parsed.data.pspPaymentRef,
          amountMinor: '1500',
          currency: 'SAR',
          failureCode: null,
        }),
      ],
    );
    expect(await app.get(PaymentService).processPending()).toBeGreaterThanOrEqual(1);
    expect((await call('alice', 'GET', `/v1/billing/payments/${p.id}`)).json().status).toBe(
      'succeeded',
    );
    expect(
      (
        await h.env.sql(`SELECT status FROM payments.psp_events WHERE event_id = $1`, [parsed.id])
      )[0]!.status,
    ).toBe('processed');
  });
});

describe('AC-M03-03: reconcile-before-retry over 1,000 injected timeouts', () => {
  it('creates no duplicate charge in any run', async () => {
    const svc = app.get(PaymentService);
    const N = 1_000;
    const base = invSeq;
    await h.env.sql(
      `INSERT INTO invoicing.invoices (id, org_id, entity_id, series, number, number_text, status, environment, currency, period_start, period_end, issued_at, due_at, source_key, subtotal_minor, tax_minor, total_minor, buyer, seller)
       SELECT gen_random_uuid(), '${orgC}', e.id, 'TO', g, 'TO-' || g, 'open', 'sandbox', 'SAR', '2026-11-01', '2026-11-30', now(), now(), 'timeout-' || g, 100 + g, 0, 100 + g,
              '{"legalName":{"ar":"x","en":"x"},"vatNumber":null,"buyerType":"b2c"}', '{"legalName":{"ar":"x","en":"x"},"vatNumber":null,"placeholder":true}'
         FROM invoicing.billing_entities e, generate_series(1, ${N}) g`,
    );
    invSeq = base + N;
    const invoices = (
      await h.env.sql(
        `SELECT id FROM invoicing.invoices WHERE org_id = $1 AND series = 'TO' ORDER BY number`,
        [orgC],
      )
    ).map((r) => r.id as string);
    expect(invoices).toHaveLength(N);
    const dupBefore = mock().duplicateCharges;
    for (const id of invoices) {
      const first = await svc.create(orgC, ids.frank!, { invoiceId: id, returnUrl: RETURN });
      expect(first.httpStatus).toBe(202); // the answer was lost
      const retry = await svc.create(orgC, ids.frank!, { invoiceId: id, returnUrl: RETURN }); // the customer tries again
      expect(retry.payment).toMatchObject({ id: first.payment.id, status: 'succeeded' });
    }
    expect(mock().duplicateCharges - dupBefore).toBe(0);
    const intents = await h.env.sql(
      `SELECT merchant_reference r FROM payments.payment_intents WHERE org_id = $1`,
      [orgC],
    );
    expect(intents).toHaveLength(N);
    for (const i of intents) expect(mock().chargeCount(i.r as string)).toBe(1);
    expect(
      await count(
        `SELECT count(*)::int n FROM invoicing.invoices WHERE org_id = $1 AND status = 'paid'`,
        [orgC],
      ),
    ).toBe(N);
    expect(
      await count(
        `SELECT count(*)::int n FROM billing.ledger_transactions WHERE org_id = $1 AND kind = 'payment_captured'`,
        [orgC],
      ),
    ).toBe(N);
  }, 900_000);
});

describe('payment guarantees at the database', () => {
  const FAKE_ORG = crypto.randomUUID();
  it('the intent state machine in the database equals the code table for every pair', async () => {
    const all: IntentStatus[] = [
      'requires_method',
      'requires_action',
      'processing',
      'succeeded',
      'failed',
      'cancelled',
      'partially_refunded',
      'refunded',
    ];
    const acct = (await h.env.sql(`SELECT id FROM payments.psp_accounts LIMIT 1`))[0]!.id as string;
    let n = 0;
    for (const from of all)
      for (const to of all) {
        if (from === to) continue;
        const id = crypto.randomUUID();
        const captured = ['succeeded', 'partially_refunded', 'refunded'].includes(from) ? 100 : 0;
        await h.env.sql(
          `INSERT INTO payments.payment_intents (id, org_id, psp_account_id, invoice_id, amount_minor, currency, status, merchant_reference, captured_minor) VALUES ($1,$2,$3,$4,100,'SAR',$5,$6,$7)`,
          [id, FAKE_ORG, acct, crypto.randomUUID(), from, `nuzm_pi_${id}`, captured],
        );
        n++;
        const capturedTo = ['succeeded', 'partially_refunded', 'refunded'].includes(to)
          ? 100
          : captured;
        const attempt = h.env.sql(
          `UPDATE payments.payment_intents SET status = $2, captured_minor = $3, updated_at = now() WHERE id = $1`,
          [id, to, capturedTo],
        );
        if (INTENT_TRANSITIONS[from].includes(to))
          await expect(attempt, `${from}→${to}`).resolves.toBeDefined();
        else await expect(attempt, `${from}→${to}`).rejects.toThrow();
      }
    expect(n).toBe(56);
  });
  it('identity, amount and merchant reference are frozen; captured and refunded only grow; attempts are append-only; nothing is deleted', async () => {
    const acct = (await h.env.sql(`SELECT id FROM payments.psp_accounts LIMIT 1`))[0]!.id as string;
    const id = crypto.randomUUID();
    await h.env.sql(
      `INSERT INTO payments.payment_intents (id, org_id, psp_account_id, invoice_id, amount_minor, currency, status, merchant_reference, captured_minor) VALUES ($1,$2,$3,$4,100,'SAR','succeeded',$5,100)`,
      [id, FAKE_ORG, acct, crypto.randomUUID(), `nuzm_pi_${id}`],
    );
    for (const sql of [
      `UPDATE payments.payment_intents SET amount_minor = 1 WHERE id = '${id}'`,
      `UPDATE payments.payment_intents SET org_id = '${orgA}' WHERE id = '${id}'`,
      `UPDATE payments.payment_intents SET merchant_reference = 'nuzm_pi_${crypto.randomUUID()}' WHERE id = '${id}'`,
      `UPDATE payments.payment_intents SET captured_minor = 50 WHERE id = '${id}'`,
      `DELETE FROM payments.payment_intents WHERE id = '${id}'`,
      `TRUNCATE payments.payment_intents CASCADE`,
      `TRUNCATE payments.payment_attempts`,
    ])
      await expect(h.env.sql(sql), sql).rejects.toThrow();
    await h.env.sql(
      `INSERT INTO payments.payment_attempts (id, intent_id, org_id, seq, status) VALUES (gen_random_uuid(), '${id}', '${FAKE_ORG}', 1, 'succeeded')`,
    );
    await expect(
      h.env.sql(`UPDATE payments.payment_attempts SET status = 'failed' WHERE intent_id = '${id}'`),
    ).rejects.toThrow(/append-only/);
    await expect(
      h.env.sql(`DELETE FROM payments.payment_attempts WHERE intent_id = '${id}'`),
    ).rejects.toThrow(/append-only/);
    for (const role of ['app', 'worker'] as const) {
      await expect(
        h.env[role].withOrg(orgA, (c) =>
          c.query(`UPDATE payments.payment_intents SET amount_minor = 1`),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        h.env[role].withOrg(orgA, (c) => c.query(`DELETE FROM payments.payment_attempts`)),
      ).rejects.toThrow(/permission denied/);
    }
  });
  it('payment applications are append-only and unique per (invoice, payment)', async () => {
    const r = (
      await h.env.sql(
        `SELECT invoice_id, payment_id FROM invoicing.invoice_payment_applications LIMIT 1`,
      )
    )[0]!;
    await expect(
      h.env.sql(
        `INSERT INTO invoicing.invoice_payment_applications (invoice_id, payment_id, org_id, amount_minor) VALUES ('${r.invoice_id}', '${r.payment_id}', '${orgA}', 1)`,
      ),
    ).rejects.toThrow(/duplicate key/);
    await expect(
      h.env.sql(`UPDATE invoicing.invoice_payment_applications SET amount_minor = 1`),
    ).rejects.toThrow(/append-only/);
    await expect(h.env.sql(`DELETE FROM invoicing.invoice_payment_applications`)).rejects.toThrow(
      /append-only/,
    );
  });
});

describe('AC-M03-04: no card data anywhere in what this platform stores', () => {
  it('no Luhn-valid card number appears in any payments, invoicing, ledger, outbox or audit row', async () => {
    const tables = [
      'payments.payment_methods',
      'payments.payment_intents',
      'payments.payment_attempts',
      'payments.psp_events',
      'payments.customers_psp',
      'invoicing.invoices',
      'invoicing.invoice_payment_applications',
      'billing.ledger_transactions',
      'billing.ledger_postings',
      'platform.outbox',
      'audit.audit_logs',
    ];
    let rows = 0;
    for (const t of tables) {
      const all = (await h.env.sql(`SELECT row_to_json(x)::text j FROM ${t} x`)) as { j: string }[];
      rows += all.length;
      for (const r of all)
        expect(looksLikeCardNumber(r.j), `${t}: ${r.j.slice(0, 80)}`).toBe(false);
    }
    expect(rows).toBeGreaterThan(500);
  });
});
