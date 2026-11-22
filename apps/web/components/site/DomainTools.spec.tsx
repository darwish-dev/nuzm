// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import { DomainTools } from './DomainTools';

describe('public domain tool', () => {
  it('searches and transfers by opening the dashboard pages with plain GET forms, in either language', () => {
    for (const locale of ['en', 'ar'] as const) {
      const { container, unmount } = render(<DomainTools locale={locale} />);
      const search = container.querySelector('#dt-panel-register') as HTMLFormElement;
      const transfer = container.querySelector('#dt-panel-transfer') as HTMLFormElement;
      expect(search.getAttribute('action')).toBe('/domains/search');
      expect(search.method).toBe('get');
      expect(search.querySelector('input[name="q"]')).not.toBeNull();
      expect(
        Array.from(search.querySelectorAll('input[name="tlds"]')).map(
          (i) => (i as HTMLInputElement).value,
        ),
      ).toEqual(['com', 'net', 'org']);
      expect(transfer.getAttribute('action')).toBe('/domains/transfers');
      expect(transfer.querySelector('input[name="domain"]')).not.toBeNull();
      unmount();
    }
  });

  it('never asks for an authorization code, a password or owner details on a public page', () => {
    const { container } = render(<DomainTools locale="en" />);
    const names = Array.from(container.querySelectorAll('input')).map((i) => i.name);
    expect(names.sort()).toEqual(['domain', 'q', 'tlds', 'tlds', 'tlds']);
  });

  it('shows one tool at a time and switches with the tabs', () => {
    const { container } = render(<DomainTools locale="en" />);
    const [register, transfer] = Array.from(container.querySelectorAll('form'));
    expect(register!.hidden).toBe(false);
    expect(transfer!.hidden).toBe(true);
    fireEvent.click(within(container).getByRole('tab', { name: 'Transfers' }));
    expect(register!.hidden).toBe(true);
    expect(transfer!.hidden).toBe(false);
  });
});
