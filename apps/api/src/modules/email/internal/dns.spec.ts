import { describe, expect, it } from 'vitest';
import type { RequiredDnsRecord } from '@nuzm/adapter-data';
import { FakeDnsResolver, checkDomain, dmarcGuidanceRecord, ownershipRecord } from './dns';

const D = 'mail.example.test';
const REQ: RequiredDnsRecord[] = [
  ownershipRecord(D, 'tok123'),
  {
    type: 'TXT',
    name: D,
    value: 'v=spf1 include:spf.provider.test ~all',
    purpose: 'spf',
    required: true,
  },
  {
    type: 'CNAME',
    name: `s1._domainkey.${D}`,
    value: 's1.dkim.provider.test',
    purpose: 'dkim',
    required: true,
  },
  {
    type: 'CNAME',
    name: `s2._domainkey.${D}`,
    value: 's2.dkim.provider.test',
    purpose: 'dkim',
    required: true,
  },
  {
    type: 'CNAME',
    name: `bounce.${D}`,
    value: 'rp.provider.test',
    purpose: 'return-path',
    required: false,
  },
  dmarcGuidanceRecord(D),
];
const MX: RequiredDnsRecord[] = [
  { type: 'MX', name: D, value: 'mx1.provider.test', priority: 10, purpose: 'mx', required: true },
  { type: 'MX', name: D, value: 'mx2.provider.test', priority: 20, purpose: 'mx', required: true },
];
const good = (r: FakeDnsResolver) => {
  r.set('TXT', `_nuzm-verify.${D}`, ['nuzm-verification=tok123']);
  r.set('TXT', D, ['v=spf1 include:spf.provider.test ~all']);
  r.set('CNAME', `s1._domainkey.${D}`, ['s1.dkim.provider.test.']);
  r.set('CNAME', `s2._domainkey.${D}`, ['S2.DKIM.PROVIDER.TEST']);
};
const trio = () => [new FakeDnsResolver('a'), new FakeDnsResolver('b'), new FakeDnsResolver('c')];
const status = (c: Awaited<ReturnType<typeof checkDomain>>, purpose: string, name?: string) =>
  c.records.filter((r) => r.purpose === purpose && (!name || r.name === name)).map((r) => r.status);

describe('DNS verification fixtures (SPF / DKIM / DMARC / MX)', () => {
  it('everything correct on every resolver: verified; trailing dots and case do not matter', async () => {
    const rs = trio();
    rs.forEach(good);
    const c = await checkDomain(D, REQ, rs);
    expect(c.state).toBe('verified');
    expect(status(c, 'dkim')).toEqual(['ok', 'ok']);
    expect(c.dmarc.state).toBe('missing'); // guidance only: never blocks
    expect(c.dmarc.suggestion).toContain('p=none');
  });
  it('missing SPF: pending/partial with SPF missing', async () => {
    const rs = trio();
    rs.forEach(good);
    rs.forEach((r) => r.set('TXT', D, []));
    const c = await checkDomain(D, REQ, rs);
    expect(c.state).toBe('partial');
    expect(status(c, 'spf')).toEqual(['missing']);
  });
  it('DUPLICATE SPF is a conflict (permerror), even when both records are individually fine', async () => {
    const rs = trio();
    rs.forEach(good);
    rs.forEach((r) =>
      r.set('TXT', D, ['v=spf1 include:spf.provider.test ~all', 'v=spf1 include:other.test ~all']),
    );
    const c = await checkDomain(D, REQ, rs);
    expect(status(c, 'spf')).toEqual(['conflict']);
    expect(c.records.find((r) => r.purpose === 'spf')!.detail).toMatch(/more than one SPF/);
    expect(c.state).toBe('partial');
  });
  it('an SPF that lacks the provider include, or allows +all, is a conflict', async () => {
    for (const v of ['v=spf1 include:someone.else ~all', 'v=spf1 +all include:spf.provider.test']) {
      const rs = trio();
      rs.forEach(good);
      rs.forEach((r) => r.set('TXT', D, [v]));
      expect(status(await checkDomain(D, REQ, rs), 'spf')).toEqual(['conflict']);
    }
  });
  it('multiple DKIM selectors are separate required records: one missing selector keeps the domain partial; a wrong target is a conflict', async () => {
    const rs = trio();
    rs.forEach(good);
    rs.forEach((r) => r.set('CNAME', `s2._domainkey.${D}`, []));
    let c = await checkDomain(D, REQ, rs);
    expect(status(c, 'dkim')).toEqual(['ok', 'missing']);
    expect(c.state).toBe('partial');
    rs.forEach((r) => r.set('CNAME', `s2._domainkey.${D}`, ['elsewhere.test']));
    c = await checkDomain(D, REQ, rs);
    expect(status(c, 'dkim')).toEqual(['ok', 'conflict']);
  });
  it("the ownership proof must carry THIS organization's token: another token does not verify", async () => {
    const rs = trio();
    rs.forEach(good);
    rs.forEach((r) => r.set('TXT', `_nuzm-verify.${D}`, ['nuzm-verification=SOMEONE-ELSE']));
    const c = await checkDomain(D, REQ, rs);
    expect(status(c, 'ownership')).toEqual(['missing']);
    expect(c.state).toBe('partial');
  });
  it.each([
    ['missing', [], 'missing'],
    ['p=none', ['v=DMARC1; p=none'], 'none'],
    ['p=quarantine with rua', ['v=DMARC1; p=quarantine; rua=mailto:d@example.test'], 'quarantine'],
    ['p=reject', ['v=DMARC1;p=reject;pct=100'], 'reject'],
    ['uppercase', ['V=DMARC1; P=REJECT'], 'reject'],
    ['no policy tag', ['v=DMARC1; rua=mailto:d@example.test'], 'invalid'],
    ['bad policy', ['v=DMARC1; p=allow'], 'invalid'],
    ['duplicate', ['v=DMARC1; p=none', 'v=DMARC1; p=reject'], 'duplicate'],
  ])('DMARC variant %s', async (_n, vals, want) => {
    const rs = trio();
    rs.forEach(good);
    rs.forEach((r) => r.set('TXT', `_dmarc.${D}`, vals));
    expect((await checkDomain(D, REQ, rs)).dmarc.state).toBe(want);
  });
  it('MX is judged as a set: complete = ok; a foreign MX with the same or a better preference is a conflict; missing = missing', async () => {
    const all = [...REQ, ...MX];
    const rs = trio();
    rs.forEach(good);
    rs.forEach((r) => r.set('MX', D, ['10 mx1.provider.test.', '20 mx2.provider.test']));
    let c = await checkDomain(D, all, rs);
    expect(status(c, 'mx')).toEqual(['ok', 'ok']);
    expect(c.state).toBe('verified');
    rs.forEach((r) =>
      r.set('MX', D, ['5 mail.oldhost.test', '10 mx1.provider.test', '20 mx2.provider.test']),
    );
    c = await checkDomain(D, all, rs);
    expect(status(c, 'mx')).toEqual(['conflict', 'conflict']);
    expect(c.state).toBe('partial');
    rs.forEach((r) => r.set('MX', D, []));
    c = await checkDomain(D, all, rs);
    expect(status(c, 'mx')).toEqual(['missing', 'missing']);
  });
  it('resolvers are judged by MAJORITY: one stale resolver cannot verify or fail a domain', async () => {
    const rs = trio();
    rs.forEach(good);
    rs[2]!.clear(); // one resolver has not seen the records yet
    expect((await checkDomain(D, REQ, rs)).state).toBe('verified');
    rs[1]!.clear();
    expect((await checkDomain(D, REQ, rs)).state).toBe('pending'); // only one of three sees them
  });
  it('resolvers that disagree on a record are a conflict ("propagation in progress"), not a silent pass', async () => {
    const rs = trio();
    rs.forEach(good);
    rs[0]!.set('CNAME', `s1._domainkey.${D}`, ['a.test']);
    rs[1]!.set('CNAME', `s1._domainkey.${D}`, ['b.test']);
    rs[2]!.set('CNAME', `s1._domainkey.${D}`, []);
    const c = await checkDomain(D, REQ, rs);
    expect(status(c, 'dkim', `s1._domainkey.${D}`)).toEqual(['conflict']);
  });
  it('when EVERY resolver fails the check is inconclusive (the caller keeps the old state) and the TTL drives the next look', async () => {
    const rs = trio();
    rs.forEach((r) => (r.failing = true));
    const c = await checkDomain(D, REQ, rs);
    expect(c.inconclusive).toBe(true);
    const slow = trio();
    slow.forEach(good);
    slow.forEach((r) => (r.ttl = 120));
    expect((await checkDomain(D, REQ, slow)).minTtl).toBe(120);
  });
});
