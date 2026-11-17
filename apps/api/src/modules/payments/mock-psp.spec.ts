import { describe, expect, it } from 'vitest';
import { MOCK_SIGNATURE_HEADER, MockPsp } from './internal/psp/mock-psp';
import { PspTimeoutError, WebhookRejectedError } from './internal/psp/psp';

const psp = () => new MockPsp('unit-test-secret');
const REF = 'nuzm_pi_01a1e64b-cd69-76ed-8a82-cc402c52bb05';
const NOW = new Date('2026-11-17T10:00:00Z');

describe('mock PSP scenarios', () => {
  const pay = async (p: MockPsp, scenario: string) => {
    const m = await p.attachMethod('cus', `tok_mock_${scenario}_x1`);
    return p.createPayment({
      merchantReference: REF,
      amountMinor: '100',
      currency: 'SAR',
      token: m.token,
    });
  };
  it('success, decline, 3-D Secure and processing answer deterministically', async () => {
    expect(await pay(psp(), 'success')).toMatchObject({ status: 'succeeded' });
    expect(await pay(psp(), 'decline')).toMatchObject({
      status: 'failed',
      failureCode: 'card_declined',
    });
    expect(await pay(psp(), '3ds')).toMatchObject({
      status: 'requires_action',
      nextAction: { type: 'redirect' },
    });
    expect(await pay(psp(), 'processing')).toMatchObject({ status: 'processing' });
  });
  it('a timeout loses the answer but the charge exists (the case reconcile-before-retry is for)', async () => {
    const p = psp();
    await expect(pay(p, 'timeout')).rejects.toBeInstanceOf(PspTimeoutError);
    expect(p.chargeCount(REF)).toBe(1);
    expect(await p.retrievePayment(REF)).toMatchObject({ status: 'succeeded' });
    expect(await p.retrievePayment('nuzm_pi_unknown')).toBeNull();
  });
  it('does not deduplicate by itself: charging the same reference twice is a duplicate charge', async () => {
    const p = psp();
    const m = await p.attachMethod('cus', 'tok_mock_success_x1');
    const input = { merchantReference: REF, amountMinor: '100', currency: 'SAR', token: m.token };
    await p.createPayment(input);
    await p.createPayment(input);
    expect(p.chargeCount(REF)).toBe(2);
    expect(p.duplicateCharges).toBe(1);
  });
  it('attaches only known tokens; an expired token and garbage are refused; details never include a card number', async () => {
    const p = psp();
    await expect(p.attachMethod('cus', 'tok_mock_expired')).rejects.toThrow(/expired/);
    await expect(p.attachMethod('cus', 'garbage')).rejects.toThrow();
    const d = await p.attachMethod('cus', 'tok_mock_success_ab12');
    expect(Object.keys(d).sort()).toEqual([
      'brand',
      'expMonth',
      'expYear',
      'fingerprint',
      'last4',
      'token',
    ]);
    expect(d.last4).toMatch(/^\d{4}$/);
  });
});

describe('webhook verification (signature over the raw body, replay window)', () => {
  const signed = () => psp().signedEvent('payment.succeeded', REF, NOW, { id: 'evt_unit_1' });
  it('accepts a correctly signed event', () => {
    const p = psp();
    const { rawBody, headers } = p.signedEvent('payment.succeeded', REF, NOW, {
      id: 'evt_unit_1',
      amountMinor: '100',
    });
    expect(p.parseWebhook(rawBody, headers, NOW)).toMatchObject({
      id: 'evt_unit_1',
      type: 'payment.succeeded',
      merchantReference: REF,
      amountMinor: '100',
    });
  });
  it('rejects a tampered body, a wrong secret, a missing or malformed signature', () => {
    const p = psp();
    const { rawBody, headers } = signed();
    expect(() => p.parseWebhook(rawBody.replace('succeeded', 'failed'), headers, NOW)).toThrow(
      WebhookRejectedError,
    );
    expect(() => new MockPsp('another-secret').parseWebhook(rawBody, headers, NOW)).toThrow(
      /signature/,
    );
    expect(() => p.parseWebhook(rawBody, {}, NOW)).toThrow(/missing/);
    expect(() => p.parseWebhook(rawBody, { [MOCK_SIGNATURE_HEADER]: 't=1,v1=zz' }, NOW)).toThrow(
      /malformed/,
    );
  });
  it('rejects a delivery outside the replay window (both directions)', () => {
    const p = psp();
    const old = p.signedEvent('payment.succeeded', REF, NOW, {
      signAt: new Date(NOW.getTime() - 10 * 60_000),
    });
    expect(() => p.parseWebhook(old.rawBody, old.headers, NOW)).toThrow(/replay window/);
    const future = p.signedEvent('payment.succeeded', REF, NOW, {
      signAt: new Date(NOW.getTime() + 10 * 60_000),
    });
    expect(() => p.parseWebhook(future.rawBody, future.headers, NOW)).toThrow(/replay window/);
  });
  it('rejects a valid signature over a body that is not an event', () => {
    const p = psp();
    const raw = '{"hello":"world"}';
    expect(() => p.parseWebhook(raw, { [MOCK_SIGNATURE_HEADER]: p.sign(raw, NOW) }, NOW)).toThrow(
      /unexpected event shape/,
    );
    const bad = 'not json';
    expect(() => p.parseWebhook(bad, { [MOCK_SIGNATURE_HEADER]: p.sign(bad, NOW) }, NOW)).toThrow(
      /not JSON/,
    );
  });
});
