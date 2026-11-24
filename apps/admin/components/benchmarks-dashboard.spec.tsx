// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
import { parseOverview } from '../lib/benchmarks';
import { bt } from '../lib/benchmarks-text';
import { BenchmarksDashboard } from './benchmarks-dashboard';

const fetchMock = vi.fn();
beforeEach(() => {
  refresh.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const full = (over: Record<string, unknown> = {}) =>
  parseOverview({
    enabled: true,
    dataset: { version: '2.0.0', hash: 'a'.repeat(64), tasks: 3, perCategory: { erp: 3 }, categories: ['erp'] },
    thresholds: { version: '2-proposed', status: 'PROPOSED', acceptance: null, items: [{ id: 'T01', scope: 'all', metric: 'validPatchRate', op: '>=', value: 0.95, why: 'because' }] },
    budget: null,
    securityReview: null,
    reviewers: [],
    runs: [{ id: 'r1', label: 'reference', createdAt: '2026-12-01T00:00:00.000Z', datasetVersion: '2.0.0', evidence: 'OFFLINE_REFERENCE_ORACLE', adapters: ['reference-oracle:reference'], tasks: 3, passRate: 1, meanQuality: 100, meanSecurity: 100, modeViolations: 0 }],
    qualifications: [],
    live: { available: false },
    ...over,
  });

describe.each(['en', 'ar'] as const)('BenchmarksDashboard (%s)', (locale) => {
  it('says offline evidence is not a model, shows thresholds as PROPOSED and the live runner as unavailable', () => {
    render(<BenchmarksDashboard locale={locale} overview={full()} canRecord />);
    expect(screen.getAllByRole('status')[0]!.textContent).toContain(bt(locale, 'notice').slice(0, 20));
    expect(screen.getByText(bt(locale, 'thresholdsProposed'))).toBeTruthy();
    expect(screen.getByText(bt(locale, 'evidenceLabel_OFFLINE_REFERENCE_ORACLE'))).toBeTruthy();
    expect(screen.getByText(new RegExp(bt(locale, 'liveUnavailable').slice(0, 12)))).toBeTruthy();
    expect(screen.getByText(bt(locale, 'qualificationEmpty'))).toBeTruthy();
    expect(screen.getByText(bt(locale, 'budgetNone'), { exact: false })).toBeTruthy();
  });
  it('is the switched-off state when the flag is off, and the empty state without runs', () => {
    const { unmount } = render(<BenchmarksDashboard locale={locale} overview={parseOverview({ enabled: false })} canRecord />);
    expect(screen.getByText(bt(locale, 'disabled'))).toBeTruthy();
    unmount();
    render(<BenchmarksDashboard locale={locale} overview={full({ runs: [] })} canRecord={false} />);
    expect(screen.getByText(bt(locale, 'runsEmpty'))).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
  });
  it('shows the acceptance when the owner accepted the thresholds', () => {
    render(<BenchmarksDashboard locale={locale} overview={full({ thresholds: { version: '2-proposed', status: 'ACCEPTED', acceptance: { acceptedBy: 'owner-1', acceptedAt: '2026-12-01T00:00:00.000Z' }, items: [] } })} canRecord />);
    expect(screen.queryByText(bt(locale, 'thresholdsProposed'))).toBeNull();
    expect(screen.getByText(/owner-1/)).toBeTruthy();
  });
  it('records an offline replay once per click through the CSRF-protected admin endpoint, then refreshes', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    render(<BenchmarksDashboard locale={locale} overview={full()} canRecord />);
    fireEvent.click(screen.getByRole('button', { name: bt(locale, 'record') }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/v1/admin/ai/benchmarks');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ action: 'run_offline', source: 'reference' });
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(init.headers['x-nuzm-realm']).toBe('admin');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.getByText(bt(locale, 'recorded'))).toBeTruthy();
  });
  it('shows a refusal and does not refresh when the server refuses', async () => {
    fetchMock.mockResolvedValue({ ok: false });
    render(<BenchmarksDashboard locale={locale} overview={full()} canRecord />);
    fireEvent.click(screen.getByRole('button', { name: bt(locale, 'record') }));
    await waitFor(() => expect(screen.getByText(bt(locale, 'failed'))).toBeTruthy());
    expect(refresh).not.toHaveBeenCalled();
  });
});
