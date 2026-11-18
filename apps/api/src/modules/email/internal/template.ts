import { ProblemException } from '../../../common/errors';
import { classOf, escapeHtml, sanitizeHtml } from './sanitize';

// C0 controls, DEL and the Unicode line/paragraph separators: anything that could end a header line
const LINE_SET = classOf([
  [0, 0x1f],
  [0x7f, 0x7f],
  [0x2028, 0x2029],
]);
const LINE_CONTROL = new RegExp(LINE_SET);
const LINE_CONTROL_G = new RegExp(LINE_SET + '+', 'g');

export type VarType = 'string' | 'number';
export type VariableSchema = Record<string, { type: VarType; required: boolean }>;
export interface TemplateDef {
  subject: string;
  html: string;
  text?: string | null;
  variables: VariableSchema;
}
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
const PH = /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,40})\s*\}\}/g;
export const placeholders = (s: string): string[] => [
  ...new Set([...s.matchAll(PH)].map((m) => m[1]!)),
];
/** Header-injection guard: no CR, LF or other control characters in anything that becomes a header (subject, addresses). */
export const hasControl = (s: string): boolean => LINE_CONTROL.test(s);

export function parseVariableSchema(raw: unknown): VariableSchema {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new ProblemException(
      'validation_failed',
      'variables must be an object of {name: {type, required}}',
    );
  const out: VariableSchema = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const d = v as { type?: unknown; required?: unknown };
    if (
      !NAME.test(k) ||
      typeof v !== 'object' ||
      v === null ||
      (d.type !== 'string' && d.type !== 'number') ||
      (d.required !== undefined && typeof d.required !== 'boolean')
    )
      throw new ProblemException(
        'validation_failed',
        `variables.${k}: use {type: string|number, required?: boolean}`,
        [{ field: `variables.${k}` }],
      );
    out[k] = { type: d.type, required: d.required !== false };
  }
  if (Object.keys(out).length > 50)
    throw new ProblemException('validation_failed', 'at most 50 variables');
  return out;
}

/** Validate a template for saving: no header injection in the subject, every placeholder declared, html sanitized. Returns the canonical definition. */
export function prepareTemplate(input: {
  subject: unknown;
  html: unknown;
  text?: unknown;
  variables?: unknown;
}): TemplateDef {
  const { subject, html } = input;
  if (
    typeof subject !== 'string' ||
    subject.length < 1 ||
    subject.length > 300 ||
    hasControl(subject)
  )
    throw new ProblemException(
      'validation_failed',
      'subject must be 1..300 characters without line breaks or control characters',
    );
  if (typeof html !== 'string' || html.length < 1 || html.length > 200_000)
    throw new ProblemException('validation_failed', 'html must be 1..200000 characters');
  if (
    input.text !== undefined &&
    input.text !== null &&
    (typeof input.text !== 'string' || input.text.length > 100_000)
  )
    throw new ProblemException('validation_failed', 'text must be at most 100000 characters');
  const variables = parseVariableSchema(input.variables);
  const clean = sanitizeHtml(html);
  const used = new Set([
    ...placeholders(subject),
    ...placeholders(clean),
    ...placeholders((input.text as string | undefined) ?? ''),
  ]);
  const undeclared = [...used].filter((u) => !variables[u]);
  if (undeclared.length)
    throw new ProblemException(
      'validation_failed',
      `undeclared variable(s): ${undeclared.join(', ')}`,
      undeclared.map((u) => ({ field: `variables.${u}`, message: 'declare it in variables' })),
    );
  if (!clean.replace(/<[^>]*>/g, '').trim())
    throw new ProblemException(
      'validation_failed',
      'the html has no visible content after sanitization',
    );
  return { subject, html: clean, text: (input.text as string | undefined) ?? null, variables };
}

/** Validate `variables` against the schema (declared names only, types, required, length) and substitute. Values are escaped for html and stripped of line breaks for the subject. */
export function renderTemplate(
  def: TemplateDef,
  values: unknown,
): { subject: string; html: string; text: string | null } {
  const v = (values ?? {}) as Record<string, unknown>;
  if (typeof v !== 'object' || Array.isArray(v))
    throw new ProblemException('validation_failed', 'variables must be an object');
  const errors: { field: string; message: string }[] = [];
  for (const k of Object.keys(v))
    if (!def.variables[k])
      errors.push({ field: `variables.${k}`, message: 'not declared by the template' });
  for (const [k, d] of Object.entries(def.variables)) {
    const x = v[k];
    if (x === undefined || x === null) {
      if (d.required) errors.push({ field: `variables.${k}`, message: 'required' });
    } else if (
      d.type === 'number' ? typeof x !== 'number' || !Number.isFinite(x) : typeof x !== 'string'
    )
      errors.push({ field: `variables.${k}`, message: `must be a ${d.type}` });
    else if (String(x).length > 1000)
      errors.push({ field: `variables.${k}`, message: 'at most 1000 characters' });
  }
  if (errors.length)
    throw new ProblemException('validation_failed', 'invalid template variables', errors);
  const sub = (s: string, f: (x: string) => string) =>
    s.replace(PH, (_m, n: string) => (v[n] === undefined || v[n] === null ? '' : f(String(v[n]))));
  const subject = sub(def.subject, (x) => x.replace(LINE_CONTROL_G, ' ')).trim();
  // the substituted html is sanitized AGAIN: a value can never add markup (it is escaped) and an href/src built from a value must still pass the URL rules
  const html = sanitizeHtml(sub(def.html, escapeHtml));
  const text = def.text ? sub(def.text, (x) => x) : null;
  return { subject, html, text };
}

/** Recipient address: one plain address (no display name, no comma/semicolon/space/angle brackets), at most 254 characters, IDNs must be punycoded. */
export const EMAIL =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
export function parseAddress(a: unknown): string {
  if (
    typeof a !== 'string' ||
    a.length > 254 ||
    hasControl(a) ||
    !EMAIL.test(a) ||
    a.includes('..') ||
    a.startsWith('.') ||
    a.split('@')[0]!.endsWith('.')
  )
    throw new ProblemException(
      'validation_failed',
      'every recipient must be one plain email address',
    );
  return a.toLowerCase();
}
