import { describe, expect, it } from 'vitest';
import {
  INSIGHT_TEXT,
  breakerTone,
  healthTone,
  moneyText,
  msText,
  percentText,
  shortId,
  ti,
  toResult,
  usageRange,
} from './ai-insights';

describe('text: Arabic and English are complete', () => {
  it('every key has a non-empty text in both languages, with the same placeholders', () => {
    const en = Object.keys(INSIGHT_TEXT.en);
    expect(Object.keys(INSIGHT_TEXT.ar).sort()).toEqual([...en].sort());
    for (const k of en) {
      const e = (INSIGHT_TEXT.en as Record<string, string>)[k]!;
      const a = (INSIGHT_TEXT.ar as Record<string, string>)[k]!;
      expect(e.trim().length, `en ${k}`).toBeGreaterThan(0);
      expect(a.trim().length, `ar ${k}`).toBeGreaterThan(0);
      const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
      expect(ph(a), k).toBe(ph(e));
    }
  });
  it('the Arabic text contains Arabic letters (no English left behind), except identifiers', () => {
    const latin = /[A-Za-z]{4,}/;
    const allowed = new Set(['ins.health.latency', 'ins.use.col.latency']); // p50 / p95 are identifiers
    for (const [k, v] of Object.entries(INSIGHT_TEXT.ar))
      if (!allowed.has(k)) expect(latin.test(v.replace(/\{\w+\}/g, '')), `${k}: ${v}`).toBe(false);
  });
  it('replaces placeholders, and shows the key for an unknown key', () => {
    expect(ti('en', 'ins.use.days', { n: 30 })).toBe('Last 30 days');
    expect(ti('ar', 'ins.use.days', { n: 7 })).toContain('7');
    expect(ti('en', 'ins.nope')).toBe('ins.nope');
  });
});

describe('formatting without floats', () => {
  it('per mille to percent', () => {
    expect(percentText(975)).toBe('97.5%');
    expect(percentText(1000)).toBe('100.0%');
    expect(percentText(0)).toBe('0.0%');
    expect(percentText(5)).toBe('0.5%');
    for (const bad of [null, -1, 1001, 1.5]) expect(percentText(bad as never)).toBe('—');
  });
  it('minor units to an exact decimal with the currency', () => {
    expect(moneyText('12345', 'USD')).toBe('123.45 USD');
    expect(moneyText('5', 'USD')).toBe('0.05 USD');
    expect(moneyText('1234', 'KWD')).toBe('1.234 KWD');
    expect(moneyText('150', 'JPY')).toBe('150 JPY');
    expect(moneyText('-250', 'SAR')).toBe('-2.50 SAR');
    expect(moneyText('9007199254740993123', 'USD')).toBe('90071992547409931.23 USD'); // beyond 2^53: exact
    expect(moneyText('77', 'XYZ')).toBe('77 XYZ (minor units)');
    expect(moneyText(null, 'USD')).toBe('—');
    expect(moneyText('12', 'MIXED')).toBe('12');
    expect(moneyText('1.5', 'USD')).toBe('—');
  });
  it('latency, ids, tones and the range', () => {
    expect(msText(1200)).toBe('1200 ms');
    expect(msText(null)).toBe('—');
    expect(shortId('0192abcd-1234-7000-8000-000000000001')).toBe('0192abcd');
    expect(healthTone('healthy')).toBe('success');
    expect(healthTone('unhealthy')).toBe('danger');
    expect(healthTone('unknown')).toBeUndefined();
    expect(breakerTone('closed')).toBe('success');
    expect(breakerTone('open')).toBe('danger');
    const r = usageRange(30, new Date('2026-11-24T12:00:00Z'));
    expect(r).toEqual({ from: '2026-10-25T12:00:00.000Z', to: '2026-11-24T12:00:00.000Z' });
  });
  it('toResult keeps only what a section needs', () => {
    expect(toResult({ response: { ok: true, status: 200 }, data: { a: 1 } })).toEqual({
      ok: true,
      data: { a: 1 },
    });
    expect(toResult({ response: { ok: false, status: 403 } })).toEqual({ ok: false, status: 403 });
    expect(toResult({ response: { ok: true, status: 200 } })).toEqual({ ok: false, status: 200 });
  });
});
