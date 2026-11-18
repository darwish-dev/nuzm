import type { EntityMeta, FieldMeta } from './types.ts';

export interface FieldError {
  field: string;
  message: string;
}
export interface FileInput {
  name: string;
  mime: string;
  size: number;
  data: Uint8Array;
}
export interface Validated {
  values: Record<string, unknown>;
  files: Record<string, FileInput>;
  errors: FieldError[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE = /^\+?[0-9 ()-]{5,30}$/;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);

function isDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Coerces one field. Returns the normalised value or an error message. */
export function coerceField(f: FieldMeta, v: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message });
  switch (f.type) {
    case 'string':
    case 'text': {
      if (typeof v !== 'string') return bad('must be text');
      const s = v.trim();
      const max = f.maxLength ?? (f.type === 'string' ? 255 : 20000);
      if (s.length > max) return bad('is longer than ' + max);
      if (f.required && s.length === 0) return bad('is required');
      return { ok: true, value: s };
    }
    case 'email': {
      if (typeof v !== 'string' || !EMAIL.test(v.trim()) || v.length > 254) return bad('must be an email address');
      return { ok: true, value: v.trim().toLowerCase() };
    }
    case 'phone':
      return typeof v === 'string' && PHONE.test(v.trim()) ? { ok: true, value: v.trim() } : bad('must be a phone number');
    case 'url': {
      if (typeof v !== 'string' || v.length > 2048 || !/^https?:\/\//i.test(v)) return bad('must be an http(s) URL');
      try {
        new URL(v);
      } catch {
        return bad('must be a valid URL');
      }
      return { ok: true, value: v };
    }
    case 'integer':
    case 'decimal': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(n)) return bad('must be a number');
      if (f.type === 'integer' && !Number.isInteger(n)) return bad('must be a whole number');
      if (f.type === 'decimal' && Math.abs(n) > 1e14) return bad('is out of range');
      if (f.min !== null && n < f.min) return bad('must be at least ' + f.min);
      if (f.max !== null && n > f.max) return bad('must be at most ' + f.max);
      return { ok: true, value: n };
    }
    case 'boolean':
      return typeof v === 'boolean' ? { ok: true, value: v } : bad('must be true or false');
    case 'date':
      return typeof v === 'string' && isDate(v) ? { ok: true, value: v } : bad('must be a date (YYYY-MM-DD)');
    case 'datetime': {
      if (typeof v !== 'string') return bad('must be a date and time');
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? bad('must be a date and time') : { ok: true, value: d.toISOString() };
    }
    case 'enum':
      return typeof v === 'string' && (f.enumValues ?? []).includes(v) ? { ok: true, value: v } : bad('must be one of ' + (f.enumValues ?? []).join(', '));
    case 'reference':
      return isUuid(v) ? { ok: true, value: v.toLowerCase() } : bad('must be an id');
    case 'file':
      return bad('files are uploaded as {name, mime, contentBase64}');
  }
}

/** Validates a create/update body against the entity metadata. Unknown fields are rejected (mass-assignment guard); `ownerId` and `version` are handled by the engine. */
export function validateInput(em: EntityMeta, body: unknown, mode: 'create' | 'update', maxFileBytes: number): Validated {
  const errors: FieldError[] = [];
  const values: Record<string, unknown> = {};
  const files: Record<string, FileInput> = {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { values, files, errors: [{ field: '$', message: 'must be an object' }] };
  const o = body as Record<string, unknown>;
  const known = new Set(em.fields.map((f) => f.name));
  for (const k of Object.keys(o)) if (!known.has(k) && k !== 'ownerId' && k !== 'version') errors.push({ field: k, message: 'is not a field of ' + em.name });
  for (const f of em.fields) {
    const present = Object.prototype.hasOwnProperty.call(o, f.name);
    const v = o[f.name];
    if (!present) {
      if (mode === 'create' && f.required) errors.push({ field: f.name, message: 'is required' });
      continue;
    }
    if (v === null || v === undefined || v === '') {
      if (f.required) errors.push({ field: f.name, message: 'is required' });
      else values[f.name] = null;
      continue;
    }
    if (f.type === 'file') {
      const x = v as { name?: unknown; mime?: unknown; contentBase64?: unknown };
      if (typeof x !== 'object' || typeof x.name !== 'string' || typeof x.contentBase64 !== 'string') {
        errors.push({ field: f.name, message: 'must be {name, mime, contentBase64}' });
        continue;
      }
      const data = Buffer.from(x.contentBase64, 'base64');
      if (data.length > maxFileBytes) {
        errors.push({ field: f.name, message: 'is larger than ' + maxFileBytes + ' bytes' });
        continue;
      }
      const name = x.name.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 255);
      files[f.name] = { name, mime: typeof x.mime === 'string' ? x.mime.slice(0, 127) : 'application/octet-stream', size: data.length, data: new Uint8Array(data) };
      continue;
    }
    const r = coerceField(f, v);
    if (r.ok) values[f.name] = r.value;
    else errors.push({ field: f.name, message: r.message });
  }
  return { values, files, errors };
}
