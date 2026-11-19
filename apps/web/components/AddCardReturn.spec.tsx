// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

const push = vi.fn();
const post = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock('../lib/client', () => ({ browserApi: () => ({ POST: post }) }));
import { AddMethodForm } from './PaymentsPanels';

afterEach(() => {
  cleanup();
  push.mockReset();
  post.mockReset();
});

describe('saving a card from the checkout', () => {
  it('goes back to the checkout after the card is saved', async () => {
    post.mockResolvedValue({ data: {}, response: { ok: true, status: 201 } });
    render(<AddMethodForm locale="en" sandbox={true} mfaFactorId={null} next="/en/checkout" />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'pay.add.submit') }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/en/checkout'));
  });
  it('goes to the payments page when it was not opened from the checkout', async () => {
    post.mockResolvedValue({ data: {}, response: { ok: true, status: 201 } });
    render(<AddMethodForm locale="en" sandbox={true} mfaFactorId={null} />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'pay.add.submit') }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/en/billing/payments#methods'));
  });
});
