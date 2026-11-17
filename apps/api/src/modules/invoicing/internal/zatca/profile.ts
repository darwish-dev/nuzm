import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * The e-invoice profile: everything that WOULD come from the official ZATCA specification (type codes, namespaces, subtype codes, VAT-number
 * format, rounding of the first hash, QR tags) lives in `spec/zatca/synthetic-profile.yaml`, not in code. Today that file is SYNTHETIC (no official
 * documents were supplied, HG-03-03): re-pinning is a configuration and golden-file change, and `pnpm zatca:guard` makes the change visible.
 */
export type DocType = 'invoice' | 'credit_note' | 'debit_note';
export type Subtype = 'standard' | 'simplified';
export interface DocKind {
  typeCode: string;
  root: string;
  lineElement: string;
  quantityElement: string;
  namespace: string;
}
export interface ZatcaProfile {
  profile: string;
  specVersion: string;
  documents: Record<DocType, DocKind>;
  subtypes: Record<Subtype, string>;
  profileId: string;
  vatNumberPattern: RegExp;
  currency: string;
  currencyDecimals: number;
  taxCategories: { standard: string; zero: string };
  firstPihSeed: string;
  reportingWindowHours: number;
  issueTimeOffsetHours: number;
  /** True while the profile is the synthetic stand-in: every output must say NOT VERIFIED vs ZATCA. */
  synthetic: boolean;
}

export function parseProfile(text: string): ZatcaProfile {
  const raw = parse(text) as Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any -- validated field by field below
  const fail = (m: string): never => {
    throw new Error(`zatca profile: ${m}`);
  };
  if (!raw || typeof raw !== 'object') return fail('not a mapping');
  const docs: Partial<Record<DocType, DocKind>> = {};
  for (const k of ['invoice', 'credit_note', 'debit_note'] as const) {
    const d = raw.documents?.[k];
    for (const f of ['typeCode', 'root', 'lineElement', 'quantityElement', 'namespace'])
      if (typeof d?.[f] !== 'string' || d[f].length < 1) fail(`documents.${k}.${f} is required`);
    docs[k] = d as DocKind;
  }
  for (const k of ['standard', 'simplified'])
    if (typeof raw.subtypes?.[k] !== 'string' || !/^[0-9A-Z]{7}$/.test(raw.subtypes[k]))
      fail(`subtypes.${k} must be a 7-character code`);
  if (typeof raw.vatNumberPattern !== 'string') fail('vatNumberPattern is required');
  if (raw.currency !== 'SAR' || raw.currencyDecimals !== 2)
    fail('only SAR with 2 decimals is supported');
  if (typeof raw.firstPihSeed !== 'string') fail('firstPihSeed is required');
  if (!Number.isInteger(raw.reportingWindowHours) || raw.reportingWindowHours < 1)
    fail('reportingWindowHours must be a positive integer');
  if (!Number.isInteger(raw.issueTimeOffsetHours) || Math.abs(raw.issueTimeOffsetHours) > 14)
    fail('issueTimeOffsetHours must be an integer UTC offset');
  if (typeof raw.profile !== 'string' || typeof raw.specVersion !== 'string')
    fail('profile and specVersion are required');
  return {
    profile: raw.profile,
    specVersion: raw.specVersion,
    documents: docs as Record<DocType, DocKind>,
    subtypes: raw.subtypes,
    profileId: String(raw.profileId),
    vatNumberPattern: new RegExp(raw.vatNumberPattern),
    currency: 'SAR',
    currencyDecimals: 2,
    taxCategories: raw.taxCategories,
    firstPihSeed: raw.firstPihSeed,
    reportingWindowHours: raw.reportingWindowHours,
    issueTimeOffsetHours: raw.issueTimeOffsetHours,
    synthetic: String(raw.profile).startsWith('SYNTHETIC') || raw.specVersion === 'UNPINNED',
  };
}

/** Find `spec/zatca/synthetic-profile.yaml` from the running code upwards (works from src, dist and the repo root), or ZATCA_PROFILE_PATH. */
export function loadProfile(env: NodeJS.ProcessEnv = process.env): ZatcaProfile {
  if (env.ZATCA_PROFILE_PATH) return parseProfile(readFileSync(env.ZATCA_PROFILE_PATH, 'utf8'));
  let dir = resolve(__dirname);
  for (let i = 0; i < 14; i++) {
    const f = join(dir, 'spec', 'zatca', 'synthetic-profile.yaml');
    if (existsSync(f)) return parseProfile(readFileSync(f, 'utf8'));
    dir = dirname(dir);
  }
  throw new Error(
    'zatca profile: spec/zatca/synthetic-profile.yaml not found (set ZATCA_PROFILE_PATH)',
  );
}
