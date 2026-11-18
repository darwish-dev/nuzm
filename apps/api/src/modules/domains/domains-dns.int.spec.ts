import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMAINS_CONFIG } from './index';
import { DnsService } from './internal/dns.service';
import { DomainOrderService } from './internal/orders.service';
import { startDomainsKit, type DomainsKit } from './testing/domains-kit';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON in tests */
let k: DomainsKit;
let n = 0;
const nm = (p: string) => `${p}-${Date.now().toString(36)}-${++n}.com`;
const contact = () => ({
  firstName: 'Salem',
  lastName: 'Alharbi',
  email: 'dns.person@example.invalid',
  phone: '+966500000000',
  address: { street: 'King Fahd Rd 1', city: 'Riyadh', postalCode: '12211', country: 'SA' },
});

async function activeDomain(who: string, org: string, name: string, prefer?: 'rc') {
  const orders = k.app.get(DomainOrderService);
  if (prefer === 'rc')
    await k.h.env.sql(
      `UPDATE domains.registrar_accounts SET priority = CASE WHEN id = $1 THEN 1 ELSE 50 END`,
      [k.accounts.rc],
    );
  const q = (
    await k.call(
      who,
      'POST',
      '/v1/quotes',
      { kind: 'domain', items: [{ name, years: 1, action: 'register' }] },
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
  if (prefer === 'rc')
    await k.h.env.sql(
      `UPDATE domains.registrar_accounts SET priority = CASE WHEN id = $1 THEN 10 ELSE 20 END`,
      [k.accounts.op],
    );
  return r.json().domain.id as string;
}
const rec = (name: string, i: number) => ({ name, type: 'A', ttl: 300, value: `192.0.2.${i + 1}` });

beforeAll(async () => {
  k = await startDomainsKit();
  k.app.get(DomainOrderService).autoKick = false;
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
});
afterAll(() => k?.close());

describe('DNS zones and records (S30)', () => {
  let zone = '';
  let name = '';
  let domainId = '';
  beforeAll(async () => {
    name = nm('dns');
    domainId = await activeDomain('alice', k.orgA, name);
  });

  it('creates a zone through the registrar adapter; a registrar without DNS hosting cannot (422 unsupported_capability)', async () => {
    const r = await k.call('alice', 'POST', '/v1/dns/zones', { domainId });
    expect(r.statusCode, r.body).toBe(201);
    zone = r.json().id;
    expect(r.json()).toMatchObject({
      domainId,
      name,
      state: 'active',
      version: 1,
      degraded: false,
    });
    expect(r.json().dnssec.available).toBe(false); // DNSSEC only appears when the probe says supported for that TLD
    expect((await k.call('alice', 'POST', '/v1/dns/zones', { domainId })).statusCode).toBe(409);
    const rcName = nm('rcdns');
    const rcDomain = await activeDomain('alice', k.orgA, rcName, 'rc');
    expect(k.rc.controls.registrationsByName(rcName)).toBe(1);
    const x = await k.call('alice', 'POST', '/v1/dns/zones', { domainId: rcDomain });
    expect(x.statusCode).toBe(422);
    expect(JSON.stringify(x.json())).toContain('unsupported_capability');
  });

  it('applies a valid change-set: per-change results, a new ETag, the registrar and our copy agree', async () => {
    const g = await k.call('alice', 'GET', `/v1/dns/zones/${zone}/records`);
    expect(g.json().items).toEqual([]);
    const v1 = g.headers.etag as string;
    const r = await k.call(
      'alice',
      'PATCH',
      `/v1/dns/zones/${zone}/records`,
      {
        create: [
          rec('@', 0),
          rec('www', 1),
          { name: '@', type: 'MX', ttl: 3600, value: { priority: 10, host: 'mail.example.net' } },
          { name: '@', type: 'TXT', value: 'v=spf1 -all' },
        ],
      },
      { headers: { 'if-match': v1 } },
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().outcome).toBe('applied');
    expect(r.json().results).toHaveLength(4);
    expect(r.headers.etag).not.toBe(v1);
    expect(k.op.controls.dnsRecords!(name)).toHaveLength(4);
    const list = (await k.call('alice', 'GET', `/v1/dns/zones/${zone}/records?type=A`)).json();
    expect(list.items.map((i: any) => i.name).sort()).toEqual(['@', 'www']);
    expect(
      await k.count(
        `SELECT count(*) n FROM audit.audit_logs WHERE org_id=$1 AND action='dns.changeset.applied'`,
        [k.orgA],
      ),
    ).toBeGreaterThanOrEqual(1);
  });

  it('ETag conflict: a stale If-Match is 412 etag_mismatch, a missing one 428; nothing changes', async () => {
    const before = k.op.controls.dnsRecords!(name).length;
    expect(
      (
        await k.call(
          'alice',
          'PATCH',
          `/v1/dns/zones/${zone}/records`,
          { create: [rec('x', 5)] },
          { headers: { 'if-match': '"1"' } },
        )
      ).statusCode,
    ).toBe(412);
    expect(
      (await k.call('alice', 'PATCH', `/v1/dns/zones/${zone}/records`, { create: [rec('x', 5)] }))
        .statusCode,
    ).toBe(428);
    expect(k.op.controls.dnsRecords!(name)).toHaveLength(before);
  });

  it('invalid sets are 422 record_invalid with errors[] and the index of the offending change; NOTHING is applied', async () => {
    const etag = (await k.call('alice', 'GET', `/v1/dns/zones/${zone}`)).headers.etag as string;
    const before = k.op.controls.dnsRecords!(name).length;
    const r = await k.call(
      'alice',
      'PATCH',
      `/v1/dns/zones/${zone}/records`,
      {
        create: [
          rec('ok1', 7),
          { name: '@', type: 'CNAME', value: 'a.example.net' },
          { name: 'bad', type: 'A', value: '127.0.0.1' },
          { name: '_acme-challenge', type: 'TXT', value: 't' },
        ],
      },
      { headers: { 'if-match': etag } },
    );
    expect(r.statusCode).toBe(422);
    const errors = r.json().errors as any[];
    expect(errors.map((e) => [e.index, e.code])).toEqual([
      [1, 'cname_at_apex'],
      [2, 'unsafe_value'],
      [3, 'reserved_name'],
    ]);
    expect(k.op.controls.dnsRecords!(name)).toHaveLength(before);
    expect((await k.call('alice', 'GET', `/v1/dns/zones/${zone}`)).headers.etag).toBe(etag);
  });

  it('AC-M07-06: a failure injected at EACH position of a 20-change set leaves the zone equal to its pre-state (registrar and our copy), version unchanged', async () => {
    for (let at = 0; at < 20; at++) {
      const g = await k.call('alice', 'GET', `/v1/dns/zones/${zone}/records`);
      const etag = g.headers.etag as string;
      const pre = k.op.controls.dnsRecords!(name)
        .map((x) => `${x.name}|${x.type}|${JSON.stringify(x.value)}`)
        .sort();
      const preMine = g
        .json()
        .items.map((x: any) => `${x.name}|${x.type}`)
        .sort();
      const changes = Array.from({ length: 20 }, (_, i) => rec(`atom${at}-${i}`, i));
      k.op.controls.injectDnsFailureAt!(at);
      const r = await k.call(
        'alice',
        'PATCH',
        `/v1/dns/zones/${zone}/records`,
        { create: changes },
        { headers: { 'if-match': etag } },
      );
      expect(r.statusCode, `position ${at}: ${r.body}`).toBe(409);
      expect(r.json().outcome).toBe('rolled_back');
      expect(r.json().results.filter((x: any) => x.status === 'applied').length).toBe(at); // the vendor really had applied `at` changes before failing
      expect(
        k.op.controls.dnsRecords!(name)
          .map((x) => `${x.name}|${x.type}|${JSON.stringify(x.value)}`)
          .sort(),
      ).toEqual(pre);
      const after = await k.call('alice', 'GET', `/v1/dns/zones/${zone}/records`);
      expect(after.headers.etag).toBe(etag);
      expect(
        after
          .json()
          .items.map((x: any) => `${x.name}|${x.type}`)
          .sort(),
      ).toEqual(preMine);
    }
    expect(
      await k.count(
        `SELECT count(*) n FROM audit.audit_logs WHERE org_id=$1 AND action='dns.changeset.rolled_back'`,
        [k.orgA],
      ),
    ).toBeGreaterThanOrEqual(19);
  });

  it('a rollback that cannot be verified marks the zone degraded, opens a reconcile, blocks further changes; a forced reconciliation adopts the registrar state and recovers', async () => {
    const etag = (await k.call('alice', 'GET', `/v1/dns/zones/${zone}`)).headers.etag as string;
    k.op.controls.dnsFailFrom(3); // three changes land, then every call fails — including the rollback
    const r = await k.call(
      'alice',
      'PATCH',
      `/v1/dns/zones/${zone}/records`,
      { create: Array.from({ length: 6 }, (_, i) => rec(`deg-${i}`, i)) },
      { headers: { 'if-match': etag } },
    );
    expect(r.statusCode).toBe(503);
    expect(r.json().outcome).toBe('degraded');
    expect((await k.call('alice', 'GET', `/v1/dns/zones/${zone}`)).json()).toMatchObject({
      state: 'degraded',
      degraded: true,
    });
    expect(
      await k.count(
        `SELECT count(*) n FROM platform.operations WHERE kind='domains.dns.reconcile' AND resource_id=$1 AND state='needs_reconcile'`,
        [zone],
      ),
    ).toBe(1);
    k.op.controls.dnsFailFrom(null);
    const blocked = await k.call(
      'alice',
      'PATCH',
      `/v1/dns/zones/${zone}/records`,
      { create: [rec('after', 9)] },
      {
        headers: {
          'if-match': (await k.call('alice', 'GET', `/v1/dns/zones/${zone}`)).headers
            .etag as string,
        },
      },
    );
    expect(blocked.statusCode).toBe(409);
    const f = await k.admin('root', 'POST', `/v1/admin/domains/${domainId}/reconciliations`);
    expect(f.statusCode, f.body).toBe(202);
    expect(f.json().results).toContain('dns_adopted');
    expect((await k.call('alice', 'GET', `/v1/dns/zones/${zone}`)).json()).toMatchObject({
      state: 'active',
      degraded: false,
    });
    expect(
      await k.count(
        `SELECT count(*) n FROM platform.operations WHERE kind='domains.dns.reconcile' AND resource_id=$1 AND state='succeeded'`,
        [zone],
      ),
    ).toBe(1);
    // our copy now equals the registrar's live zone
    const live = k.op.controls.dnsRecords!(name).length;
    expect(
      (await k.call('alice', 'GET', `/v1/dns/zones/${zone}/records`)).json().items,
    ).toHaveLength(live);
  });

  it('abuse controls: records-per-zone quota, reserved _acme-challenge and Nuzm hosting targets are refused to users; linkage-managed records cannot be edited by users', async () => {
    const cfg = k.app.get(DOMAINS_CONFIG) as any;
    const savedMax = cfg.maxRecordsPerZone;
    const savedSuffixes = cfg.protectedTargetSuffixes;
    cfg.protectedTargetSuffixes = ['sites.nuzm-hosting.test'];
    const etag = (await k.call('alice', 'GET', `/v1/dns/zones/${zone}`)).headers.etag as string;
    const cname = await k.call(
      'alice',
      'PATCH',
      `/v1/dns/zones/${zone}/records`,
      { create: [{ name: 'takeover', type: 'CNAME', value: 'abc.sites.nuzm-hosting.test' }] },
      { headers: { 'if-match': etag } },
    );
    expect(cname.statusCode).toBe(422);
    expect(JSON.stringify(cname.json())).toContain('protected_target');
    const cur = (await k.call('alice', 'GET', `/v1/dns/zones/${zone}/records`)).json().items.length;
    cfg.maxRecordsPerZone = cur;
    const q = await k.call(
      'alice',
      'PATCH',
      `/v1/dns/zones/${zone}/records`,
      { create: [rec('quota', 3)] },
      { headers: { 'if-match': etag } },
    );
    expect(q.statusCode).toBe(422);
    expect(JSON.stringify(q.json())).toContain('quota_exceeded');
    cfg.maxRecordsPerZone = savedMax;
    cfg.protectedTargetSuffixes = savedSuffixes;
    // a linkage-written record (through the service, as DnsLinkagePort will) is immutable for users
    const dns = k.app.get(DnsService);
    const v = (await k.call('alice', 'GET', `/v1/dns/zones/${zone}`)).headers.etag as string;
    await dns.applyChangeSet(
      k.orgA,
      null,
      zone,
      Number(v.replace(/"/g, '')),
      { create: [{ name: '_acme-challenge', type: 'TXT', ttl: 120, value: 'tok123' }] },
      { writer: 'linkage' },
    );
    const e2 = (await k.call('alice', 'GET', `/v1/dns/zones/${zone}`)).headers.etag as string;
    const del = await k.call(
      'alice',
      'PATCH',
      `/v1/dns/zones/${zone}/records`,
      { delete: [{ name: '_acme-challenge', type: 'TXT' }] },
      { headers: { 'if-match': e2 } },
    );
    expect(del.statusCode).toBe(422);
    const rows = (
      await k.call('alice', 'GET', `/v1/dns/zones/${zone}/records?name=_acme-challenge`)
    ).json().items;
    expect(rows[0]).toMatchObject({ managedBy: 'linkage' });
  });

  it('roles and tenants: viewers read but cannot write, billing_admin reads; another organization sees nothing (404)', async () => {
    const etag = (await k.call('carol', 'GET', `/v1/dns/zones/${zone}`)).headers.etag as string;
    expect(
      (
        await k.call(
          'carol',
          'PATCH',
          `/v1/dns/zones/${zone}/records`,
          { create: [rec('v', 1)] },
          { headers: { 'if-match': etag } },
        )
      ).statusCode,
    ).toBe(403);
    expect((await k.call('carol', 'POST', '/v1/dns/zones', { domainId })).statusCode).toBe(403);
    expect((await k.call('dave', 'GET', `/v1/dns/zones/${zone}/records`)).statusCode).toBe(200);
    const asB = (
      m: 'GET' | 'PATCH' | 'POST',
      url: string,
      body?: object,
      h: Record<string, string> = {},
    ) => k.call('bob', m, url, body, { org: k.orgB, headers: h });
    expect((await asB('GET', `/v1/dns/zones/${zone}`)).statusCode).toBe(404);
    expect((await asB('GET', `/v1/dns/zones/${zone}/records`)).statusCode).toBe(404);
    expect(
      (
        await asB(
          'PATCH',
          `/v1/dns/zones/${zone}/records`,
          { create: [rec('b', 2)] },
          { 'if-match': '"1"' },
        )
      ).statusCode,
    ).toBe(404);
    expect((await asB('POST', '/v1/dns/zones', { domainId })).statusCode).toBe(404);
    expect((await asB('GET', '/v1/dns/zones')).json().items).toEqual([]);
  });

  it('SSRF/injection in record values never reaches the registrar: control characters, URLs and addresses of the platform itself are refused', async () => {
    const etag = (await k.call('alice', 'GET', `/v1/dns/zones/${zone}`)).headers.etag as string;
    const before = k.op.controls.dnsRecords!(name).length;
    const bad = [
      { name: 'a', type: 'A', value: '169.254.169.254' },
      { name: 'b', type: 'CNAME', value: 'http://internal.service/x' },
      { name: 'c', type: 'TXT', value: 'ok\r\n; evil IN A 1.2.3.4' },
      { name: 'd', type: 'MX', value: { priority: 1, host: 'a b' } },
      { name: 'e;rm', type: 'A', value: '192.0.2.1' },
    ];
    for (const b of bad) {
      const r = await k.call(
        'alice',
        'PATCH',
        `/v1/dns/zones/${zone}/records`,
        { create: [b] },
        { headers: { 'if-match': etag } },
      );
      expect(r.statusCode, JSON.stringify(b)).toBe(422);
    }
    expect(k.op.controls.dnsRecords!(name)).toHaveLength(before);
  });
});
