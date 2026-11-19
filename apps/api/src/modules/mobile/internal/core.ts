import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';

/** Shared building blocks of the mobile module (M10B). Pure: no I/O. */
export type Row = Record<string, unknown>;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);
export const newId = (): string => uuidv7();
export const sha256 = (s: string | Uint8Array): string =>
  createHash('sha256').update(s).digest('hex');
export const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

/** Deterministic JSON (keys sorted) for hashes that bind an approval to exact content. */
export function canonicalJson(v: unknown): string {
  const walk = (x: unknown): unknown => {
    if (x === null || typeof x === 'string' || typeof x === 'boolean') return x;
    if (typeof x === 'number') {
      if (!Number.isFinite(x)) throw new TypeError('canonicalJson: non-finite number');
      return x;
    }
    if (Array.isArray(x)) return x.map(walk);
    if (typeof x === 'object' && x !== null) {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(x).sort()) {
        const val = (x as Record<string, unknown>)[k];
        if (val !== undefined) o[k] = walk(val);
      }
      return o;
    }
    throw new TypeError(`canonicalJson: unsupported value of type ${typeof x}`);
  };
  return JSON.stringify(walk(v));
}
export const hashOf = (v: unknown): string => sha256(canonicalJson(v));
/** reject unknown members of a request body: nothing can hide in an extra field */
export function onlyKeys(b: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(b).filter((k) => !allowed.includes(k));
}
