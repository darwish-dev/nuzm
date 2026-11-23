// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';
import { AgentTimeline } from './AgentTimeline';
import type { Timeline } from '../lib/agent-timeline';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let calls: { url: string; method: string }[] = [];
const mockFetch = (h: (url: string) => Response) => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: String(init.method ?? 'GET') });
      return h(url);
    }),
  );
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const limit = (used: number, max: number) => ({ used, max });
const tl = (o: Partial<Timeline> = {}): Timeline =>
  ({
    planId: 'pl1',
    runId: 'r1',
    mode: 'AGENTIC',
    runState: 'succeeded',
    fellBack: null,
    plan: 'Add a pricing page after reading the layout.',
    limits: {
      turns: limit(2, 8),
      toolCalls: limit(2, 60),
      resultBytes: limit(2048, 400000),
      tokens: limit(900, 60000),
      seconds: limit(3, 300),
    },
    steps: [
      {
        seq: 0,
        node: 'turn-1',
        phase: 'plan',
        status: 'succeeded',
        errorCode: null,
        reason: null,
        tokensIn: 400,
        tokensOut: 100,
        startedAt: null,
        finishedAt: null,
        toolCalls: [
          {
            callId: 'c1',
            tool: 'read_file',
            args: { path: 'src/app/page.tsx' },
            status: 'succeeded',
            errorCode: null,
            resultBytes: 1536,
            durationMs: 4,
          },
          {
            callId: 'c2',
            tool: 'search_text',
            args: { query: 'x' },
            status: 'denied',
            errorCode: 'limit_exceeded',
            resultBytes: 0,
            durationMs: null,
          },
        ],
      },
      {
        seq: 100,
        node: 'validate',
        phase: 'validate',
        status: 'succeeded',
        errorCode: null,
        reason: null,
        tokensIn: 0,
        tokensOut: 0,
        startedAt: null,
        finishedAt: null,
        toolCalls: [],
      },
    ],
    outcome: {
      outcome: 'adapted',
      summary: 'Added pricing',
      patches: 2,
      versionId: 'v2',
      branch: 'work/ai',
    },
    ...o,
  }) as unknown as Timeline;
const ui = (locale: 'en' | 'ar' = 'en') => render(<AgentTimeline locale={locale} planId="pl1" />);

describe('the read-only timeline', () => {
  it('shows the plan, each step with its phase, the tool calls with redacted arguments and sizes, the limits and the outcome', async () => {
    mockFetch(() => json(200, tl()));
    ui();
    await screen.findByTestId('agt-steps');
    expect(calls[0]).toEqual({
      url: '/v1/builder/generation-plans/pl1/timeline',
      method: 'GET',
    });
    expect(screen.getByTestId('agt-plan').textContent).toContain('pricing page');
    expect(screen.getByTestId('agt-step-turn-1').textContent).toContain(t('en', 'agt.phase.plan'));
    expect(screen.getAllByTestId('agt-call')).toHaveLength(2);
    expect(screen.getByText('read_file')).toBeTruthy();
    expect(screen.getByText(t('en', 'agt.callStatus.denied'))).toBeTruthy();
    expect(screen.getByText(/path=src\/app\/page\.tsx/)).toBeTruthy();
    expect(screen.getByTestId('agt-limits').textContent).toContain('2 of 8');
    expect(screen.getByTestId('agt-outcome').textContent).toContain(t('en', 'agt.outcome.adapted'));
    expect(screen.getByTestId('agt-outcome').textContent).toContain('work/ai');
  });

  it('is read-only: the only control is the refresh button, nothing is posted', async () => {
    mockFetch(() => json(200, tl()));
    ui();
    await screen.findByTestId('agt-steps');
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([t('en', 'agt.refresh')]);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('says why a run fell back to the single call', async () => {
    mockFetch(() =>
      json(200, tl({ mode: 'AGENTIC_FELL_BACK', fellBack: 'ceiling_turns' } as Partial<Timeline>)),
    );
    ui();
    const b = await screen.findByTestId('agt-fallback');
    expect(b.textContent).toContain(t('en', 'agt.fallback.ceiling_turns'));
  });

  it('renders in Arabic', async () => {
    mockFetch(() => json(200, tl()));
    ui('ar');
    await screen.findByTestId('agt-steps');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(t('ar', 'agt.title'));
    expect(screen.getByTestId('agt-outcome').textContent).toContain(t('ar', 'agt.outcome.adapted'));
  });

  it('empty: a plan without a run; single call: no steps', async () => {
    mockFetch(() =>
      json(200, tl({ mode: 'NONE', runId: null, steps: [], outcome: null } as Partial<Timeline>)),
    );
    ui();
    await screen.findByText(t('en', 'agt.none'));
    cleanup();
    mockFetch(() => json(200, tl({ mode: 'SINGLE_CALL', steps: [] } as Partial<Timeline>)));
    ui();
    await screen.findByText(t('en', 'agt.single'));
  });

  it('error and forbidden states show a message by code (never the raw text) and offer a retry', async () => {
    mockFetch(() =>
      json(403, {
        type: 'x',
        title: 'raw server text',
        status: 403,
        code: 'forbidden',
        traceId: 'tr-9',
      }),
    );
    ui();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain('raw server text');
    expect(alert.textContent).toContain('tr-9');
    expect(screen.getByText(t('en', 'agt.retry'))).toBeTruthy();
    cleanup();
    mockFetch(() => json(200, { unexpected: true }));
    ui();
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('shows a text a model produced as text, never as markup', async () => {
    mockFetch(() => json(200, tl({ plan: '<img src=x onerror=alert(1)>' } as Partial<Timeline>)));
    ui();
    const p = await screen.findByTestId('agt-plan');
    expect(p.querySelector('img')).toBeNull();
    expect(p.textContent).toContain('<img');
  });
});
