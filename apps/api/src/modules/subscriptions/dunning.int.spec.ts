import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { DunningService, SubscriptionService } from '../billing';
import { OrderService } from '../commerce';
import { BillingScheduler, BILLING_SCHEDULER_LOCK } from './billing-scheduler';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
type Row = Record<string, any>;

const h = new Harness();
let app: App;
const ids: Record<string, string> = {};
const jars: Record<string, Record<string, string>> = {};
const staff: Record<string, Record<string, string>> = {};
let starter = '';
let orgSeq = 0;

const sql = (q: string, p: unknown[] = []) => h.env.sql(q, p) as Promise<Row[]>;
const count = async (q: string, p: unknown[] = []) => Number((await sql(q, p))[0]!.n);
const dun = () => app.get(DunningService);
const subs = () => app.get(SubscriptionService);
const D = (s: string) => new Date(`${s}T10:00:00Z`);
const RETURN = 'http://127.0.0.1:3000/en/billing/payment-return';

const call = (who: string, method: 'GET' | 'POST', url: string, org: string, body?: object) =>
  app.inject({
    method,
    url,
    headers: {
      cookie: cookieHeader(jars[who]!),
      'x-csrf-token': jars[who]!.nuzm_csrf ?? '',
      'x-nuzm-org': org,
      'idempotency-key': `k-${Math.random()}`,
    },
    ...(body ? { payload: body } : {}),
  });
const admin = (who: string, method: 'GET' | 'PATCH', url: string, body?: object) =>
  app.inject({
    method,
    url,
    headers: { cookie: cookieHeader(staff[who]!), 'x-csrf-token': staff[who]!.nuzm_admin_csrf! },
    ...(body ? { payload: body } : {}),
  });

const newOrg = async () => {
  const n = ++orgSeq;
  const org = (
    await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { cookie: cookieHeader(jars.alice!), 'x-csrf-token': jars.alice!.nuzm_csrf! },
      payload: { name: `Dun Org ${n}` },
    })
  ).json().id as string;
  const add = async (token: string, card: string) => {
    const r = await call('alice', 'POST', '/v1/billing/payment-methods', org, {
      provider: 'mock',
      setupToken: `${token}_${card}${n}`,
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };
  return {
    org,
    ok: await add('tok_mock_success', 'a'),
    decline: await add('tok_mock_decline', 'b'),
  };
};
/** A subscription whose first payment is declined on 2026-11-01: past_due with an open invoice. */
const overdue = async () => {
  const o = await newOrg();
  const s = await subs().create(
    o.org,
    ids.alice!,
    { planVersionId: starter, paymentMethodId: o.decline },
    D('2026-11-01'),
  );
  expect(s.status).toBe('past_due');
  return { ...o, sub: s };
};
const caseOf = async (subId: string) =>
  (
    await sql(
      `SELECT * FROM billing.dunning_cases WHERE subscription_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [subId],
    )
  )[0]!;
const events = (org: string, topic: string) =>
  count(`SELECT count(*)::int n FROM platform.outbox WHERE org_id = $1 AND topic = $2`, [
    org,
    topic,
  ]);
const kinds = async (org: string) =>
  (await sql(`SELECT kind FROM platform.notifications WHERE org_id = $1`, [org])).map(
    (r) => r.kind as string,
  );
const subStatus = async (id: string) =>
  (await sql(`SELECT status FROM billing.subscriptions WHERE id = $1`, [id]))[0]!.status as string;
const payInvoice = async (o: { org: string; ok: string }, invoiceId: string) => {
  const r = await call('alice', 'POST', '/v1/billing/payments', o.org, {
    invoiceId,
    paymentMethodId: o.ok,
    returnUrl: RETURN,
  });
  expect(r.json().status).toBe('succeeded');
};

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  for (const n of ['alice', 'bob']) {
    ids[n] = await h.createUser(n);
    jars[n] = await h.sessionFor(app, ids[n]!);
    await h.elevate(jars[n]!);
  }
  for (const [name, roles] of Object.entries({ fin1: ['finance'], sup: ['support'] })) {
    const u = await h.platformUser(app, `staff-${name}`, roles);
    ids[name] = u.id;
    staff[name] = u.jar;
  }
  starter = (
    await sql(
      `SELECT v.id FROM billing.plans p JOIN billing.plan_versions v ON v.plan_id = p.id WHERE p.key = 'starter' AND v.status = 'published' ORDER BY v.version DESC LIMIT 1`,
    )
  )[0]!.id;
  await sql(
    `INSERT INTO metering.meters (id, unit, aggregation_window, basis) VALUES ('plan.starter_months','subscription_month','day','subscription')`,
  );
  const publisher = '00000000-0000-0000-0000-000000000001';
  const book = crypto.randomUUID();
  const bv = crypto.randomUUID();
  await sql(
    `INSERT INTO billing.price_books (id, name, currency, placeholder) VALUES ($1,'dun-test','SAR',false)`,
    [book],
  );
  await sql(
    `INSERT INTO billing.price_book_versions (id, price_book_id, version, status, effective_from) VALUES ($1,$2,1,'draft','2026-01-01T00:00:00Z')`,
    [bv, book],
  );
  for (const [m, price] of [
    ['plan.starter_months', '3000'],
    ['ai.credits_consumed', '1'],
  ])
    await sql(
      `INSERT INTO billing.price_items (id, version_id, meter_id, tier_model, unit_price_minor) VALUES (gen_random_uuid(),$1,$2,'flat',$3)`,
      [bv, m, price],
    );
  await sql(
    `UPDATE billing.price_book_versions SET status = 'published', published_by = $2, published_at = now() WHERE id = $1`,
    [bv, publisher],
  );
});
afterAll(() => h.close());

describe('the timeline (policy proposal: retries D+1/3/5, notices D+3/7, restrict D+14, suspend D+21, owner review D+45)', () => {
  it('opens a case at the first failure and walks the stages in order, emitting requests only and deleting nothing', async () => {
    const o = await overdue();
    const sid = o.sub.id;
    expect(await dun().run(D('2026-11-01'))).toMatchObject({ opened: 1, retries: 0, advanced: 0 });
    expect(await caseOf(sid)).toMatchObject({
      stage: 'overdue',
      retries_done: 0,
      policy_version: 1,
    });
    expect(await kinds(o.org)).toContain('billing.payment_failed');
    expect((await dun().run(D('2026-11-01'))).opened).toBe(0); // a second run the same day opens nothing

    expect((await dun().run(D('2026-11-02'))).retries).toBe(1);
    expect((await dun().run(D('2026-11-03'))).retries).toBe(0);
    let r = await dun().run(D('2026-11-04')); // day 3
    expect(r).toMatchObject({ retries: 1, advanced: 1 });
    expect(await caseOf(sid)).toMatchObject({ stage: 'reminder_1', retries_done: 2 });
    expect((await dun().run(D('2026-11-06'))).retries).toBe(1); // day 5
    r = await dun().run(D('2026-11-08')); // day 7
    expect(r.advanced).toBe(1);
    expect(await caseOf(sid)).toMatchObject({ stage: 'reminder_2', retries_done: 3 });
    expect(await dun().run(D('2026-11-12'))).toMatchObject({ retries: 0, advanced: 0 });
    expect(await subStatus(sid)).toBe('past_due');

    await dun().run(D('2026-11-15')); // day 14
    expect(await caseOf(sid)).toMatchObject({ stage: 'restricted' });
    expect(await subStatus(sid)).toBe('unpaid');
    expect(await events(o.org, 'dunning.restrict_requested')).toBe(1);
    expect(await events(o.org, 'dunning.suspend_requested')).toBe(0);

    await dun().run(D('2026-11-22')); // day 21
    expect(await caseOf(sid)).toMatchObject({ stage: 'suspended' });
    expect(await events(o.org, 'dunning.suspend_requested')).toBe(1);

    await dun().run(D('2026-12-16')); // day 45
    expect(await caseOf(sid)).toMatchObject({ stage: 'terminated_pending' });
    expect(await events(o.org, 'dunning.review_requested')).toBe(1);
    expect(await dun().run(D('2026-12-16'))).toMatchObject({ advanced: 0, retries: 0 }); // nothing further, ever

    // nothing was deleted or terminated: the subscription and its invoice still exist, still unpaid, and no deletion request exists
    expect(await subStatus(sid)).toBe('unpaid');
    expect(
      (
        await sql(`SELECT status FROM invoicing.invoices WHERE id = $1`, [o.sub.latestInvoiceId])
      )[0]!.status,
    ).toBe('open');
    expect(
      await count(
        `SELECT count(*)::int n FROM platform.outbox WHERE org_id = $1 AND topic ~ '(delete|terminate)'`,
        [o.org],
      ),
    ).toBe(0);
    expect(await kinds(o.org)).toEqual(
      expect.arrayContaining([
        'billing.dunning_reminder',
        'billing.dunning_restricted',
        'billing.dunning_suspended',
        'billing.dunning_review',
      ]),
    );
    expect(
      await count(
        `SELECT count(*)::int n FROM audit.audit_logs WHERE org_id = $1 AND action = 'billing.dunning.stage_changed'`,
        [o.org],
      ),
    ).toBe(5);
  });

  it('a scheduler that was down for 3 weeks still produces every stage in order, once', async () => {
    const o = await overdue();
    await dun().run(D('2026-11-01'));
    const r = await dun().run(D('2026-11-22')); // day 21 in one go
    expect(r.advanced).toBe(4);
    expect(await caseOf(o.sub.id)).toMatchObject({ stage: 'suspended', retries_done: 3 });
    const stages = (
      await sql(
        `SELECT after->>'stage' stage FROM audit.audit_logs WHERE org_id = $1 AND action = 'billing.dunning.stage_changed' ORDER BY id`,
        [o.org],
      )
    ).map((x) => x.stage);
    expect(stages).toEqual(['reminder_1', 'reminder_2', 'restricted', 'suspended']);
    expect(await events(o.org, 'dunning.restrict_requested')).toBe(1);
    expect(await events(o.org, 'dunning.suspend_requested')).toBe(1);
  });

  it('only one open case per subscription, whatever runs concurrently', async () => {
    const o = await overdue();
    await Promise.all([1, 2, 3, 4].map(() => dun().run(D('2026-11-01'))));
    expect(
      await count(`SELECT count(*)::int n FROM billing.dunning_cases WHERE subscription_id = $1`, [
        o.sub.id,
      ]),
    ).toBe(1);
  });
});

describe('recovery', () => {
  it('paying the invoice at any stage closes the case, reactivates the subscription and lifts the purchase restriction', async () => {
    const o = await overdue();
    await dun().run(D('2026-11-01'));
    await dun().run(D('2026-11-15')); // restricted + unpaid
    expect(await subStatus(o.sub.id)).toBe('unpaid');
    // restricted: a NEW purchase is refused with 402, nothing else is
    const q = await call('alice', 'POST', '/v1/quotes', o.org, {
      kind: 'ai-credit',
      items: [{ credits: '100' }],
    });
    expect(q.statusCode).toBe(201);
    await expect(
      app.get(OrderService).createFromQuote(o.org, q.json().id, ids.alice!),
    ).rejects.toMatchObject({ code: 'account_restricted', status: 402 });
    expect(
      (await call('alice', 'GET', `/v1/billing/subscriptions/${o.sub.id}`, o.org)).json(),
    ).toMatchObject({ status: 'unpaid', dunningStage: 'restricted' });

    await payInvoice(o, o.sub.latestInvoiceId!);
    const r = await dun().run(D('2026-11-16'));
    expect(r.closed).toBeGreaterThanOrEqual(1);
    expect(await caseOf(o.sub.id)).toMatchObject({ stage: 'restricted' }); // history kept
    expect((await caseOf(o.sub.id)).closed_reason).toBe('paid');
    expect(await subStatus(o.sub.id)).toBe('active');
    expect(
      (await call('alice', 'GET', `/v1/billing/subscriptions/${o.sub.id}`, o.org)).json()
        .dunningStage,
    ).toBeNull();
    expect(
      (await app.get(OrderService).createFromQuote(o.org, q.json().id, ids.alice!)).id,
    ).toBeTruthy(); // purchases work again
    expect(await kinds(o.org)).toContain('billing.payment_recovered');
    expect(
      await count(
        `SELECT count(*)::int n FROM audit.audit_logs WHERE org_id = $1 AND action = 'billing.dunning.recovered'`,
        [o.org],
      ),
    ).toBe(1);
    // nothing more happens afterwards
    await dun().run(D('2026-12-20'));
    expect(
      await count(`SELECT count(*)::int n FROM billing.dunning_cases WHERE subscription_id = $1`, [
        o.sub.id,
      ]),
    ).toBe(1);
    expect((await caseOf(o.sub.id)).stage).toBe('restricted'); // a closed case never moves again
  });

  it('a retry that succeeds (customer fixed the card) closes the case at once', async () => {
    const o = await overdue();
    await dun().run(D('2026-11-01'));
    await sql(`UPDATE billing.subscriptions SET payment_method_id = $2 WHERE id = $1`, [
      o.sub.id,
      o.ok,
    ]);
    await dun().run(D('2026-11-02')); // day 1 retry (the run is global: judge THIS case)
    expect((await caseOf(o.sub.id)).closed_reason).toBe('paid');
    expect(await subStatus(o.sub.id)).toBe('active');
  });

  it('a customer who cancels while overdue is cancelled at once and the case closes; the plan goes back to free', async () => {
    const o = await overdue();
    await dun().run(D('2026-11-01'));
    expect(
      (await call('alice', 'POST', `/v1/billing/subscriptions/${o.sub.id}/cancellation`, o.org, {}))
        .statusCode,
    ).toBe(200);
    expect(await dun().run(D('2026-11-02'))).toMatchObject({ closed: 1 });
    expect(await subStatus(o.sub.id)).toBe('cancelled');
    expect((await caseOf(o.sub.id)).closed_reason).toBe('subscription_cancelled');
  });
});

describe('finance: list, hold, resume (HTTP)', () => {
  it('lists cases with filters; support can neither read nor hold, only finance can', async () => {
    const o = await overdue();
    await dun().run(D('2026-11-01'));
    const list = await admin('fin1', 'GET', `/v1/admin/billing/dunning?org=${o.org}`);
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).toMatchObject({
      orgId: o.org,
      stage: 'overdue',
      hold: false,
      closedAt: null,
      policyVersion: 1,
    });
    expect(
      (await admin('fin1', 'GET', `/v1/admin/billing/dunning?org=${o.org}&stage=restricted`)).json()
        .items,
    ).toHaveLength(0);
    expect(
      (await admin('fin1', 'GET', `/v1/admin/billing/dunning?org=${o.org}&state=closed`)).json()
        .items,
    ).toHaveLength(0);
    expect((await admin('fin1', 'GET', '/v1/admin/billing/dunning?stage=nope')).statusCode).toBe(
      422,
    );
    expect((await admin('sup', 'GET', `/v1/admin/billing/dunning?org=${o.org}`)).statusCode).toBe(
      403, // finance and platform admins read; support does not
    );
    const id = list.json().items[0].id as string;
    expect(
      (
        await admin('sup', 'PATCH', `/v1/admin/billing/dunning/${id}`, {
          action: 'hold',
          reason: 'x',
        })
      ).statusCode,
    ).toBe(403);
    const asCustomer = await app.inject({
      method: 'GET',
      url: '/v1/admin/billing/dunning',
      headers: { cookie: cookieHeader(jars.alice!) },
    });
    expect([401, 403, 404]).toContain(asCustomer.statusCode);
  });

  it('a held case gets no retries and no stage; resuming continues (days kept counting); holds are audited and need a reason', async () => {
    const o = await overdue();
    await dun().run(D('2026-11-01'));
    const id = (await caseOf(o.sub.id)).id as string;
    for (const bad of [
      {},
      { action: 'x', reason: 'r' },
      { action: 'hold' },
      { action: 'hold', reason: '' },
      { action: 'hold', reason: 'r', extra: 1 },
    ])
      expect(
        (await admin('fin1', 'PATCH', `/v1/admin/billing/dunning/${id}`, bad)).statusCode,
        JSON.stringify(bad),
      ).toBe(422);
    const held = await admin('fin1', 'PATCH', `/v1/admin/billing/dunning/${id}`, {
      action: 'hold',
      reason: 'customer promised payment',
    });
    expect(held.statusCode).toBe(200);
    expect(held.json()).toMatchObject({ hold: true, holdReason: 'customer promised payment' });
    const again = await admin('fin1', 'PATCH', `/v1/admin/billing/dunning/${id}`, {
      action: 'hold',
      reason: 'same',
    });
    expect(again.json().version).toBe(held.json().version); // repeating changes nothing
    await dun().run(D('2026-11-15')); // the run is global: judge THIS case only
    expect(await caseOf(o.sub.id)).toMatchObject({ stage: 'overdue', retries_done: 0 });
    const resumed = await admin('fin1', 'PATCH', `/v1/admin/billing/dunning/${id}`, {
      action: 'resume',
      reason: 'promise broken',
    });
    expect(resumed.json()).toMatchObject({ hold: false, holdReason: null });
    await dun().run(D('2026-11-15'));
    expect(await caseOf(o.sub.id)).toMatchObject({ stage: 'restricted' }); // the 14 days had kept counting
    expect(
      await count(
        `SELECT count(*)::int n FROM audit.audit_logs WHERE org_id = $1 AND action IN ('billing.dunning.held','billing.dunning.resumed')`,
        [o.org],
      ),
    ).toBe(2);
    // a closed case cannot be changed
    await payInvoice(o, o.sub.latestInvoiceId!);
    await dun().run(D('2026-11-16'));
    expect(
      (
        await admin('fin1', 'PATCH', `/v1/admin/billing/dunning/${id}`, {
          action: 'hold',
          reason: 'late',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await admin('fin1', 'PATCH', `/v1/admin/billing/dunning/${crypto.randomUUID()}`, {
          action: 'hold',
          reason: 'x',
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('dunning database guards', () => {
  it('stage only forward, identity frozen, closed immutable, no delete/truncate, one open case', async () => {
    const o = await overdue();
    await dun().run(D('2026-11-01'));
    await dun().run(D('2026-11-08')); // reminder_2
    const k = await caseOf(o.sub.id);
    await expect(
      sql(`UPDATE billing.dunning_cases SET stage = 'reminder_1' WHERE id = $1`, [k.id]),
    ).rejects.toThrow(/only moves forward/);
    await expect(
      sql(`UPDATE billing.dunning_cases SET opened_at = now() WHERE id = $1`, [k.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql(`UPDATE billing.dunning_cases SET retries_done = 0 WHERE id = $1`, [k.id]),
    ).rejects.toThrow(/retries only grow/);
    await expect(
      sql(`UPDATE billing.dunning_cases SET hold = true WHERE id = $1`, [k.id]),
    ).rejects.toThrow(); // a hold needs a reason
    await expect(sql(`DELETE FROM billing.dunning_cases WHERE id = $1`, [k.id])).rejects.toThrow(
      /never deleted/,
    );
    await expect(sql(`TRUNCATE billing.dunning_cases`)).rejects.toThrow(/never truncated/);
    await expect(
      sql(
        `INSERT INTO billing.dunning_cases (id, org_id, subscription_id, invoice_id, policy_version, opened_at, stage_changed_at) VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), 1, now(), now())`,
        [o.org, o.sub.id],
      ),
    ).rejects.toThrow(/dunning_one_open_idx/);
    await sql(
      `UPDATE billing.dunning_cases SET closed_at = now(), closed_reason = 'paid' WHERE id = $1`,
      [k.id],
    );
    await expect(
      sql(`UPDATE billing.dunning_cases SET stage = 'suspended' WHERE id = $1`, [k.id]),
    ).rejects.toThrow(/closed dunning case cannot change/);
  });
});

describe('billing scheduler', () => {
  it('one tick runs renewals, dunning and both sweepers against the real services', async () => {
    const o = await overdue();
    const r = await app.get(BillingScheduler).tick(D('2026-11-01'));
    expect(r).not.toBeNull();
    expect(r!.dunning).toMatchObject({ opened: expect.any(Number) });
    expect(r!.subscriptions).toMatchObject({ failed: 0 });
    expect(typeof r!.paymentEvents).toBe('number');
    expect(typeof r!.refunds).toBe('number');
    expect(await caseOf(o.sub.id)).toBeTruthy();
  });

  it('only one instance ticks at a time; a failing step does not stop the others', async () => {
    const db = (app.get(SubscriptionService) as any).db;
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const calls: string[] = [];
    const slow = new BillingScheduler(
      db,
      {
        runDue: async () => {
          calls.push('subs');
          await gate;
          return { renewed: 0, settled: 0, failed: 0 };
        },
      },
      {
        run: async () => {
          calls.push('dunning');
          throw new Error('boom');
        },
      },
      {
        processPending: async () => {
          calls.push('events');
          return 0;
        },
      },
      {
        processPending: async () => {
          calls.push('refunds');
          return 0;
        },
      },
      {
        run: async () => {
          calls.push('einvoicing');
          return {} as never;
        },
      },
      () => undefined,
    );
    const first = slow.tick();
    await new Promise((r) => setTimeout(r, 300)); // the first tick holds the lock inside its slow step
    expect(await slow.tick()).toBeNull(); // the second instance does nothing
    expect(calls).toEqual(['subs']);
    release();
    const done = await first;
    expect(done!.dunning).toEqual({ error: 'boom' });
    expect(calls).toEqual(['subs', 'dunning', 'events', 'refunds', 'einvoicing']);
    expect(BILLING_SCHEDULER_LOCK).toBe(7300002);
    // the lock is free again afterwards
    expect(await slow.tick()).not.toBeNull();
  });

  it('is off by default and validates its interval', () => {
    expect(BillingScheduler.intervalFromEnv({})).toBe(0);
    expect(BillingScheduler.intervalFromEnv({ BILLING_SCHEDULER_INTERVAL_SECONDS: '1' })).toBe(5);
    expect(BillingScheduler.intervalFromEnv({ BILLING_SCHEDULER_INTERVAL_SECONDS: '60' })).toBe(60);
    expect(() =>
      BillingScheduler.intervalFromEnv({ BILLING_SCHEDULER_INTERVAL_SECONDS: '-1' }),
    ).toThrow();
  });
});
