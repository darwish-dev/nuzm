import { buildBody } from './ubl';
import type { ZatcaDocument } from './build-document';
import type { ZatcaProfile } from './profile';
import { UUID } from '@nuzm/domain';

/**
 * Local validation harness (docs/11 §5). Two layers:
 *  1. STRUCTURAL rules of the synthetic profile (this file): totals, VAT-number format, required parties, chain fields, XML equals the model.
 *  2. Official XSD/Schematron validation: NOT AVAILABLE. The slot is `OfficialValidator`; it stays empty until the owner supplies the official
 *     artifacts (HG-03-03), and every result here says so. A document that passes layer 1 is NOT claimed to be ZATCA-valid.
 */
export interface Issue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}
export interface ValidationResult {
  valid: boolean;
  issues: Issue[];
  /** Always true today: no official schema or Schematron is available. */
  notVerifiedVsZatca: boolean;
}
/** Plug-in point for the official XSD/Schematron validation (empty until HG-03-03 delivers the artifacts). */
export interface OfficialValidator {
  validate(xml: string): Promise<Issue[]>;
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const halfUp = (a: bigint, b: bigint) => (a * 2n + b) / (2n * b);

export function validateDocument(
  p: ZatcaProfile,
  d: ZatcaDocument,
  o: { now?: Date; xmlBody?: string } = {},
): ValidationResult {
  const issues: Issue[] = [];
  const err = (code: string, message: string) => issues.push({ severity: 'error', code, message });
  const warn = (code: string, message: string) =>
    issues.push({ severity: 'warning', code, message });

  if (d.currency !== p.currency) err('currency', `currency must be ${p.currency}`);
  if (!UUID.test(d.uuid)) err('uuid', 'uuid is not a UUID');
  if (d.icv < 1n) err('icv', 'icv must be at least 1');
  if (!B64.test(d.pih) || ![44, 88].includes(d.pih.length))
    err('pih', 'pih must be a base64 SHA-256 hash (or the first-document seed form)');
  if (!d.number || d.number.length > 60) err('number', 'document number is required');
  if (o.now && d.issuedAt.getTime() > o.now.getTime() + 60_000)
    err('issue_date', 'issue date is in the future');

  if (!d.seller.nameEn) err('seller_name', 'seller name is required');
  if (!d.seller.vatNumber)
    err('seller_vat_missing', 'seller VAT number is required (billing entity data, HG-03-01)');
  else if (!p.vatNumberPattern.test(d.seller.vatNumber))
    err('seller_vat_format', 'seller VAT number does not match the configured format');
  if (d.subtype === 'standard') {
    if (!d.buyer.nameEn) err('buyer_name', 'a standard tax invoice needs the buyer name');
    if (!d.buyer.vatNumber)
      err('buyer_vat_missing', 'a standard tax invoice needs the buyer VAT number');
    else if (!p.vatNumberPattern.test(d.buyer.vatNumber))
      err('buyer_vat_format', 'buyer VAT number does not match the configured format');
    if (!d.buyer.address.city)
      err('buyer_address', 'a standard tax invoice needs the buyer address');
  }
  if ((d.type === 'credit_note' || d.type === 'debit_note') && !d.reference)
    err('reference', 'a credit or debit note must reference the original invoice');
  if (d.type === 'invoice' && d.reference)
    err('reference', 'an invoice does not reference another document');

  if (d.lines.length < 1) err('lines', 'at least one line is required');
  let net = 0n;
  let tax = 0n;
  for (const l of d.lines) {
    if (l.netMinor < 0n || l.taxMinor < 0n)
      err('line_amount', `line ${l.id} has a negative amount`);
    if (!/^\d+(\.\d{1,8})?$/.test(l.quantity))
      err('line_quantity', `line ${l.id} has an invalid quantity`);
    if (l.rateBps < 0 || l.rateBps > 10_000) err('line_rate', `line ${l.id} has an invalid rate`);
    else if (l.netMinor > 0n && halfUp(l.netMinor * BigInt(l.rateBps), 10_000n) !== l.taxMinor)
      warn(
        'tax_rounding',
        `line ${l.id}: tax differs from net × rate rounded half-up (the configured rounding rule may differ; pin to the official guidance [VERIFY])`,
      );
    net += l.netMinor;
    tax += l.taxMinor;
  }
  if (d.totals.netMinor !== net) err('total_net', 'document net total is not the sum of the lines');
  if (d.totals.taxMinor !== tax) err('total_tax', 'document tax total is not the sum of the lines');
  if (d.totals.totalMinor !== d.totals.netMinor + d.totals.taxMinor)
    err('total_gross', 'document total is not net + tax');

  if (o.xmlBody !== undefined && o.xmlBody !== buildBody(p, d))
    err('xml_model_mismatch', 'the XML does not match the document model');
  warn(
    'official_validation_unavailable',
    'no official XSD/Schematron is available (HG-03-03): this result is NOT VERIFIED vs ZATCA',
  );
  return { valid: !issues.some((i) => i.severity === 'error'), issues, notVerifiedVsZatca: true };
}
