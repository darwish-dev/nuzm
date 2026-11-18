// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
import { AddMethodForm, MethodsTable, PaymentReturn } from './PaymentsPanels';

afterEach(cleanup);

describe('add payment method form (PCI scope reduction)', () => {
  it('contains no free-text field at all: no card number, expiry or CVV can be typed into this app', () => {
    const { container } = render(<AddMethodForm locale="en" sandbox={true} mfaFactorId={null} />);
    expect(container.querySelectorAll('input')).toHaveLength(0);
    expect(container.querySelectorAll('textarea')).toHaveLength(0);
    const options = [...container.querySelectorAll('option')].map((o) => o.getAttribute('value'));
    expect(options).toEqual(['success', 'decline', '3ds', 'timeout']);
    expect(screen.getByText(t('en', 'pay.add.sandbox'))).toBeTruthy();
  });
  it('shows nothing to submit when no sandbox provider is available (a real one is not connected)', () => {
    const { container } = render(<AddMethodForm locale="ar" sandbox={false} mfaFactorId={null} />);
    expect(container.querySelectorAll('form')).toHaveLength(0);
    expect(screen.getByText(t('ar', 'pay.add.unavailable'))).toBeTruthy();
  });
});

describe('payment methods table', () => {
  const rows = [
    {
      id: 'a',
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2099,
      isDefault: true,
      expiring: false,
    },
    {
      id: 'b',
      brand: 'visa',
      last4: '0002',
      expMonth: 1,
      expYear: 2020,
      isDefault: false,
      expiring: false,
    },
    {
      id: 'c',
      brand: 'visa',
      last4: '1111',
      expMonth: 12,
      expYear: 2099,
      isDefault: false,
      expiring: true,
    },
  ];
  it('marks the default, expired and expiring cards, and shows only brand, last four digits and expiry', () => {
    const { container } = render(
      <MethodsTable locale="en" rows={rows} canManage={true} mfaFactorId={null} />,
    );
    expect(screen.getByText(t('en', 'pay.methods.default'))).toBeTruthy();
    expect(screen.getByText(t('en', 'pay.methods.expired'))).toBeTruthy();
    expect(screen.getByText(t('en', 'pay.methods.expiring'))).toBeTruthy();
    expect(screen.getAllByRole('button', { name: t('en', 'pay.methods.remove') })).toHaveLength(3);
    expect(
      screen.getAllByRole('button', { name: t('en', 'pay.methods.makeDefault') }),
    ).toHaveLength(2); // not offered for the default
    expect(container.textContent).toContain('visa ending 4242');
  });
  it('offers no actions to a read-only member', () => {
    render(<MethodsTable locale="en" rows={rows} canManage={false} mfaFactorId={null} />);
    // the table's Cards / Table view switch is not an action
    expect(
      screen.queryAllByRole('button').filter((b) => !b.closest('.nz-view-toggle')),
    ).toHaveLength(0);
  });
});

describe('payment return', () => {
  it('says there is nothing to show when there is no payment id anywhere', async () => {
    sessionStorage.clear();
    render(<PaymentReturn locale="en" paymentId={null} />);
    expect(await screen.findByText(t('en', 'ret.missing'))).toBeTruthy();
  });
});
