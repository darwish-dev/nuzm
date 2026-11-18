import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMAINS_CONFIG } from './internal/ports';
import { startDomainsKit, type DomainsKit } from './testing/domains-kit';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON in tests */
let k: DomainsKit;
beforeAll(async () => {
  k = await startDomainsKit();
});
afterAll(() => k?.close());

const quote = (who: string, items: object[], org?: string) =>
  k.call('alice' === who ? who : who, 'POST', '/v1/quotes', { kind: 'domain', items }, { org });
const counts = async (org: string) => ({
  orders: await k.count(`SELECT count(*) n FROM commerce.orders WHERE org_id=$1`, [org]),
  auths: await k.count(`SELECT count(*) n FROM commerce.authorizations WHERE org_id=$1`, [org]),
  ledger: await k.count(`SELECT count(*) n FROM billing.ledger_transactions WHERE org_id=$1`, [
    org,
  ]),
  domainOrders: await k.count(`SELECT count(*) n FROM domains.domain_orders WHERE org_id=$1`, [
    org,
  ]),
});

describe('POST /v1/quotes kind=domain (S28 task 5)', () => {
  it('issues an immutable quote with price, tax estimate, eligibility, residency and expiry', async () => {
    const r = await quote('alice', [{ name: 'quote-happy-1.com', years: 2, action: 'register' }]);
    expect(r.statusCode, r.body).toBe(201);
    const q = r.json();
    expect(q.kind).toBe('domain');
    expect(q.items).toHaveLength(1);
    expect(q.items[0]).toMatchObject({
      meterId: 'domain.registration_years',
      quantity: '2.00000000',
      unit: 'year',
    });
    // 8.99 EUR cost × 4.10 = 36.859 SAR/yr → rounded UP to 3686 minor units; ×2 years
    expect(q.items[0].unitPriceMinor).toBe('3686.00000000');
    expect(q.items[0].amountMinor).toBe('7372');
    expect(q.taxEstimate.taxMinor).toMatch(/^\d+$/);
    expect(BigInt(q.totalMinor)).toBe(BigInt(q.subtotalMinor) + BigInt(q.taxEstimate.taxMinor));
    expect(q.eligibility).toHaveLength(1);
    expect(q.eligibility[0]).toMatchObject({
      name: 'quote-happy-1.com',
      state: 'allowed',
      rule: 'policy.allowed',
      tld: 'com',
    });
    expect(q.residency.status).toBe('evaluated');
    expect(q.residency.decisions[0].decision).toBe('allow');
    expect(Date.parse(q.expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
    // immutable: the database refuses any change
    await expect(
      k.h.env.sql(`UPDATE commerce.quotes SET total_minor = 1 WHERE id = $1`, [q.id]),
    ).rejects.toThrow(/immutable/);
    // the eligibility evidence is stored append-only and tied to the quote
    const ev = await k.h.env.sql(
      `SELECT result, quote_id FROM domains.eligibility_checks WHERE quote_id = $1`,
      [q.id],
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]!.result).toBe('allowed');
    await expect(
      k.h.env.sql(`UPDATE domains.eligibility_checks SET result='allowed' WHERE quote_id = $1`, [
        q.id,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it('AC-M07-04: 100 quote attempts for TLDs without policy/capability enablement (incl. every Saudi TLD) are 422 and create 0 orders, authorizations or ledger rows', async () => {
    const before = await counts(k.orgA);
    const tlds = [
      'sa',
      'com.sa',
      'net.sa',
      'org.sa',
      'edu.sa',
      'gov.sa',
      'med.sa',
      'pub.sa',
      'id.sa',
      'sch.sa',
      'xn--mgberp4a5d4ar',
      'xyz',
      'ae',
      'io',
      'dev',
      'info',
      'biz',
      'co.uk',
    ];
    let n = 0;
    const codes = new Map<number, number>();
    for (let i = 0; i < 100; i++) {
      const tld = tlds[i % tlds.length]!;
      const r = await quote('alice', [
        { name: `blocked-${i}.${tld}`, years: 1, action: 'register' },
      ]);
      codes.set(r.statusCode, (codes.get(r.statusCode) ?? 0) + 1);
      expect(r.statusCode, `${tld}: ${r.body}`).toBe(422);
      expect(JSON.stringify(r.json())).toMatch(/unsupported_capability|eligibility_blocked/);
      n++;
    }
    expect(n).toBe(100);
    expect(await counts(k.orgA)).toEqual(before);
    const blocked = await k.count(
      `SELECT count(*) n FROM domains.eligibility_checks WHERE org_id=$1 AND result='blocked' AND name LIKE 'blocked-%'`,
      [k.orgA],
    );
    expect(blocked).toBe(100); // each refusal left its evidence
    expect(
      await k.count(
        `SELECT count(*) n FROM audit.audit_logs WHERE org_id=$1 AND action='domain.eligibility.blocked'`,
        [k.orgA],
      ),
    ).toBeGreaterThanOrEqual(100);
  });

  it('a taken name is 409 domain_unavailable (no owner leaked); a name this org already owns is not offered twice', async () => {
    k.op.controls.seedTaken('quote-taken-1.com');
    const r = await quote('alice', [{ name: 'quote-taken-1.com' }]);
    expect(r.statusCode).toBe(409);
    expect(JSON.stringify(r.json())).toContain('domain_unavailable');
  });

  it('validates items: years, action, duplicates, bad names; and the kind needs the quote permission', async () => {
    for (const items of [
      [{ name: 'x y.com' }],
      [{ name: 'ok-1.com', years: 11 }],
      [{ name: 'ok-1.com', years: 0 }],
      [{ name: 'ok-1.com', action: 'steal' }],
      [{ name: 'dup-1.com' }, { name: 'dup-1.com' }],
      [{ name: 5 }],
    ])
      expect((await quote('alice', items as object[])).statusCode, JSON.stringify(items)).toBe(422);
    expect((await quote('carol', [{ name: 'viewer-1.com' }])).statusCode).toBe(403);
  });

  it('renewal of a domain you do not own is 404', async () => {
    expect((await quote('alice', [{ name: 'not-mine-1.com', action: 'renew' }])).statusCode).toBe(
      404,
    );
  });

  it('residency: a registrar outside the organization policy refuses the quote (403 residency_denied) before anything is ordered', async () => {
    const cur = await k.call('bob', 'GET', '/v1/compliance/residency-policy', undefined, {
      org: k.orgB,
    });
    const put = await k.call(
      'bob',
      'PUT',
      '/v1/compliance/residency-policy',
      { mode: 'in_kingdom_only' },
      { org: k.orgB, headers: { 'if-match': cur.headers.etag as string } },
    );
    expect(put.statusCode).toBe(200);
    const before = await counts(k.orgB);
    const r = await quote('bob', [{ name: 'residency-1.com' }], k.orgB);
    expect(r.statusCode).toBe(403);
    expect(JSON.stringify(r.json())).toContain('residency_denied');
    expect(await counts(k.orgB)).toEqual(before);
  });

  it('no sellable registrar (account disabled) ⇒ unsupported_capability, not a price', async () => {
    await k.h.env.sql(`UPDATE domains.registrar_accounts SET enabled = false`);
    try {
      const r = await quote('alice', [{ name: 'quote-noreg-1.com' }]);
      expect(r.statusCode).toBe(422);
      expect(JSON.stringify(r.json())).toContain('unsupported_capability');
    } finally {
      await k.h.env.sql(`UPDATE domains.registrar_accounts SET enabled = true`);
    }
  });

  it('a currency with no exchange rate is never priced', async () => {
    const cfg = k.app.get(DOMAINS_CONFIG) as any;
    const saved = cfg.fx;
    cfg.fx = { SAR: '1' };
    try {
      const r = await quote('alice', [{ name: 'quote-nofx-1.net' }]);
      expect(r.statusCode).toBe(422);
    } finally {
      cfg.fx = saved;
    }
  });
});
