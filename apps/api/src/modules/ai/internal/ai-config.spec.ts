import { describe, expect, it } from 'vitest';
import { loadAiConfig } from './model';

describe('live provider gate configuration (S-AG4)', () => {
  it('nothing is approved for live calls and Claude stays on contract 1.0 by default', () => {
    const c = loadAiConfig({});
    expect(c.liveProviders).toEqual([]);
    expect(c.claudeContract).toBe('1.0');
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
  it("tool calling for Claude is declared only for the exact value '1.1'", () => {
    expect(loadAiConfig({ AI_CLAUDE_CONTRACT: '1.1' }).claudeContract).toBe('1.1');
    for (const v of ['1.1.0', 'true', '2', '', '1']) {
      expect(loadAiConfig({ AI_CLAUDE_CONTRACT: v }).claudeContract).toBe('1.0');
    }
  });
});
