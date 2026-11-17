import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * Consent purposes (spec/compliance/purposes.yaml). Validated at load: a bad file stops the process rather than changing what people are asked.
 * Placeholder texts (`COUNSEL-TEXT-REQUIRED`) are allowed and reported (`pendingCounsel`): the API works, but nothing can claim that the wording is
 * approved (HG-04-01).
 */
export interface Purpose {
  id: string;
  category: string;
  textVersion: string;
  label: { ar: string; en: string };
  text: { ar: string; en: string };
  pendingCounsel: boolean;
}
export interface PurposeCatalog {
  version: number;
  status: string;
  purposes: Purpose[];
  byId: Map<string, Purpose>;
}

const PLACEHOLDER = 'COUNSEL-TEXT-REQUIRED';

export function parsePurposes(text: string): PurposeCatalog {
  const raw = parse(text) as Record<string, unknown> | null;
  const fail = (m: string): never => {
    throw new Error(`consent purposes: ${m}`);
  };
  if (!raw || typeof raw !== 'object') return fail('not a mapping');
  if (!Number.isInteger(raw.version) || (raw.version as number) < 1)
    fail('version must be a positive integer');
  if (typeof raw.status !== 'string' || raw.status.length < 3) fail('status is required');
  if (!Array.isArray(raw.purposes) || raw.purposes.length === 0)
    fail('purposes must be a non-empty list');
  const out: Purpose[] = [];
  const byId = new Map<string, Purpose>();
  for (const p of raw.purposes as Record<string, unknown>[]) {
    const id = p.id;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_]{2,60}$/.test(id))
      fail(`bad purpose id ${JSON.stringify(id)}`);
    if (byId.has(id as string)) fail(`duplicate purpose ${id as string}`);
    const lang = (o: unknown, what: string) => {
      const x = o as { ar?: unknown; en?: unknown } | undefined;
      for (const l of ['ar', 'en'] as const)
        if (
          typeof x?.[l] !== 'string' ||
          (x[l] as string).trim() === '' ||
          (x[l] as string).length > 2000
        )
          fail(`${id as string}: ${what}.${l} is required (1..2000 characters)`);
      return { ar: x!.ar as string, en: x!.en as string };
    };
    const textVersion = p.textVersion;
    if (typeof textVersion !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(textVersion))
      fail(`${id as string}: textVersion is required`);
    if (typeof p.category !== 'string' || p.category.trim() === '')
      fail(`${id as string}: category is required`);
    const label = lang(p.label, 'label');
    const txt = lang(p.text, 'text');
    const purpose: Purpose = {
      id: id as string,
      category: p.category as string,
      textVersion: textVersion as string,
      label,
      text: txt,
      pendingCounsel: txt.ar === PLACEHOLDER || txt.en === PLACEHOLDER,
    };
    out.push(purpose);
    byId.set(purpose.id, purpose);
  }
  return { version: raw.version as number, status: raw.status as string, purposes: out, byId };
}

/** `CONSENT_PURPOSES_PATH`, else spec/compliance/purposes.yaml found by walking up from this file or the working directory. */
export function loadPurposes(path = process.env.CONSENT_PURPOSES_PATH): PurposeCatalog {
  if (path) return parsePurposes(readFileSync(resolve(path), 'utf8'));
  for (let d = __dirname, i = 0; i < 10; i++, d = dirname(d)) {
    const f = join(d, 'spec/compliance/purposes.yaml');
    if (existsSync(f)) return parsePurposes(readFileSync(f, 'utf8'));
  }
  const f = join(process.cwd(), 'spec/compliance/purposes.yaml');
  if (existsSync(f)) return parsePurposes(readFileSync(f, 'utf8'));
  throw new Error('consent purposes: spec/compliance/purposes.yaml not found');
}
