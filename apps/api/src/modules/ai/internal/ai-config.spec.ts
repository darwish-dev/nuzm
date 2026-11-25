import { describe, expect, it } from 'vitest';
import { loadAiConfig } from './model';

describe('live provider gate configuration (S-AG4)', () => {
  it('nothing is approved for live calls by default, and unattested providers never get sensitive content (D10)', () => {
    const c = loadAiConfig({});
    expect(c.liveProviders).toEqual([]);
    expect(c.allowUnattestedForSensitive).toBe(false);
  });
  it("only the exact value 'true' lets an unattested provider receive sensitive content (D10: it must stay false)", () => {
    expect(
      loadAiConfig({ AI_ALLOW_UNATTESTED_SENSITIVE: 'true' }).allowUnattestedForSensitive,
    ).toBe(true);
    for (const v of ['1', 'yes', 'TRUE', '', 'false'])
      expect(loadAiConfig({ AI_ALLOW_UNATTESTED_SENSITIVE: v }).allowUnattestedForSensitive).toBe(
        false,
      );
  });
  it('only the listed, well-formed provider codes are approved', () => {
    expect(
      loadAiConfig({ AI_LIVE_PROVIDERS: ' claude , acme-ai ,,BAD CODE,../x,' }).liveProviders,
    ).toEqual(['claude', 'acme-ai']);
  });
  it('production never approves a live provider through this setting (the production vault is not decided, D-12)', () => {
    expect(
      loadAiConfig({ NODE_ENV: 'production', AI_LIVE_PROVIDERS: 'claude' }).liveProviders,
    ).toEqual([]);
  });

  it('spending limits: no output ceiling and two repairs by default; set values are read exactly', () => {
    expect(loadAiConfig({})).toMatchObject({ maxOutputTokensCeiling: null, repairAttempts: 2 });
    expect(
      loadAiConfig({ AI_MAX_OUTPUT_TOKENS: '512', AI_MAX_REPAIR_ATTEMPTS: '0' }),
    ).toMatchObject({ maxOutputTokensCeiling: 512, repairAttempts: 0 });
  });
  it('a malformed spending limit stops the process instead of being dropped', () => {
    for (const v of ['abc', '0', '-1', '12.5', '200001'])
      expect(() => loadAiConfig({ AI_MAX_OUTPUT_TOKENS: v })).toThrow(/AI_MAX_OUTPUT_TOKENS/);
    for (const v of ['3', '-1', 'none'])
      expect(() => loadAiConfig({ AI_MAX_REPAIR_ATTEMPTS: v })).toThrow(/AI_MAX_REPAIR_ATTEMPTS/);
  });
  it('resilience defaults: bounded retries with backoff, a breaker that opens after 5 consecutive health failures, and no fallback restriction', () => {
    const c = loadAiConfig({});
    expect(c).toMatchObject({
      attemptsPerCandidate: 2,
      retryBaseDelayMs: 200,
      retryMaxDelayMs: 5000,
      breakerFailureThreshold: 5,
      breakerOpenMs: 30000,
      fallbackPolicy: null,
    });
  });
  it('resilience settings are read, floored and sanitised', () => {
    const c = loadAiConfig({
      AI_RETRY_BASE_MS: '10.9',
      AI_BREAKER_THRESHOLD: '0',
      AI_BREAKER_OPEN_MS: 'x',
      AI_ATTEMPTS_PER_CANDIDATE: '3',
    });
    expect(c).toMatchObject({
      retryBaseDelayMs: 10,
      breakerFailureThreshold: 5,
      breakerOpenMs: 30000,
      attemptsPerCandidate: 3,
    });
  });
  it('the fallback policy is read only when well-formed; anything else keeps the safe default', () => {
    const ok = JSON.stringify({
      mode: 'approved_only',
      approved: { 'claude/claude-opus-5-5': ['mock-a/m'] },
    });
    expect(loadAiConfig({ AI_FALLBACK_POLICY: ok }).fallbackPolicy).toEqual({
      mode: 'approved_only',
      approved: { 'claude/claude-opus-5-5': ['mock-a/m'] },
    });
    for (const bad of [
      '',
      'not json',
      '[]',
      '{"mode":"nope"}',
      '{"mode":"approved_only","approved":{"x":[]}}',
    ])
      expect(loadAiConfig({ AI_FALLBACK_POLICY: bad }).fallbackPolicy).toBeNull();
  });
});
