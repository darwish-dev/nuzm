import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeyringFieldCipher } from '../../common/field-crypto';
import { SecretStore } from '../../common/secrets';
import { AuditSink } from '../../common/audit';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { InvoiceService, TaxProfileSealer, TaxProfileService, TaxService } from './index';
import { rulesFromEnv } from './internal/tax-profile.rules';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
type Row = Record<string, any>;
const h = new Harness();
let app: App;
let orgA = '';
let orgB = '';
let orgC = '';
const jars: Record<string, Record<string, string>> = {};
const VAT = '300000000000003';
const address = {
  street: 'King Fahd Road',
  buildingNumber: '1234',
  district: 'Olaya',
  city: 'Riyadh',
  postalCode: '12211',
  country: 'SA',
};
const profile = {
  buyerType: 'b2b',
  legalName: { ar: 'شركة الأفق السرية', en: 'Secret Horizon Co' },
  vatNumber: VAT,
  crNumber: '1010000000',
  address,
};

const call = (
  who: string,
  method: 'GET' | 'PUT',
  url: string,
  body: object | undefined,
  org: string,
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
const mk = async (who: string, name: string) =>
  (
    await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { cookie: cookieHeader(jars[who]!), 'x-csrf-token': jars[who]!.nuzm_csrf! },
      payload: { name },
    })
  ).json().id as string;
const row = async (org: string) =>
  (await h.env.sql(`SELECT * FROM invoicing.tax_profiles WHERE org_id = $1`, [org]))[0] as
    Row | undefined;

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  for (const n of ['alice', 'bob', 'carol'])
    jars[n] = await h.sessionFor(app, await h.createUser(n));
  orgA = await mk('alice', 'Seal A');
  orgB = await mk('bob', 'Seal B');
  orgC = await mk('carol', 'Seal C');
});
afterAll(() => h.close());

describe('a saved tax profile is sealed in the database', () => {
  it('stores only ciphertext: no name, VAT, CR number or address appears in any column', async () => {
    const put = await call('alice', 'PUT', '/v1/billing/tax-profile', profile, orgA);
    expect(put.statusCode).toBe(200);
    const r = (await row(orgA))!;
    expect(r.pii_enc).toMatch(/^enc:v1:dev1:/);
    for (const c of ['legal_name_ar', 'legal_name_en', 'vat_number', 'cr_number', 'address'])
      expect(r[c], c).toBeNull();
    const raw = JSON.stringify(r);
    for (const secret of ['Secret Horizon', 'شركة الأفق', VAT, '1010000000', 'King Fahd', '12211'])
      expect(raw).not.toContain(secret);
    expect(r.buyer_type).toBe('b2b'); // not personal: stays readable for reporting
  });
  it('reads back exactly what was saved, with its ETag', async () => {
    const get = await call('alice', 'GET', '/v1/billing/tax-profile', undefined, orgA);
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject(profile);
    expect(get.headers.etag).toBeTruthy();
  });
  it('a replacement is sealed again with a fresh IV (the ciphertext changes even for the same content)', async () => {
    const before = (await row(orgA))!.pii_enc;
    const get = await call('alice', 'GET', '/v1/billing/tax-profile', undefined, orgA);
    const put = await call('alice', 'PUT', '/v1/billing/tax-profile', profile, orgA, {
      'if-match': get.headers.etag as string,
    });
    expect(put.statusCode).toBe(200);
    const after = (await row(orgA))!;
    expect(after.pii_enc).not.toBe(before);
    expect(after.version).toBe(2);
  });
  it('the audit trail still names fields, never the values', async () => {
    const a = await h.env.sql(
      `SELECT after FROM audit.audit_logs WHERE org_id = $1 AND action LIKE 'invoicing.tax_profile.%'`,
      [orgA],
    );
    expect(a.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(a)).not.toContain('Secret Horizon');
    expect(JSON.stringify(a)).not.toContain(VAT);
  });
});

describe('the database enforces the sealing', () => {
  it('refuses a new plaintext row and a plaintext column beside ciphertext', async () => {
    await expect(
      h.env.sql(
        `INSERT INTO invoicing.tax_profiles (org_id, buyer_type, legal_name_ar, legal_name_en) VALUES ($1,'b2c','x','x')`,
        [orgB],
      ),
    ).rejects.toThrow(/tax_profiles_new_rows_sealed/);
    await expect(
      h.env.sql(`UPDATE invoicing.tax_profiles SET legal_name_en = 'leak' WHERE org_id = $1`, [
        orgA,
      ]),
    ).rejects.toThrow(/no_plaintext_beside_ciphertext/);
    await expect(
      h.env.sql(`UPDATE invoicing.tax_profiles SET pii_enc = 'not sealed' WHERE org_id = $1`, [
        orgA,
      ]),
    ).rejects.toThrow(/new_rows_sealed/);
  });
  it('a sealed value copied to another organization does not open there (bound to its row)', async () => {
    await call(
      'bob',
      'PUT',
      '/v1/billing/tax-profile',
      { ...profile, legalName: { ar: 'ب', en: 'B Co' } },
      orgB,
    );
    const a = (await row(orgA))!.pii_enc;
    await h.env.sql(`UPDATE invoicing.tax_profiles SET pii_enc = $2 WHERE org_id = $1`, [orgB, a]);
    await expect(app.get(TaxProfileService).get(orgB)).rejects.toThrow(/does not open/);
    const b = await call('bob', 'GET', '/v1/billing/tax-profile', undefined, orgB);
    expect(b.statusCode).toBe(500); // never another organization's data, never a silent blank
    await h.env.sql(`UPDATE invoicing.tax_profiles SET pii_enc = $2 WHERE org_id = $1`, [orgB, a]); // (leave B broken; it is not used below)
  });
});

describe('legacy plaintext rows (written before S13d)', () => {
  const legacy = async (org: string) => {
    await h.env.sql(
      `ALTER TABLE invoicing.tax_profiles DROP CONSTRAINT tax_profiles_new_rows_sealed`,
    );
    await h.env.sql(
      `INSERT INTO invoicing.tax_profiles (org_id, buyer_type, legal_name_ar, legal_name_en, vat_number, cr_number, address) VALUES ($1,'b2b','قديم','Legacy Co',$2,'1010000001',$3::jsonb)
       ON CONFLICT (org_id) DO UPDATE SET pii_enc = NULL, legal_name_ar = 'قديم', legal_name_en = 'Legacy Co', vat_number = $2, cr_number = '1010000001', address = $3::jsonb`,
      [org, VAT, JSON.stringify(address)],
    );
    await h.env.sql(
      `ALTER TABLE invoicing.tax_profiles ADD CONSTRAINT tax_profiles_new_rows_sealed CHECK (pii_enc IS NOT NULL AND pii_enc ~ '^enc:v1:[A-Za-z0-9_-]{1,40}:[A-Za-z0-9_-]{38,}$') NOT VALID`,
    );
  };
  it('are still read (profile, tax estimate and invoice buyer snapshot) until the backfill has sealed them', async () => {
    await legacy(orgC);
    expect((await row(orgC))!.pii_enc).toBeNull();
    const g = await call('carol', 'GET', '/v1/billing/tax-profile', undefined, orgC);
    expect(g.json()).toMatchObject({ legalName: { ar: 'قديم', en: 'Legacy Co' }, vatNumber: VAT });
    const est = await app.get(TaxService).estimate(orgC, [10000n]);
    expect(est.status).toBe('computed');
    const inv = (
      await app.get(InvoiceService).issueSubscriptionCharge(orgC, {
        sourceKey: 'seal-1',
        currency: 'SAR',
        periodStart: '2026-11-01',
        periodEnd: '2026-11-30',
        lines: [
          {
            description: 'Fee',
            quantity: '1',
            unit: 'subscription_period',
            netMinor: '10000',
            meterId: null,
            sourceId: 'seal-line-1',
          },
        ],
      })
    ).invoice;
    const snap = (
      await h.env.sql(`SELECT buyer FROM invoicing.invoices WHERE id = $1`, [inv.id])
    )[0]!.buyer;
    expect(snap).toMatchObject({
      buyerType: 'b2b',
      legalName: { en: 'Legacy Co' },
      vatNumber: VAT,
    });
  });
  it('the sealer seals them, keeps version and update time, is idempotent, and then the constraint validates', async () => {
    const before = (await row(orgC))!;
    const sealer = app.get(TaxProfileSealer);
    const r1 = await sealer.run();
    expect(r1.sealed).toBeGreaterThanOrEqual(1);
    const after = (await row(orgC))!;
    expect(after.pii_enc).toMatch(/^enc:v1:dev1:/);
    for (const c of ['legal_name_ar', 'legal_name_en', 'vat_number', 'cr_number', 'address'])
      expect(after[c], c).toBeNull();
    expect(after.version).toBe(before.version);
    expect(String(after.updated_at)).toBe(String(before.updated_at));
    expect(
      (await call('carol', 'GET', '/v1/billing/tax-profile', undefined, orgC)).json(),
    ).toMatchObject({ legalName: { en: 'Legacy Co' }, vatNumber: VAT });
    expect(await sealer.run()).toMatchObject({ sealed: 0, resealed: 0, remainingPlaintext: 0 });
    expect(
      await h.env.sql(
        `SELECT 1 FROM audit.audit_logs WHERE action = 'invoicing.tax_profile.sealed_backfill'`,
      ),
    ).toHaveLength(1);
    await h.env.sql(
      `ALTER TABLE invoicing.tax_profiles VALIDATE CONSTRAINT tax_profiles_new_rows_sealed`,
    );
  });
});

describe('key rotation', () => {
  it('re-seals every profile with the new current key; the new config opens them; once resealed the old key can be retired', async () => {
    await h.env.sql(`DELETE FROM invoicing.tax_profiles WHERE org_id = $1`, [orgB]); // org B was broken on purpose above
    const store = app.get(SecretStore);
    const k2 = await store.put('field-key-k2', randomBytes(32).toString('base64'));
    const both = new KeyringFieldCipher(
      store,
      [
        { id: 'dev1', ref: 'vault://mem/field-key-dev1' },
        { id: 'k2', ref: k2, current: true },
      ],
      true,
    );
    const sealer = new TaxProfileSealer(h.env.app, both, app.get(AuditSink));
    const r = await sealer.run();
    expect(r.resealed).toBeGreaterThanOrEqual(2); // org A and org C
    expect(r).toMatchObject({ remainingPlaintext: 0, remainingOldKey: 0 });
    for (const org of [orgA, orgC]) expect((await row(org))!.pii_enc, org).toMatch(/^enc:v1:k2:/);
    expect(await sealer.run()).toMatchObject({ sealed: 0, resealed: 0 }); // idempotent
    // the service with the rotated key ring returns the same data as before
    const svc = new TaxProfileService(h.env.app, app.get(AuditSink), rulesFromEnv(), both);
    expect(await svc.get(orgA)).toMatchObject({
      legalName: profile.legalName,
      vatNumber: VAT,
      address,
    });
    // the version and the update time were not touched by the re-seal
    expect((await row(orgA))!.version).toBe(2);
    // retire the old key: the resealed values still open, an old-key-only configuration no longer opens anything it should not
    const onlyNew = new KeyringFieldCipher(store, [{ id: 'k2', ref: k2, current: true }], true);
    const svcNew = new TaxProfileService(h.env.app, app.get(AuditSink), rulesFromEnv(), onlyNew);
    expect(await svcNew.get(orgC)).toMatchObject({ legalName: { en: 'Legacy Co' } });
    const onlyOld = new KeyringFieldCipher(
      store,
      [{ id: 'dev1', ref: 'vault://mem/field-key-dev1', current: true }],
      true,
    );
    await expect(
      new TaxProfileService(h.env.app, app.get(AuditSink), rulesFromEnv(), onlyOld).get(orgA),
    ).rejects.toThrow(/unknown field encryption key k2/);
    expect(
      await h.env.sql(
        `SELECT 1 FROM audit.audit_logs WHERE action = 'invoicing.tax_profile.sealed_backfill'`,
      ),
    ).toHaveLength(2);
  });
});
