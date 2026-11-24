// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

const post = vi.fn();
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock('../lib/client', () => ({ browserApi: () => ({ POST: post }) }));
import { HostingNewSite } from './HostingNewSite';

const ok = (data: unknown, status = 200) => ({ response: { ok: true, status }, data });
const fail = (status: number, code: string) => ({
  response: { ok: false, status },
  error: { code },
});
const plans = [
  { id: 'p1', name: 'Starter', runtimes: ['php:8.3', 'static'], summary: '10 GB', price: null },
  { id: 'p2', name: 'Business', runtimes: ['nodejs:20'], summary: '50 GB', price: '99.00 SAR' },
];
const projects = [{ id: 'pr1', name: 'Shop' }];
const view = () => render(<HostingNewSite locale="en" plans={plans} projects={projects} />);

beforeEach(() => [post, push].forEach((m) => m.mockReset()));
afterEach(cleanup);

describe('add a website', () => {
  it('quotes the chosen plan and runtime, creates the site and opens it', async () => {
    post
      .mockResolvedValueOnce(ok({ id: 'q1' }, 201))
      .mockResolvedValueOnce(ok({ site: { id: 's1' }, operationId: 'o1' }, 202));
    view();
    // choosing a plan offers that plan's runtimes only
    fireEvent.click(screen.getByRole('radio', { name: /Business/ }));
    expect(
      [...(screen.getByLabelText(t('en', 'host.new.runtime')) as HTMLSelectElement).options].map(
        (o) => o.value,
      ),
    ).toEqual(['nodejs:20']);
    fireEvent.change(screen.getByLabelText(t('en', 'host.new.name')), {
      target: { value: 'My shop' },
    });
    fireEvent.change(screen.getByLabelText(t('en', 'host.new.domain')), {
      target: { value: 'Shop.Example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'host.new.go') }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/hosting/sites/s1'));
    expect(post.mock.calls[0]![0]).toBe('/v1/quotes');
    expect(post.mock.calls[0]![1].body).toEqual({
      kind: 'hosting',
      items: [{ planId: 'p2', runtime: 'nodejs:20' }],
    });
    expect(post.mock.calls[1]![0]).toBe('/v1/hosting/sites');
    expect(post.mock.calls[1]![1].body).toEqual({
      quoteId: 'q1',
      planId: 'p2',
      name: 'My shop',
      projectId: 'pr1',
      runtime: 'nodejs:20',
      primaryDomain: 'shop.example.com',
    });
    // both calls are safely retryable
    expect(post.mock.calls[0]![1].params.header['Idempotency-Key']).toBeTruthy();
    expect(post.mock.calls[1]![1].params.header['Idempotency-Key']).toBeTruthy();
  });

  it('explains a full server instead of a generic error, and creates nothing', async () => {
    post
      .mockResolvedValueOnce(ok({ id: 'q1' }, 201))
      .mockResolvedValueOnce(fail(409, 'no_capacity'));
    view();
    fireEvent.change(screen.getByLabelText(t('en', 'host.new.name')), {
      target: { value: 'Blog' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'host.new.go') }));
    expect(await screen.findByText(t('en', 'host.new.noCapacity'))).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });
});
