import { ProblemException } from '../../../../common/errors';
import type { DocType, Subtype, ZatcaProfile } from './profile';

/** A party as it appears on the e-invoice (a snapshot taken when the legal document was issued). */
export interface Party {
  nameAr: string;
  nameEn: string;
  vatNumber: string | null;
  crNumber: string | null;
  address: {
    street?: string;
    building?: string;
    district?: string;
    city?: string;
    postalCode?: string;
    country?: string;
  };
}
export interface DocLine {
  id: number;
  description: string;
  /** Exact decimal string (up to 8 decimals). */
  quantity: string;
  unit: string;
  netMinor: bigint;
  taxMinor: bigint;
  rateBps: number;
}
/** The model every generator step works from: XML, hash, QR and validation are all functions of this and nothing else. */
export interface ZatcaDocument {
  type: DocType;
  subtype: Subtype;
  /** Human document number (the legal number on the invoice). */
  number: string;
  uuid: string;
  icv: bigint;
  pih: string;
  /** UTC instant of issue; the local date/time in the XML are derived with the profile's offset. */
  issuedAt: Date;
  currency: string;
  seller: Party;
  buyer: Party;
  lines: DocLine[];
  totals: { netMinor: bigint; taxMinor: bigint; totalMinor: bigint };
  /** Credit and debit notes: the invoice they correct and why. */
  reference: { number: string; reason: string } | null;
}

type Row = Record<string, unknown>;
const pick = (o: Row | undefined, k: string): string | undefined =>
  typeof o?.[k] === 'string' && (o[k] as string).length ? (o[k] as string) : undefined;

export function partyFrom(snapshot: Row): Party {
  const name = (snapshot.legalName ?? {}) as { ar?: string; en?: string };
  const a = (snapshot.address ?? {}) as Row;
  const address: Party['address'] = {};
  for (const k of ['street', 'district', 'city', 'postalCode', 'country'] as const) {
    const v = pick(a, k);
    if (v) address[k] = v;
  }
  const building = pick(a, 'buildingNumber') ?? pick(a, 'building'); // the tax profile calls it buildingNumber
  if (building) address.building = building;
  return {
    nameAr: name.ar ?? name.en ?? '',
    nameEn: name.en ?? name.ar ?? '',
    vatNumber: (snapshot.vatNumber as string | null) ?? null,
    crNumber: (snapshot.crNumber as string | null) ?? null,
    address,
  };
}

/** Standard tax invoice (B2B) needs a VAT-registered buyer; everything else is simplified (B2C). */
export const subtypeOf = (buyerType: unknown, buyerVat: string | null): Subtype =>
  buyerType === 'b2b' && buyerVat ? 'standard' : 'simplified';

/** Build the document model from an issued invoice or credit note (rows as stored). Pure: no I/O, no clock. */
export function buildDocument(
  p: ZatcaProfile,
  src: {
    type: DocType;
    number: string;
    uuid: string;
    icv: bigint;
    pih: string;
    issuedAt: Date;
    currency: string;
    seller: Row;
    buyer: Row;
    lines: {
      quantity: string;
      unit: string;
      description: string;
      netMinor: string;
      taxMinor: string;
      rateBps: number;
    }[];
    reference?: { number: string; reason: string } | null;
  },
): ZatcaDocument {
  if (src.currency.trim() !== p.currency)
    throw new ProblemException(
      'validation_failed',
      `e-invoices are issued in ${p.currency}; ${src.currency.trim()} is not supported`,
    );
  if (src.lines.length < 1)
    throw new ProblemException('validation_failed', 'a document needs at least one line');
  if ((src.type === 'credit_note' || src.type === 'debit_note') && !src.reference)
    throw new ProblemException(
      'validation_failed',
      'a credit or debit note must reference the original invoice',
    );
  const lines: DocLine[] = src.lines.map((l, i) => ({
    id: i + 1,
    description: l.description,
    quantity: l.quantity,
    unit: l.unit,
    netMinor: BigInt(l.netMinor),
    taxMinor: BigInt(l.taxMinor),
    rateBps: l.rateBps,
  }));
  const net = lines.reduce((s, l) => s + l.netMinor, 0n);
  const tax = lines.reduce((s, l) => s + l.taxMinor, 0n);
  const buyer = partyFrom(src.buyer);
  return {
    type: src.type,
    subtype: subtypeOf(src.buyer.buyerType, buyer.vatNumber),
    number: src.number,
    uuid: src.uuid,
    icv: src.icv,
    pih: src.pih,
    issuedAt: src.issuedAt,
    currency: p.currency,
    seller: partyFrom(src.seller),
    buyer,
    lines,
    totals: { netMinor: net, taxMinor: tax, totalMinor: net + tax },
    reference: src.reference ?? null,
  };
}
