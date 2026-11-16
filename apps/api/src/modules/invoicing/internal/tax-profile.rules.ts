import { ProblemException } from '../../../common/errors';

/**
 * Tax-profile validation rules. The FORMATS below are configuration, not law: they are working assumptions from public
 * e-invoicing documentation and every one is [VERIFY] with the tax advisor / the pinned ZATCA spec (docs/11 §4, HG-03-04).
 * Override per deployment with TAX_VAT_NUMBER_REGEX, TAX_CR_NUMBER_REGEX, TAX_POSTAL_CODE_REGEX, TAX_BUILDING_NUMBER_REGEX.
 */
export interface ProfileRules {
  vatNumber: RegExp;
  crNumber: RegExp;
  postalCode: RegExp;
  buildingNumber: RegExp;
}
export const rulesFromEnv = (env: NodeJS.ProcessEnv = process.env): ProfileRules => ({
  vatNumber: new RegExp(env.TAX_VAT_NUMBER_REGEX ?? '^3\\d{13}3$'), // 15 digits starting and ending with 3 [VERIFY]
  crNumber: new RegExp(env.TAX_CR_NUMBER_REGEX ?? '^\\d{10}$'), // [VERIFY]
  postalCode: new RegExp(env.TAX_POSTAL_CODE_REGEX ?? '^\\d{5}$'), // [VERIFY]
  buildingNumber: new RegExp(env.TAX_BUILDING_NUMBER_REGEX ?? '^\\d{4}$'), // [VERIFY]
});

export interface Address {
  street: string;
  buildingNumber: string;
  district: string;
  city: string;
  postalCode: string;
  country: string;
}
export interface TaxProfileInput {
  buyerType: 'b2b' | 'b2c';
  legalName: { ar: string; en: string };
  vatNumber: string | null;
  crNumber: string | null;
  address: Partial<Address>;
}

const ADDRESS_FIELDS = [
  'street',
  'buildingNumber',
  'district',
  'city',
  'postalCode',
  'country',
] as const;

/** Validate and normalize a profile body; throws 422 with one entry per bad field. */
export function parseTaxProfile(
  raw: Record<string, unknown>,
  rules: ProfileRules,
): TaxProfileInput {
  const errors: { field: string; message: string }[] = [];
  const bad = (field: string, message: string) => errors.push({ field, message });
  const buyerType = raw.buyerType;
  if (buyerType !== 'b2b' && buyerType !== 'b2c') bad('buyerType', "must be 'b2b' or 'b2c'");
  const ln = (raw.legalName ?? {}) as { ar?: unknown; en?: unknown };
  const name = (k: 'ar' | 'en') => {
    const v = ln[k];
    if (typeof v !== 'string' || v.trim().length < 1 || v.length > 200)
      bad(`legalName.${k}`, 'is required (1..200 characters)');
    return typeof v === 'string' ? v.trim() : '';
  };
  const legalName = { ar: name('ar'), en: name('en') };
  const optional = (k: 'vatNumber' | 'crNumber', re: RegExp) => {
    const v = raw[k];
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !re.test(v.trim())) {
      bad(k, 'has an invalid format');
      return null;
    }
    return v.trim();
  };
  const vatNumber = optional('vatNumber', rules.vatNumber);
  const crNumber = optional('crNumber', rules.crNumber);
  if (buyerType === 'b2b' && vatNumber === null && !errors.some((e) => e.field === 'vatNumber'))
    bad('vatNumber', 'is required for a VAT-registered (b2b) buyer');

  const a = (raw.address ?? {}) as Record<string, unknown>;
  const address: Partial<Address> = {};
  for (const f of ADDRESS_FIELDS) {
    const v = a[f];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || v.length > 120) {
      bad(`address.${f}`, 'must be a string of at most 120 characters');
      continue;
    }
    address[f] = v.trim();
  }
  if (address.postalCode !== undefined && !rules.postalCode.test(address.postalCode))
    bad('address.postalCode', 'has an invalid format');
  if (address.buildingNumber !== undefined && !rules.buildingNumber.test(address.buildingNumber))
    bad('address.buildingNumber', 'has an invalid format');
  if (address.country !== undefined && !/^[A-Z]{2}$/.test(address.country))
    bad('address.country', 'must be an ISO 3166-1 alpha-2 code');
  if (buyerType === 'b2b')
    for (const f of ADDRESS_FIELDS)
      if (address[f] === undefined) bad(`address.${f}`, 'is required for a b2b buyer');

  if (errors.length)
    throw new ProblemException('validation_failed', 'the tax profile is invalid', errors);
  return { buyerType: buyerType as 'b2b' | 'b2c', legalName, vatNumber, crNumber, address };
}
