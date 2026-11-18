import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainOrderService } from './internal/orders.service';
import { startDomainsKit, type DomainsKit } from './testing/domains-kit';

let k: DomainsKit;
let orders: DomainOrderService;
let n = 0;
const nm = (p: string) => `${p}-${Date.now().toString(36)}-${++n}.com`;
const contact = () => ({
  firstName: 'Salem',
  lastName: 'Alharbi',
  email: 'hook.person@example.invalid',
  phone: '+966500000000',
  address: { street: 'King Fahd Rd 1', city: 'Riyadh', postalCode: '12211', country: 'SA' },
});

beforeAll(async () => {
  k = await startDomainsKit();
  orders = k.app.get(DomainOrderService);
  orders.autoKick = false;
  const r = await k.call('alice', 'POST', '/v1/compliance/consents', {
    purposeId: 'domain_registrant_disclosure',
    granted: true,
    localeShown: 'en',
    textVersion: 'placeholder-1',
    subjectRef: 'org',
  });
  if (![200, 201].includes(r.statusCode)) throw new Error(r.body);
  await k.fund(k.orgA, '100000000');
});
afterAll(() => k?.close());

const hook = (provider: string, body: string, headers: Record<string, string>) =>
  k.app.inject({
    method: 'POST',
    url: `/v1/webhooks/registrars/${provider}`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: body,
  });
const ledgerRecords = (orderId: string) =>
  k.count(`SELECT count(*) n FROM billing.ledger_transactions WHERE source_event_id = $1`, [
    `domain-order:${orderId}:record`,
  ]);

/** A registration the registry holds as pending (REQ) until the webhook completes it. */
async function pending(name: string) {
  k.op.controls.holdRegistrations(true);
  const q = (
    await k.call('alice', 'POST', '/v1/quotes', {
      kind: 'domain',
      items: [{ name, years: 1, action: 'register' }],
    })
  ).json();
  const r = await k.call('alice', 'POST', '/v1/domains', {
    quoteId: q.id,
    contacts: { registrant: contact() },
  });
  expect(r.statusCode, r.body).toBe(202);
  await orders.run(k.orgA, r.json().operationId);
  k.op.controls.holdRegistrations(false);
  return r.json();
}

describe('inbound registrar webhooks (S29 task 5)', () => {
  it('a registration pending at the registry stays provider_pending, then a signed webhook completes it', async () => {
    const name = nm('hook');
    const o = await pending(name);
    const row = (
      await k.h.env.sql(`SELECT state FROM domains.domain_orders WHERE id=$1`, [o.orderId])
    )[0]!;
    expect(row.state).toBe('provider_pending');
    expect((await k.call('alice', 'GET', `/v1/domains/${o.domain.id}`)).json().state).toBe(
      'pending',
    );
    k.op.controls.activate(name);
    const now = new Date();
    const body = k.op.controls.webhookBody('domain.created', 'evt-first', name, now);
    const sig = k.op.controls.signWebhook!(body, now);
    const r = await hook('openprovider', body, sig.headers);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().outcome).toBe('processed');
    expect((await k.call('alice', 'GET', `/v1/domains/${o.domain.id}`)).json().state).toBe(
      'active',
    );
    expect(await ledgerRecords(o.orderId)).toBe(1);
  });

  it('AC-M07-02: the same event delivered 100 times (10 in parallel) ⇒ 1 state change, 1 meter event, 1 ledger transaction', async () => {
    const name = nm('dup');
    const o = await pending(name);
    k.op.controls.activate(name);
    const now = new Date();
    const body = k.op.controls.webhookBody('domain.created', 'evt-dup-100', name, now);
    const sig = k.op.controls.signWebhook!(body, now);
    const outcomes: string[] = [];
    for (let batch = 0; batch < 10; batch++) {
      const rs = await Promise.all(
        Array.from({ length: 10 }, () => hook('openprovider', body, sig.headers)),
      );
      for (const r of rs) {
        expect(r.statusCode, r.body).toBe(200);
        outcomes.push(r.json().outcome);
      }
    }
    expect(outcomes).toHaveLength(100);
    expect(outcomes.filter((x) => x === 'processed')).toHaveLength(1);
    expect(outcomes.filter((x) => x === 'duplicate')).toHaveLength(99);
    expect(
      await k.count(
        `SELECT count(*) n FROM platform.webhook_events_inbound WHERE provider='openprovider' AND event_id='evt-dup-100'`,
      ),
    ).toBe(1);
    expect(await ledgerRecords(o.orderId)).toBe(1);
    expect(
      await k.count(
        `SELECT count(*) n FROM platform.outbox WHERE topic='usage.recorded' AND payload->>'resourceId' = $1`,
        [o.domain.id],
      ),
    ).toBe(1);
    expect(
      await k.count(
        `SELECT count(*) n FROM platform.outbox WHERE topic='domain.registered' AND payload->>'domainId' = $1`,
        [o.domain.id],
      ),
    ).toBe(1);
    expect(k.op.controls.registrationsByName(name)).toBe(1);
    // a DIFFERENT event id for the same completed order changes nothing either (the order is final)
    const b2 = k.op.controls.webhookBody('domain.created', 'evt-dup-other', name, now);
    const r2 = await hook('openprovider', b2, k.op.controls.signWebhook!(b2, now).headers);
    expect(r2.statusCode).toBe(200);
    expect(await ledgerRecords(o.orderId)).toBe(1);
    expect(
      await k.count(
        `SELECT count(*) n FROM platform.outbox WHERE topic='usage.recorded' AND payload->>'resourceId' = $1`,
        [o.domain.id],
      ),
    ).toBe(1);
  });

  it('forged signatures are 401, replays outside the window are 409, malformed bodies 422, unknown providers 404; nothing is stored for them', async () => {
    const now = new Date();
    const body = k.op.controls.webhookBody('domain.created', 'evt-forged', 'x-forged.com', now);
    const good = k.op.controls.signWebhook!(body, now);
    const before = await k.count(`SELECT count(*) n FROM platform.webhook_events_inbound`);
    expect(
      (await hook('openprovider', body.replace('x-forged', 'y-forged'), good.headers)).statusCode,
    ).toBe(401);
    expect(
      (await hook('openprovider', body, { 'x-webhook-signature': 't=1,v1=' + '0'.repeat(64) }))
        .statusCode,
    ).toBe(401);
    expect((await hook('openprovider', body, {})).statusCode).toBe(401);
    const old = new Date(Date.now() - 3_600_000);
    const ob = k.op.controls.webhookBody('domain.created', 'evt-old', 'x-old.com', old);
    expect(
      (await hook('openprovider', ob, k.op.controls.signWebhook!(ob, old).headers)).statusCode,
    ).toBe(409);
    const mal = '{broken';
    expect(
      (await hook('openprovider', mal, k.op.controls.signWebhook!(mal, now).headers)).statusCode,
    ).toBe(422);
    expect((await hook('resellerclub', body, good.headers)).statusCode).toBe(404); // no webhooks documented for this vendor
    expect((await hook('nope', body, good.headers)).statusCode).toBe(404);
    expect(await k.count(`SELECT count(*) n FROM platform.webhook_events_inbound`)).toBe(before);
  });

  it('unknown event types are stored and ignored; a name we do not hold changes nothing and leaks nothing', async () => {
    const now = new Date();
    const unk = JSON.stringify({
      id: 'evt-unknown-1',
      eventType: 'somethingNew',
      timeStamp: Math.floor(now.getTime() / 1000),
      data: { domain: 'whatever-not-ours.com', domainId: 1 },
    });
    const r = await hook('openprovider', unk, k.op.controls.signWebhook!(unk, now).headers);
    expect(r.statusCode).toBe(200);
    expect(r.json().outcome).toBe('ignored');
    expect(
      await k.count(
        `SELECT count(*) n FROM platform.webhook_events_inbound WHERE event_id='evt-unknown-1'`,
      ),
    ).toBe(1);
    const stored = (
      await k.h.env.sql(
        `SELECT payload::text p FROM platform.webhook_events_inbound WHERE event_id='evt-unknown-1'`,
      )
    )[0]!.p as string;
    expect(stored).not.toContain('"data"'); // a whitelist, never the raw body
    const other = k.op.controls.webhookBody(
      'domain.created',
      'evt-notours',
      'not-ours-at-all.com',
      now,
    );
    const o = await hook('openprovider', other, k.op.controls.signWebhook!(other, now).headers);
    expect(o.json().outcome).toBe('ignored');
  });

  it('transfer_failed releases the reservation and fails the transfer', async () => {
    const name = nm('xfer');
    const q = (
      await k.call('alice', 'POST', '/v1/quotes', {
        kind: 'domain',
        items: [{ name, years: 1, action: 'transfer_in' }],
      })
    ).json();
    const secret = `AUTHCODE-${Math.random().toString(36).slice(2, 10)}-SECRET`;
    const r = await k.call('alice', 'POST', '/v1/domains/transfers', {
      quoteId: q.id,
      name,
      authCode: secret,
      contacts: { registrant: contact() },
    });
    expect(r.statusCode, r.body).toBe(202);
    expect(JSON.stringify(r.json())).not.toContain(secret);
    await orders.run(k.orgA, r.json().operationId);
    expect(
      (
        await k.h.env.sql(`SELECT state FROM domains.domain_orders WHERE id=$1`, [r.json().orderId])
      )[0]!.state,
    ).toBe('provider_pending');
    // AC-M07-08: the auth code is in no table, no log-like column, no audit, no outbox, no response
    for (const [tbl, col] of [
      ['platform.operations', "input::text||coalesce(result::text,'')||coalesce(error::text,'')"],
      [
        'audit.audit_logs',
        "coalesce(before::text,'')||coalesce(after::text,'')||coalesce(detail::text,'')",
      ],
      ['platform.outbox', 'payload::text'],
      ['domains.domain_transfers', 'row_to_json(domain_transfers)::text'],
      ['domains.domain_orders', 'row_to_json(domain_orders)::text'],
      ['platform.webhook_events_inbound', 'payload::text'],
    ] as const)
      expect(
        (
          await k.h.env.sql(
            `SELECT count(*)::int n FROM ${tbl} WHERE ${col} LIKE '%' || $1 || '%'`,
            [secret],
          )
        )[0]!.n,
        tbl,
      ).toBe(0);
    const list = await k.call('alice', 'GET', '/v1/domains/transfers');
    expect(JSON.stringify(list.json())).not.toContain(secret);
    expect(JSON.stringify(list.json())).not.toContain('vault://');
    expect(list.json().items[0]).toMatchObject({ name, state: 'pending' });
    const now = new Date();
    const body = JSON.stringify({
      id: 'evt-xfer-fail',
      eventType: 'transfer.failed',
      timeStamp: Math.floor(now.getTime() / 1000),
      data: { domain: name, domainId: 0 },
    });
    // the adapter classifies this event name as a transfer failure
    const res = await hook('openprovider', body, k.op.controls.signWebhook!(body, now).headers);
    expect(res.statusCode).toBe(200);
    expect(
      (
        await k.h.env.sql(
          `SELECT state, authorization_state FROM domains.domain_orders WHERE id=$1`,
          [r.json().orderId],
        )
      )[0],
    ).toMatchObject({ state: 'failed', authorization_state: 'released' });
    expect((await k.call('alice', 'GET', '/v1/domains/transfers')).json().items[0].state).toBe(
      'failed',
    );
    expect(
      await k.count(`SELECT count(*) n FROM billing.ledger_transactions WHERE source_event_id=$1`, [
        `domain-order:${r.json().orderId}:release`,
      ]),
    ).toBe(1);
  });

  it('the cross-border consent and residency gate applies to transfers too: a transfer to a registrar outside the policy is refused at quote time', async () => {
    const cur = await k.call('bob', 'GET', '/v1/compliance/residency-policy', undefined, {
      org: k.orgB,
    });
    await k.call(
      'bob',
      'PUT',
      '/v1/compliance/residency-policy',
      { mode: 'in_kingdom_only' },
      { org: k.orgB, headers: { 'if-match': cur.headers.etag as string } },
    );
    const q = await k.call(
      'bob',
      'POST',
      '/v1/quotes',
      { kind: 'domain', items: [{ name: nm('xb'), years: 1, action: 'transfer_in' }] },
      { org: k.orgB },
    );
    expect(q.statusCode).toBe(403);
  });
});
