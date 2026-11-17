import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { MockPsp, RefundService } from './index';
import { RefundService as RefundServiceImpl } from './internal/refund.service';
import { LedgerPostingService } from '../billing';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { PspRegistry } from './internal/psp/registry';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
type Row = Record<string, any>;

const PAN = ['4242', '4242', '4242', '4242'].join('');
const RETURN = 'http://127.0.0.1:3000/en/billing/payment-return';
const h = new Harness();
let app: App;
let orgA = '';
let orgB = '';
const ids: Record<string, string> = {};
const jars: Record<string, Record<string, string>> = {};
const staff: Record<string, Record<string, string>> = {};
const M: Record<string, string> = {};
let invSeq = 0;

const call = (
  who: string,
  method: 'GET' | 'POST',
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
const refundReq = (who: string, body: object, key: string | null = `r-${Math.random()}`) =>
  app.inject({
    method: 'POST',
    url: '/v1/admin/billing/refunds',
    headers: {
      cookie: cookieHeader(staff[who]!),
      'x-csrf-token': staff[who]!.nuzm_admin_csrf!,
      ...(key ? { 'idempotency-key': key } : {}),
    },
    payload: body,
  });
const mock = () => app.get(MockPsp);
const refunds = () => app.get(RefundService);
const sql = (q: string, p: unknown[] = []) => h.env.sql(q, p) as Promise<Row[]>;
const count = async (q: string, p: unknown[] = []) => Number((await sql(q, p))[0]!.n);
const hook = (raw: string, headers: Record<string, string>) =>
  app.inject({ method: 'POST', url: '/v1/webhooks/payments/mock', headers, payload: raw });

const invoice = async (org: string, total: number) => {
  const id = crypto.randomUUID();
  const n = ++invSeq;
  await sql(
    `INSERT INTO invoicing.invoices (id, org_id, entity_id, series, number, number_text, status, environment, currency, period_start, period_end, issued_at, due_at, source_key, subtotal_minor, tax_minor, total_minor, paid_minor, buyer, seller)
     SELECT $1, $2, id, 'RF', $3::bigint, 'RF-' || $3::text, 'open', 'sandbox', 'SAR', '2026-11-01', '2026-11-30', now(), now(), $4, $5, 0, $5, 0, '{"legalName":{"ar":"x","en":"x"},"vatNumber":null,"buyerType":"b2c"}', '{"legalName":{"ar":"x","en":"x"},"vatNumber":null,"placeholder":true}' FROM invoicing.billing_entities LIMIT 1`,
    [id, org, n, `rf-fixture-${n}`, total],
  );
  return id;
};
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
/** A captured payment of `total` minor units on a fresh open invoice. */
const captured = async (total: number, method = M.success!) => {
  const inv = await invoice(orgA, total);
  const r = await call('alice', 'POST', '/v1/billing/payments', {
    invoiceId: inv,
    returnUrl: RETURN,
    paymentMethodId: method,
  });
  expect(r.statusCode).toBe(201);
  expect(r.json().status).toBe('succeeded');
  return { paymentId: r.json().id as string, invoiceId: inv };
};
const intent = async (id: string) =>
  (
    await sql(
      `SELECT status, captured_minor::text cap, refunded_minor::text ref, merchant_reference mr FROM payments.payment_intents WHERE id = $1`,
      [id],
    )
  )[0]!;
const refundLedger = (paymentId: string, refundId: string) =>
  sql(
    `SELECT a.code, p.direction, p.amount_minor::text amt, a.subledger_key FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id = p.account_id JOIN billing.ledger_transactions t ON t.id = p.transaction_id WHERE t.idempotency_key = $1 ORDER BY a.code`,
    [`payment:${paymentId}:refund:${refundId}`],
  );
const refundTxCount = async (paymentId: string) =>
  count(`SELECT count(*)::int n FROM billing.ledger_transactions WHERE idempotency_key LIKE $1`, [
    `payment:${paymentId}:refund:%`,
  ]);

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  for (const n of ['alice', 'bob', 'carol']) {
    ids[n] = await h.createUser(n);
    jars[n] = await h.sessionFor(app, ids[n]!);
    await h.elevate(jars[n]!);
  }
  const mk = async (who: string, name: string) =>
    (
      await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: { cookie: cookieHeader(jars[who]!), 'x-csrf-token': jars[who]!.nuzm_csrf! },
        payload: { name },
      })
    ).json().id as string;
  orgA = await mk('alice', 'Refund A');
  orgB = await mk('bob', 'Refund B');
  await sql(
    `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, 'viewer')`,
    [orgA, ids.carol],
  );
  for (const [name, roles] of Object.entries({
    fin1: ['finance'],
    root: ['platform_admin'],
    sup: ['support'],
  })) {
    const u = await h.platformUser(app, `staff-${name}`, roles);
    ids[name] = u.id;
    staff[name] = u.jar;
  }
  M.success = await addMethod('alice', 'tok_mock_success_a1');
  M.decline = await addMethod('alice', 'tok_mock_decline_b1');
  M.threeds = await addMethod('alice', 'tok_mock_3ds_c1');
  M.timeout = await addMethod('alice', 'tok_mock_timeout_d1');
});
afterAll(() => h.close());

describe('refunds', () => {
  it('refunds part of a payment: PSP refunded once, intent partially_refunded, ledger Dr 1200 / Cr 1100, audit and outbox event', async () => {
    const { paymentId } = await captured(10000);
    const r = await refundReq('fin1', { paymentId, amount: '4000', reason: 'customer request' });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body).toMatchObject({
      status: 'succeeded',
      amountMinor: '4000',
      currency: 'SAR',
      paymentId,
      failureCode: null,
    });
    const i = await intent(paymentId);
    expect(i).toMatchObject({ status: 'partially_refunded', cap: '10000', ref: '4000' });
    expect(mock().refundedTotal(i.mr)).toBe(4000n);
    expect(mock().duplicateRefunds).toBe(0);
    expect(await refundLedger(paymentId, body.id)).toEqual([
      { code: '1100', direction: 'credit', amt: '4000', subledger_key: 'mock-sandbox' },
      { code: '1200', direction: 'debit', amt: '4000', subledger_key: null },
    ]);
    expect(
      await count(
        `SELECT count(*)::int n FROM platform.outbox WHERE topic = 'payment.refunded' AND payload->>'refundId' = $1`,
        [body.id],
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*)::int n FROM audit.audit_logs WHERE action IN ('payments.refund.requested','payments.refund.succeeded') AND resource_id = $1`,
        [body.id],
      ),
    ).toBe(2);
    // the invoice stays paid: the legal correction is the credit note, a refund moves money
    const inv = await sql(
      `SELECT status FROM invoicing.invoices WHERE id = (SELECT invoice_id FROM payments.payment_intents WHERE id = $1)`,
      [paymentId],
    );
    expect(inv[0]!.status).toBe('paid');
  });

  it('refunding the rest moves the payment to refunded; nothing more can be refunded', async () => {
    const { paymentId } = await captured(5000);
    expect(
      (await refundReq('fin1', { paymentId, amount: '2000', reason: 'part 1' })).statusCode,
    ).toBe(201);
    expect(
      (await refundReq('fin1', { paymentId, amount: '3000', reason: 'part 2' })).statusCode,
    ).toBe(201);
    expect(await intent(paymentId)).toMatchObject({ status: 'refunded', ref: '5000' });
    const more = await refundReq('fin1', { paymentId, amount: '1', reason: 'too much' });
    expect(more.statusCode).toBe(409);
    expect(await refundTxCount(paymentId)).toBe(2);
  });

  it('refuses more than the remaining captured amount (422) without calling the PSP or posting anything', async () => {
    const { paymentId } = await captured(3000);
    const calls = mock().refundedTotal((await intent(paymentId)).mr);
    const r = await refundReq('fin1', { paymentId, amount: '3001', reason: 'x' });
    expect(r.statusCode).toBe(422);
    expect(r.json().detail).toMatch(/can still be refunded \(3000\)/);
    expect(
      await count(`SELECT count(*)::int n FROM payments.refunds WHERE intent_id = $1`, [paymentId]),
    ).toBe(0);
    expect(mock().refundedTotal((await intent(paymentId)).mr)).toBe(calls);
    expect(await refundTxCount(paymentId)).toBe(0);
  });

  it('is idempotent: the same key and body returns the same refund (200, one PSP refund); another body under that key is refused', async () => {
    const { paymentId } = await captured(8000);
    const body = { paymentId, amount: '1000', reason: 'dup test' };
    const a = await refundReq('fin1', body, 'same-key-1');
    const b = await refundReq('fin1', body, 'same-key-1');
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(
      await count(`SELECT count(*)::int n FROM payments.refunds WHERE intent_id = $1`, [paymentId]),
    ).toBe(1);
    expect(mock().refundedTotal((await intent(paymentId)).mr)).toBe(1000n);
    expect(await refundTxCount(paymentId)).toBe(1);
    expect((await refundReq('fin1', { ...body, amount: '1001' }, 'same-key-1')).statusCode).toBe(
      422,
    );
    expect((await refundReq('fin1', body, null)).statusCode).toBe(400);
  });

  it('is finance-only: support and customers cannot refund; unknown payments are 404; bad bodies are 422', async () => {
    const { paymentId } = await captured(1000);
    const body = { paymentId, amount: '100', reason: 'x' };
    expect((await refundReq('sup', body)).statusCode).toBe(403);
    const asCustomer = await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/refunds',
      headers: {
        cookie: cookieHeader(jars.alice!),
        'x-csrf-token': jars.alice!.nuzm_csrf!,
        'idempotency-key': 'c1',
      },
      payload: body,
    });
    expect([401, 403, 404]).toContain(asCustomer.statusCode);
    expect((await refundReq('fin1', { ...body, paymentId: crypto.randomUUID() })).statusCode).toBe(
      404,
    );
    for (const bad of [
      {},
      { ...body, amount: '0' },
      { ...body, amount: '1.5' },
      { ...body, amount: 100 },
      { ...body, reason: '' },
      { ...body, paymentId: 'nope' },
      { ...body, creditNoteId: 'nope' },
    ])
      expect((await refundReq('fin1', bad)).statusCode, JSON.stringify(bad)).toBe(422);
    expect(await refundTxCount(paymentId)).toBe(0);
  });

  it('a declined refund is recorded as failed, releases its reservation and posts nothing', async () => {
    const { paymentId } = await captured(6000);
    mock().queueRefund('fail');
    const r = await refundReq('fin1', { paymentId, amount: '6000', reason: 'will fail' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ status: 'failed', failureCode: 'refund_declined' });
    expect(await intent(paymentId)).toMatchObject({ status: 'succeeded', ref: '0' });
    expect(await refundTxCount(paymentId)).toBe(0);
    // the reservation is released: the same amount can be refunded again
    const again = await refundReq('fin1', { paymentId, amount: '6000', reason: 'second try' });
    expect(again.json().status).toBe('succeeded');
    expect(await intent(paymentId)).toMatchObject({ status: 'refunded', ref: '6000' });
  });

  it('an uncertain PSP answer (timeout) stays pending, reserves the amount, and is reconciled WITHOUT a second refund', async () => {
    const { paymentId } = await captured(9000);
    mock().queueRefund('timeout');
    const dupBefore = mock().duplicateRefunds;
    const r = await refundReq('fin1', { paymentId, amount: '9000', reason: 'timeout' });
    expect(r.statusCode).toBe(202);
    expect(r.json().status).toBe('pending');
    // pending money is reserved: nothing more can be refunded meanwhile
    expect((await refundReq('fin1', { paymentId, amount: '1', reason: 'over' })).statusCode).toBe(
      422,
    );
    const n = await refunds().processPending(50, 0);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await intent(paymentId)).toMatchObject({ status: 'refunded', ref: '9000' });
    expect(mock().refundedTotal((await intent(paymentId)).mr)).toBe(9000n);
    expect(mock().duplicateRefunds).toBe(dupBefore);
    expect(await refundTxCount(paymentId)).toBe(1);
    expect(await refunds().processPending(50, 0)).toBe(0); // nothing left to do; repeating is harmless
    expect(await refundTxCount(paymentId)).toBe(1);
  });

  it('a refund the PSP has not finished stays pending until the PSP finishes it; then one ledger effect', async () => {
    const { paymentId } = await captured(4000);
    mock().queueRefund('pending');
    const r = await refundReq('fin1', { paymentId, amount: '4000', reason: 'slow psp' });
    expect(r.statusCode).toBe(202);
    const id = r.json().id as string;
    expect(await refunds().processPending(50, 0)).toBe(0); // still pending at the PSP
    expect(await intent(paymentId)).toMatchObject({ status: 'succeeded', ref: '0' });
    const ref = (
      await sql(`SELECT merchant_reference mr FROM payments.refunds WHERE id = $1`, [id])
    )[0]!.mr;
    mock().finishRefund(ref, 'succeeded');
    expect(await refunds().processPending(50, 0)).toBe(1);
    expect(await intent(paymentId)).toMatchObject({ status: 'refunded', ref: '4000' });
    expect((await refundLedger(paymentId, id)).length).toBe(2);
  });

  it('a refund that never reached the PSP (crash after the insert) is sent once by the sweeper', async () => {
    const { paymentId } = await captured(2500);
    const id = crypto.randomUUID();
    await sql(
      `INSERT INTO payments.refunds (id, org_id, intent_id, amount_minor, unapplied_minor, currency, reason, merchant_reference, requested_by, idempotency_key, request_hash)
       VALUES ($1,$2,$3,2500,0,'SAR','crashed',$4,$5,'crash-1','h')`,
      [id, orgA, paymentId, `nuzm_rf_${id}`, ids.fin1],
    );
    expect(await refunds().processPending(50, 0)).toBe(1);
    expect(await intent(paymentId)).toMatchObject({ status: 'refunded', ref: '2500' });
    expect(mock().refundedTotal((await intent(paymentId)).mr)).toBe(2500n);
    expect(mock().duplicateRefunds).toBe(0);
  });

  it('concurrent refunds can never exceed the captured amount', async () => {
    const { paymentId } = await captured(10000);
    const rs = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        refundReq('fin1', { paymentId, amount: '3000', reason: `c${i}` }),
      ),
    );
    const ok = rs.filter((r) => r.statusCode === 201 && r.json().status === 'succeeded').length;
    expect(ok).toBe(3);
    expect(rs.filter((r) => r.statusCode === 422 || r.statusCode === 409).length).toBe(5);
    const i = await intent(paymentId);
    expect(i).toMatchObject({ status: 'partially_refunded', ref: '9000' });
    expect(mock().refundedTotal(i.mr)).toBe(9000n);
    expect(await refundTxCount(paymentId)).toBe(3);
  });

  it('a payment that could not be applied to its invoice refunds from unapplied customer payments (2500), not receivables', async () => {
    const inv = await invoice(orgA, 7000);
    const p = await call('alice', 'POST', '/v1/billing/payments', {
      invoiceId: inv,
      returnUrl: RETURN,
      paymentMethodId: M.threeds,
    });
    expect(p.json().status).toBe('requires_action');
    await sql(`UPDATE invoicing.invoices SET status = 'void' WHERE id = $1`, [inv]); // the invoice stops being payable while the customer authenticates
    const ev = mock().complete((await intent(p.json().id)).mr, 'succeeded');
    expect((await hook(ev.rawBody, ev.headers)).statusCode).toBe(200);
    const paymentId = p.json().id as string;
    expect(
      (
        await sql(
          `SELECT code, direction FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id = p.account_id JOIN billing.ledger_transactions t ON t.id = p.transaction_id WHERE t.idempotency_key = $1 AND a.code = '2500'`,
          [`payment:${paymentId}:capture`],
        )
      ).length,
    ).toBe(1);
    const r = await refundReq('fin1', { paymentId, amount: '7000', reason: 'void invoice' });
    expect(r.json().status).toBe('succeeded');
    expect(await refundLedger(paymentId, r.json().id)).toEqual([
      { code: '1100', direction: 'credit', amt: '7000', subledger_key: 'mock-sandbox' },
      { code: '2500', direction: 'debit', amt: '7000', subledger_key: null },
    ]);
  });

  it('a linked credit note becomes refunded once the refunds against it cover its total', async () => {
    const { paymentId, invoiceId } = await captured(10000);
    const note = {
      status: 'issued',
      invoiceId,
      currency: 'SAR',
      totalMinor: '6000',
      id: crypto.randomUUID(),
    };
    const marked: string[] = [];
    const svc = new RefundServiceImpl(
      app.get(DB),
      app.get(AuditSink),
      app.get(LedgerPostingService),
      app.get(PspRegistry),
      { appliedOf: async () => 10000n },
      {
        get: async () => note as never,
        markRefunded: async (_o: string, id: string) => {
          marked.push(id);
          return true;
        },
      },
    );
    const a = await svc.request(
      ids.fin1!,
      { paymentId, amount: '2000', reason: 'cn', creditNoteId: note.id },
      'cn-1',
    );
    expect(a.refund.creditNoteId).toBe(note.id);
    expect(marked).toEqual([]); // 2000 of 6000 returned
    await svc.request(
      ids.fin1!,
      { paymentId, amount: '4000', reason: 'cn', creditNoteId: note.id },
      'cn-2',
    );
    expect(marked).toEqual([note.id]); // 6000 of 6000 returned
    // a credit note of another invoice, or one that is not issued, is refused
    note.invoiceId = crypto.randomUUID();
    await expect(
      svc.request(
        ids.fin1!,
        { paymentId, amount: '10', reason: 'cn', creditNoteId: note.id },
        'cn-3',
      ),
    ).rejects.toThrow();
  });

  it('refusing to refund a wallet top-up payment (unspent-credit rule is not built)', async () => {
    const t = await call('alice', 'POST', '/v1/billing/wallet-topups', {
      amount: { amount: '5000', currency: 'SAR' },
      paymentMethodId: M.success,
      returnUrl: RETURN,
    });
    expect(t.statusCode).toBe(201);
    const r = await refundReq('fin1', {
      paymentId: t.json().payment.id,
      amount: '100',
      reason: 'x',
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().detail).toMatch(/wallet top-up/);
  });
});

describe('refund database guards', () => {
  it('amounts only grow, refunds are immutable and never deleted or truncated', async () => {
    const { paymentId } = await captured(1000);
    const r = await refundReq('fin1', { paymentId, amount: '300', reason: 'guards' });
    const id = r.json().id as string;
    await expect(
      sql(`UPDATE payments.payment_intents SET refunded_minor = 0 WHERE id = $1`, [paymentId]),
    ).rejects.toThrow(/only grow/);
    await expect(
      sql(`UPDATE payments.refunds SET amount_minor = 1 WHERE id = $1`, [id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql(`UPDATE payments.refunds SET status = 'pending' WHERE id = $1`, [id]),
    ).rejects.toThrow(/illegal refund transition/);
    await expect(sql(`DELETE FROM payments.refunds WHERE id = $1`, [id])).rejects.toThrow(
      /never deleted/,
    );
    await expect(sql(`TRUNCATE payments.refunds`)).rejects.toThrow(/never truncated/);
    await expect(
      sql(`UPDATE payments.payment_intents SET refunded_minor = 5000 WHERE id = $1`, [paymentId]),
    ).rejects.toThrow();
  });
});

describe('wallet top-ups', () => {
  const walletLedger = (paymentId: string) =>
    sql(
      `SELECT a.code, p.direction, p.amount_minor::text amt, a.subledger_key FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id = p.account_id JOIN billing.ledger_transactions t ON t.id = p.transaction_id WHERE t.idempotency_key = $1 ORDER BY a.code`,
      [`payment:${paymentId}:capture`],
    );
  const topup = (amount: string, method?: string, extra: object = {}, who = 'alice', org = orgA) =>
    call(
      who,
      'POST',
      '/v1/billing/wallet-topups',
      {
        amount: { amount, currency: 'SAR' },
        ...(method ? { paymentMethodId: method } : {}),
        returnUrl: RETURN,
        ...extra,
      },
      org,
    );

  it('tops up the wallet: payment captured, wallet credited once (Dr 1100 / Cr 2100), top-up marked credited', async () => {
    const r = await topup('12000', M.success);
    expect(r.statusCode).toBe(201);
    const t = r.json();
    expect(t).toMatchObject({ status: 'credited', amountMinor: '12000', currency: 'SAR' });
    expect(t.payment).toMatchObject({
      status: 'succeeded',
      invoiceId: null,
      walletTopupId: t.id,
      capturedMinor: '12000',
    });
    expect(await walletLedger(t.payment.id)).toEqual([
      { code: '1100', direction: 'debit', amt: '12000', subledger_key: 'mock-sandbox' },
      { code: '2100', direction: 'credit', amt: '12000', subledger_key: null },
    ]);
    expect(
      Number(
        (
          await sql(
            `SELECT coalesce(sum(CASE WHEN direction='credit' THEN amount_minor ELSE -amount_minor END),0)::text n FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id = p.account_id WHERE a.code = '2100' AND a.org_id = $1`,
            [orgA],
          )
        )[0]!.n,
      ),
    ).toBeGreaterThanOrEqual(12000);
    expect(
      await count(
        `SELECT count(*)::int n FROM platform.outbox WHERE org_id = $1 AND topic = 'ledger.posted' AND payload->>'wallet' = 'true'`,
        [orgA],
      ),
    ).toBeGreaterThanOrEqual(1);
  });

  it('enforces the configured minimum and maximum and the money shape; refuses card data', async () => {
    for (const amount of ['999', '10000001', '0'])
      expect((await topup(amount, M.success)).statusCode, amount).toBe(422);
    expect(
      (
        await call('alice', 'POST', '/v1/billing/wallet-topups', {
          amount: '5000',
          returnUrl: RETURN,
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await call('alice', 'POST', '/v1/billing/wallet-topups', {
          amount: { amount: '1000.5', currency: 'SAR' },
          returnUrl: RETURN,
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await call('alice', 'POST', '/v1/billing/wallet-topups', {
          amount: { amount: '5000', currency: 'sar' },
          returnUrl: RETURN,
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await call('alice', 'POST', '/v1/billing/wallet-topups', {
          amount: { amount: '5000', currency: 'SAR' },
        })
      ).statusCode,
    ).toBe(422);
    const pan = await call('alice', 'POST', '/v1/billing/wallet-topups', {
      amount: { amount: '5000', currency: 'SAR' },
      returnUrl: RETURN,
      number: PAN,
    });
    expect(pan.statusCode).toBe(422);
    expect(pan.json().code ?? pan.json().type).toMatch(/pan_not_allowed/);
  });

  it('is billing:manage only; a replayed Idempotency-Key returns the same top-up', async () => {
    expect((await topup('5000', M.success, {}, 'carol')).statusCode).toBe(403);
    const key = { 'idempotency-key': 'topup-replay-1' };
    const before = await count(
      `SELECT count(*)::int n FROM billing.wallet_topups WHERE org_id = $1`,
      [orgA],
    );
    const body = {
      amount: { amount: '5000', currency: 'SAR' },
      paymentMethodId: M.success,
      returnUrl: RETURN,
    };
    const a = await call('alice', 'POST', '/v1/billing/wallet-topups', body, orgA, key);
    const b = await call('alice', 'POST', '/v1/billing/wallet-topups', body, orgA, key);
    expect(a.statusCode).toBe(201);
    expect(b.json().id).toBe(a.json().id);
    expect(
      await count(`SELECT count(*)::int n FROM billing.wallet_topups WHERE org_id = $1`, [orgA]),
    ).toBe(before + 1);
  });

  it('a declined payment leaves the top-up pending with no ledger entry; paying it again with another method credits it once', async () => {
    const r = await topup('7000', M.decline);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ status: 'pending' });
    expect(r.json().payment).toMatchObject({ status: 'failed', failureCode: 'card_declined' });
    const topupId = r.json().id as string;
    expect(await walletLedger(r.json().payment.id)).toEqual([]);
    const retry = await call('alice', 'POST', '/v1/billing/payments', {
      walletTopupId: topupId,
      paymentMethodId: M.success,
      returnUrl: RETURN,
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().status).toBe('succeeded');
    expect(
      (await sql(`SELECT status FROM billing.wallet_topups WHERE id = $1`, [topupId]))[0]!.status,
    ).toBe('credited');
    expect((await walletLedger(retry.json().id)).length).toBe(2);
    // paying a credited top-up again is refused
    const again = await call('alice', 'POST', '/v1/billing/payments', {
      walletTopupId: topupId,
      paymentMethodId: M.success,
      returnUrl: RETURN,
    });
    expect(again.statusCode).toBe(409);
  });

  it('an uncertain PSP answer is reconciled when the payment is read: credited exactly once, no second charge', async () => {
    const r = await topup('6500', M.timeout);
    expect(r.statusCode).toBe(202);
    const paymentId = r.json().payment.id as string;
    const mr = (await intent(paymentId)).mr;
    const got = await call('alice', 'GET', `/v1/billing/payments/${paymentId}`);
    expect(got.json().status).toBe('succeeded');
    await call('alice', 'GET', `/v1/billing/payments/${paymentId}`);
    expect(mock().chargeCount(mr)).toBe(1);
    expect(mock().duplicateCharges).toBe(0);
    expect((await walletLedger(paymentId)).length).toBe(2);
    expect(
      (await sql(`SELECT status FROM billing.wallet_topups WHERE id = $1`, [r.json().id]))[0]!
        .status,
    ).toBe('credited');
  });

  it('3-D Secure: pending until the webhook; a duplicate webhook delivered 5 times credits once', async () => {
    const r = await topup('8800', M.threeds);
    expect(r.statusCode).toBe(201);
    expect(r.json().payment.status).toBe('requires_action');
    expect(r.json().status).toBe('pending');
    const paymentId = r.json().payment.id as string;
    const ev = mock().complete((await intent(paymentId)).mr, 'succeeded');
    const rs = await Promise.all(Array.from({ length: 5 }, () => hook(ev.rawBody, ev.headers)));
    expect(rs.every((x) => x.statusCode === 200)).toBe(true);
    expect((await walletLedger(paymentId)).length).toBe(2);
    expect(
      await count(
        `SELECT count(*)::int n FROM billing.ledger_transactions WHERE idempotency_key = $1`,
        [`payment:${paymentId}:capture`],
      ),
    ).toBe(1);
    expect(
      (await sql(`SELECT status FROM billing.wallet_topups WHERE id = $1`, [r.json().id]))[0]!
        .status,
    ).toBe('credited');
  });

  it('payment targets: exactly one of invoiceId / walletTopupId; another organization cannot pay your top-up', async () => {
    const t = (await topup('5000', M.decline)).json();
    const inv = await invoice(orgA, 1000);
    for (const bad of [
      { returnUrl: RETURN },
      { returnUrl: RETURN, invoiceId: inv, walletTopupId: t.id },
      { returnUrl: RETURN, walletTopupId: t.id, amount: '10' },
    ])
      expect(
        (await call('alice', 'POST', '/v1/billing/payments', bad)).statusCode,
        JSON.stringify(bad),
      ).toBe(422);
    const bobMethod = await addMethod('bob', 'tok_mock_success_bob1', orgB);
    const foreign = await call(
      'bob',
      'POST',
      '/v1/billing/payments',
      { walletTopupId: t.id, paymentMethodId: bobMethod, returnUrl: RETURN },
      orgB,
    );
    expect(foreign.statusCode).toBe(404);
  });

  it('database: a top-up is credited only with its ledger link, and credited top-ups and targets are immutable', async () => {
    const r = await topup('5000', M.success);
    const id = r.json().id as string;
    await expect(
      sql(`UPDATE billing.wallet_topups SET amount_minor = 1 WHERE id = $1`, [id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql(
        `UPDATE billing.wallet_topups SET status = 'pending', ledger_transaction_id = NULL, credited_at = NULL WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow();
    await expect(sql(`DELETE FROM billing.wallet_topups WHERE id = $1`, [id])).rejects.toThrow(
      /never deleted/,
    );
    await expect(
      sql(
        `UPDATE payments.payment_intents SET wallet_topup_id = NULL, invoice_id = $2 WHERE id = $1`,
        [r.json().payment.id, crypto.randomUUID()],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql(
        `INSERT INTO payments.payment_intents (id, org_id, psp_account_id, amount_minor, currency, merchant_reference) SELECT gen_random_uuid(), $1, id, 1, 'SAR', 'nuzm_pi_' || gen_random_uuid() FROM payments.psp_accounts LIMIT 1`,
        [orgA],
      ),
    ).rejects.toThrow(/target_chk/);
  });
});
