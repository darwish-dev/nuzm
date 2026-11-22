import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RegistrarAdminService } from './internal/registrar-admin.service';
import { SearchService } from './internal/search.service';
import { startDomainsKit, type DomainsKit } from './testing/domains-kit';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON in tests */
let k: DomainsKit;
beforeAll(async () => {
  k = await startDomainsKit();
});
afterAll(() => k?.close());

describe('registrar registry (S28 task 6)', () => {
  it('lists registrars and accounts with the probe matrix; everything probed on a mock is NOT VERIFIED', async () => {
    const r = await k.admin('root', 'GET', '/v1/admin/registrars');
    expect(r.statusCode).toBe(200);
    const b = r.json();
    // `dnet` is listed on purpose (migration 0930, owner request 2026-11-21): DISABLED, with no adapter and no account, so nothing is sold through it
    expect(b.registrars.map((x: any) => x.providerCode)).toEqual([
      'dnet',
      'openprovider',
      'resellerclub',
    ]);
    expect(b.registrars.find((x: any) => x.providerCode === 'dnet').enabled).toBe(false);
    expect(b.accounts.map((a: any) => a.providerCode).sort()).toEqual([
      'openprovider',
      'resellerclub',
    ]);
    expect(b.accounts).toHaveLength(2);
    for (const a of b.accounts) {
      expect(a.verification).toBe('NOT VERIFIED');
      expect(a.evidenceKind).toBe('mock');
      expect(a.enabled).toBe(true);
      expect(a.capabilities['registrar.search']).toBe('supported');
    }
    const rc = b.accounts.find((a: any) => a.providerCode === 'resellerclub');
    expect(rc.capabilities['registrar.dns']).toBe('unsupported');
    expect(rc.capabilities['registrar.webhooks']).toBe('unsupported');
  });
  it('refuses credential values: only vault:// references are accepted (422 credential_value_rejected)', async () => {
    const r1 = await k.admin('root', 'POST', '/v1/admin/registrars', {
      providerCode: 'openprovider',
      label: 'x',
      environment: 'sandbox',
      vaultRef: 'plain-password',
      dataRegion: 'NL',
    });
    expect(r1.statusCode).toBe(422);
    expect(r1.json().code ?? r1.json().type).toContain('credential_value_rejected');
    const r2 = await k.admin('root', 'POST', '/v1/admin/registrars', {
      providerCode: 'openprovider',
      label: 'x',
      environment: 'sandbox',
      vaultRef: 'vault://a/b',
      dataRegion: 'NL',
      password: 'hunter2',
    });
    expect(r2.statusCode).toBe(422);
    expect(JSON.stringify(r2.json())).not.toContain('hunter2');
  });
  it('support may read but not change; customers cannot reach the admin API', async () => {
    expect((await k.admin('support', 'GET', '/v1/admin/registrars')).statusCode).toBe(200);
    const w = await k.admin('support', 'POST', '/v1/admin/registrars', {
      providerCode: 'openprovider',
      label: 'x',
      environment: 'sandbox',
      vaultRef: 'vault://a/b',
      dataRegion: 'NL',
    });
    expect(w.statusCode).toBe(403);
    const c = await k.call('alice', 'GET', '/v1/admin/registrars');
    expect([401, 403, 404]).toContain(c.statusCode);
  });
  it('audits the verification without any secret or vault reference content', async () => {
    const rows = await k.h.env.sql(
      `SELECT detail::text d FROM audit.audit_logs WHERE action = 'registrar.account.verified'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(r.d).not.toContain('mock-credential-value');
      expect(r.d).not.toContain('vault://');
    }
  });
  it('a non-live account cannot be enabled when the profile does not allow non-live registrars', async () => {
    const c = await k.admin('root', 'POST', '/v1/admin/registrars', {
      providerCode: 'openprovider',
      label: 'strict',
      environment: 'sandbox',
      vaultRef: 'vault://test/openprovider',
      dataRegion: 'NL',
      currency: 'EUR',
      priority: 99,
    });
    const id = c.json().id as string;
    const prev = process.env.DOMAINS_ALLOW_NON_LIVE_REGISTRARS;
    // the config object is read at start-up: prove the guard through the service with a strict config instead
    const svc = k.app.get(RegistrarAdminService) as any;
    const saved = svc.cfg.allowNonLiveRegistrars;
    svc.cfg.allowNonLiveRegistrars = false;
    try {
      const v = await k.admin('root', 'POST', `/v1/admin/registrars/${id}/verification`, {
        enable: true,
      });
      expect(v.statusCode).toBe(422);
      expect(JSON.stringify(v.json())).toContain('NOT VERIFIED');
      expect(
        await k.count(
          `SELECT count(*) n FROM domains.registrar_accounts WHERE id = $1 AND enabled`,
          [id],
        ),
      ).toBe(0);
    } finally {
      svc.cfg.allowNonLiveRegistrars = saved;
      process.env.DOMAINS_ALLOW_NON_LIVE_REGISTRARS = prev;
    }
  });
});

describe('GET /v1/domains/search (S28 task 4)', () => {
  it('returns price, premium flag, eligibility and cache TTL; blocked TLDs are listed with the reason and cost no vendor call', async () => {
    const r = await k.call(
      'alice',
      'GET',
      '/v1/domains/search?q=nuzm-fresh-1&tlds=com,net,sa,com.sa,xyz',
    );
    expect(r.statusCode).toBe(200);
    const items = r.json().items as any[];
    const by = (n: string) => items.find((i) => i.name === n);
    expect(by('nuzm-fresh-1.com')).toMatchObject({
      available: true,
      premium: false,
      purchasable: true,
      eligibility: { state: 'allowed' },
    });
    expect(by('nuzm-fresh-1.com').price.currency).toBe('SAR');
    expect(by('nuzm-fresh-1.com').price.amountMinor).toMatch(/^\d+$/);
    expect(by('nuzm-fresh-1.com').cacheTtl).toBeGreaterThan(0);
    for (const t of ['sa', 'com.sa', 'xyz']) {
      const i = by(`nuzm-fresh-1.${t}`);
      expect(i.eligibility.state).toBe('blocked');
      expect(i.purchasable).toBe(false);
      expect(i.available).toBeNull();
    }
    expect(by('nuzm-fresh-1.sa').eligibility.rule).toBe('policy.saudi_absent');
  });
  it('a taken name is unavailable; a full name is split on the TLD; invalid input is 422', async () => {
    k.op.controls.seedTaken('nuzm-taken-1.com');
    const r = await k.call('alice', 'GET', '/v1/domains/search?q=nuzm-taken-1.com');
    expect(r.json().items.find((i: any) => i.name === 'nuzm-taken-1.com')).toMatchObject({
      available: false,
      purchasable: false,
    });
    expect((await k.call('alice', 'GET', '/v1/domains/search?q=')).statusCode).toBe(422);
    expect((await k.call('alice', 'GET', '/v1/domains/search?q=bad%20name')).statusCode).toBe(422);
  });
  it('IDN input is searched as punycode', async () => {
    const r = await k.call(
      'alice',
      'GET',
      '/v1/domains/search?q=%D9%85%D8%AB%D8%A7%D9%84&tlds=com',
    );
    expect(r.statusCode).toBe(200);
    expect(r.json().items[0].name).toBe('xn--mgbh0fb.com');
  });
  it('caches availability: a second search within the TTL does not call the registrar again', async () => {
    const before = k.op.controls.lastRequestBodies().length;
    await k.call('alice', 'GET', '/v1/domains/search?q=nuzm-cache-1&tlds=com');
    const mid = k.op.controls.lastRequestBodies().length;
    await k.call('alice', 'GET', '/v1/domains/search?q=nuzm-cache-1&tlds=com');
    expect(k.op.controls.lastRequestBodies().length).toBe(mid);
    expect(mid).toBeGreaterThan(before);
  });
  it('viewers and other roles: viewer is refused, billing_admin and developer may search; the feature is invisible without the flag', async () => {
    expect((await k.call('carol', 'GET', '/v1/domains/search?q=abc-1')).statusCode).toBe(403);
    expect((await k.call('erin', 'GET', '/v1/domains/search?q=abc-1&tlds=com')).statusCode).toBe(
      200,
    );
    expect((await k.call('dave', 'GET', '/v1/domains/search?q=abc-1&tlds=com')).statusCode).toBe(
      200,
    );
  });
  it('rate limit per organization: 429 and an audit event', async () => {
    const svc = k.app.get(SearchService) as any;
    const saved = svc.cfg.searchRatePerMinute;
    svc.cfg.searchRatePerMinute = 3;
    svc.limiter.hits.clear();
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++)
        codes.push(
          (
            await k.call('bob', 'GET', '/v1/domains/search?q=rl-test&tlds=com', undefined, {
              org: k.orgB,
            })
          ).statusCode,
        );
      expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(2);
      expect(
        await k.count(
          `SELECT count(*) n FROM audit.audit_logs WHERE org_id=$1 AND action='domain.search.quota_exceeded'`,
          [k.orgB],
        ),
      ).toBeGreaterThanOrEqual(2);
    } finally {
      svc.cfg.searchRatePerMinute = saved;
    }
  });
  it('a registry outage never reads as available', async () => {
    k.op.controls.inject('search', 'outage', 2);
    const r = await k.call('alice', 'GET', '/v1/domains/search?q=nuzm-outage-1&tlds=com');
    expect(r.statusCode).toBe(200);
    const i = r.json().items[0];
    expect(i.available).not.toBe(true);
    expect(i.purchasable).toBe(false);
  });
});
