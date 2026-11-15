import { describe, expect, it } from 'vitest';
import { defaultLocale, dir, formatMinor, isLocale, missingKeys, t } from './index';

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
});
