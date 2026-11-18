/**
 * Secret redaction for everything an execution persists or returns (inputs, outputs, errors, logs). Three layers: (1) any value EQUAL to a secret the step
 * handled (connector token, webhook secret, an idempotency header the receiver echoed) is replaced; (2) values that look like credentials are replaced;
 * (3) keys that name a credential have their string values replaced. The result is also capped in size so one step cannot fill the database.
 */
const KEY = /(secret|password|passwd|token|api[-_]?key|authorization|cookie|private[-_]?key|credential|signature)/i;
const VALUE: RegExp[] = [
  /(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bnzk_[A-Za-z0-9]{8,}/g,
  /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /vault:\/\/[A-Za-z0-9/_.-]+/g,
];
export const REDACTED = '[redacted]';

export function redactString(s: string, secrets: readonly string[] = []): string {
  let out = s;
  for (const sec of secrets) if (sec.length >= 6) out = out.split(sec).join(REDACTED);
  for (const re of VALUE) out = out.replace(re, REDACTED);
  return out;
}

export function redact(v: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 12) return '[truncated]';
  if (typeof v === 'string') return redactString(v, secrets);
  if (Array.isArray(v)) return v.slice(0, 1000).map((x) => redact(x, secrets, depth + 1));
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .slice(0, 500)
        .map(([k, x]) => [k, KEY.test(k) && typeof x === 'string' ? REDACTED : redact(x, secrets, depth + 1)]),
    );
  return v;
}

/** Redact, then cap the JSON size (a truncated value is replaced by a marker, never cut mid-structure). */
export function sanitize(v: unknown, secrets: readonly string[], capBytes: number): unknown {
  const r = redact(v, secrets);
  const size = Buffer.byteLength(JSON.stringify(r ?? null), 'utf8');
  return size > capBytes ? { truncated: true, bytes: size } : r;
}
