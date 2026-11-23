import { describe, expect, it } from 'vitest';
import { t } from '@nuzm/i18n';
import {
  argsLine,
  bytesLabel,
  callStatusKey,
  fallbackKey,
  isLive,
  isTimeline,
  limitPct,
  modeKey,
  phaseKey,
  stateKey,
  stepStatusKey,
  type Timeline,
} from './agent-timeline';

describe('keys', () => {
  it('a known value gets its own sentence and an unknown one is "unknown", never raw text', () => {
    expect(modeKey('AGENTIC_FELL_BACK')).toBe('agt.mode.AGENTIC_FELL_BACK');
    expect(modeKey('<script>')).toBe('agt.mode.UNKNOWN');
    expect(stateKey('budget_exceeded')).toBe('agt.state.budget_exceeded');
    expect(stateKey(undefined)).toBe('agt.state.UNKNOWN');
    expect(phaseKey('explore')).toBe('agt.phase.explore');
    expect(phaseKey(null)).toBe('agt.phase.UNKNOWN');
    expect(stepStatusKey('waiting_approval')).toBe('agt.stepStatus.waiting_approval');
    expect(callStatusKey('denied')).toBe('agt.callStatus.denied');
    expect(fallbackKey('ceiling_turns')).toBe('agt.fallback.ceiling_turns');
    expect(fallbackKey('whatever')).toBe('agt.fallback.UNKNOWN');
  });

  it('every key exists in Arabic and English', () => {
    const keys = [
      ...['NONE', 'SINGLE_CALL', 'AGENTIC', 'AGENTIC_FELL_BACK', 'x'].map(modeKey),
      ...[
        'queued',
        'running',
        'waiting_approval',
        'succeeded',
        'failed',
        'cancelled',
        'budget_exceeded',
        'x',
      ].map(stateKey),
      ...['plan', 'explore', 'propose', 'validate', 'apply', 'fallback', 'x'].map(phaseKey),
      ...[
        'pending',
        'running',
        'succeeded',
        'failed',
        'waiting_approval',
        'skipped',
        'cancelled',
        'x',
      ].map(stepStatusKey),
      ...['succeeded', 'failed', 'denied', 'waiting_approval', 'x'].map(callStatusKey),
      ...[
        'agentic_disabled',
        'tools_unavailable',
        'no_tool_capable_model',
        'provider_error',
        'invalid_proposal',
        'ceiling_turns',
        'ceiling_time',
        'ceiling_tokens',
        'x',
      ].map(fallbackKey),
    ];
    for (const k of keys) {
      expect(t('ar', k), `ar ${k}`).not.toBe(k);
      expect(t('en', k), `en ${k}`).not.toBe(k);
    }
  });
});

describe('numbers', () => {
  it('a limit is a bounded whole percent; bad numbers are 0, never NaN', () => {
    expect(limitPct({ used: 5, max: 10 })).toBe(50);
    expect(limitPct({ used: 50, max: 10 })).toBe(100);
    expect(limitPct({ used: -3, max: 10 })).toBe(0);
    expect(limitPct({ used: 1, max: 0 })).toBe(0);
    expect(limitPct({ used: 'x', max: 10 })).toBe(0);
    expect(limitPct(undefined)).toBe(0);
  });
  it('byte counts are readable', () => {
    expect(bytesLabel(0)).toBe('0 B');
    expect(bytesLabel(1536)).toBe('1.5 KB');
    expect(bytesLabel(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(bytesLabel(NaN)).toBe('0 B');
    expect(bytesLabel('9')).toBe('0 B');
  });
});

describe('arguments and shape', () => {
  it('shows redacted arguments as one bounded line', () => {
    expect(argsLine({ path: 'src/a.ts', limit: 5 })).toBe('path=src/a.ts limit=5');
    expect(argsLine(null)).toBe('');
    expect(argsLine([1])).toBe('');
    expect(argsLine({ q: 'x'.repeat(500) }).length).toBeLessThanOrEqual(160);
  });
  it('only a timeline of the expected shape is accepted', () => {
    const ok = { planId: 'p', mode: 'AGENTIC', steps: [], limits: {} };
    expect(isTimeline(ok)).toBe(true);
    expect(isTimeline({ ...ok, steps: 'x' })).toBe(false);
    expect(isTimeline(null)).toBe(false);
    expect(isTimeline({ message: 'nope' })).toBe(false);
  });
  it('polls only while the run is moving', () => {
    const tl = (runState: string | null) => ({ runState }) as unknown as Timeline;
    expect(isLive(tl('running'))).toBe(true);
    expect(isLive(tl('queued'))).toBe(true);
    expect(isLive(tl('succeeded'))).toBe(false);
    expect(isLive(null)).toBe(false);
  });
});
