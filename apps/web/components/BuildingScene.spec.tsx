// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { t } from '@nuzm/i18n';
import { BuildingScene } from './BuildingScene';

afterEach(cleanup);

describe('the preview while the site is being written', () => {
  it('is announced once with the step being worked on, and its drawing is hidden from screen readers', () => {
    const { container } = render(<BuildingScene locale="en" label="Writing the pages 5/6" />);
    expect(screen.getByRole('img', { name: 'Writing the pages 5/6' })).toBeTruthy();
    expect(container.querySelector('.bscene-window')?.getAttribute('aria-hidden')).toBe('true');
  });
  it('falls back to a generic label, and draws the sections that animate in one after another', () => {
    const { container } = render(<BuildingScene locale="en" label="" />);
    expect(screen.getByRole('img', { name: t('en', 'bld.card.working') })).toBeTruthy();
    const delays = [...container.querySelectorAll<HTMLElement>('.bscene-pop')].map((e) =>
      e.style.getPropertyValue('--i'),
    );
    expect(delays).toEqual(['0', '1', '3', '4', '5']);
  });
});
