import fc from 'fast-check';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { ArchiveConflict, ArchiveCorrupt, LocalWormArchive } from './archive';
import { buildDocument, type ZatcaDocument } from './build-document';
import { buildCsr } from './csr';
import { documentHash, firstPih, sha256Base64, verifyChain } from './hash-chain';
import { loadProfile, parseProfile } from './profile';
import { decodeTlv, encodeTlv } from './qr-tlv';
import { DevFileVault, signDocumentHash, sha256, verifySignature } from './signing';
import { assemble, buildBody, money, stripStamp, trimDec, unitPrice } from './ubl';
import { validateDocument } from './validator';

const P = loadProfile();
const tmp = mkdtempSync(join(tmpdir(), 'zatca-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const VAT = '300000000000003';
const seller = {
  legalName: { ar: 'نظم', en: 'Nuzm & Co "Test"' },
  vatNumber: VAT,
  crNumber: '1010000001',
  address: { city: 'Riyadh', country: 'SA', street: 'King <Fahd>' },
};
const buyerB2b = {
  buyerType: 'b2b',
  legalName: { ar: 'شركة الأفق', en: 'Horizon Co' },
  vatNumber: VAT,
  address: { city: 'Jeddah' },
};
const buyerB2c = {
  buyerType: 'b2c',
  legalName: { ar: 'فرد', en: 'Person' },
  vatNumber: null,
  address: {},
};
const lines = [
  {
    quantity: '2',
    unit: 'subscription_period',
    description: 'Subscription starter × 2',
    netMinor: '6000',
    taxMinor: '900',
    rateBps: 1500,
  },
  {
    quantity: '1.5',
    unit: 'gib_month',
    description: 'Usage storage',
    netMinor: '1001',
    taxMinor: '150',
    rateBps: 1500,
  },
];
const doc = (over: Partial<Parameters<typeof buildDocument>[1]> = {}): ZatcaDocument =>
  buildDocument(P, {
    type: 'invoice',
    number: 'NZ-00000001',
    uuid: '0f4c6e5a-8b3d-4a64-9a5e-3f0c2f1b7d11',
    icv: 1n,
    pih: firstPih(P),
    issuedAt: new Date('2026-11-17T21:30:15Z'),
    currency: 'SAR',
    seller,
    buyer: buyerB2b,
    lines,
    reference: null,
    ...over,
  });

describe('profile', () => {
  it('loads the synthetic profile and says so', () => {
    expect(P.synthetic).toBe(true);
    expect(P.profile).toBe('SYNTHETIC-NOT-OFFICIAL');
    expect(P.subtypes.standard).toHaveLength(7);
  });
  it('refuses a malformed profile', () => {
    expect(() => parseProfile('x: 1')).toThrow(/documents/);
    expect(() => parseProfile('')).toThrow(/not a mapping/);
  });
});

describe('money and decimals', () => {
  it('formats minor units exactly', () => {
    expect(money(0n)).toBe('0.00');
    expect(money(5n)).toBe('0.05');
    expect(money(123456n)).toBe('1234.56');
    expect(trimDec('1.50000000')).toBe('1.5');
    expect(trimDec('2.00000000')).toBe('2');
    expect(trimDec('0.00000000')).toBe('0');
  });
  it('unit price is net ÷ quantity, exact and half-up', () => {
    expect(unitPrice(6000n, '2')).toBe('30.00');
    expect(unitPrice(1001n, '1.5')).toBe('6.67333333');
    expect(unitPrice(1n, '3')).toBe('0.00333333');
    expect(unitPrice(100n, '0')).toBe('0.00');
  });
  it('property (10,000 runs): minor units never lose a digit', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        (m) => BigInt(money(m).replace('.', '')) === m,
      ),
      { numRuns: 10_000 },
    );
  });
});

describe('hash chain', () => {
  it('the first PIH is base64 of the hex SHA-256 of the seed', () => {
    const f = firstPih(P);
    expect(f).toHaveLength(88);
    expect(f.startsWith('NWZlY2Vi')).toBe(true);
    expect(Buffer.from(f, 'base64').toString()).toMatch(/^[0-9a-f]{64}$/);
  });
  const link = (icv: bigint, pih: string, hash: string) => ({ icv, pih, invoiceHash: hash });
  it('accepts a proper chain', () => {
    const a = sha256Base64('a');
    const b = sha256Base64('b');
    expect(
      verifyChain([link(1n, firstPih(P), a), link(2n, a, b), link(3n, b, sha256Base64('c'))], P),
    ).toEqual([]);
    expect(verifyChain([], P)).toEqual([]);
  });
  it('reports every kind of break', () => {
    const a = sha256Base64('a');
    const b = sha256Base64('b');
    const kinds = (l: ReturnType<typeof link>[], re?: Map<bigint, string>) =>
      verifyChain(l, P, re).map((p) => p.problem);
    expect(kinds([link(2n, firstPih(P), a)])).toEqual(['first_icv']);
    expect(kinds([link(1n, a, a)])).toEqual(['first_pih']);
    expect(kinds([link(1n, firstPih(P), a), link(3n, a, b)])).toEqual(['gap']);
    expect(kinds([link(1n, firstPih(P), a), link(1n, a, b)])).toEqual(['duplicate']);
    expect(kinds([link(1n, firstPih(P), a), link(2n, b, b)])).toEqual(['pih_mismatch']);
    expect(kinds([link(1n, firstPih(P), a)], new Map([[1n, b]]))).toEqual(['hash_mismatch']);
  });
});

describe('QR TLV', () => {
  it('round-trips fields (including Arabic text and binary)', () => {
    const f = [
      { tag: 1, value: Buffer.from('شركة نظم', 'utf8') },
      { tag: 2, value: Buffer.from(VAT) },
      { tag: 7, value: Buffer.from([0, 255, 128, 3]) },
    ];
    const back = decodeTlv(encodeTlv(f));
    expect(back.map((x) => x.tag)).toEqual([1, 2, 7]);
    expect(back[0]!.value.toString('utf8')).toBe('شركة نظم');
    expect([...back[2]!.value]).toEqual([0, 255, 128, 3]);
  });
  it('refuses oversized values, bad tags and truncated input', () => {
    expect(() => encodeTlv([{ tag: 1, value: Buffer.alloc(256) }])).toThrow(/255/);
    expect(() => encodeTlv([{ tag: 0, value: Buffer.alloc(1) }])).toThrow(/tag/);
    expect(() => decodeTlv(Buffer.from([1, 5, 65]).toString('base64'))).toThrow(/truncated/);
  });
  it('property (10,000 runs): decode(encode(x)) = x', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            tag: fc.integer({ min: 1, max: 255 }),
            value: fc.uint8Array({ maxLength: 255 }).map((u) => Buffer.from(u)),
          }),
          { maxLength: 9 },
        ),
        (fields) => {
          const back = decodeTlv(encodeTlv(fields));
          return (
            back.length === fields.length &&
            back.every((b, i) => b.tag === fields[i]!.tag && b.value.equals(fields[i]!.value))
          );
        },
      ),
      { numRuns: 10_000 },
    );
  });
});

describe('UBL body', () => {
  it('is deterministic, compact and escapes everything it prints', () => {
    const a = buildBody(P, doc());
    expect(buildBody(P, doc())).toBe(a);
    expect(a).not.toMatch(/>\s+</);
    expect(a).toContain('Nuzm &amp; Co &quot;Test&quot;');
    expect(a).toContain('King &lt;Fahd&gt;');
    expect(a).toContain('<cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>');
    expect(a).toContain('<cbc:IssueDate>2026-11-18</cbc:IssueDate>'); // 21:30 UTC is 00:30 the next day at +03
    expect(a).toContain('<cbc:IssueTime>00:30:15</cbc:IssueTime>');
    expect(a).toContain(
      '<cbc:LineExtensionAmount currencyID="SAR">70.01</cbc:LineExtensionAmount>',
    );
    expect(a).toContain('<cbc:PayableAmount currencyID="SAR">80.51</cbc:PayableAmount>');
    expect(a).toContain('<cbc:InvoicedQuantity unitCode="gib_month">1.5</cbc:InvoicedQuantity>');
  });
  it('simplified for a consumer, credit note with its reference and root element', () => {
    expect(buildBody(P, doc({ buyer: buyerB2c }))).toContain('name="0200000"');
    const cn = buildBody(
      P,
      doc({ type: 'credit_note', reference: { number: 'NZ-00000001', reason: 'duplicate' } }),
    );
    expect(cn).toContain('<CreditNote ');
    expect(cn).toContain('<cbc:InvoiceTypeCode name="0100000">381</cbc:InvoiceTypeCode>');
    expect(cn).toContain(
      '<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>NZ-00000001</cbc:ID>',
    );
    expect(cn).toContain('<cac:CreditNoteLine>');
  });
  it('a different model gives a different hash (every field that matters is in the body)', () => {
    const base = documentHash(buildBody(P, doc()));
    const variants = [
      doc({ number: 'NZ-00000002' }),
      doc({ icv: 2n }),
      doc({ pih: sha256Base64('x') }),
      doc({ buyer: buyerB2c }),
      doc({ lines: lines.slice(0, 1) }),
      doc({ issuedAt: new Date('2026-11-17T21:30:16Z') }),
      doc({ uuid: '1f4c6e5a-8b3d-4a64-9a5e-3f0c2f1b7d11' }),
      doc({ lines: [{ ...lines[0]!, description: 'Subscription starter × 3' }, lines[1]!] }),
    ];
    for (const v of variants) expect(documentHash(buildBody(P, v))).not.toBe(base);
  });
  it('stamping is removable: strip(assemble(body)) is byte-for-byte the hashed body', () => {
    const b = buildBody(P, doc());
    const final = assemble(b, 'UVI=', 'c2ln', 'a2V5');
    expect(final).not.toBe(b);
    expect(final).toContain('<cbc:ID>QR</cbc:ID>');
    expect(stripStamp(final)).toBe(b);
    expect(documentHash(stripStamp(final))).toBe(documentHash(b));
    expect(stripStamp(b)).toBe(b);
  });
  it('property (1,000 runs): any description and amounts survive escaping and stamping', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 60 }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        (desc, net) => {
          const d = doc({
            lines: [
              {
                quantity: '1',
                unit: 'u',
                description: desc || 'x',
                netMinor: net.toString(),
                taxMinor: ((net * 15n) / 100n).toString(),
                rateBps: 1500,
              },
            ],
          });
          const b = buildBody(P, d);
          return stripStamp(assemble(b, 'QQ==', 'Qg==', 'Qw==')) === b;
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('validator (structural rules of the synthetic profile; never claims ZATCA validity)', () => {
  const codes = (d: ZatcaDocument, o = {}) =>
    validateDocument(P, d, o)
      .issues.filter((i) => i.severity === 'error')
      .map((i) => i.code);
  it('a good document is valid but always NOT VERIFIED vs ZATCA', () => {
    const r = validateDocument(P, doc(), {
      xmlBody: buildBody(P, doc()),
      now: new Date('2026-11-18T00:00:00Z'),
    });
    expect(r.valid).toBe(true);
    expect(r.notVerifiedVsZatca).toBe(true);
    expect(r.issues.map((i) => i.code)).toContain('official_validation_unavailable');
  });
  it('refuses missing or malformed seller and buyer data', () => {
    expect(codes(doc({ seller: { ...seller, vatNumber: null } }))).toContain('seller_vat_missing');
    expect(codes(doc({ seller: { ...seller, vatNumber: '12345' } }))).toContain(
      'seller_vat_format',
    );
    expect(codes(doc({ buyer: { ...buyerB2b, vatNumber: '12345' } }))).toContain(
      'buyer_vat_format',
    );
    expect(codes(doc({ buyer: { ...buyerB2b, address: {} } }))).toContain('buyer_address');
    expect(codes(doc({ buyer: buyerB2c }))).toEqual([]); // simplified needs no buyer VAT
  });
  it('credit notes need a reference, invoices must not have one', () => {
    expect(() => doc({ type: 'credit_note' })).toThrow(
      expect.objectContaining({ detail: expect.stringMatching(/reference/) }),
    );
    expect(codes({ ...doc(), reference: { number: 'x', reason: 'y' } })).toContain('reference');
  });
  it('detects tampered totals, a stale XML and a future date', () => {
    const d = doc();
    expect(
      codes({ ...d, totals: { ...d.totals, totalMinor: d.totals.totalMinor + 1n } }),
    ).toContain('total_gross');
    expect(codes({ ...d, totals: { ...d.totals, netMinor: 1n } })).toContain('total_net');
    expect(codes(d, { xmlBody: buildBody(P, doc({ number: 'OTHER' })) })).toContain(
      'xml_model_mismatch',
    );
    expect(codes(d, { now: new Date('2026-01-01T00:00:00Z') })).toContain('issue_date');
  });
  it('flags a tax amount that is not net × rate rounded half-up as a warning', () => {
    const r = validateDocument(P, doc({ lines: [{ ...lines[0]!, taxMinor: '901' }] }));
    expect(r.issues.find((i) => i.code === 'tax_rounding')?.severity).toBe('warning');
  });
  it('refuses other currencies at build time', () => {
    expect(() => doc({ currency: 'USD' })).toThrow(
      expect.objectContaining({ detail: expect.stringMatching(/SAR/) }),
    );
  });
});

describe('signing through a vault reference (no key ever leaves the vault)', () => {
  const vault = new DevFileVault(join(tmp, 'vault'));
  const ref = 'vault://dev/zatca/test-key-1';
  it('signs a document hash and the signature verifies with the public key only', async () => {
    await vault.generateTestKey(ref);
    const hash = documentHash(buildBody(P, doc()));
    const { signature, publicKey } = await signDocumentHash(vault, ref, hash);
    expect(
      verifySignature(
        Buffer.from(publicKey, 'base64'),
        Buffer.from(hash, 'base64'),
        Buffer.from(signature, 'base64'),
      ),
    ).toBe(true);
    expect(
      verifySignature(
        Buffer.from(publicKey, 'base64'),
        sha256('other'),
        Buffer.from(signature, 'base64'),
      ),
    ).toBe(false);
    expect(Object.keys(await signDocumentHash(vault, ref, hash)).sort()).toEqual([
      'publicKey',
      'signature',
    ]);
  });
  it('refuses to overwrite a key, odd references, wrong digests and a production profile', async () => {
    await expect(vault.generateTestKey(ref)).rejects.toThrow(/already exists/);
    await expect(
      vault.sign('vault://dev/zatca/../../etc/passwd', Buffer.alloc(32)),
    ).rejects.toThrow(/reference/);
    await expect(vault.sign('/tmp/key.pem', Buffer.alloc(32))).rejects.toThrow(/reference/);
    await expect(vault.sign(ref, Buffer.alloc(31))).rejects.toThrow(/32-byte/);
    expect(() => new DevFileVault(join(tmp, 'v2'), { NODE_ENV: 'production' })).toThrow(
      /production/,
    );
    expect(await vault.exists('vault://dev/zatca/missing-key')).toBe(false);
  });
});

describe('CSR (PKCS#10, test artifact)', () => {
  const vault = new DevFileVault(join(tmp, 'vault-csr'));
  const ref = 'vault://dev/zatca/csr-key';
  // a tiny DER reader: enough to take the CSR apart and check its signature
  const read = (b: Buffer, at = 0) => {
    const tag = b[at]!;
    let len = b[at + 1]!;
    let hdr = 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + b[at + 2 + i]!;
      hdr = 2 + n;
    }
    return { tag, hdr, len, end: at + hdr + len, body: b.subarray(at + hdr, at + hdr + len) };
  };
  it('is a well-formed CSR whose signature verifies with the embedded public key', async () => {
    await vault.generateTestKey(ref);
    const { der, pem } = await buildCsr(vault, ref, {
      commonName: 'EGS1-TEST',
      organization: 'Nuzm Test',
      organizationalUnit: 'Riyadh',
      country: 'SA',
      serialNumber: '1-Nuzm|2-EGS1|3-abc',
    });
    expect(pem).toMatch(/^-----BEGIN CERTIFICATE REQUEST-----\n/);
    expect(pem.trim()).toMatch(/-----END CERTIFICATE REQUEST-----$/);
    expect(Buffer.from(pem.split('\n').slice(1, -2).join(''), 'base64').equals(der)).toBe(true);
    const outer = read(der);
    expect(outer.tag).toBe(0x30);
    const info = read(outer.body);
    const alg = read(outer.body, info.end);
    const sig = read(outer.body, alg.end);
    expect(sig.tag).toBe(0x03);
    const infoBytes = outer.body.subarray(0, info.end);
    // the info holds version, subject, SPKI, attributes: pull the SPKI (third element)
    const version = read(info.body);
    const subject = read(info.body, version.end);
    const spki = read(info.body, subject.end);
    const spkiDer = info.body.subarray(subject.end, spki.end);
    expect(subject.body.toString('latin1')).toContain('EGS1-TEST');
    expect(
      verify(
        null,
        sha256(infoBytes),
        { key: createPublicKey({ key: spkiDer, format: 'der', type: 'spki' }), dsaEncoding: 'der' },
        sig.body.subarray(1),
      ),
    ).toBe(true);
    // altering the request breaks the signature
    const tampered = Buffer.from(infoBytes);
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 5) ^ 1, tampered.length - 5);
    expect(
      verify(
        null,
        sha256(tampered),
        { key: createPublicKey({ key: spkiDer, format: 'der', type: 'spki' }), dsaEncoding: 'der' },
        sig.body.subarray(1),
      ),
    ).toBe(false);
  });
  it('validates its inputs', async () => {
    await expect(
      buildCsr(vault, ref, { commonName: 'x', organization: 'y', country: 'Saudi' }),
    ).rejects.toThrow(/two-letter/);
    await expect(
      buildCsr(vault, ref, { commonName: '', organization: 'y', country: 'SA' }),
    ).rejects.toThrow(/commonName/);
  });
});

describe('WORM archive', () => {
  const a = new LocalWormArchive(join(tmp, 'archive'));
  it('writes once, accepts an identical rewrite, refuses different bytes, detects damage and traversal', async () => {
    const put = await a.put('sandbox/e1/0000000001.xml', Buffer.from('<a/>'));
    expect((await a.put('sandbox/e1/0000000001.xml', Buffer.from('<a/>'))).sha256).toBe(put.sha256);
    await expect(a.put('sandbox/e1/0000000001.xml', Buffer.from('<b/>'))).rejects.toBeInstanceOf(
      ArchiveConflict,
    );
    expect((await a.get(put.ref, put.sha256)).toString()).toBe('<a/>');
    await expect(a.get(put.ref, 'f'.repeat(64))).rejects.toBeInstanceOf(ArchiveCorrupt);
    await expect(a.put('../escape.xml', Buffer.from('x'))).rejects.toThrow(/invalid archive key/);
    await expect(a.put('sandbox/../../x.xml', Buffer.from('x'))).rejects.toThrow(
      /invalid archive key/,
    );
    // the object is read-only on disk
    const p = join(tmp, 'archive', 'sandbox/e1/0000000001.xml');
    chmodSync(p, 0o644);
    writeFileSync(p, '<tampered/>');
    await expect(a.get(put.ref, put.sha256)).rejects.toBeInstanceOf(ArchiveCorrupt);
  });
});
