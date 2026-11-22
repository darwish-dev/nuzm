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
});
