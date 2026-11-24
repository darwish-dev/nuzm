import { describe, expect, it } from 'vitest';
import * as pkg from './index';
import { PROVIDER_DRAFTS, modelErrorFromHttpStatus } from './provider-drafts';

describe('OpenAI and Gemini integration contracts (D11: contracts only, no adapter)', () => {
  it.each(Object.values(PROVIDER_DRAFTS))('$id is a draft with no adapter, no live gate opened and no vendor statement taken as verified', (d) => {
    expect(d.status).toBe('DRAFT_NOT_IMPLEMENTED');
    expect(d.adapterClass).toBeNull();
    expect(d.sequencing).toMatchObject({ decision: 'D11' });
    expect(d.wireMapping.length).toBeGreaterThanOrEqual(10);
    expect(d.wireMapping.every((r) => r.verified === false && r.source === null)).toBe(true);
    for (const decision of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D9']) expect(d.requiredDecisions.some((x) => x.startsWith(decision + ' '))).toBe(true);
    expect(d.acceptance.join(' ')).toContain('AI_LIVE_PROVIDERS');
    expect(d.mustNotBeAssumed.join(' ')).toMatch(/prices/);
  });
  it('the package exports no OpenAI or Gemini adapter class', () => {
    const names = Object.keys(pkg);
    expect(names.filter((n) => /openai|gemini/i.test(n) && /adapter/i.test(n))).toEqual([]);
  });
  it('maps statuses to contract errors the same way for every provider', () => {
    const e = (s: number, ra?: number) => modelErrorFromHttpStatus(s, ra);
    expect(e(429, 2000)).toMatchObject({ code: 'rate_limited', retryable: true, retryAfterMs: 2000 });
    for (const s of [500, 502, 503, 529, 599]) expect(e(s)).toMatchObject({ code: 'unavailable', retryable: true });
    for (const s of [408, 504, 524]) expect(e(s)).toMatchObject({ code: 'timeout', retryable: true });
    for (const s of [401, 403]) expect(e(s)).toMatchObject({ code: 'invalid_request', retryable: false });
    for (const s of [400, 404, 413, 422, 418, 301]) expect(e(s)).toMatchObject({ code: 'invalid_request', retryable: false, retryAfterMs: undefined });
    expect(e(401, 5000).retryAfterMs).toBeUndefined(); // a hint on a non-retryable error is dropped
    expect(e(Number.NaN).code).toBe('invalid_request');
  });
  it('never carries an upstream message: the text is fixed', () => {
    expect(modelErrorFromHttpStatus(500).message).toBe('the model provider answered with an error (HTTP 500)');
  });
});
