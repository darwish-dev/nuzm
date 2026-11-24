// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
import { parseOverview, parseScorecard } from '../lib/benchmarks';
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
    dataset: {
      version: '2.0.0',
      hash: 'a'.repeat(64),
      tasks: 3,
      perCategory: { erp: 3 },
      categories: ['erp'],
    },
    thresholds: {
      version: '2-proposed',
      status: 'PROPOSED',
      acceptance: null,
      items: [
        {
          id: 'T01',
          scope: 'all',
          metric: 'validPatchRate',
          op: '>=',
          value: 0.95,
          why: 'because',
        },
      ],
    },
    budget: null,
    securityReview: null,
    reviewers: [],
    runs: [
      {
        id: 'r1',
        label: 'reference',
        createdAt: '2026-12-01T00:00:00.000Z',
        datasetVersion: '2.0.0',
        evidence: 'OFFLINE_REFERENCE_ORACLE',
        adapters: ['reference-oracle:reference'],
        tasks: 3,
        passRate: 1,
        meanQuality: 100,
        meanSecurity: 100,
        modeViolations: 0,
      },
    ],
    qualifications: [],
    live: {
      available: false,
      stages: {
        rateBasis: {
          model: 'Claude Opus 5.5',
          source: 'vendor list price, read 2026-11-24',
          status: 'TO_BE_CONFIRMED_BY_S02_D6',
        },
        prices: { currency: 'USD', input: '400', output: '2000' },
        assumptions: { usagePermille: 600, inputSharePermille: 850 },
        plans: ['A', 'B', 'C', 'D', 'E'].map((stage) => ({
          stage,
          tasks: 5,
          runs: 5,
          models: stage === 'D' ? 2 : 1,
          currency: 'USD',
          max: { tokens: 220000, requests: 30, costMinor: stage === 'C' ? '8360' : '440' },
          estimate: { tokens: 132000, costMinor: '88' },
          duration: { estimatedMinutes: 4, maximumMinutes: 8 },
        })),
        definitions: [{ id: 'E', prerequisites: ['PROVIDER_VERIFIED', 'BASELINE_RECORDED'] }],
        monthly: { estimateCostMinor: '3400', maxCostMinor: '17000' },
      },
    },
    ...over,
  });

describe.each(['en', 'ar'] as const)('BenchmarksDashboard (%s)', (locale) => {
  it('says offline evidence is not a model, shows thresholds as PROPOSED and the live runner as unavailable', () => {
    render(<BenchmarksDashboard locale={locale} overview={full()} canRecord />);
    expect(screen.getAllByRole('status')[0]!.textContent).toContain(
      bt(locale, 'notice').slice(0, 20),
    );
    expect(screen.getByText(bt(locale, 'thresholdsProposed'))).toBeTruthy();
    expect(screen.getByText(bt(locale, 'evidenceLabel_OFFLINE_REFERENCE_ORACLE'))).toBeTruthy();
    expect(screen.getByText(new RegExp(bt(locale, 'liveUnavailable').slice(0, 12)))).toBeTruthy();
    expect(screen.getByText(bt(locale, 'qualificationEmpty'))).toBeTruthy();
    expect(screen.getByText(bt(locale, 'budgetNone'), { exact: false })).toBeTruthy();
  });
  it('is the switched-off state when the flag is off, and the empty state without runs', () => {
    const { unmount } = render(
      <BenchmarksDashboard
        locale={locale}
        overview={parseOverview({ enabled: false })}
        canRecord
      />,
    );
    expect(screen.getByText(bt(locale, 'disabled'))).toBeTruthy();
    unmount();
    render(<BenchmarksDashboard locale={locale} overview={full({ runs: [] })} canRecord={false} />);
    expect(screen.getByText(bt(locale, 'runsEmpty'))).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
  });
  it('shows the acceptance when the owner accepted the thresholds', () => {
    render(
      <BenchmarksDashboard
        locale={locale}
        overview={full({
          thresholds: {
            version: '2-proposed',
            status: 'ACCEPTED',
            acceptance: { acceptedBy: 'owner-1', acceptedAt: '2026-12-01T00:00:00.000Z' },
            items: [],
          },
        })}
        canRecord
      />,
    );
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

/** the section a heading id labels (a table with a caption is a region of its own, so a role query by name would match twice) */
const section = (id: string): HTMLElement => document.getElementById(id)!.closest('section')!;

const card = parseScorecard({
  scorecard: [
    {
      dimension: 'functional',
      value: 100,
      unit: 'score',
      tasks: 83,
      thresholds: [{ id: 'T16', status: 'PASS' }],
    },
    {
      dimension: 'arabic-rtl',
      value: 0.84,
      unit: 'rate',
      tasks: 25,
      thresholds: [{ id: 'T19', status: 'FAIL' }],
    },
    {
      dimension: 'latency',
      value: null,
      unit: 'ms',
      tasks: 0,
      thresholds: [{ id: 'T11', status: 'NOT MEASURED' }],
    },
  ],
});

describe.each(['en', 'ar'] as const)('BenchmarksDashboard Phase 2 sections (%s)', (locale) => {
  it('shows the five stages with estimated and maximum cost, all blocked, and says the rate is not approved', () => {
    render(<BenchmarksDashboard locale={locale} overview={full()} canRecord={false} />);
    const region = section('bench-stages');
    for (const id of ['A', 'B', 'C', 'D', 'E'] as const)
      expect(within(region).getByText(bt(locale, `stageName_${id}`))).toBeTruthy();
    expect(within(region).getAllByText(bt(locale, 'stageBlocked'))).toHaveLength(5);
    expect(within(region).getByText('83.60 USD')).toBeTruthy(); // the maximum of stage C, integer arithmetic
    expect(within(region).getByText('5 × 2')).toBeTruthy(); // stage D covers two models
    expect(
      within(region).getByText(new RegExp(bt(locale, 'rateReference').slice(0, 10))),
    ).toBeTruthy();
    expect(within(region).getByText(bt(locale, 'prereq_PROVIDER_VERIFIED'))).toBeTruthy();
    expect(within(region).getByText(bt(locale, 'prereq_BASELINE_RECORDED'))).toBeTruthy();
    expect(within(region).getByText(/60%/)).toBeTruthy();
  });
  it('shows the rate as approved when it came with the budget', () => {
    const base = full();
    const overview = {
      ...base,
      stages: {
        ...base.stages!,
        rateBasis: { model: null, source: 'agreement 1', status: 'APPROVED_WITH_BUDGET' },
      },
    };
    render(<BenchmarksDashboard locale={locale} overview={overview} canRecord={false} />);
    expect(screen.getByText(bt(locale, 'rateApproved', { source: 'agreement 1' }))).toBeTruthy();
  });
  it('omits the plan when the API sent none, and shows the empty scorecard state', () => {
    const base = full();
    render(
      <BenchmarksDashboard
        locale={locale}
        overview={{ ...base, stages: null }}
        canRecord={false}
      />,
    );
    expect(document.getElementById('bench-stages')).toBeNull();
    expect(screen.getByText(bt(locale, 'scorecardEmpty'))).toBeTruthy();
  });
  it('shows the scorecard with pass, fail and not-measured as text, not colour alone', () => {
    render(
      <BenchmarksDashboard locale={locale} overview={full()} canRecord={false} scorecard={card} />,
    );
    const region = section('bench-score');
    expect(within(region).getByText(bt(locale, 'dim_functional'))).toBeTruthy();
    expect(within(region).getByText('84%')).toBeTruthy();
    expect(within(region).getByText(bt(locale, 'statusPass'))).toBeTruthy();
    expect(within(region).getByText(bt(locale, 'statusFail'))).toBeTruthy();
    expect(within(region).getAllByText(bt(locale, 'statusNotMeasured')).length).toBeGreaterThan(0);
    expect(within(region).getAllByText(bt(locale, 'notMeasured')).length).toBeGreaterThan(0);
  });
  it('a non-manager sees no action form but still sees the plan (read-only)', () => {
    render(<BenchmarksDashboard locale={locale} overview={full()} canRecord={false} />);
    expect(screen.queryByRole('button', { name: bt(locale, 'record') })).toBeNull();
    expect(section('bench-stages')).toBeTruthy();
  });
});
