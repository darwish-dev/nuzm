import type { SecretMaterial } from './vault';

export const REDACTED = '[REDACTED]';
const SENSITIVE_KEY =
  /(pass(word|wd)?|secret|token|authori[sz]ation|api[-_]?key|access[-_]?key|private[-_]?key|credential|signature|cookie|session)/i;

/**
 * Redaction library. Two independent layers: (1) key-name based (`secret`, `token`, `authorization`, …) and (2) VALUE based: every
 * secret value obtained from the vault is registered, and any occurrence of it (or of its base64/URL-encoded form) inside any string
 * is replaced. Layer 2 is what the canary-secret test exercises: a secret that leaks under an innocent key name is still removed.
 */
export class Redactor {
  private readonly values = new Set<string>();

  /** Register the secret values of resolved material (and extra canaries in tests). Values shorter than 6 chars are ignored (too noisy). */
  register(material: SecretMaterial | string | readonly string[]): this {
    const list =
      typeof material === 'string'
        ? [material]
        : Array.isArray(material)
          ? (material as readonly string[])
          : Object.values((material as SecretMaterial).fields);
    for (const v of list) {
      if (typeof v !== 'string' || v.length < 6) continue;
      this.values.add(v);
      this.values.add(Buffer.from(v).toString('base64'));
      this.values.add(encodeURIComponent(v));
    }
    return this;
  }

  string(s: string): string {
    let out = s;
    for (const v of this.values) if (out.includes(v)) out = out.split(v).join(REDACTED);
    return out;
  }

  deep<T>(input: T, depth = 0): T {
    if (depth > 12) return REDACTED as unknown as T;
    if (typeof input === 'string') return this.string(input) as unknown as T;
    if (Array.isArray(input)) return input.map((x) => this.deep(x, depth + 1)) as unknown as T;
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input as Record<string, unknown>))
        out[k] =
          SENSITIVE_KEY.test(k) && v !== null && v !== undefined
            ? REDACTED
            : this.deep(v, depth + 1);
      return out as T;
    }
    return input;
  }

  /** Value-only scrub (no key-name rule): for result payloads where a key such as `nuzm-token` is legitimate data. */
  scrubValues<T>(input: T, depth = 0): T {
    if (depth > 12) return REDACTED as unknown as T;
    if (typeof input === 'string') return this.string(input) as unknown as T;
    if (Array.isArray(input))
      return input.map((x) => this.scrubValues(x, depth + 1)) as unknown as T;
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input as Record<string, unknown>))
        out[this.string(k)] = this.scrubValues(v, depth + 1);
      return out as T;
    }
    return input;
  }

  /** True when `value` (any JSON-able thing or string) still contains a registered secret. */
  leaks(value: unknown): boolean {
    const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
    for (const v of this.values) if (text.includes(v)) return true;
    return false;
  }
}

export const redactKeys = <T>(input: T): T => new Redactor().deep(input);
