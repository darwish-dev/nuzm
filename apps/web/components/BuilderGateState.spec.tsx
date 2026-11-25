// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { missingKeys, t, type Locale } from '@nuzm/i18n';
import { NotEnabledState } from './BuilderParts';

/** DEFECT-20d: the "not enabled" state names the capability that is missing and shows no flag key. */
afterEach(cleanup);
const LOCALES: Locale[] = ['ar', 'en'];

describe.each(LOCALES)('NotEnabledState (%s)', (locale) => {
  it('app builder off: the app-builder message (the default)', () => {
    render(<NotEnabledState locale={locale} />);
    expect(screen.getByText(t(locale, 'm10.notEnabled.title'))).toBeTruthy();
    expect(screen.queryByText(t(locale, 'bt.gate.ai.title'))).toBeNull();
  });
  it('AI capability off: says AI, does not blame the app builder, shows no flag key', () => {
    const { container } = render(<NotEnabledState locale={locale} capability="ai" />);
    expect(screen.getByText(t(locale, 'bt.gate.ai.title'))).toBeTruthy();
    expect(screen.getByText(t(locale, 'bt.gate.ai.body'))).toBeTruthy();
    expect(screen.queryByText(t(locale, 'm10.notEnabled.title'))).toBeNull();
    expect(container.textContent ?? '').not.toMatch(/ai\.enabled|app_builder/);
  });
  it('the new keys exist in both languages', () => {
    expect(missingKeys()).toEqual([]);
    expect(t(locale, 'bt.gate.ai.title')).not.toBe('bt.gate.ai.title');
    expect(t(locale, 'bt.lc.state.missing')).not.toBe('bt.lc.state.missing');
  });
});
