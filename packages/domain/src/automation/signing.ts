import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * M11 S52: webhook signatures, used for OUTBOUND deliveries (`/v1/webhook-endpoints`) and for INBOUND workflow triggers.
 * Header value: `t=<unix seconds>,v1=<hex>[,v1=<hex>]` where `v1 = HMAC-SHA256(secret, "<t>.<body>")`. Several `v1` entries are sent
 * while a secret rotation overlaps (old and new secret both valid for the receiver). The receiver rejects timestamps outside the
 * tolerance (default 5 minutes) and dedupes on the event id, so a captured request cannot be replayed.
 */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export const sign = (secret: string, timestamp: number, body: string): string =>
  createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

/** Build the header for one or more active secrets (current + previous during rotation overlap). */
export function signatureHeader(secrets: readonly string[], timestamp: number, body: string): string {
  if (secrets.length === 0) throw new Error('at least one secret is required');
  return `t=${timestamp},${secrets.map((s) => `v1=${sign(s, timestamp, body)}`).join(',')}`;
}

export type VerifyFailure = 'malformed' | 'timestamp_outside_tolerance' | 'signature_mismatch';
export type VerifyResult = { ok: true; timestamp: number } | { ok: false; reason: VerifyFailure };

export function verifySignature(
  header: string | undefined,
  body: string,
  secrets: readonly string[],
  nowSeconds: number,
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
): VerifyResult {
  if (typeof header !== 'string' || header.length === 0 || header.length > 1000) return { ok: false, reason: 'malformed' };
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 1) return { ok: false, reason: 'malformed' };
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') {
      if (!/^\d{1,12}$/.test(v)) return { ok: false, reason: 'malformed' };
      t = Number(v);
    } else if (k === 'v1') {
      if (!/^[0-9a-f]{64}$/.test(v)) return { ok: false, reason: 'malformed' };
      sigs.push(v);
    }
  }
  if (t === null || sigs.length === 0 || sigs.length > 5) return { ok: false, reason: 'malformed' };
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return { ok: false, reason: 'timestamp_outside_tolerance' };
  let match = false;
  for (const secret of secrets) {
    const expected = Buffer.from(sign(secret, t, body), 'hex');
    for (const s of sigs) {
      const given = Buffer.from(s, 'hex');
      // evaluate every comparison (no early exit on the secret) so timing does not tell which secret matched
      if (given.length === expected.length && timingSafeEqual(given, expected)) match = true;
    }
  }
  return match ? { ok: true, timestamp: t } : { ok: false, reason: 'signature_mismatch' };
}

/** Deterministic per-step idempotency key (docs M11 S51.4): the same logical step attempt-group always yields the same key. */
export const stepIdempotencyKey = (executionId: string, stepId: string, attemptGroup: string): string =>
  createHash('sha256').update(`${executionId}|${stepId}|${attemptGroup}`).digest('hex');
