// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';
import type { Run, RunEvent } from '../lib/builder';

const stream = {
  run: null as Run | null,
  events: [] as RunEvent[],
  status: 'open',
  changed: null as Run | null,
  setRun: vi.fn(),
  reconnect: vi.fn(),
};
vi.mock('../lib/builder-client', async (orig) => ({
  ...(await orig<typeof import('../lib/builder-client')>()),
  useRunStream: () => stream,
}));
import { RunCard } from './BuilderRunCard';

afterEach(() => {
  cleanup();
  stream.run = null;
  stream.events = [];
});
let n = 0;
const ev = (type: string, data: Record<string, unknown> = {}): RunEvent => ({
  seq: ++n,
  type,
  data,
  at: '2026-11-19T10:00:00Z',
});
const run = (over: Partial<Run> = {}): Run =>
  ({
    id: 'r1',
    sessionId: 's1',
    projectId: 'p1',
    kind: 'website',
    state: 'running',
    step: null,
    usage: { spentCredits: '26', tokensIn: 100, tokensOut: 500 },
    error: null,
    pendingApproval: null,
    artifacts: [],
    ...over,
  }) as unknown as Run;
const card = (over: { canWrite?: boolean } = {}) =>
  render(<RunCard locale="en" runId="r1" canWrite={over.canWrite ?? true} />);

describe('run card in the chat', () => {
  it('while working: a loader, a progress bar, the steps with the current one marked, the cost and Cancel', () => {
    stream.run = run();
    stream.events = [ev('step_started', { task: 'requirements' })];
    const { container } = card();
    expect(screen.getByText(t('en', 'bld.card.working'))).toBeTruthy();
    expect(container.querySelector('.bld-orbit')).toBeTruthy();
    expect(screen.getByRole('progressbar')).toBeTruthy();
    const steps = within(screen.getByRole('list', { name: t('en', 'bld.run.events') }));
    expect(steps.getAllByRole('listitem')).toHaveLength(5);
    expect(container.querySelector('li[data-state="active"]')?.textContent).toContain(
      t('en', 'bld.stage.requirements'),
    );
    expect(screen.getByRole('button', { name: t('en', 'bld.run.cancel') })).toBeTruthy();
  });
  it('waiting for the person: no loader, the plan with Approve and Reject, and the pages named', () => {
    stream.run = run({
      state: 'waiting_approval',
      pendingApproval: {
        id: 'a1',
        kind: 'plan',
        summary: { pages: [{ pageId: 'home', slug: 'home', sections: 5 }] },
        expiresAt: '2026-11-20T10:00:00Z',
      },
    });
    stream.events = [ev('step_started', { task: 'architecture' }), ev('approval_requested')];
    const { container } = card();
    expect(screen.getByText(t('en', 'bld.card.waiting'))).toBeTruthy();
    expect(container.querySelector('.bld-orbit')).toBeNull();
    expect(screen.getByRole('button', { name: t('en', 'bld.approval.approve') })).toBeTruthy();
    expect(screen.getByRole('button', { name: t('en', 'bld.approval.deny') })).toBeTruthy();
    expect(screen.getByText(/home/)).toBeTruthy();
  });
  it('a viewer sees the plan but gets no decision buttons and no Cancel', () => {
    stream.run = run({
      state: 'waiting_approval',
      pendingApproval: { id: 'a1', kind: 'plan', summary: {}, expiresAt: '2026-11-20T10:00:00Z' },
    });
    card({ canWrite: false });
    expect(screen.queryByRole('button', { name: t('en', 'bld.approval.approve') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('en', 'bld.run.cancel') })).toBeNull();
  });
  it('done and failed are stated plainly; the history opens on demand', () => {
    stream.run = run({ state: 'failed', error: { code: 'agent_output_invalid' } });
    stream.events = [ev('step_started', { task: 'requirements' }), ev('failed', {})];
    const { rerender } = card();
    expect(screen.getAllByText(t('en', 'bld.card.failed')).length).toBeGreaterThan(0);
    expect(
      screen.getByText(t('en', 'bld.run.failedNote', { code: 'agent_output_invalid' })),
    ).toBeTruthy();
    expect(screen.queryByRole('list', { name: t('en', 'bld.card.history') })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('en', 'bld.card.showHistory') }));
    expect(screen.getByRole('list', { name: t('en', 'bld.card.history') })).toBeTruthy();
    stream.run = run({ state: 'succeeded' });
    rerender(<RunCard locale="en" runId="r1" canWrite />);
    expect(screen.getAllByText(t('en', 'bld.card.done')).length).toBeGreaterThan(0);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  });
  it('a denied change finishes the run without applying anything and does not say the site was updated', () => {
    stream.run = run({ state: 'succeeded', result: { applied: false, rejected: true } });
    card();
    expect(screen.getAllByText(t('en', 'bld.card.rejected')).length).toBeGreaterThan(0);
    expect(screen.queryByText(t('en', 'bld.card.done'))).toBeNull();
    expect(screen.getByRole('progressbar').getAttribute('aria-label')).toBe(
      t('en', 'bld.card.rejected'),
    );
  });
});
