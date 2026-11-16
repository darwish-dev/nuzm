import { describe, expect, it } from 'vitest';
import {
  defaultLocale,
  dir,
  formatDateTime,
  formatMinor,
  isLocale,
  missingKeys,
  placeholderMismatches,
  t,
  tDynamic,
} from './index';

describe('i18n', () => {
  it('defaults to Arabic RTL (D-32)', () => {
    expect(defaultLocale).toBe('ar');
    expect(dir('ar')).toBe('rtl');
    expect(dir('en')).toBe('ltr');
  });
  it('has identical keys in ar and en', () => {
    expect(missingKeys()).toEqual([]);
  });
  it('validates locales', () => {
    expect(isLocale('ar')).toBe(true);
    expect(isLocale('fr')).toBe(false);
  });
  it('translates', () => {
    expect(t('en', 'app.web.title')).toContain('Customer');
    expect(t('ar', 'app.web.title')).toContain('نظم');
  });
  it('formats SAR minor units without floating-point storage', () => {
    expect(formatMinor('12345', 'SAR', 'en').replace(/\s/g, ' ')).toBe('SAR 123.45');
    expect(() => formatMinor('12.5', 'SAR', 'en')).toThrow();
    expect(() => formatMinor('100', 'JPY', 'en')).toThrow();
  });
  it('uses the same {placeholders} in both locales', () => {
    expect(placeholderMismatches()).toEqual([]);
  });
  it('fills parameters and leaves unknown ones visible', () => {
    expect(t('en', 'home.title', { name: 'Layla' })).toBe('Welcome, Layla');
    expect(t('ar', 'home.title', { name: 'ليلى' })).toBe('مرحبًا، ليلى');
    expect(t('en', 'home.title')).toBe('Welcome, {name}');
  });
  it('falls back for untranslated dynamic keys', () => {
    expect(tDynamic('en', 'role.viewer', 'viewer')).toBe('Viewer');
    expect(tDynamic('ar', 'role.nonexistent', 'nonexistent')).toBe('nonexistent');
  });
  it('formats timestamps in Asia/Riyadh with Latin digits in both locales', () => {
    const iso = '2026-11-16T09:30:00Z';
    expect(formatDateTime(iso, 'en')).toContain('12:30');
    expect(formatDateTime(iso, 'ar')).toMatch(/12:30/);
  });
});
