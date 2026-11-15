import { randomBytes } from 'node:crypto';

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/** W3C trace context: reuse the caller's trace id when valid, else mint one. */
export function traceIdFrom(header: string | string[] | undefined): string {
  const h = Array.isArray(header) ? header[0] : header;
  const m = h ? TRACEPARENT.exec(h.trim()) : null;
  return m && m[1] !== '0'.repeat(32) ? m[1]! : randomBytes(16).toString('hex');
}
