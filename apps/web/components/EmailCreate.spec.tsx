// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';
import { NewMailboxForm } from './EmailPanels';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
afterEach(cleanup);

const domains = [
  { id: 'd1', domain: 'nuzm.sa' },
  { id: 'd2', domain: 'example.com' },
] as never;
const form = () => render(<NewMailboxForm locale="en" domains={domains} mfaFactorId={null} />);

describe('mailbox creation (landing-style)', () => {
  it('shows the live address as the name and domain are chosen, and the storage presets set the quota', () => {
    const { container } = form();
    expect(container.querySelector('.ld-preview')).toBeNull();
    fireEvent.change(screen.getByLabelText(t('en', 'm8.mb.local')), { target: { value: 'Info' } });
    fireEvent.change(screen.getByLabelText(t('en', 'm8.emd.domain')), { target: { value: 'd2' } });
    expect(container.querySelector('.ld-preview bdi')?.textContent).toBe('info@example.com');
    const five = screen.getByRole('button', { name: t('en', 'ld.mail.gb', { n: 5 }) });
    fireEvent.click(five);
    expect(five.getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText(t('en', 'ld.mail.custom')) as HTMLInputElement).value).toBe(
      '5120',
    );
  });
  it('refuses an invalid name or quota before asking for a price, with the reason beside the field', () => {
    form();
    fireEvent.change(screen.getByLabelText(t('en', 'm8.mb.local')), { target: { value: 'a b' } });
    fireEvent.change(screen.getByLabelText(t('en', 'ld.mail.custom')), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('en', 'm8.q.request')) }));
    expect(screen.getByRole('alert').textContent).toContain(t('en', 'm8.mb.err.local'));
    expect(screen.getByLabelText(t('en', 'm8.mb.local')).getAttribute('aria-invalid')).toBe('true');
  });
  it('without a domain it says so instead of showing the form', () => {
    render(<NewMailboxForm locale="en" domains={[]} mfaFactorId={null} />);
    expect(screen.getByText(t('en', 'm8.mb.noDomains'), { exact: false })).toBeTruthy();
  });
});
