import type { DocLine, Party, ZatcaDocument } from './build-document';
import type { ZatcaProfile } from './profile';

/**
 * UBL 2.1 style XML for the SYNTHETIC profile (docs/11 §5). Element names follow the public UBL 2.1 vocabulary; the exact set, order, schemes
 * and extensions that ZATCA requires are NOT VERIFIED (no official documents, HG-03-03).
 *
 * The output is deterministic and compact (no whitespace between elements, fixed attribute order, one escaping), so the same model always yields
 * the same bytes. `buildBody` is the part that is hashed; `assemble` inserts the QR and the signature AFTER hashing, at fixed places, and
 * `stripStamp` removes them again, so a stamped document can always be re-hashed and checked against the chain.
 */
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Minor units → "123.45" (exact; SAR has 2 decimals). */
export const money = (m: bigint): string => {
  const neg = m < 0n;
  const a = neg ? -m : m;
  return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
};
/** Exact decimal string → trimmed (no trailing zeros, at least one digit). */
export const trimDec = (d: string): string => {
  if (!d.includes('.')) return d;
  const t = d.replace(/0+$/, '').replace(/\.$/, '');
  return t === '' ? '0' : t;
};
/** Unit price = net / quantity, exact, 8 decimals half-up, shown with at least 2. Zero quantity → 0.00. */
export function unitPrice(netMinor: bigint, quantity: string): string {
  const [w = '0', f = ''] = quantity.split('.');
  const q = BigInt(w) * 100_000_000n + BigInt(f.padEnd(8, '0').slice(0, 8));
  if (q === 0n) return '0.00';
  const scaled = (netMinor * 10n ** 14n * 2n + q) / (2n * q); // price × 10^8, half-up
  const s =
    `${scaled / 100_000_000n}.${(scaled % 100_000_000n).toString().padStart(8, '0')}`.replace(
      /0+$/,
      '',
    );
  return s.endsWith('.') ? `${s}00` : /\.\d$/.test(s) ? `${s}0` : s;
}
const cbc = (name: string, value: string, attrs = '') =>
  `<cbc:${name}${attrs}>${esc(value)}</cbc:${name}>`;
const amt = (name: string, m: bigint, cur: string) => cbc(name, money(m), ` currencyID="${cur}"`);

export const localParts = (p: ZatcaProfile, at: Date): { date: string; time: string } => {
  const l = new Date(at.getTime() + p.issueTimeOffsetHours * 3_600_000);
  const iso = l.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
};

const address = (a: Party['address']) =>
  `<cac:PostalAddress>${a.street ? cbc('StreetName', a.street) : ''}${a.building ? cbc('BuildingNumber', a.building) : ''}${a.district ? cbc('CitySubdivisionName', a.district) : ''}${a.city ? cbc('CityName', a.city) : ''}${a.postalCode ? cbc('PostalZone', a.postalCode) : ''}<cac:Country>${cbc('IdentificationCode', a.country ?? 'SA')}</cac:Country></cac:PostalAddress>`;
const party = (tag: 'AccountingSupplierParty' | 'AccountingCustomerParty', p: Party) =>
  `<cac:${tag}><cac:Party>${p.crNumber ? `<cac:PartyIdentification>${cbc('ID', p.crNumber, ' schemeID="CRN"')}</cac:PartyIdentification>` : ''}${address(p.address)}${p.vatNumber ? `<cac:PartyTaxScheme>${cbc('CompanyID', p.vatNumber)}<cac:TaxScheme>${cbc('ID', 'VAT')}</cac:TaxScheme></cac:PartyTaxScheme>` : ''}<cac:PartyLegalEntity>${cbc('RegistrationName', p.nameEn)}${p.nameAr && p.nameAr !== p.nameEn ? cbc('CompanyLegalForm', p.nameAr) : ''}</cac:PartyLegalEntity></cac:Party></cac:${tag}>`;

const category = (p: ZatcaProfile, rateBps: number) =>
  rateBps > 0 ? p.taxCategories.standard : p.taxCategories.zero;
const percent = (bps: number) => `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}`;
const taxCategory = (
  p: ZatcaProfile,
  bps: number,
  tag: 'TaxCategory' | 'ClassifiedTaxCategory' = 'TaxCategory',
) =>
  `<cac:${tag}>${cbc('ID', category(p, bps))}${cbc('Percent', percent(bps))}<cac:TaxScheme>${cbc('ID', 'VAT')}</cac:TaxScheme></cac:${tag}>`;

const line = (p: ZatcaProfile, d: ZatcaDocument, l: DocLine) => {
  const kind = p.documents[d.type];
  return (
    `<cac:${kind.lineElement}>${cbc('ID', String(l.id))}${cbc(kind.quantityElement, trimDec(l.quantity), ` unitCode="${esc(l.unit)}"`)}` +
    `${amt('LineExtensionAmount', l.netMinor, d.currency)}` +
    `<cac:TaxTotal>${amt('TaxAmount', l.taxMinor, d.currency)}${amt('RoundingAmount', l.netMinor + l.taxMinor, d.currency)}</cac:TaxTotal>` +
    `<cac:Item>${cbc('Name', l.description)}${taxCategory(p, l.rateBps, 'ClassifiedTaxCategory')}</cac:Item>` +
    `<cac:Price>${cbc('PriceAmount', unitPrice(l.netMinor, l.quantity), ` currencyID="${d.currency}"`)}</cac:Price></cac:${kind.lineElement}>`
  );
};

/** Markers of the parts inserted after hashing. */
export const QR_OPEN = '<cac:AdditionalDocumentReference><cbc:ID>QR</cbc:ID>';
export const SIG_OPEN = '<cac:Signature>';

export function buildBody(p: ZatcaProfile, d: ZatcaDocument): string {
  const kind = p.documents[d.type];
  const { date, time } = localParts(p, d.issuedAt);
  const byRate = new Map<number, { net: bigint; tax: bigint }>();
  for (const l of d.lines) {
    const e = byRate.get(l.rateBps) ?? { net: 0n, tax: 0n };
    e.net += l.netMinor;
    e.tax += l.taxMinor;
    byRate.set(l.rateBps, e);
  }
  const subtotals = [...byRate.entries()]
    .sort(([a], [b]) => a - b)
    .map(
      ([bps, e]) =>
        `<cac:TaxSubtotal>${amt('TaxableAmount', e.net, d.currency)}${amt('TaxAmount', e.tax, d.currency)}${taxCategory(p, bps)}</cac:TaxSubtotal>`,
    )
    .join('');
  const ref = d.reference
    ? `<cac:BillingReference><cac:InvoiceDocumentReference>${cbc('ID', d.reference.number)}</cac:InvoiceDocumentReference></cac:BillingReference>${`<cac:PaymentMeans>${cbc('InstructionNote', d.reference.reason)}</cac:PaymentMeans>`}`
    : '';
  return (
    `<?xml version="1.0" encoding="UTF-8"?><${kind.root} xmlns="${kind.namespace}" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">` +
    cbc('ProfileID', p.profileId) +
    cbc('ID', d.number) +
    cbc('UUID', d.uuid) +
    cbc('IssueDate', date) +
    cbc('IssueTime', time) +
    cbc('InvoiceTypeCode', kind.typeCode, ` name="${p.subtypes[d.subtype]}"`) +
    cbc('DocumentCurrencyCode', d.currency) +
    cbc('TaxCurrencyCode', d.currency) +
    ref +
    `<cac:AdditionalDocumentReference>${cbc('ID', 'ICV')}${cbc('UUID', d.icv.toString())}</cac:AdditionalDocumentReference>` +
    `<cac:AdditionalDocumentReference>${cbc('ID', 'PIH')}<cac:Attachment>${cbc('EmbeddedDocumentBinaryObject', d.pih, ' mimeType="text/plain"')}</cac:Attachment></cac:AdditionalDocumentReference>` +
    party('AccountingSupplierParty', d.seller) +
    party('AccountingCustomerParty', d.buyer) +
    `<cac:TaxTotal>${amt('TaxAmount', d.totals.taxMinor, d.currency)}</cac:TaxTotal>` +
    `<cac:TaxTotal>${amt('TaxAmount', d.totals.taxMinor, d.currency)}${subtotals}</cac:TaxTotal>` +
    `<cac:LegalMonetaryTotal>${amt('LineExtensionAmount', d.totals.netMinor, d.currency)}${amt('TaxExclusiveAmount', d.totals.netMinor, d.currency)}${amt('TaxInclusiveAmount', d.totals.totalMinor, d.currency)}${amt('PayableAmount', d.totals.totalMinor, d.currency)}</cac:LegalMonetaryTotal>` +
    d.lines.map((l) => line(p, d, l)).join('') +
    `</${kind.root}>`
  );
}

/** Insert the QR reference and the signature block at their fixed places (right after the PIH reference, and just before the supplier party). */
export function assemble(
  body: string,
  qrBase64: string,
  signatureBase64: string,
  publicKeyBase64: string,
): string {
  const qr = `${QR_OPEN}<cac:Attachment>${cbc('EmbeddedDocumentBinaryObject', qrBase64, ' mimeType="text/plain"')}</cac:Attachment></cac:AdditionalDocumentReference>`;
  const sig = `${SIG_OPEN}${cbc('ID', 'urn:synthetic:signature')}<cac:SignatoryParty><cac:PartyIdentification>${cbc('ID', publicKeyBase64)}</cac:PartyIdentification></cac:SignatoryParty><cac:DigitalSignatureAttachment><cac:ExternalReference>${cbc('URI', signatureBase64)}</cac:ExternalReference></cac:DigitalSignatureAttachment></cac:Signature>`;
  const at = body.indexOf('<cac:AccountingSupplierParty>');
  if (at < 0) throw new Error('not a body produced by buildBody');
  return body.slice(0, at) + qr + sig + body.slice(at);
}

/** Remove the QR and signature blocks again: the result is byte-for-byte the hashed body. */
export function stripStamp(finalXml: string): string {
  let x = finalXml;
  const qs = x.indexOf(QR_OPEN);
  if (qs >= 0) {
    const end = '</cac:AdditionalDocumentReference>';
    const qe = x.indexOf(end, qs) + end.length;
    x = x.slice(0, qs) + x.slice(qe);
  }
  const ss = x.indexOf(SIG_OPEN);
  if (ss >= 0) {
    const end = '</cac:Signature>';
    const se = x.indexOf(end, ss) + end.length;
    x = x.slice(0, ss) + x.slice(se);
  }
  return x;
}
