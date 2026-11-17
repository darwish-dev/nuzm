import { describe, expect, it } from 'vitest';
import {
  PAYMENT_FINAL,
  cardState,
  paymentIdFrom,
  previewMessage,
  sandboxToken,
  sandboxUi,
  statusTone,
} from './payments';

describe('sandbox card tokens', () => {
  it('build setup tokens, never a card number', () => {
    expect(sandboxToken('success', 'A1b2')).toBe('tok_mock_success_a1b2');
    expect(sandboxToken('3ds', 'x'.repeat(30))).toBe(`tok_mock_3ds_${'x'.repeat(12)}`);
    expect(sandboxToken('decline', '4242 4242')).toBe('tok_mock_decline_42424242'); // separators are dropped, not carried
    expect(() => sandboxToken('success', '---')).toThrow();
  });
  it('the sandbox picker is on outside production and can be forced', () => {
    expect(sandboxUi({})).toBe(true);
    expect(sandboxUi({ NODE_ENV: 'production' })).toBe(false);
    expect(sandboxUi({ NODE_ENV: 'production', PSP_SANDBOX_UI: 'true' })).toBe(true);
    expect(sandboxUi({ PSP_SANDBOX_UI: 'false' })).toBe(false);
  });
});

describe('card state', () => {
  const now = new Date('2026-11-17T10:00:00Z');
  it('expiring in the last 30 days of the expiry month, expired after it', () => {
    expect(cardState(12, 2026, now)).toBe('ok'); // ends 2026-12-31: 44 days away -> not yet
    expect(cardState(11, 2026, now)).toBe('expiring'); // ends 2026-11-30: 13 days
    expect(cardState(10, 2026, now)).toBe('expired');
    expect(cardState(1, 2030, now)).toBe('ok');
    expect(cardState(12, 2026, new Date('2026-12-05T00:00:00Z'))).toBe('expiring');
    expect(cardState(12, 2026, new Date('2027-01-01T00:00:00Z'))).toBe('expired');
    expect(cardState(12, 2026, new Date('2026-12-31T23:00:00Z'))).toBe('expiring'); // still valid on the last day
  });
});

describe('status tones and previews', () => {
  it('maps states to tones and leaves unknown ones neutral', () => {
    expect(statusTone('paid')).toBe('success');
    expect(statusTone('past_due')).toBe('warn');
    expect(statusTone('rejected')).toBe('danger');
    expect(statusTone('something_new')).toBeUndefined();
  });
  it('turns a proration preview into a message and a positive amount', () => {
    expect(previewMessage({ effect: 'charge', netMinor: '1500' })).toEqual({
      key: 'sub.preview.charge',
      amountMinor: '1500',
    });
    expect(previewMessage({ effect: 'credit', netMinor: '-1500' })).toEqual({
      key: 'sub.preview.credit',
      amountMinor: '1500',
    });
    expect(previewMessage({ effect: 'none', netMinor: '0' })).toEqual({
      key: 'sub.preview.none',
      amountMinor: null,
    });
  });
});

describe('payment return', () => {
  it('accepts only a uuid and knows the final states', () => {
    expect(paymentIdFrom('0F4C6E5A-8B3D-4A64-9A5E-3F0C2F1B7D11')).toBe(
      '0f4c6e5a-8b3d-4a64-9a5e-3f0c2f1b7d11',
    );
    expect(paymentIdFrom(['0f4c6e5a-8b3d-4a64-9a5e-3f0c2f1b7d11', 'x'])).toBe(
      '0f4c6e5a-8b3d-4a64-9a5e-3f0c2f1b7d11',
    );
    for (const bad of [undefined, '', 'abc', '<script>', '1; DROP'])
      expect(paymentIdFrom(bad)).toBeNull();
    expect(PAYMENT_FINAL.has('succeeded')).toBe(true);
    expect(PAYMENT_FINAL.has('processing')).toBe(false);
    expect(PAYMENT_FINAL.has('requires_action')).toBe(false);
  });
});
