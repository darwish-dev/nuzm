/** Pure helpers for the payment, subscription and invoice screens (no I/O). */

export const SANDBOX_CARDS = ['success', 'decline', '3ds', 'timeout'] as const;
export type SandboxCard = (typeof SANDBOX_CARDS)[number];

/**
 * The sandbox PSP's setup token for a chosen test card (like a PSP's test card numbers): `tok_mock_<scenario>_<card>`. The suffix names the
 * physical card, so each saved test card is distinct. NO card number is ever built, shown, typed or sent by the web app.
 */
export function sandboxToken(kind: SandboxCard, suffix: string): string {
  const s = suffix
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12);
  if (s.length < 1) throw new Error('a card suffix is required');
  return `tok_mock_${kind}_${s}`;
}

/** The sandbox card picker is shown only while the payment provider is the sandbox one (`PSP_SANDBOX_UI`, default on outside production). */
export function sandboxUi(env: Record<string, string | undefined> = process.env): boolean {
  if (env.PSP_SANDBOX_UI !== undefined) return env.PSP_SANDBOX_UI === 'true';
  return env.NODE_ENV !== 'production';
}

export type CardState = 'ok' | 'expiring' | 'expired';
/** A card is "expiring" in the last 30 days of its expiry month and "expired" after it (same rule as the notice). */
export function cardState(expMonth: number, expYear: number, now = new Date()): CardState {
  const last = Date.UTC(expYear, expMonth, 0); // last day of the expiry month, 00:00 UTC
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (today > last) return 'expired';
  return (last - today) / 86_400_000 <= 30 ? 'expiring' : 'ok';
}

export type Tone = 'success' | 'warn' | 'danger' | undefined;
const TONES: Record<string, Tone> = {
  paid: 'success',
  succeeded: 'success',
  active: 'success',
  cleared: 'success',
  reported: 'success',
  credited: 'success',
  refunded: 'success',
  issued: 'success',
  applied: 'success',
  open: 'warn',
  partially_paid: 'warn',
  processing: 'warn',
  requires_action: 'warn',
  trialing: 'warn',
  pending: 'warn',
  queued: 'warn',
  submitted: 'warn',
  stamped: 'warn',
  generated: 'warn',
  partially_refunded: 'warn',
  past_due: 'warn',
  failed: 'danger',
  cancelled: 'danger',
  void: 'danger',
  uncollectible: 'danger',
  unpaid: 'danger',
  rejected: 'danger',
  error: 'danger',
};
export const statusTone = (status: string): Tone => TONES[status];

/** What a plan-change preview means, as a translation key plus the amount to show (always a positive integer string, minor units). */
export function previewMessage(p: { effect: 'charge' | 'credit' | 'none'; netMinor: string }): {
  key: 'sub.preview.charge' | 'sub.preview.credit' | 'sub.preview.none';
  amountMinor: string | null;
} {
  if (p.effect === 'charge') return { key: 'sub.preview.charge', amountMinor: p.netMinor };
  if (p.effect === 'credit')
    return { key: 'sub.preview.credit', amountMinor: p.netMinor.replace(/^-/, '') };
  return { key: 'sub.preview.none', amountMinor: null };
}

/** The payment return page reads `paymentId` from the query; anything but a UUID is ignored (never echoed). */
export function paymentIdFrom(q: string | string[] | undefined): string | null {
  const v = Array.isArray(q) ? q[0] : q;
  return v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
    ? v.toLowerCase()
    : null;
}

/** Final payment states (the return page stops polling there). */
export const PAYMENT_FINAL = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'partially_refunded',
  'refunded',
]);

/** `YYYY-MM-DD` (a date column) is shown as is; ISO instants go through the locale formatter by the caller. */
export const isDateOnly = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
