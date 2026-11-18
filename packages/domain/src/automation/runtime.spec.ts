import { describe, expect, it } from 'vitest';
import { CircuitBreaker, TokenBucket } from './limits';
import {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_WINDOW_SECONDS,
  isRetryableStatus,
  shouldRetryStep,
  stepBackoffSeconds,
  webhookDelaySeconds,
} from './retry';
import { cronMatches, isValidTimeZone, nextCronRun, parseCron } from './cron';
import { sign, signatureHeader, stepIdempotencyKey, verifySignature } from './signing';

describe('webhook signing', () => {
  const body = '{"id":"evt_1"}';
  const now = 1_800_000_000;
  it('verifies a valid signature', () => {
    const h = signatureHeader(['s3cret'], now, body);
    expect(verifySignature(h, body, ['s3cret'], now)).toEqual({ ok: true, timestamp: now });
  });
  it('rejects tampered bodies, wrong secrets, malformed headers', () => {
    const h = signatureHeader(['s3cret'], now, body);
    expect(verifySignature(h, body + ' ', ['s3cret'], now)).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
    expect(verifySignature(h, body, ['other'], now)).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
    for (const bad of [
      undefined,
      '',
      'garbage',
      't=abc,v1=00',
      `t=${now}`,
      `t=${now},v1=zz`,
      `v1=${'0'.repeat(64)}`,
    ])
      expect(verifySignature(bad, body, ['s3cret'], now), String(bad)).toEqual({
        ok: false,
        reason: 'malformed',
      });
  });
  it('rejects timestamps outside the 5 minute window in both directions (replay)', () => {
    const old = signatureHeader(['s'], now - 301, body);
    expect(verifySignature(old, body, ['s'], now)).toEqual({
      ok: false,
      reason: 'timestamp_outside_tolerance',
    });
    const future = signatureHeader(['s'], now + 301, body);
    expect(verifySignature(future, body, ['s'], now)).toEqual({
      ok: false,
      reason: 'timestamp_outside_tolerance',
    });
    expect(verifySignature(signatureHeader(['s'], now - 299, body), body, ['s'], now).ok).toBe(
      true,
    );
  });
  it('secret rotation overlap: old and new secrets are both accepted while both are active', () => {
    const h = signatureHeader(['new', 'old'], now, body);
    expect(verifySignature(h, body, ['old'], now).ok).toBe(true);
    expect(verifySignature(h, body, ['new'], now).ok).toBe(true);
    expect(verifySignature(h, body, ['retired'], now).ok).toBe(false);
    expect(sign('a', 1, 'b')).toHaveLength(64);
  });
  it('step idempotency keys are deterministic and group-sensitive', () => {
    const a = stepIdempotencyKey('e1', 's1', '0');
    expect(a).toBe(stepIdempotencyKey('e1', 's1', '0'));
    expect(a).not.toBe(stepIdempotencyKey('e1', 's1', '1'));
    expect(a).not.toBe(stepIdempotencyKey('e2', 's1', '0'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('retry schedules', () => {
  it('step backoff grows exponentially, is capped and jittered into [50%,100%]', () => {
    expect(stepBackoffSeconds(1, undefined, () => 1)).toBe(2);
    expect(stepBackoffSeconds(2, undefined, () => 1)).toBe(4);
    expect(stepBackoffSeconds(3, undefined, () => 0)).toBe(4);
    expect(stepBackoffSeconds(20, undefined, () => 1)).toBe(300);
    for (let i = 1; i < 10; i++) {
      const hi = stepBackoffSeconds(i, undefined, () => 1);
      const lo = stepBackoffSeconds(i, undefined, () => 0);
      expect(lo).toBeLessThanOrEqual(hi);
    }
  });
  it('default is 5 attempts', () => {
    expect([1, 2, 3, 4, 5].map((a) => shouldRetryStep(a))).toEqual([true, true, true, true, false]);
  });
  it('webhook schedule spans up to ~24 h and then dead-letters', () => {
    expect(WEBHOOK_WINDOW_SECONDS).toBeLessThanOrEqual(24 * 3600);
    expect(WEBHOOK_WINDOW_SECONDS).toBeGreaterThan(23 * 3600); // 23.9 h nominal; jitter can only shorten it
    expect(webhookDelaySeconds(1, () => 1)).toBe(30); // jitter only shortens: 80%..100% of the step
    expect(webhookDelaySeconds(1, () => 0)).toBe(24);
    expect(webhookDelaySeconds(WEBHOOK_MAX_ATTEMPTS - 1, () => 1)).toBe(29_400);
    expect(webhookDelaySeconds(WEBHOOK_MAX_ATTEMPTS)).toBeNull();
    let prev = 0;
    for (let a = 1; a < WEBHOOK_MAX_ATTEMPTS; a++) {
      const d = webhookDelaySeconds(a, () => 0.5)!;
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });
  it('classifies retryable statuses', () => {
    expect([0, 408, 429, 500, 503].every(isRetryableStatus)).toBe(true);
    expect([200, 301, 400, 401, 404, 410, 422].some(isRetryableStatus)).toBe(false);
  });
});

describe('rate limiting and circuit breaker', () => {
  it('token bucket refills and reports retry-after', () => {
    const b = new TokenBucket(3, 1, 0);
    expect([b.take(0), b.take(0), b.take(0), b.take(0)]).toEqual([true, true, true, false]);
    expect(b.retryAfterSeconds(0)).toBe(1);
    expect(b.take(1500)).toBe(true);
    expect(b.take(1500)).toBe(false);
  });
  it('breaker opens after the threshold, half-opens after the window and closes on success', () => {
    const c = new CircuitBreaker({ failureThreshold: 3, openSeconds: 10 });
    for (let i = 0; i < 3; i++) {
      expect(c.allow(i)).toBe(true);
      c.failure(i);
    }
    expect(c.allow(100)).toBe(false);
    expect(c.status(10_100)).toBe('half_open');
    expect(c.allow(10_100)).toBe(true); // one probe
    expect(c.allow(10_101)).toBe(false);
    c.success();
    expect(c.status(10_200)).toBe('closed');
    c.failure(20_000);
    c.failure(20_001);
    c.failure(20_002);
    expect(c.allow(20_003)).toBe(false);
  });
});

describe('cron', () => {
  it('parses and matches fields, steps and ranges', () => {
    const c = parseCron('*/15 9-17 * * 1-5');
    expect(cronMatches(c, new Date('2026-11-16T09:30:00Z'))).toBe(true); // Monday
    expect(cronMatches(c, new Date('2026-11-16T09:31:00Z'))).toBe(false);
    expect(cronMatches(c, new Date('2026-11-15T09:30:00Z'))).toBe(false); // Sunday
  });
  it('computes the next run in UTC and in an organization time zone', () => {
    expect(nextCronRun('0 0 * * *', new Date('2026-11-18T10:00:00Z'))?.toISOString()).toBe(
      '2026-11-19T00:00:00.000Z',
    );
    // Riyadh is UTC+3 all year
    expect(
      nextCronRun('0 9 * * *', new Date('2026-11-18T00:00:00Z'), 'Asia/Riyadh')?.toISOString(),
    ).toBe('2026-11-18T06:00:00.000Z');
    expect(nextCronRun('30 2 29 2 *', new Date('2026-03-01T00:00:00Z'))?.toISOString()).toBe(
      '2028-02-29T02:30:00.000Z',
    );
  });
  it('rejects bad expressions and time zones', () => {
    for (const bad of [
      '',
      '* * * *',
      '60 * * * *',
      '* 24 * * *',
      '*/0 * * * *',
      'a b c d e',
      '5-1 * * * *',
    ])
      expect(() => parseCron(bad), bad).toThrow();
    expect(isValidTimeZone('Asia/Riyadh')).toBe(true);
    expect(isValidTimeZone('Mars/Base')).toBe(false);
  });
  it('day-of-month OR day-of-week when both are restricted', () => {
    const c = parseCron('0 0 13 * 5');
    expect(cronMatches(c, new Date('2026-11-13T00:00:00Z'))).toBe(true); // 13th and a Friday
    expect(cronMatches(c, new Date('2026-11-20T00:00:00Z'))).toBe(true); // Friday
    expect(cronMatches(c, new Date('2026-11-14T00:00:00Z'))).toBe(false);
  });
});
