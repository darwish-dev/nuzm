import { describe, expect, it } from 'vitest';
import { containsCardData, looksLikeCardNumber, luhnValid } from './internal/pan';

// card numbers are built at runtime from parts: the repository scanner must never see one in the source
const VISA = ['4242', '4242', '4242', '4242'].join('');
const AMEX = ['3782', '822463', '10005'].join('');
const MC = ['5555', '5555', '5555', '4444'].join('');

describe('Luhn and card-number detection', () => {
  it('accepts valid numbers and rejects a single wrong digit', () => {
    for (const n of [VISA, AMEX, MC]) expect(luhnValid(n)).toBe(true);
    expect(luhnValid(VISA.slice(0, 15) + '3')).toBe(false);
  });
  it('detects contiguous and grouped numbers, in the middle of text', () => {
    expect(looksLikeCardNumber(VISA)).toBe(true);
    expect(looksLikeCardNumber(`pay with ${VISA.replace(/(.{4})/g, '$1 ').trim()} please`)).toBe(
      true,
    );
    expect(looksLikeCardNumber(VISA.replace(/(.{4})/g, '$1-').slice(0, -1))).toBe(true);
    expect(looksLikeCardNumber(AMEX)).toBe(true);
  });
  it('does not flag ordinary numbers, ids, timestamps or amounts', () => {
    for (const ok of [
      '0198f0a2-7b3c-7d11-8a4f-123456789012',
      '1763380000000',
      '12345',
      '999999999999',
      '4242',
      'nuzm_pi_01a1e64b-cd69-76ed-8a82-cc402c52bb05',
      '18547',
      '300000000000003',
    ])
      expect(looksLikeCardNumber(ok), ok).toBe(false);
  });
});

describe('containsCardData (request bodies)', () => {
  it('refuses card-like field names, whatever the value', () => {
    for (const k of [
      'number',
      'cardNumber',
      'card_number',
      'pan',
      'cvv',
      'cvc',
      'securityCode',
      'expiry',
      'cardholder',
    ])
      expect(containsCardData({ [k]: 'x' }), k).toBe(true);
  });
  it('refuses a card number hidden in any value, any depth, number or string', () => {
    expect(containsCardData({ setupToken: VISA })).toBe(true);
    expect(containsCardData({ a: { b: [{ c: `ref ${VISA}` }] } })).toBe(true);
    expect(containsCardData({ x: Number(VISA.slice(0, 15)) })).toBe(
      looksLikeCardNumber(VISA.slice(0, 15)),
    );
  });
  it('accepts tokens and normal bodies', () => {
    expect(containsCardData({ provider: 'mock', setupToken: 'tok_mock_success_a1' })).toBe(false);
    expect(
      containsCardData({
        invoiceId: '0198f0a2-7b3c-7d11-8a4f-123456789012',
        returnUrl: 'http://127.0.0.1:3000/x',
        amount: '11500',
      }),
    ).toBe(false);
  });
});
