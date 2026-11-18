import {
  CONTACT_ROLES,
  type ContactPayload,
  type ContactRole,
  type ContactSet,
} from '@nuzm/registrar-contracts';
import { ProblemException } from '../../../common/errors';
import type { FieldCipher } from '../../../common/field-crypto';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,255}\.[^\s@<>"]{2,}$/;
const E164 = /^\+[1-9]\d{6,14}$/;

/** Parses and validates a contact set from a request body. Missing admin/tech/billing default to the registrant. PII: callers never log the result. */
export function parseContacts(raw: unknown, requiredExtra: string[]): ContactSet {
  const errors: { field: string; message: string }[] = [];
  const one = (v: unknown, at: string): ContactPayload | null => {
    const bad = (f: string, m: string) => errors.push({ field: `${at}.${f}`, message: m });
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      bad('', 'must be an object');
      return null;
    }
    const o = v as Record<string, unknown>;
    const str = (k: string, min: number, max: number, req = true) => {
      const x = o[k];
      if (x === undefined || x === null || x === '') {
        if (req) bad(k, 'is required');
        return undefined;
      }
      if (typeof x !== 'string' || x.length < min || x.length > max || CONTROL.test(x)) {
        bad(k, `must be ${min}..${max} characters without control characters`);
        return undefined;
      }
      return x.trim();
    };
    const firstName = str('firstName', 1, 100);
    const lastName = str('lastName', 1, 100);
    const organization = str('organization', 1, 200, false);
    const email = str('email', 3, 320);
    if (email && !EMAIL.test(email)) bad('email', 'is not a valid e-mail address');
    const phone = str('phone', 7, 16);
    if (phone && !E164.test(phone)) bad('phone', 'must be E.164, for example +966500000000');
    const a = o.address as Record<string, unknown> | undefined;
    if (!a || typeof a !== 'object') bad('address', 'is required');
    const addr = (k: string, min: number, max: number, req = true) => {
      const x = a?.[k];
      if (x === undefined || x === null || x === '') {
        if (req) bad(`address.${k}`, 'is required');
        return undefined;
      }
      if (typeof x !== 'string' || x.length < min || x.length > max || CONTROL.test(x)) {
        bad(`address.${k}`, `must be ${min}..${max} characters`);
        return undefined;
      }
      return x.trim();
    };
    const street = addr('street', 1, 200);
    const city = addr('city', 1, 100);
    const state = addr('state', 1, 100, false);
    const postalCode = addr('postalCode', 1, 20);
    const country = addr('country', 2, 2);
    if (country && !/^[A-Za-z]{2}$/.test(country))
      bad('address.country', 'must be an ISO 3166-1 alpha-2 code');
    let extra: Record<string, string> | undefined;
    if (o.extra !== undefined) {
      if (
        !o.extra ||
        typeof o.extra !== 'object' ||
        Array.isArray(o.extra) ||
        Object.entries(o.extra).some(
          ([k, x]) =>
            !/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k) ||
            typeof x !== 'string' ||
            x.length > 200 ||
            CONTROL.test(x),
        )
      )
        bad('extra', 'must be a map of short strings');
      else extra = o.extra as Record<string, string>;
    }
    for (const f of requiredExtra) if (!extra?.[f]) bad(`extra.${f}`, 'is required for this TLD');
    if (errors.some((e) => e.field.startsWith(at))) return null;
    return {
      firstName: firstName!,
      lastName: lastName!,
      ...(organization ? { organization } : {}),
      email: email!,
      phone: phone!,
      address: {
        street: street!,
        city: city!,
        ...(state ? { state } : {}),
        postalCode: postalCode!,
        country: country!.toUpperCase(),
      },
      ...(extra ? { extra } : {}),
    };
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new ProblemException(
      'validation_failed',
      'contacts must be an object with at least a registrant',
    );
  const c = raw as Record<string, unknown>;
  for (const k of Object.keys(c))
    if (!(CONTACT_ROLES as readonly string[]).includes(k))
      errors.push({ field: `contacts.${k}`, message: 'unknown role' });
  const registrant = one(c.registrant, 'contacts.registrant');
  const out: Partial<ContactSet> = { registrant: registrant! };
  for (const r of ['admin', 'tech', 'billing'] as const)
    out[r] = c[r] === undefined ? registrant! : one(c[r], `contacts.${r}`)!;
  if (errors.length)
    throw new ProblemException('validation_failed', 'the contacts are invalid', errors);
  return out as ContactSet;
}

export const contactColumn = 'domains.domain_contacts.payload_enc';
export const sealContact = (cipher: FieldCipher, rowId: string, p: ContactPayload) =>
  cipher.encryptJson(p, { column: contactColumn, row: rowId });
export const openContact = (cipher: FieldCipher, rowId: string, sealed: string) =>
  cipher.decryptJson<ContactPayload>(sealed, { column: contactColumn, row: rowId });

/** Display masking for callers without `domain:write`: enough to recognise a contact, never enough to use it. */
export function maskContact(p: ContactPayload): Record<string, unknown> {
  const [u, d] = p.email.split('@');
  return {
    firstName: `${p.firstName.slice(0, 1)}***`,
    lastName: `${p.lastName.slice(0, 1)}***`,
    ...(p.organization ? { organization: `${p.organization.slice(0, 1)}***` } : {}),
    email: `${(u ?? '').slice(0, 1)}***@${d ?? ''}`,
    phone: `${p.phone.slice(0, 4)}******${p.phone.slice(-2)}`,
    address: { country: p.address.country },
    masked: true,
  };
}
export type { ContactRole };
