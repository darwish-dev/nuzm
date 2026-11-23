// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';
import { TemplateWorkspace } from './TemplateWorkspace';
import type { Workspace } from '../lib/generation';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
const mockFetch = (h: (url: string, method: string) => Response) => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: String(init.method),
        headers: init.headers as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return h(url, String(init.method));
    }),
  );
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const linked = (o: Partial<Workspace> = {}): Workspace =>
  ({
    linked: true,
    project: { id: 'p1', headVersionId: 'v1' },
    copiedAt: '2026-11-21T10:00:00.000Z',
    templateAvailable: true,
    template: {
      resourceId: 'r1',
      versionId: 'tv1',
      versionSeq: 2,
      name: 'Starter Dashboard',
      license: 'MIT',
    },
    diff: {
      added: ['src/mine.ts'],
      modified: ['src/app/page.tsx'],
      removed: ['README.md'],
      unchanged: 3,
      baselineFiles: 5,
      currentFiles: 5,
      departure: 40,
      truncated: false,
      counts: { added: 1, modified: 1, removed: 1 },
    },
    ...o,
  }) as Workspace;
const ui = (w: Workspace, o: { canWrite?: boolean; canRun?: boolean; agentic?: boolean } = {}) =>
  render(
    <TemplateWorkspace
      locale="en"
      projectId="p1"
      workspace={w}
      canWrite={o.canWrite ?? true}
      canRun={o.canRun ?? true}
      agentic={o.agentic ?? false}
    />,
  );

describe('the comparison', () => {
  it("shows the template, the departure and the changed paths of the customer's own project", () => {
    ui(linked());
    expect(screen.getByText('Starter Dashboard')).toBeTruthy();
    expect(screen.getByTestId('gen-diff').textContent).toContain('40%');
    expect(screen.getByText('src/mine.ts')).toBeTruthy();
    expect(screen.getByText('README.md')).toBeTruthy();
    expect(screen.getByText(t('en', 'gen.diff.unchanged', { n: 3 }))).toBeTruthy();
  });
  it('says so when the template is gone, when nothing differs, and when the project was not copied', () => {
    ui(linked({ templateAvailable: false, template: null }));
    expect(screen.getByText(t('en', 'gen.template.gone'))).toBeTruthy();
    cleanup();
    ui(
      linked({
        diff: {
          added: [],
          modified: [],
          removed: [],
          unchanged: 5,
          baselineFiles: 5,
          currentFiles: 5,
          departure: 0,
          truncated: false,
          counts: { added: 0, modified: 0, removed: 0 },
        },
      }),
    );
    expect(screen.getByText(t('en', 'gen.diff.none'))).toBeTruthy();
    cleanup();
    ui({ linked: false, project: { id: 'p1', headVersionId: 'v1' } } as Workspace);
    expect(screen.getByText(t('en', 'gen.notLinked.title'))).toBeTruthy();
  });
});

describe('plan, preview and run', () => {
  const plan = (status: string, execution: object) => ({
    id: 'pl1',
    projectId: 'p1',
    status,
    plan: { execution },
  });
  const context = {
    planId: 'pl1',
    mode: 'ADAPTIVE',
    aiProcessing: false,
    policy: 'Adaptation mode ADAPTIVE: adapt',
    tokens: { used: 120, budget: 12000 },
    blocks: [
      { kind: 'requirement', label: 'requirement', tokens: 10, text: 'Requirement:\nadd pricing' },
      { kind: 'file', label: 'file-1', tokens: 30, text: 'path: src/mine.ts\nexport const a = 1' },
    ],
    included: ['src/mine.ts'],
    excluded: [{ path: 'src/app/page.tsx', reason: 'ai_processing_not_allowed' }],
    notes: ['template_contents_withheld'],
  };
  it('records a plan, previews exactly what would be sent (with what was withheld and why), and sends nothing by itself', async () => {
    mockFetch((url) =>
      url.endsWith('/generation-plans')
        ? json(201, plan('PLANNED', { status: 'READY' }))
        : url.endsWith('/context')
          ? json(200, context)
          : json(404, {}),
    );
    ui(linked());
    fireEvent.change(screen.getByLabelText(t('en', 'gen.plan.text')), {
      target: { value: 'add pricing' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'gen.plan.create') }));
    await waitFor(() => expect(screen.getByTestId('gen-plan')).toBeTruthy());
    expect(calls[0]).toMatchObject({
      url: '/v1/builder/generation-plans',
      method: 'POST',
      body: { projectId: 'p1', text: 'add pricing', mode: 'ADAPTIVE' },
    });
    expect(calls[0]!.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'gen.ctx.preview') }));
    await waitFor(() => expect(screen.getByTestId('gen-ctx')).toBeTruthy());
    expect(screen.getByText(t('en', 'gen.ctx.withheld'))).toBeTruthy();
    const pack = within(screen.getByTestId('gen-ctx'));
    expect(pack.getByText(/src\/app\/page\.tsx/)).toBeTruthy();
    expect(
      screen.getByText(t('en', 'gen.ctx.reason.ai_processing_not_allowed'), { exact: false }),
    ).toBeTruthy();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /v1/builder/generation-plans',
      'GET /v1/builder/generation-plans/pl1/context',
    ]); // no run was started
  });
  it('starts the run once with its own key, then shows the run link and the new status', async () => {
    mockFetch((url) =>
      url.endsWith('/generation-plans')
        ? json(201, plan('PLANNED', { status: 'READY' }))
        : url.endsWith('/runs')
          ? json(201, plan('RUNNING', { status: 'RUNNING', runId: 'run1' }))
          : json(404, {}),
    );
    ui(linked());
    fireEvent.change(screen.getByLabelText(t('en', 'gen.plan.text')), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'gen.plan.create') }));
    await waitFor(() => screen.getByRole('button', { name: t('en', 'gen.run.start') }));
    fireEvent.click(screen.getByRole('button', { name: t('en', 'gen.run.start') }));
    await waitFor(() =>
      expect(screen.getByRole('link', { name: t('en', 'gen.run.open') }).getAttribute('href')).toBe(
        '/en/builder/runs/run1',
      ),
    );
    expect(calls.filter((c) => c.method === 'POST').at(-1)).toMatchObject({
      url: '/v1/builder/generation-plans/pl1/runs',
      method: 'POST',
      body: {}, // the single call unless the agent was asked for
    });
    expect(screen.getByText(t('en', 'gen.plan.status.RUNNING'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('en', 'gen.run.start') })).toBeNull(); // a plan starts once
  });
  it('a plan that was already started says so; a viewer cannot record one; without AI permission the run cannot start; a blocked plan says why', async () => {
    mockFetch((url) =>
      url.endsWith('/generation-plans')
        ? json(201, plan('PLANNED', { status: 'READY' }))
        : json(409, { code: 'conflict' }),
    );
    ui(linked());
    fireEvent.change(screen.getByLabelText(t('en', 'gen.plan.text')), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'gen.plan.create') }));
    await waitFor(() => screen.getByRole('button', { name: t('en', 'gen.run.start') }));
    fireEvent.click(screen.getByRole('button', { name: t('en', 'gen.run.start') }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(t('en', 'gen.err.conflict')),
    );
    cleanup();
    ui(linked(), { canWrite: false });
    expect(screen.getByText(t('en', 'gen.readonly'))).toBeTruthy();
    expect(screen.queryByLabelText(t('en', 'gen.plan.text'))).toBeNull();
    cleanup();
    mockFetch(() => json(201, plan('PLANNED', { status: 'READY' })));
    ui(linked(), { canRun: false });
    fireEvent.change(screen.getByLabelText(t('en', 'gen.plan.text')), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'gen.plan.create') }));
    await waitFor(() => expect(screen.getByText(t('en', 'gen.run.needsAi'))).toBeTruthy());
    expect(screen.queryByRole('button', { name: t('en', 'gen.run.start') })).toBeNull();
    cleanup();
    mockFetch(() => json(201, plan('PLANNED', { status: 'BLOCKED' })));
    ui(linked());
    fireEvent.change(screen.getByLabelText(t('en', 'gen.plan.text')), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'gen.plan.create') }));
    await waitFor(() => expect(screen.getByText(t('en', 'gen.run.blocked'))).toBeTruthy());
  });
  it('a failed preview shows a plain error with no raw server text', async () => {
    mockFetch((url) =>
      url.endsWith('/generation-plans')
        ? json(201, plan('PLANNED', { status: 'READY' }))
        : json(500, { code: 'boom', detail: 'password=hunter2', traceId: 'trace-9' }),
    );
    ui(linked());
    fireEvent.change(screen.getByLabelText(t('en', 'gen.plan.text')), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'gen.plan.create') }));
    await waitFor(() => screen.getByRole('button', { name: t('en', 'gen.ctx.preview') }));
    fireEvent.click(screen.getByRole('button', { name: t('en', 'gen.ctx.preview') }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).not.toContain('hunter2');
    expect(screen.getByRole('alert').textContent).toContain('trace-9');
  });
});

describe('the read-only agent option (knowledge.agentic_generation, default off)', () => {
  const plan = (status: string, execution: object) => ({
    id: 'pl1',
    projectId: 'p1',
    status,
    plan: { execution },
  });
  const ready = (url: string, method = 'GET') =>
    url.endsWith('/generation-plans')
      ? json(201, plan('PLANNED', { status: 'READY' }))
      : url.endsWith('/runs')
        ? json(201, plan('RUNNING', { status: 'RUNNING', runId: 'run1' }))
        : url.endsWith('/timeline')
          ? json(200, {
              planId: 'pl1',
              runId: 'run1',
              mode: 'AGENTIC',
              runState: 'running',
              fellBack: null,
              plan: null,
              limits: {
                turns: { used: 0, max: 8 },
                toolCalls: { used: 0, max: 60 },
                resultBytes: { used: 0, max: 400000 },
                tokens: { used: 0, max: 60000 },
                seconds: { used: 0, max: 300 },
              },
              steps: [],
              outcome: null,
            })
          : json(404, { method });
  const toReady = async () => {
    fireEvent.change(screen.getByLabelText(t('en', 'gen.plan.text')), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'gen.plan.create') }));
    await waitFor(() => screen.getByRole('button', { name: t('en', 'gen.run.start') }));
  };

  it('is not offered while the flag is off', async () => {
    mockFetch(ready);
    ui(linked(), { agentic: false });
    await toReady();
    expect(screen.queryByLabelText(t('en', 'agt.opt.label'))).toBeNull();
  });

  it('is not offered without permission to run AI', async () => {
    mockFetch(ready);
    ui(linked(), { agentic: true, canRun: false });
    await toReady().catch(() => undefined);
    expect(screen.queryByLabelText(t('en', 'agt.opt.label'))).toBeNull();
  });

  it('when chosen, the run is requested with agentic: true and the timeline follows it', async () => {
    mockFetch(ready);
    ui(linked(), { agentic: true });
    await toReady();
    const box = screen.getByLabelText(t('en', 'agt.opt.label')) as HTMLInputElement;
    expect(box.checked).toBe(false); // off unless the person chooses it
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'gen.run.start') }));
    await screen.findByTestId('agt');
    expect(calls.find((c) => c.url.endsWith('/runs'))!.body).toEqual({ agentic: true });
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/v1/builder/generation-plans/pl1/timeline')).toBe(true),
    );
  });
});
