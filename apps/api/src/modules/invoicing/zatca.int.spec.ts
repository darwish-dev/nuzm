import 'reflect-metadata';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { CreditNoteService, InvoiceService, ZatcaDocumentService } from './index';
import { ArchiveCorrupt } from './internal/zatca/archive';
import { documentHash, firstPih } from './internal/zatca/hash-chain';
import { decodeTlv } from './internal/zatca/qr-tlv';
import { DevFileVault, verifySignature } from './internal/zatca/signing';
import { stripStamp } from './internal/zatca/ubl';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
type Row = Record<string, any>;

const tmp = mkdtempSync(join(tmpdir(), 'zatca-int-'));
process.env.ZATCA_MODE = 'sandbox';
process.env.ZATCA_ARCHIVE_DIR = join(tmp, 'archive');
process.env.ZATCA_DEV_VAULT_DIR = join(tmp, 'vault');

const VAT = '300000000000003';
const h = new Harness();
let app: App;
let orgA = '';
let orgB = '';
let entity = '';
const ids: Record<string, string> = {};
const jars: Record<string, Record<string, string>> = {};
let seq = 0;

const sql = (q: string, p: unknown[] = []) => h.env.sql(q, p) as Promise<Row[]>;
const count = async (q: string, p: unknown[] = []) => Number((await sql(q, p))[0]!.n);
const svc = () => app.get(ZatcaDocumentService);
const vault = () => new DevFileVault(process.env.ZATCA_DEV_VAULT_DIR);
const mkInvoice = async (org: string, net = '10000') => {
  const n = ++seq;
  const r = await app.get(InvoiceService).issueSubscriptionCharge(org, {
    sourceKey: `zt-${n}`,
    currency: 'SAR',
    periodStart: '2026-11-01',
    periodEnd: '2026-11-30',
    lines: [
      {
        description: `Fee ${n} & more`,
        quantity: '1',
        unit: 'subscription_period',
        netMinor: net,
        meterId: null,
        sourceId: `zt-line-${n}`,
      },
    ],
  });
  return r.invoice.id;
};

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  for (const n of ['alice', 'bob']) {
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
  orgA = await mk('alice', 'Zatca A');
  orgB = await mk('bob', 'Zatca B');
  // a registered seller for the TEST database (the seeded entity is a placeholder: HG-03-01)
  entity = (
    await sql(
      `SELECT id FROM invoicing.billing_entities WHERE status = 'active' ORDER BY created_at LIMIT 1`,
    )
  )[0]!.id;
  await sql(
    `UPDATE invoicing.billing_entities SET placeholder = false, vat_number = $2, cr_number = '1010000001', address = '{"city":"Riyadh","country":"SA","street":"King Fahd Road"}' WHERE id = $1`,
    [entity, VAT],
  );
  // org B is a VAT-registered business buyer
  const put = await app.inject({
    method: 'PUT',
    url: '/v1/billing/tax-profile',
    headers: {
      cookie: cookieHeader(jars.bob!),
      'x-csrf-token': jars.bob!.nuzm_csrf!,
      'x-nuzm-org': orgB,
    },
    payload: {
      buyerType: 'b2b',
      legalName: { ar: 'شركة الأفق', en: 'Horizon Co' },
      vatNumber: VAT,
      crNumber: '1010000000',
      address: {
        street: 'Tahlia',
        buildingNumber: '1234',
        district: 'Olaya',
        city: 'Jeddah',
        postalCode: '12211',
        country: 'SA',
      },
    },
  });
  expect([200, 201], put.body).toContain(put.statusCode);
});
afterAll(async () => {
  await h.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('generation and the chain', () => {
  it('generates a simplified document for a consumer, starting the chain, and validates it (NOT VERIFIED vs ZATCA)', async () => {
    const inv = await mkInvoice(orgA);
    const d = await svc().generate(orgA, { type: 'invoice', id: inv });
    expect(d).toMatchObject({
      environment: 'sandbox',
      sourceType: 'invoice',
      sourceId: inv,
      documentType: 'invoice',
      subtype: 'simplified',
      icv: '1',
      stamped: false,
      archived: false,
      notVerifiedVsZatca: true,
    });
    expect(d.pih).toBe(firstPih(svc().profile));
    const row = (
      await sql(`SELECT xml_body, invoice_hash FROM invoicing.zatca_documents WHERE id = $1`, [
        d.id,
      ])
    )[0]!;
    expect(documentHash(row.xml_body)).toBe(row.invoice_hash);
    expect(row.xml_body).toContain('Fee 1 &amp; more');
    expect(row.xml_body).toContain('<cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>');
    const v = await svc().validateStored(orgA, d.id);
    expect(v).toMatchObject({ valid: true, notVerifiedVsZatca: true });
    expect(
      await count(
        `SELECT count(*)::int n FROM audit.audit_logs WHERE org_id = $1 AND action = 'invoicing.zatca_document.generated'`,
        [orgA],
      ),
    ).toBe(1);
  });

  it('is idempotent: the same legal document gives the same e-invoice, even when generated 5 times at once', async () => {
    const inv = await mkInvoice(orgA);
    const rs = await Promise.all(
      Array.from({ length: 5 }, () => svc().generate(orgA, { type: 'invoice', id: inv })),
    );
    expect(new Set(rs.map((r) => r.id)).size).toBe(1);
    expect(
      await count(`SELECT count(*)::int n FROM invoicing.zatca_documents WHERE source_id = $1`, [
        inv,
      ]),
    ).toBe(1);
  });

  it('a business buyer gets a standard document; the chain continues across organizations; a credit note references its invoice', async () => {
    const inv = await mkInvoice(orgB);
    const d = await svc().generate(orgB, { type: 'invoice', id: inv });
    expect(d.subtype).toBe('standard');
    const prev = (
      await sql(
        `SELECT invoice_hash FROM invoicing.zatca_documents WHERE icv = $1 AND entity_id = $2`,
        [(BigInt(d.icv) - 1n).toString(), entity],
      )
    )[0]!;
    expect(d.pih).toBe(prev.invoice_hash); // the previous document belongs to ANOTHER organization
    const cn = await app.get(CreditNoteService).issue(orgB, null, {
      invoiceId: inv,
      reasonCode: 'billing_error',
      reason: 'duplicate charge',
      sourceKey: 'zt-cn-1',
    });
    const c = await svc().generate(orgB, { type: 'credit_note', id: cn.id });
    expect(c).toMatchObject({ documentType: 'credit_note', subtype: 'standard' });
    expect(BigInt(c.icv)).toBe(BigInt(d.icv) + 1n);
    const body = (
      await sql(`SELECT xml_body FROM invoicing.zatca_documents WHERE id = $1`, [c.id])
    )[0]!.xml_body as string;
    expect(body).toContain('<CreditNote ');
    expect(body).toContain(
      `<cac:InvoiceDocumentReference><cbc:ID>${(await sql(`SELECT number_text FROM invoicing.invoices WHERE id = $1`, [inv]))[0]!.number_text}</cbc:ID>`,
    );
    expect((await svc().validateStored(orgB, c.id)).valid).toBe(true);
  });

  it('20 concurrent generations across two organizations: icv unique and consecutive, no gap, chain intact', async () => {
    const invs = await Promise.all(
      Array.from({ length: 20 }, (_, i) => mkInvoice(i % 2 ? orgA : orgB)),
    );
    const docs = await Promise.all(
      invs.map((id, i) => svc().generate(i % 2 ? orgA : orgB, { type: 'invoice', id })),
    );
    expect(new Set(docs.map((d) => d.icv)).size).toBe(20);
    const chain = await svc().verifyChain(entity, 'sandbox');
    expect(chain.problems).toEqual([]);
    expect(chain.checked).toBe(
      await count(
        `SELECT count(*)::int n FROM invoicing.zatca_documents WHERE entity_id = $1 AND environment = 'sandbox'`,
        [entity],
      ),
    );
    expect(
      Number(
        (
          await sql(
            `SELECT max(icv)::int m FROM invoicing.zatca_documents WHERE entity_id = $1 AND environment = 'sandbox'`,
            [entity],
          )
        )[0]!.m,
      ),
    ).toBe(chain.checked);
    // the counter itself has no gap either
    expect(
      Number(
        (
          await sql(
            `SELECT next_value::int n FROM invoicing.invoice_sequences WHERE entity_id = $1 AND series = 'ICVSBX'`,
            [entity],
          )
        )[0]!.n,
      ),
    ).toBe(chain.checked + 1);
  });

  it('a document that does not validate creates nothing and gives its number back (no gap)', async () => {
    const inv = await mkInvoice(orgA);
    const before = (
      await sql(
        `SELECT next_value::int n FROM invoicing.invoice_sequences WHERE entity_id = $1 AND series = 'ICVSBX'`,
        [entity],
      )
    )[0]!.n;
    const bad = await mkInvoiceWithSeller(orgA, null);
    await expect(svc().generate(orgA, { type: 'invoice', id: bad })).rejects.toMatchObject({
      detail: expect.stringMatching(/seller_vat_missing/),
    });
    expect(
      await count(`SELECT count(*)::int n FROM invoicing.zatca_documents WHERE source_id = $1`, [
        bad,
      ]),
    ).toBe(0);
    expect(
      (
        await sql(
          `SELECT next_value::int n FROM invoicing.invoice_sequences WHERE entity_id = $1 AND series = 'ICVSBX'`,
          [entity],
        )
      )[0]!.n,
    ).toBe(before);
    expect((await svc().generate(orgA, { type: 'invoice', id: inv })).icv).toBe(String(before));
    expect((await svc().verifyChain(entity, 'sandbox')).problems).toEqual([]);
  });

  it('simulation has its own chain; the service is off by default and refuses production', async () => {
    const real: any = svc();
    const sim = new ZatcaDocumentService(
      real.db,
      real.audit,
      real.profile,
      real.archive,
      'simulation',
    );
    const inv = await mkInvoice(orgA);
    const d = await sim.generate(orgA, { type: 'invoice', id: inv });
    expect(d).toMatchObject({ environment: 'simulation', icv: '1' });
    const off = new ZatcaDocumentService(real.db, real.audit, real.profile, real.archive, 'off');
    await expect(off.generate(orgA, { type: 'invoice', id: inv })).rejects.toMatchObject({
      detail: expect.stringMatching(/not enabled/),
    });
    expect(ZatcaDocumentService.modeFromEnv({})).toBe('off');
    expect(() => ZatcaDocumentService.modeFromEnv({ ZATCA_MODE: 'production' })).toThrow(
      /HG-03-03/,
    );
    expect(() => ZatcaDocumentService.modeFromEnv({ ZATCA_MODE: 'live' })).toThrow();
  });

  it('refuses unknown sources and other organizations', async () => {
    await expect(
      svc().generate(orgA, { type: 'invoice', id: crypto.randomUUID() }),
    ).rejects.toMatchObject({ status: 404 });
    const inv = await mkInvoice(orgA);
    await expect(svc().generate(orgB, { type: 'invoice', id: inv })).rejects.toMatchObject({
      status: 404,
    });
    const d = await svc().generate(orgA, { type: 'invoice', id: inv });
    await expect(svc().get(orgB, d.id)).rejects.toMatchObject({ status: 404 });
  });
});

/** An invoice whose seller snapshot has no VAT number: issued while the entity temporarily had none (the snapshot is what the e-invoice uses). */
async function mkInvoiceWithSeller(org: string, vat: string | null): Promise<string> {
  await sql(`UPDATE invoicing.billing_entities SET vat_number = $2 WHERE id = $1`, [entity, vat]);
  try {
    return await mkInvoice(org);
  } finally {
    await sql(`UPDATE invoicing.billing_entities SET vat_number = $2 WHERE id = $1`, [entity, VAT]);
  }
}

describe('stamping and the archive', () => {
  it('stamps once: ECDSA signature over the document hash, QR with the required fields, final XML = body + stamp, WORM copy', async () => {
    const ref = 'vault://dev/zatca/int-key-1';
    await vault().generateTestKey(ref);
    const inv = await mkInvoice(orgA, '25000');
    const d0 = await svc().generate(orgA, { type: 'invoice', id: inv });
    const d = await svc().stamp(orgA, d0.id, vault(), ref);
    expect(d).toMatchObject({ stamped: true, archived: true });
    const row = (await sql(`SELECT * FROM invoicing.zatca_documents WHERE id = $1`, [d.id]))[0]!;
    expect(stripStamp(row.xml_final)).toBe(row.xml_body);
    expect(documentHash(stripStamp(row.xml_final))).toBe(row.invoice_hash);
    expect(
      verifySignature(
        Buffer.from(row.public_key, 'base64'),
        Buffer.from(row.invoice_hash, 'base64'),
        Buffer.from(row.signature, 'base64'),
      ),
    ).toBe(true);
    const tlv = new Map(decodeTlv(row.qr).map((f) => [f.tag, f.value]));
    expect(tlv.get(1)!.toString('utf8')).toBe(
      (
        await sql(`SELECT legal_name_en n FROM invoicing.billing_entities WHERE id = $1`, [entity])
      )[0]!.n,
    );
    expect(tlv.get(2)!.toString()).toBe(VAT);
    expect(tlv.get(3)!.toString()).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(tlv.get(4)!.toString()).toBe('287.50'); // 250.00 + 15% VAT
    expect(tlv.get(5)!.toString()).toBe('37.50');
    expect(tlv.get(6)!.toString()).toBe(row.invoice_hash);
    expect(tlv.get(7)!.toString('base64')).toBe(row.signature);
    expect(tlv.get(8)!.toString('base64')).toBe(row.public_key);
    // archived: the object equals the database copy; stamping again changes nothing
    const file = join(process.env.ZATCA_ARCHIVE_DIR!, row.archive_ref);
    expect(readFileSync(file, 'utf8')).toBe(row.xml_final);
    expect((await svc().stamp(orgA, d.id, vault(), ref)).id).toBe(d.id);
    expect(
      await count(
        `SELECT count(*)::int n FROM audit.audit_logs WHERE org_id = $1 AND action = 'invoicing.zatca_document.stamped' AND resource_id = $2`,
        [orgA, d.id],
      ),
    ).toBe(1);
    expect((await svc().verifyStored(orgA)).problems).toEqual([]);
  });

  it('detects a damaged archive object and rewrites a missing one from the database copy', async () => {
    const ref = 'vault://dev/zatca/int-key-2';
    await vault().generateTestKey(ref);
    const d = await svc().stamp(
      orgA,
      (await svc().generate(orgA, { type: 'invoice', id: await mkInvoice(orgA) })).id,
      vault(),
      ref,
    );
    const row = (
      await sql(`SELECT archive_ref, xml_final FROM invoicing.zatca_documents WHERE id = $1`, [
        d.id,
      ])
    )[0]!;
    const file = join(process.env.ZATCA_ARCHIVE_DIR!, row.archive_ref);
    chmodSync(file, 0o644);
    writeFileSync(file, '<tampered/>');
    await expect(svc().ensureArchived(orgA, d.id)).rejects.toBeInstanceOf(ArchiveCorrupt);
    unlinkSync(file);
    await svc().ensureArchived(orgA, d.id);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(row.xml_final);
  });

  it('the database refuses to edit a stored body, so a stamp always covers the hashed bytes', async () => {
    const ref = 'vault://dev/zatca/int-key-3';
    await vault().generateTestKey(ref);
    const d0 = await svc().generate(orgA, { type: 'invoice', id: await mkInvoice(orgA) });
    await expect(
      sql(`UPDATE invoicing.zatca_documents SET xml_body = xml_body || ' ' WHERE id = $1`, [d0.id]),
    ).rejects.toThrow(/immutable/); // the database refuses the edit
    expect((await svc().stamp(orgA, d0.id, vault(), ref)).stamped).toBe(true);
  });
});

describe('database guards', () => {
  it('the chain is enforced by the database; bodies, stamps and links are immutable; never deleted or truncated', async () => {
    const d = (
      await sql(`SELECT * FROM invoicing.zatca_documents WHERE stamped_at IS NOT NULL LIMIT 1`)
    )[0]!;
    const tip = (
      await sql(`SELECT icv::int i, invoice_hash FROM invoicing.zatca_chain_tip($1, 'sandbox')`, [
        entity,
      ])
    )[0]!;
    const ins = (icv: number, pih: string) =>
      sql(
        `INSERT INTO invoicing.zatca_documents (id, org_id, entity_id, environment, source_type, source_id, document_type, subtype, uuid, icv, pih, invoice_hash, xml_body)
           VALUES (gen_random_uuid(), $1, $2, 'sandbox', 'invoice', gen_random_uuid(), 'invoice', 'simplified', gen_random_uuid(), $3, $4, $5, '<x/>')`,
        [orgA, entity, icv, pih, 'h'.repeat(44)],
      );
    await expect(ins(tip.i + 2, tip.invoice_hash)).rejects.toThrow(/icv must continue the chain/);
    await expect(ins(tip.i + 1, 'x'.repeat(44))).rejects.toThrow(
      /pih must be the previous document hash/,
    );
    await expect(
      sql(`UPDATE invoicing.zatca_documents SET invoice_hash = $2 WHERE id = $1`, [
        d.id,
        'y'.repeat(44),
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql(`UPDATE invoicing.zatca_documents SET signature = 'AAAA' WHERE id = $1`, [d.id]),
    ).rejects.toThrow(/re-stamped/);
    await expect(
      sql(
        `UPDATE invoicing.zatca_documents SET archive_ref = 'other/ref.xml', archive_sha256 = 'z' WHERE id = $1`,
        [d.id],
      ),
    ).rejects.toThrow(/set once/);
    await expect(
      sql(`DELETE FROM invoicing.zatca_documents WHERE id = $1`, [d.id]),
    ).rejects.toThrow(/never deleted/);
    await expect(sql(`TRUNCATE invoicing.zatca_documents`)).rejects.toThrow(
      /never truncated|cannot truncate/,
    );
  });
});
