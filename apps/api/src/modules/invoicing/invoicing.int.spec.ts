import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { SequenceService, TaxProfileService, TaxService } from './index';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
type Row = Record<string, any>;

const h = new Harness();
let app: App;
let orgA = '';
let orgB = '';
const ids: Record<string, string> = {};
const jars: Record<string, Record<string, string>> = {};

const call = (
  who: string,
  method: 'GET' | 'PUT',
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
      ...extra,
    },
    ...(body ? { payload: body } : {}),
  });
const VAT = '300000000000003'; // 15 digits, starts and ends with 3 (the default [VERIFY] format)
const address = {
  street: 'King Fahd Road',
  buildingNumber: '1234',
  district: 'Olaya',
  city: 'Riyadh',
  postalCode: '12211',
  country: 'SA',
};
const b2b = {
  buyerType: 'b2b',
  legalName: { ar: 'شركة الأفق', en: 'Horizon Co' },
  vatNumber: VAT,
  crNumber: '1010000000',
  address,
};
const audits = (org: string, action: string) =>
  h.env.sql(`SELECT after FROM audit.audit_logs WHERE org_id=$1 AND action=$2 ORDER BY id`, [
    org,
    action,
  ]) as Promise<Row[]>;

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  for (const n of ['alice', 'bob', 'carol', 'dave', 'erin']) {
    ids[n] = await h.createUser(n);
    jars[n] = await h.sessionFor(app, ids[n]!);
  }
  orgA =
    (await call('alice', 'GET', '/v1/organizations', undefined, '').then(() => null),
    (
      await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: { cookie: cookieHeader(jars.alice!), 'x-csrf-token': jars.alice!.nuzm_csrf! },
        payload: { name: 'Tax A' },
      })
    ).json().id);
  orgB = (
    await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { cookie: cookieHeader(jars.bob!), 'x-csrf-token': jars.bob!.nuzm_csrf! },
      payload: { name: 'Tax B' },
    })
  ).json().id;
  for (const [u, role] of [
    ['carol', 'viewer'],
    ['dave', 'billing_admin'],
    ['erin', 'developer'],
  ] as const)
    await h.env.sql(
      `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, $3)`,
      [orgA, ids[u], role],
    );
});
afterAll(() => h.close());

describe('tax profile API', () => {
  it('has no profile until one is set (404); only billing readers read, only billing managers write', async () => {
    expect((await call('dave', 'GET', '/v1/billing/tax-profile')).statusCode).toBe(404);
    expect((await call('carol', 'GET', '/v1/billing/tax-profile')).statusCode).toBe(403);
    expect((await call('erin', 'GET', '/v1/billing/tax-profile')).statusCode).toBe(403);
    expect((await call('erin', 'PUT', '/v1/billing/tax-profile', b2b)).statusCode).toBe(403);
    expect((await call('carol', 'PUT', '/v1/billing/tax-profile', b2b)).statusCode).toBe(403);
  });

  it('creates (no precondition) with an ETag, then replaces only with the current version (428 / 412)', async () => {
    const created = await call('dave', 'PUT', '/v1/billing/tax-profile', b2b);
    expect(created.statusCode).toBe(200);
    expect(created.headers.etag).toBe('"1"');
    expect(created.json()).toMatchObject({
      buyerType: 'b2b',
      vatNumber: VAT,
      legalName: { en: 'Horizon Co' },
      version: 1,
    });
    expect((await call('alice', 'GET', '/v1/billing/tax-profile')).json().crNumber).toBe(
      '1010000000',
    );
    const next = { ...b2b, legalName: { ar: 'شركة الأفق المحدودة', en: 'Horizon Ltd' } };
    expect((await call('dave', 'PUT', '/v1/billing/tax-profile', next)).statusCode).toBe(428);
    expect(
      (await call('dave', 'PUT', '/v1/billing/tax-profile', next, orgA, { 'if-match': '"9"' }))
        .statusCode,
    ).toBe(412);
    expect(
      (await call('dave', 'PUT', '/v1/billing/tax-profile', next, orgA, { 'if-match': 'junk' }))
        .statusCode,
    ).toBe(422);
    const ok = await call('dave', 'PUT', '/v1/billing/tax-profile', next, orgA, {
      'if-match': '"1"',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"2"');
    expect(
      (await call('dave', 'PUT', '/v1/billing/tax-profile', next, orgA, { 'if-match': '"1"' }))
        .statusCode,
    ).toBe(412);
  });

  it('validates per field (formats are config, [VERIFY]) and a b2b buyer needs a VAT number and a full address', async () => {
    const put = (b: object) =>
      call('dave', 'PUT', '/v1/billing/tax-profile', b, orgA, { 'if-match': '"2"' });
    const cases: [object, string][] = [
      [{ ...b2b, vatNumber: '123' }, 'vatNumber'],
      [{ ...b2b, vatNumber: null }, 'vatNumber'],
      [{ ...b2b, crNumber: 'abc' }, 'crNumber'],
      [{ ...b2b, address: { ...address, postalCode: '12' } }, 'address.postalCode'],
      [{ ...b2b, address: { ...address, buildingNumber: '12' } }, 'address.buildingNumber'],
      [{ ...b2b, address: { ...address, country: 'sa' } }, 'address.country'],
      [{ ...b2b, address: { street: 'x' } }, 'address.city'],
      [{ ...b2b, legalName: { ar: '', en: 'x' } }, 'legalName.ar'],
      [{ ...b2b, buyerType: 'b3b' }, 'buyerType'],
    ];
    for (const [body, field] of cases) {
      const r = await put(body);
      expect(r.statusCode, field).toBe(422);
      expect(
        (r.json().errors as { field: string }[]).map((e) => e.field),
        field,
      ).toContain(field);
    }
    // a b2c buyer needs only names; numbers are optional
    expect(
      (await put({ buyerType: 'b2c', legalName: { ar: 'فرد', en: 'Individual' } })).statusCode,
    ).toBe(200);
  });

  it('keeps personal values out of the audit trail and is tenant isolated', async () => {
    const rows = [
      ...(await audits(orgA, 'invoicing.tax_profile.created')),
      ...(await audits(orgA, 'invoicing.tax_profile.updated')),
    ];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(rows)).not.toContain(VAT);
    expect(JSON.stringify(rows)).not.toContain('Horizon');
    expect((await call('bob', 'GET', '/v1/billing/tax-profile', undefined, orgB)).statusCode).toBe(
      404,
    ); // B has none; A's is invisible
    expect(
      (
        await h.env.app.withOrg(orgB, (c) =>
          c.query(`SELECT count(*)::int n FROM invoicing.tax_profiles`),
        )
      ).rows[0]!.n,
    ).toBe(0);
    expect(
      (await call('carol', 'GET', '/v1/billing/tax-profile', undefined, orgB)).statusCode,
    ).toBe(404); // not a member of B
  });
});

describe('platform configuration (rates, entities)', () => {
  it('the seed has the standard rate flagged [VERIFY] and a placeholder entity that carries no registration numbers', async () => {
    const rates = await h.env.sql(
      `SELECT code, rate_bps, scope, verify FROM invoicing.tax_rates ORDER BY code`,
    );
    expect(rates.find((r) => r.code === 'SA-VAT-STD')).toMatchObject({
      rate_bps: 1500,
      scope: 'domestic',
      verify: true,
    });
    expect(rates.every((r) => r.verify)).toBe(true);
    const ent = (await h.env.sql(`SELECT * FROM invoicing.billing_entities`))[0]!;
    expect(ent).toMatchObject({
      placeholder: true,
      vat_number: null,
      cr_number: null,
      invoice_series: 'NZM',
    });
    expect(ent.legal_name_en).toContain('PLACEHOLDER-NOT-REGISTERED');
    await expect(
      h.env.sql(`UPDATE invoicing.billing_entities SET vat_number = '300000000000003'`),
    ).rejects.toThrow(/check/i);
  });
  it('rate periods cannot overlap, and no runtime role can change rates or entities', async () => {
    await expect(
      h.env.sql(
        `INSERT INTO invoicing.tax_rates (id, code, rate_bps, scope, valid_from) VALUES (gen_random_uuid(), 'DUP', 500, 'domestic', '2026-01-01')`,
      ),
    ).rejects.toThrow(/tax_rates_no_overlap|conflicting/i);
    for (const role of ['app', 'worker'] as const) {
      const db = h.env[role];
      await expect(
        db.withOrg(orgA, (c) =>
          c.query(
            `INSERT INTO invoicing.tax_rates (id, code, rate_bps, scope, valid_from) VALUES (gen_random_uuid(), 'X', 1, 'zero', '2030-01-01')`,
          ),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.withOrg(orgA, (c) => c.query(`UPDATE invoicing.tax_rates SET rate_bps = 0`)),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.withOrg(orgA, (c) =>
          c.query(`UPDATE invoicing.billing_entities SET status = 'retired'`),
        ),
      ).rejects.toThrow(/permission denied/);
    }
  });
});

describe('TaxService (profile + effective-dated rates)', () => {
  const tax = () => app.get(TaxService);
  it('a b2c buyer without a profile pays the standard rate; per-line tax sums to the total', async () => {
    const r = await tax().estimate(
      orgB,
      [1001n, 3n, 10n],
      new Date('2026-11-17T10:00:00Z'),
      'domestic',
    );
    expect(r).toMatchObject({
      status: 'computed',
      rateCode: 'SA-VAT-STD',
      rateBps: 1500,
      taxMinor: 152n,
      reviewRequired: false,
    });
    expect(r.perLineTaxMinor).toEqual([150n, 0n, 2n]);
    expect(r.reasons).toEqual(['rate_unverified']);
  });
  it('an unknown scope is standard-rated AND flagged; a foreign buyer is flagged', async () => {
    const unknown = await tax().estimate(orgB, [100n], new Date('2026-11-17T10:00:00Z'), null);
    expect(unknown).toMatchObject({ rateBps: 1500, reviewRequired: true });
    expect(unknown.reasons).toContain('scope_not_configured');
    await app
      .get(TaxProfileService)
      .put(
        orgB,
        ids.bob!,
        { buyerType: 'b2c', legalName: { ar: 'أجنبي', en: 'Foreign' }, address: { country: 'AE' } },
        null,
      );
    const foreign = await tax().estimate(
      orgB,
      [100n],
      new Date('2026-11-17T10:00:00Z'),
      'domestic',
    );
    expect(foreign.reviewRequired).toBe(true);
    expect(foreign.reasons).toContain('buyer_outside_jurisdiction');
  });
  it('a configured zero scope is 0 and not flagged; a date before any rate is an error', async () => {
    expect(
      await tax().estimate(orgA, [100n], new Date('2026-11-17T10:00:00Z'), 'zero'),
    ).toMatchObject({ rateBps: 0, taxMinor: 0n, reviewRequired: false });
    await expect(
      tax().estimate(orgA, [100n], new Date('2010-01-01T00:00:00Z'), 'domestic'),
    ).rejects.toMatchObject({ code: 'service_unavailable' });
  });
});

describe('gapless invoice sequences (AC-M03-05)', () => {
  const entity = async () =>
    (await h.env.sql(`SELECT id FROM invoicing.billing_entities WHERE code = 'nuzm'`))[0]!
      .id as string;
  const take = (e: string, series: string) =>
    h.env.app.withOrg(
      orgA,
      async (c) =>
        (
          await c.query<{ n: string }>(`SELECT invoicing.allocate_number($1, $2)::text n`, [
            e,
            series,
          ])
        ).rows[0]!.n,
    );

  it('200 concurrent allocations give exactly 1..200, each once', async () => {
    const e = await entity();
    const got = await Promise.all(Array.from({ length: 200 }, () => take(e, 'NZM')));
    expect(new Set(got).size).toBe(200);
    expect(got.map(Number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 200 }, (_, i) => i + 1),
    );
  });
  it('a rolled-back issue gives its number back: no gap', async () => {
    const e = await entity();
    await expect(
      h.env.app.withOrg(orgA, async (c) => {
        await c.query(`SELECT invoicing.allocate_number($1, 'NZM')`, [e]);
        throw new Error('issue failed after taking a number');
      }),
    ).rejects.toThrow(/issue failed/);
    expect(await take(e, 'NZM')).toBe('201'); // 200 allocated above; the rolled-back one did not consume 201
  });
  it('series are independent, the formatted number is zero-padded, and the entity must exist and be active', async () => {
    const e = await entity();
    expect(await take(e, 'TST')).toBe('1');
    expect(await take(e, 'TST')).toBe('2');
    await h.env.app.withOrg(orgA, async (c) => {
      expect((await app.get(SequenceService).next(c, e, 'ABC')).formatted).toBe('ABC-00000001');
    });
    await expect(take('00000000-0000-4000-8000-000000000000', 'NZM')).rejects.toThrow(
      /unknown or retired/,
    );
    await expect(
      h.env.app.withOrg(orgA, (c) => app.get(SequenceService).next(c, e, 'bad')),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
  it('runtime roles cannot touch the counters directly', async () => {
    for (const role of ['app', 'worker'] as const) {
      await expect(
        h.env[role].withOrg(orgA, (c) =>
          c.query(`UPDATE invoicing.invoice_sequences SET next_value = 1`),
        ),
      ).rejects.toThrow();
      await expect(
        h.env[role].withOrg(orgA, (c) => c.query(`SELECT * FROM invoicing.invoice_sequences`)),
      ).rejects.toThrow(/permission denied/);
    }
  });
});
