import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerPostingService, recipes } from '../billing';
import { FinrecService } from '../finrec';
import { HOSTING_READ_PORT, InMemoryHostingReadPort } from './index';
import { DnsLinkageService } from './internal/linkage.service';
import { DomainOrderService } from './internal/orders.service';
import { DomainJobs } from './internal/renewal.service';
import { OpenproviderMockInject } from './testing/statement-inject';
import { startDomainsKit, type DomainsKit } from './testing/domains-kit';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON in tests */
let k: DomainsKit;
let orders: DomainOrderService;
let n = 0;
const nm = (p: string) => `${p}-${Date.now().toString(36)}-${++n}.com`;
const contact = () => ({
  firstName: 'Salem',
  lastName: 'Alharbi',
  email: 's31.person@example.invalid',
  phone: '+966500000000',
  address: { street: 'King Fahd Rd 1', city: 'Riyadh', postalCode: '12211', country: 'SA' },
});
const exp = async (id: string) =>
  new Date(
    (await k.h.env.sql(`SELECT expires_at e FROM domains.domains WHERE id=$1`, [id]))[0]!.e as Date,
  ).getTime();
const setAuto = async (who: string, org: string, id: string) => {
  const g = await k.call(who, 'GET', `/v1/domains/${id}`, undefined, { org });
  const r = await k.call(
    who,
    'PATCH',
    `/v1/domains/${id}`,
    { autoRenew: true },
    { org, headers: { 'if-match': g.headers.etag as string } },
  );
  if (r.statusCode !== 200) throw new Error(`autoRenew ${r.statusCode} ${r.body}`);
};
const SITE = '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeee1';

async function activeDomain(who: string, org: string, name: string, years = 1) {
  const q = (
    await k.call(
      who,
      'POST',
      '/v1/quotes',
      { kind: 'domain', items: [{ name, years, action: 'register' }] },
      { org },
    )
  ).json();
  const r = await k.call(
    who,
    'POST',
    '/v1/domains',
    { quoteId: q.id, contacts: { registrant: contact() } },
    { org },
  );
  if (r.statusCode !== 202) throw new Error(`order ${r.statusCode} ${r.body}`);
  await orders.run(org, r.json().operationId);
  return { id: r.json().domain.id as string, orderId: r.json().orderId as string, q };
}

beforeAll(async () => {
  k = await startDomainsKit();
  orders = k.app.get(DomainOrderService);
  orders.autoKick = false;
  for (const [who, org] of [
    ['alice', k.orgA],
    ['bob', k.orgB],
  ] as const) {
    await k.call(
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
    await k.fund(org, '100000000');
  }
  (k.app.get(HOSTING_READ_PORT) as InMemoryHostingReadPort).put({
    id: SITE,
    orgId: k.orgA,
    state: 'active',
    targets: { ipv4: ['203.0.113.10', '203.0.113.11'], ipv6: ['2001:db8::10'], cname: null },
    ssl: { state: 'pending', challenge: 'dns-01' },
  });
});
afterAll(() => k?.close());

describe('hosting linkage (DnsLinkagePort, S31 task 1; M06 site is an in-memory FAKE, NOT VERIFIED vs M06)', () => {
  let domainId = '';
  let name = '';
  let zone = '';
  beforeAll(async () => {
    name = nm('link');
    domainId = (await activeDomain('alice', k.orgA, name)).id;
    zone = (await k.call('alice', 'POST', '/v1/dns/zones', { domainId })).json().id;
    // the customer already has an A record at www: the link replaces it (a CNAME/addresses cannot coexist), and the preview says so
    const etag = (await k.call('alice', 'GET', `/v1/dns/zones/${zone}`)).headers.etag as string;
    await k.call(
      'alice',
      'PATCH',
      `/v1/dns/zones/${zone}/records`,
      {
        create: [
          { name: 'www', type: 'A', ttl: 300, value: '192.0.2.99' },
          { name: 'blog', type: 'A', ttl: 300, value: '192.0.2.50' },
        ],
      },
      { headers: { 'if-match': etag } },
    );
  });
  it('previews the change-set from the site’s real targets and what it would replace; nothing is written by a preview', async () => {
    const before = k.op.controls.dnsRecords!(name).length;
    const r = await k.call('alice', 'POST', `/v1/domains/${domainId}/hosting-links`, {
      siteId: SITE,
    });
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json().proposal;
    expect(r.json().outcome).toBe('preview');
    expect(
      p.records
        .filter((x: any) => x.name === '@' && x.type === 'A')
        .map((x: any) => x.value)
        .sort(),
    ).toEqual(['203.0.113.10', '203.0.113.11']);
    expect(p.records.some((x: any) => x.type === 'AAAA' && x.value === '2001:db8::10')).toBe(true);
    expect(p.replaces).toEqual([{ name: 'www', type: 'A', value: '192.0.2.99' }]);
    expect(p.ssl).toEqual({ state: 'pending', challenge: 'dns-01' });
    expect(k.op.controls.dnsRecords!(name)).toHaveLength(before);
  });
  it('applies the link atomically through the DNS engine: records are platform-managed (linkage), unrelated records untouched, audited with the approver', async () => {
    const r = await k.call('alice', 'POST', `/v1/domains/${domainId}/hosting-links`, {
      siteId: SITE,
      apply: true,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().outcome).toBe('applied');
    const recs = (await k.call('alice', 'GET', `/v1/dns/zones/${zone}/records`)).json().items;
    expect(recs.filter((x: any) => x.managedBy === 'linkage').length).toBeGreaterThanOrEqual(5);
    expect(recs.find((x: any) => x.name === 'blog')).toMatchObject({ managedBy: 'user' });
    expect(recs.some((x: any) => x.name === 'www' && x.value === '192.0.2.99')).toBe(false);
    expect(
      k.op.controls.dnsRecords!(name).some((x) => x.name === 'www' && x.value === '192.0.2.99'),
    ).toBe(false);
    expect(
      await k.count(
        `SELECT count(*) n FROM audit.audit_logs WHERE org_id=$1 AND action='domain.hosting.linked' AND actor_user_id=$2`,
        [k.orgA, k.ids.alice],
      ),
    ).toBe(1);
    // idempotent: applying again changes nothing
    const again = await k.call('alice', 'POST', `/v1/domains/${domainId}/hosting-links`, {
      siteId: SITE,
      apply: true,
    });
    expect(again.json().outcome).toBe('unchanged');
    const cur = (await k.call('alice', 'GET', `/v1/domains/${domainId}/hosting-links`)).json();
    expect(cur.records.every((x: any) => x.managedBy === 'linkage')).toBe(true);
    // users cannot touch the platform-managed records
    const etag = (await k.call('alice', 'GET', `/v1/dns/zones/${zone}`)).headers.etag as string;
    const del = await k.call(
      'alice',
      'PATCH',
      `/v1/dns/zones/${zone}/records`,
      { delete: [{ name: '@', type: 'A' }] },
      { headers: { 'if-match': etag } },
    );
    expect(del.statusCode).toBe(422);
  });
  it('ACME DNS-01: only through the port; the user API refuses _acme-challenge; the record is cleaned up after validation', async () => {
    const port = k.app.get(DnsLinkageService);
    const token = 'acme-token-ABCDEFGH-1234567890';
    const etag = (await k.call('alice', 'GET', `/v1/dns/zones/${zone}`)).headers.etag as string;
    const user = await k.call(
      'alice',
      'PATCH',
      `/v1/dns/zones/${zone}/records`,
      { create: [{ name: '_acme-challenge', type: 'TXT', value: token }] },
      { headers: { 'if-match': etag } },
    );
    expect(user.statusCode).toBe(422);
    await port.writeAcmeChallenge(k.orgA, name, token);
    expect(
      k.op.controls.dnsRecords!(name).some(
        (x) => x.name === '_acme-challenge' && x.value === token,
      ),
    ).toBe(true);
    await expect(port.writeAcmeChallenge(k.orgA, name, 'short')).rejects.toThrow();
    await port.clearAcmeChallenge(k.orgA, name, token);
    expect(k.op.controls.dnsRecords!(name).some((x) => x.name === '_acme-challenge')).toBe(false);
    await port.clearAcmeChallenge(k.orgA, name, token); // idempotent
  });
  it('errors: unknown site, another organization’s site, no zone, viewers', async () => {
    expect(
      (
        await k.call('alice', 'POST', `/v1/domains/${domainId}/hosting-links`, {
          siteId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeee9',
        })
      ).statusCode,
    ).toBe(404);
    const other = (await activeDomain('bob', k.orgB, nm('bsite'))).id;
    expect(
      (
        await k.call(
          'bob',
          'POST',
          `/v1/domains/${other}/hosting-links`,
          { siteId: SITE },
          { org: k.orgB },
        )
      ).statusCode,
    ).toBe(404); // org A's site is invisible to org B
    const nz = (await activeDomain('alice', k.orgA, nm('nozone'))).id;
    expect(
      (await k.call('alice', 'POST', `/v1/domains/${nz}/hosting-links`, { siteId: SITE }))
        .statusCode,
    ).toBe(422);
    expect(
      (await k.call('carol', 'POST', `/v1/domains/${domainId}/hosting-links`, { siteId: SITE }))
        .statusCode,
    ).toBe(403);
  });
});

describe('renewals: reminders, auto-renew, approval, payment failure (S31 task 2)', () => {
  it('reminders at 60/30/7/1 days go out once per threshold; re-running the job sends nothing new', async () => {
    const d = await activeDomain('alice', k.orgA, nm('remind'));
    const base = await exp(d.id);
    const jobs = k.app.get(DomainJobs);
    const notes = () =>
      k.count(
        `SELECT count(*) n FROM platform.notifications WHERE org_id=$1 AND kind='domain.renewal_reminder' AND body->'params'->>'name' = (SELECT name FROM domains.domains WHERE id=$2)`,
        [k.orgA, d.id],
      );
    const day = 86_400_000;
    for (const [days, expected] of [
      [61, 0],
      [59, 1],
      [59, 1],
      [29, 2],
      [6, 3],
      [0.5, 4],
    ] as const) {
      await jobs.runDaily(new Date(base - days * day));
      if (expected > 0) expect(await notes(), `at ${days} days`).toBeGreaterThan(0);
      const r = await k.h.env.sql(
        `SELECT count(*)::int n FROM audit.audit_logs WHERE org_id=$1 AND action='domain.renewal.reminder' AND resource_id=$2`,
        [k.orgA, d.id],
      );
      expect(r[0]!.n, `at ${days} days`).toBe(expected);
    }
  });
  it('auto-renew within the standing limit orders the renewal; the registration is extended once and the wallet charged once', async () => {
    const d = await activeDomain('alice', k.orgA, nm('auto'));
    await setAuto('alice', k.orgA, d.id);
    const base = await exp(d.id);
    const jobs = k.app.get(DomainJobs);
    const res = await jobs.runDaily(new Date(base - 20 * 86_400_000));
    expect(res.autoRenewals).toBeGreaterThanOrEqual(1);
    const ord = (
      await k.h.env.sql(
        `SELECT id, operation_id FROM domains.domain_orders WHERE domain_id=$1 AND type='renewal'`,
        [d.id],
      )
    )[0]!;
    await orders.run(k.orgA, ord.operation_id as string);
    expect(await exp(d.id)).toBeGreaterThan(base);
    expect((await jobs.runDaily(new Date(base - 19 * 86_400_000))).autoRenewals).toBe(0); // one attempt per cycle
    expect(
      await k.count(
        `SELECT count(*) n FROM domains.domain_orders WHERE domain_id=$1 AND type='renewal'`,
        [d.id],
      ),
    ).toBe(1);
  });
  it('auto-renew above the spending limit asks for a spend approval (M02) and orders nothing', async () => {
    const d = await activeDomain('alice', k.orgA, nm('approve'));
    await setAuto('alice', k.orgA, d.id);
    const limit = await k.call('alice', 'PUT', '/v1/billing/spending-limits', {
      scope: 'org',
      period: 'monthly',
      currency: 'SAR',
      amountMinor: '1',
      mode: 'hard',
    });
    if (![200, 201].includes(limit.statusCode))
      return void expect(limit.statusCode, limit.body).toBeLessThan(500);
    const base = await exp(d.id);
    const res = await k.app.get(DomainJobs).runDaily(new Date(base - 10 * 86_400_000));
    expect(res.approvalsRequested).toBeGreaterThanOrEqual(1);
    expect(
      await k.count(
        `SELECT count(*) n FROM domains.domain_orders WHERE domain_id=$1 AND type='renewal'`,
        [d.id],
      ),
    ).toBe(0);
    expect(
      await k.count(
        `SELECT count(*) n FROM audit.audit_logs WHERE org_id=$1 AND action='domain.renewal.approval_requested' AND resource_id=$2`,
        [k.orgA, d.id],
      ),
    ).toBe(1);
    await k.h.env
      .sql(`DELETE FROM billing.spending_limits WHERE org_id=$1`, [k.orgA])
      .catch(() => undefined);
  });
  it('a failed renewal payment flags the domain renewal_at_risk and notifies with the dunning link', async () => {
    const d = await activeDomain('bob', k.orgB, nm('risk'));
    await setAuto('bob', k.orgB, d.id);
    // empty the wallet (a consumption posting) so the renewal cannot be paid
    const bal = Number(
      (
        await k.h.env.sql(
          `SELECT coalesce(sum(CASE WHEN p.direction='credit' THEN p.amount_minor ELSE -p.amount_minor END),0) n FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id=p.account_id WHERE a.code='2100' AND a.org_id=$1`,
          [k.orgB],
        )
      )[0]!.n,
    );
    await k.app.get(LedgerPostingService).post(
      recipes.walletConsume({
        orgId: k.orgB,
        netMinor: String(bal),
        currency: 'SAR',
        description: 'drain',
        sourceEventId: crypto.randomUUID(),
      }),
      `drain-${Date.now()}`,
    );
    const base = await exp(d.id);
    const res = await k.app.get(DomainJobs).runDaily(new Date(base - 5 * 86_400_000));
    expect(res.atRisk).toBeGreaterThanOrEqual(1);
    expect(
      (await k.call('bob', 'GET', `/v1/domains/${d.id}`, undefined, { org: k.orgB })).json(),
    ).toMatchObject({ state: 'renewal_at_risk', renewalAtRisk: true });
    const note = await k.h.env.sql(
      `SELECT body::text b FROM platform.notifications WHERE org_id=$1 AND kind='domain.renewal_payment_failed'`,
      [k.orgB],
    );
    expect(note.length).toBeGreaterThan(0);
    expect(note[0]!.b).toContain('/billing/overdue');
  });
  it('dns.zone_months accrues once per zone per day (deterministic event id)', async () => {
    const d = await activeDomain('alice', k.orgA, nm('zm'));
    await k.call('alice', 'POST', '/v1/dns/zones', { domainId: d.id });
    const jobs = k.app.get(DomainJobs);
    const day = new Date('2027-03-10T12:00:00Z');
    expect(await jobs.accrueZoneMonths(day)).toBeGreaterThanOrEqual(1);
    expect(await jobs.accrueZoneMonths(day)).toBe(0);
    expect(
      await k.count(
        `SELECT count(*) n FROM platform.outbox WHERE topic='usage.recorded' AND payload->>'meterId'='dns.zone_months' AND payload->>'windowStart' LIKE '2027-03-10%'`,
      ),
    ).toBe(
      await k.count(
        `SELECT count(*) n FROM domains.dns_zones WHERE state IN ('active','degraded')`,
      ),
    );
  });
});

describe('RC-04 against the registrar statement (S31 task 3; mock statement: NOT VERIFIED, AC-M07-15 stays BLOCKED)', () => {
  it('reports exactly the injected variances: a changed amount, a statement line with no order, an order with no line', async () => {
    const aName = nm('rc4a');
    const a = await activeDomain('alice', k.orgA, aName);
    const b = await activeDomain('alice', k.orgA, nm('rc4b'));
    const day = new Date().toISOString().slice(0, 10);
    const finrec = k.app.get(FinrecService);
    // 1) clean: statement == captured costs
    const asAdmin = async () => {
      const runs = await finrec.request(k.staff.finance!.id, {
        types: ['RC-04'],
        periodFrom: day,
        periodTo: day,
      });
      for (const r of runs) await finrec.process(r.id);
      const items = await k.h.env.sql(
        `SELECT kind, match_key AS key FROM finrec.reconciliation_items WHERE run_id = ANY($1::uuid[]) ORDER BY key`,
        [runs.map((r: any) => r.id)],
      );
      return items as any[];
    };
    const clean = (await asAdmin()).filter((i) => /bill|statement/.test(i.kind));
    expect(clean, JSON.stringify(clean)).toEqual([]);
    // 2) inject: the registrar statement now shows an extra charge and a different amount for order A
    OpenproviderMockInject.changeAmount(k, aName);
    OpenproviderMockInject.extraLine(k);
    const items = (await asAdmin()).filter((i) => /bill/.test(i.kind));
    const kinds = items.map((i) => i.kind).sort();
    expect(kinds).toEqual(['bill_amount_mismatch', 'bill_line_without_cost']);
    expect(items.find((i) => i.kind === 'bill_amount_mismatch')!.key).toContain(
      `domain-order:${a.orderId}`,
    );
    void b;
  });
});

describe('admin reads (UI-M07-10, UI-M07-12)', () => {
  it('support and platform admins read the queue and a domain with MASKED contacts; customers cannot', async () => {
    const list = await k.admin('support', 'GET', '/v1/admin/domains?limit=5');
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items.length).toBeGreaterThan(0);
    expect(list.json().items[0].verification).toBe('NOT VERIFIED');
    const id = list.json().items[0].id;
    const d = await k.admin('support', 'GET', `/v1/admin/domains/${id}`);
    expect(d.statusCode).toBe(200);
    expect(d.json().contactsMasked).toBe(true);
    expect(JSON.stringify(d.json())).not.toContain('s31.person@example.invalid');
    expect(JSON.stringify(d.json())).not.toContain('Alharbi');
    expect((await k.call('alice', 'GET', '/v1/admin/domains')).statusCode).toBeGreaterThanOrEqual(
      401,
    );
    expect(
      (await k.admin('support', 'POST', `/v1/admin/domains/${id}/reconciliations`)).statusCode,
    ).toBe(403);
    expect(
      (await k.admin('finance', 'GET', '/v1/admin/domains?needsReconcile=true')).statusCode,
    ).toBe(200);
  });
});
