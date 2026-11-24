// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('../lib/client', () => ({ browserApi: () => ({ GET: get, POST: post }) }));
import { AiProviderInsightsPanel } from './AiProviderInsightsPanel';
import { ti, type HealthItem, type RegistryItem, type Result } from '../lib/ai-insights';

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});
afterEach(cleanup);

const ok = (data: unknown) => ({ response: { ok: true, status: 200 }, data });
const fail = (status: number, code?: string) => ({
  response: { ok: false, status },
  error: code ? { code } : undefined,
});
const health = (o: Partial<HealthItem> = {}): HealthItem => ({
  key: 'claude',
  status: 'healthy',
  samples: 40,
  successPerMille: 975,
  p50LatencyMs: 800,
  p95LatencyMs: 2100,
  lastErrorCode: 'unavailable',
  lastErrorAt: Date.UTC(2026, 10, 24, 10, 0, 0),
  lastSuccessAt: Date.UTC(2026, 10, 24, 11, 0, 0),
  breaker: 'closed',
  ...o,
});
const reg = (o: Partial<RegistryItem> = {}): RegistryItem => ({
  providerCode: 'claude',
  modelId: 'claude-opus-5-5',
  providerEnabled: false,
  priced: false,
  contextTokens: 1_000_000,
  maxOutputTokens: 128_000,
  effective: ['chat'],
  pending: ['tool-use'],
  capabilities: [
    { capability: 'chat', declared: true, effective: true, basis: 'adapter_declared' },
    { capability: 'tool-use', declared: true, effective: false, basis: 'no_evidence' },
    { capability: 'vision', declared: false, effective: false, basis: 'not_declared' },
  ],
  ...o,
});
const providers = [
  { id: 'p-claude', code: 'claude', displayName: 'Claude' },
  { id: 'p-mock', code: 'mock-model', displayName: 'Mock' },
];
const okRes = <T,>(data: T): Result<T> => ({ ok: true, data });
const panel = (
  o: Partial<Parameters<typeof AiProviderInsightsPanel>[0]> = {},
  locale: 'en' | 'ar' = 'en',
) =>
  render(
    <AiProviderInsightsPanel
      locale={locale}
      health={okRes({ items: [health()] })}
      registry={okRes({ items: [reg()] })}
      providers={providers}
      canManage={true}
      mfaFactorId={null}
      {...o}
    />,
  );
const T = (k: string, p?: Record<string, string | number>) => ti('en', k, p);

describe('health', () => {
  it('shows status, integer percentages, latency and the circuit; the table has a caption', () => {
    panel();
    const table = screen.getByRole('table', { name: T('ins.health.title') });
    expect(within(table).getByText(T('ins.status.healthy'))).toBeTruthy();
    expect(within(table).getByText('97.5%')).toBeTruthy();
    expect(within(table).getByText('800 ms / 2100 ms')).toBeTruthy();
    expect(within(table).getByText(T('ins.breaker.closed'))).toBeTruthy();
    expect(within(table).getByText(/unavailable · 10:00:00 UTC/)).toBeTruthy();
  });
  it('an open circuit is shown as paused; an empty list, an error and a forbidden state each have their own state', () => {
    const { unmount } = panel({
      health: okRes({
        items: [health({ status: 'unhealthy', breaker: 'open', successPerMille: 0 })],
      }),
    });
    expect(screen.getByText(T('ins.breaker.open'))).toBeTruthy();
    unmount();
    panel({ health: okRes({ items: [] }) });
    expect(screen.getByText(T('ins.health.empty'))).toBeTruthy();
    cleanup();
    panel({ health: { ok: false, status: 500 } });
    expect(screen.getByText(T('ins.err.title'))).toBeTruthy();
    // the other sections are not blanked by it
    expect(screen.getByRole('table', { name: T('ins.reg.title') })).toBeTruthy();
    cleanup();
    panel({ health: { ok: false, status: 403 } });
    expect(screen.getByText(T('ins.forbidden.title'))).toBeTruthy();
  });
});

describe('capability registry', () => {
  it('says what is in use, what is pending and why, and that an unpriced model is never offered', () => {
    panel();
    const table = screen.getByRole('table', { name: T('ins.reg.title') });
    expect(within(table).getByText(T('ins.reg.disabled'))).toBeTruthy();
    expect(within(table).getByText(T('ins.reg.noPrice'))).toBeTruthy();
    expect(within(table).getByText(T('ins.reg.effective'))).toBeTruthy();
    expect(within(table).getByText(T('ins.reg.pending'))).toBeTruthy();
    expect(within(table).getByText(T('ins.basis.no_evidence'))).toBeTruthy();
    expect(within(table).getByText(T('ins.basis.adapter_declared'))).toBeTruthy();
    expect(within(table).getByText('1000000 / 128000')).toBeTruthy();
  });
  it('an empty registry has a state', () => {
    panel({ registry: okRes({ items: [] }) });
    expect(screen.getByText(T('ins.reg.empty'))).toBeTruthy();
  });
});

describe('usage report', () => {
  const report = (o: Record<string, unknown> = {}) => ({
    from: 'a',
    to: 'b',
    groupBy: 'model',
    truncated: false,
    rows: [
      {
        providerCode: 'claude',
        modelRef: 'claude-opus-5-5',
        day: null,
        calls: 10,
        okCalls: 9,
        errorCalls: 1,
        estimatedCalls: 0,
        tokensIn: '9007199254740993',
        tokensOut: '2000',
        credits: '5000',
        costMinor: '12345',
        costCurrency: 'USD',
        p50LatencyMs: 700,
        p95LatencyMs: 1900,
      },
    ],
    ...o,
  });
  it('asks for the chosen period and grouping and shows exact integers and money', async () => {
    get.mockResolvedValue(ok(report()));
    panel();
    fireEvent.change(screen.getByLabelText(T('ins.use.range')), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText(T('ins.use.group')), { target: { value: 'model' } });
    fireEvent.click(screen.getByRole('button', { name: T('ins.use.show') }));
    const table = await screen.findByRole('table', { name: T('ins.use.title') });
    const q = get.mock.calls[0]![1].params.query;
    expect(get.mock.calls[0]![0]).toBe('/v1/admin/ai/usage');
    expect(q.groupBy).toBe('model');
    expect(Date.parse(q.to) - Date.parse(q.from)).toBe(7 * 86_400_000);
    expect(within(table).getByText('9007199254740993 / 2000')).toBeTruthy(); // beyond 2^53, exact
    expect(within(table).getByText('123.45 USD')).toBeTruthy();
    expect(within(table).getByText('10 (9 / 1)')).toBeTruthy();
  });
  it('warns when the report was cut, labels mixed currencies and never adds them up', async () => {
    get.mockResolvedValue(
      ok(
        report({
          truncated: true,
          rows: [{ ...report().rows[0], costMinor: null, costCurrency: 'MIXED' }],
        }),
      ),
    );
    panel();
    fireEvent.click(screen.getByRole('button', { name: T('ins.use.show') }));
    expect(await screen.findByText(T('ins.use.truncated'))).toBeTruthy();
    expect(screen.getByText(T('ins.use.mixed'))).toBeTruthy();
  });
  it('has an empty, an error and a forbidden state', async () => {
    get.mockResolvedValueOnce(ok(report({ rows: [] })));
    panel();
    fireEvent.click(screen.getByRole('button', { name: T('ins.use.show') }));
    expect(await screen.findByText(T('ins.use.empty'))).toBeTruthy();
    get.mockResolvedValueOnce(fail(500));
    fireEvent.click(screen.getByRole('button', { name: T('ins.use.show') }));
    await waitFor(() => expect(screen.getAllByText(T('ins.err.title')).length).toBeGreaterThan(0));
    get.mockResolvedValueOnce(fail(403));
    fireEvent.click(screen.getByRole('button', { name: T('ins.use.show') }));
    expect(await screen.findByText(T('ins.forbidden.title'))).toBeTruthy();
  });
});

describe('rate card history', () => {
  it('needs a provider; then lists the versions with their changes', async () => {
    panel();
    const btn = screen.getByRole('button', { name: T('ins.rc.show') }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    get.mockResolvedValue(
      ok({
        items: [
          {
            id: 'v2',
            version: '2',
            recordedBy: '0192abcd-1234-7000-8000-000000000001',
            recordedAt: '2026-11-24T10:00:00.000Z',
            models: {
              'claude-opus-5-5': {
                creditsPerMillionInput: '1800',
                creditsPerMillionOutput: '9000',
              },
            },
            changes: [{ modelId: 'claude-opus-5-5', change: 'changed' }],
          },
          {
            id: 'v1',
            version: '1',
            recordedBy: '0192abcd-1234-7000-8000-000000000001',
            recordedAt: '2026-11-20T10:00:00.000Z',
            models: {
              'claude-opus-5-5': {
                creditsPerMillionInput: '1500',
                creditsPerMillionOutput: '7500',
              },
            },
            changes: [],
          },
        ],
      }),
    );
    fireEvent.change(
      screen.getByLabelText(T('ins.rc.provider'), { selector: '#ins-rc-provider' }),
      { target: { value: 'p-claude' } },
    );
    fireEvent.click(screen.getByRole('button', { name: T('ins.rc.show') }));
    const table = await screen.findByRole('table', { name: T('ins.rc.title') });
    expect(get.mock.calls[0]![1]).toEqual({ params: { path: { id: 'p-claude' } } });
    expect(within(table).getByText('claude-opus-5-5: 1800 / 9000')).toBeTruthy();
    expect(within(table).getByText(T('ins.rc.none'))).toBeTruthy();
    expect(within(table).getAllByText('0192abcd').length).toBe(2);
  });
  it('an empty history has a state', async () => {
    get.mockResolvedValue(ok({ items: [] }));
    panel();
    fireEvent.change(
      screen.getByLabelText(T('ins.rc.provider'), { selector: '#ins-rc-provider' }),
      { target: { value: 'p-mock' } },
    );
    fireEvent.click(screen.getByRole('button', { name: T('ins.rc.show') }));
    expect(await screen.findByText(T('ins.rc.empty'))).toBeTruthy();
  });
});

describe('model discovery', () => {
  const pick = () => {
    fireEvent.change(
      screen.getByLabelText(T('ins.rc.provider'), { selector: '#ins-disc-provider' }),
      { target: { value: 'p-claude' } },
    );
    fireEvent.click(screen.getByRole('button', { name: T('ins.disc.run') }));
  };
  it('is offered only to someone who may manage providers', () => {
    panel({ canManage: false });
    expect(screen.queryByText(T('ins.disc.title'))).toBeNull();
  });
  it('shows what the provider listed, labelled as a live request that is not capability evidence', async () => {
    post.mockResolvedValue(
      ok({
        providerCode: 'claude',
        live: true,
        checkedAt: '2026-11-24T10:00:00.000Z',
        confirmed: ['claude-opus-5-5'],
        unlistedByVendor: [],
        notDeclared: [{ modelId: 'claude-other-1' }],
      }),
    );
    panel();
    expect(screen.getByText(T('ins.disc.help'))).toBeTruthy();
    pick();
    expect(await screen.findByText(T('ins.disc.live'))).toBeTruthy();
    expect(post.mock.calls[0]![0]).toBe('/v1/admin/ai/model-providers/{id}/model-discovery');
    expect(post.mock.calls[0]![1]).toEqual({ params: { path: { id: 'p-claude' } } });
    expect(screen.getByText('claude-other-1')).toBeTruthy();
    expect(
      within(screen.getByText(`${T('ins.disc.confirmed')}:`).closest('p')!).getByText(
        /claude-opus-5-5/,
      ),
    ).toBeTruthy();
  });
  it('explains a refusal while live calls are not approved, and a failed listing', async () => {
    post.mockResolvedValueOnce(fail(422, 'unsupported_capability'));
    panel();
    pick();
    expect(await screen.findByText(T('ins.disc.refused'))).toBeTruthy();
    post.mockResolvedValueOnce(fail(503, 'service_unavailable'));
    fireEvent.click(screen.getByRole('button', { name: T('ins.disc.run') }));
    expect(await screen.findByText(T('ins.disc.failed'))).toBeTruthy();
  });
});

describe('Arabic', () => {
  it('renders the same sections in Arabic', () => {
    panel({}, 'ar');
    expect(screen.getByRole('heading', { name: ti('ar', 'ins.title') })).toBeTruthy();
    expect(screen.getByRole('table', { name: ti('ar', 'ins.health.title') })).toBeTruthy();
    expect(screen.getByText(ti('ar', 'ins.status.healthy'))).toBeTruthy();
    expect(screen.getByRole('button', { name: ti('ar', 'ins.use.show') })).toBeTruthy();
    expect(screen.getByRole('button', { name: ti('ar', 'ins.disc.run') })).toBeTruthy();
  });
});

describe('tool-calling probe', () => {
  const fill = () => {
    fireEvent.change(
      screen.getByLabelText(T('ins.rc.provider'), { selector: '#ins-probe-provider' }),
      { target: { value: 'p-claude' } },
    );
    fireEvent.change(screen.getByLabelText(T('ins.probe.model')), {
      target: { value: 'claude-opus-5-5' },
    });
    fireEvent.change(screen.getByLabelText(T('ins.probe.ref')), {
      target: { value: 'synthetic-D9-ref' },
    });
  };
  it('is offered only to someone who may approve', () => {
    panel({ canApprove: false });
    expect(screen.queryByText(T('ins.probe.title'))).toBeNull();
    cleanup();
    panel({ canApprove: true });
    expect(screen.getByText(T('ins.probe.help'))).toBeTruthy();
  });
  it('refuses an incomplete form on the screen, without calling the API', () => {
    panel({ canApprove: true });
    fireEvent.click(screen.getByTestId('ins-probe-run'));
    expect(screen.getByText(T('ins.probe.invalid'))).toBeTruthy();
    fill();
    fireEvent.change(screen.getByLabelText(T('ins.probe.cap')), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('ins-probe-run'));
    expect(screen.getByText(T('ins.probe.invalid'))).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });
  it('posts the probe action and shows the evidence rows recorded for the model', async () => {
    post.mockResolvedValue(
      ok({
        capabilityEvidence: [
          { model: 'claude-opus-5-5', capability: 'tool-use', state: 'VERIFIED' },
          { model: 'claude-opus-5-5', capability: 'parallel-tool-calls', state: 'NOT VERIFIED' },
          { model: 'other-model', capability: 'tool-use', state: 'VERIFIED' },
        ],
      }),
    );
    panel({ canApprove: true });
    fill();
    fireEvent.click(screen.getByTestId('ins-probe-run'));
    expect(await screen.findByText(T('ins.probe.done'))).toBeTruthy();
    expect(post.mock.calls[0]![0]).toBe('/v1/admin/ai/model-providers');
    expect(post.mock.calls[0]![1].body).toEqual({
      action: 'probe_tool_use',
      id: 'p-claude',
      model: 'claude-opus-5-5',
      approvalRef: 'synthetic-D9-ref',
      maxTotalTokens: 11716,
    });
    expect(screen.getByText(T('ins.probe.state.VERIFIED'))).toBeTruthy();
    expect(screen.getByText(T('ins.probe.state.NOT VERIFIED'))).toBeTruthy();
    expect(screen.queryByText('other-model')).toBeNull();
  });
  it('explains a refusal (nothing was sent)', async () => {
    post.mockResolvedValue(fail(422, 'unsupported_capability'));
    panel({ canApprove: true });
    fill();
    fireEvent.click(screen.getByTestId('ins-probe-run'));
    expect(await screen.findByText(T('ins.probe.refused'))).toBeTruthy();
  });
});
