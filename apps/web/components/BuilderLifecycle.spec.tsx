// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { missingKeys, t, type Locale } from '@nuzm/i18n';
import {
  LIFECYCLE_STEPS,
  LifecyclePanel,
  LifecycleStart,
  failureKey,
  viewFromEvents,
  type LifecycleView,
} from './BuilderLifecycle';

afterEach(cleanup);
const LOCALES: Locale[] = ['ar', 'en'];
const txt = (e: Element) => e.textContent ?? '';
const attr = (e: Element, a: string) => e.getAttribute(a);
const disabled = (e: Element) => (e as HTMLButtonElement).disabled;

type Ev = { type: string; data?: Record<string, unknown> };
const step = (s: string, status: string, extra: Record<string, unknown> = {}): Ev => ({
  type: 'lifecycle_step',
  data: { step: s, status, round: 0, ...extra },
});
const prog = (percent: number, done: number, total = 14, extra = {}) => ({
  percent,
  done,
  total,
  repairRound: 0,
  tokens: 1200,
  credits: '15',
  ...extra,
});
const CLEAN: Ev[] = [
  { type: 'lifecycle_started', data: { steps: 18 } },
  ...['requirements', 'project_analysis', 'architecture'].flatMap((s, i) => [
    step(s, 'started'),
    step(s, 'succeeded', {
      summary: `${s} ok`,
      progress: prog(Math.round(((i + 1) / 14) * 100), i + 1),
    }),
  ]),
];

describe('viewFromEvents', () => {
  it('is null until a lifecycle event exists', () => {
    expect(viewFromEvents([])).toBeNull();
    expect(viewFromEvents([{ type: 'created' }, { type: 'state_changed' }])).toBeNull();
  });
  it('shows finished steps, the running one and the progress the engine reported', () => {
    const v = viewFromEvents([...CLEAN, step('plan', 'started')])!;
    expect(v.steps).toHaveLength(18);
    expect(v.steps.slice(0, 3).map((s) => s.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    expect(v.steps.find((s) => s.id === 'plan')!.status).toBe('running');
    expect(v.current).toBe('plan');
    expect(v.percent).toBe(21);
    expect(v.tokens).toBe(1200);
    expect(v.status).toBe('running');
  });
  it('a repair step is not shown as pending forever: skipped once later steps run, a repair round re-opens it', () => {
    const later = [...CLEAN, step('tests', 'succeeded')];
    expect(viewFromEvents(later)!.steps.find((s) => s.id === 'repair')!.status).toBe('skipped');
    const repaired = viewFromEvents([
      ...CLEAN,
      step('build', 'succeeded', { passed: false, progress: prog(40, 6, 14, { repairRound: 1 }) }),
      step('error_analysis', 'started', { round: 1 }),
      step('error_analysis', 'succeeded', { round: 1, summary: '2 diagnostics' }),
      step('repair', 'started', { round: 1 }),
    ])!;
    expect(repaired.steps.find((s) => s.id === 'error_analysis')).toMatchObject({
      status: 'succeeded',
      round: 1,
    });
    expect(repaired.steps.find((s) => s.id === 'repair')!.status).toBe('running');
    expect(repaired.repairRound).toBe(1);
  });
  it('a retried step goes back to pending with its code; a failure and the final status come from the events', () => {
    const v = viewFromEvents([
      ...CLEAN,
      step('file_generation', 'started'),
      step('file_generation', 'retry', { code: 'timeout' }),
      step('file_generation', 'started'),
      step('file_generation', 'failed', { code: 'permission_denied' }),
      {
        type: 'lifecycle_finished',
        data: { status: 'failed', code: 'permission_denied', progress: prog(30, 4) },
      },
    ])!;
    expect(v.status).toBe('failed');
    expect(v.failureCode).toBe('permission_denied');
    expect(v.failureStep).toBe('file_generation');
    expect(v.current).toBeNull();
  });
  it('waiting for the approval, then finished; cancelled marks what had not run', () => {
    const w = viewFromEvents([
      ...CLEAN,
      step('deployment_approval', 'waiting_approval', { approvalId: 'a-1' }),
      { type: 'lifecycle_finished', data: { status: 'waiting_approval' } },
    ])!;
    expect(w.status).toBe('waiting_approval');
    expect(w.approvalId).toBe('a-1');
    const c = viewFromEvents([
      ...CLEAN,
      step('plan', 'started'),
      { type: 'lifecycle_finished', data: { status: 'cancelled', code: 'cancelled' } },
    ])!;
    expect(c.steps.find((s) => s.id === 'plan')!.status).toBe('cancelled');
    expect(c.steps.find((s) => s.id === 'tests')!.status).toBe('cancelled');
    const done = viewFromEvents([
      ...CLEAN,
      { type: 'lifecycle_finished', data: { status: 'succeeded' } },
    ])!;
    expect(done.percent).toBe(100);
  });
  it('ignores unknown steps and malformed data instead of throwing', () => {
    const v = viewFromEvents([
      { type: 'lifecycle_step', data: { step: 'rm -rf', status: 'started' } },
      { type: 'lifecycle_step', data: { step: 'plan', status: 'succeeded', progress: 'x' } },
      { type: 'lifecycle_finished', data: { status: 'weird' } },
    ])!;
    expect(v.status).toBe('running');
    expect(v.steps.find((s) => s.id === 'plan')!.status).toBe('succeeded');
  });
  it('knows all 18 steps and has a name for each in both languages', () => {
    expect(LIFECYCLE_STEPS).toHaveLength(18);
    for (const l of LOCALES)
      for (const s of LIFECYCLE_STEPS)
        expect(t(l, `bt.lc.step.${s}` as never)).not.toBe(`bt.lc.step.${s}`);
  });
});

describe('failureKey', () => {
  it('maps codes to messages, collapses tool denials and never shows an unknown code', () => {
    expect(failureKey('repair_exhausted')).toBe('bt.lc.failure.repair_exhausted');
    expect(failureKey('unknown_tool')).toBe('bt.lc.failure.tool_denied');
    expect(failureKey('<script>alert(1)</script>')).toBe('bt.lc.failure.unknown');
    expect(failureKey(null)).toBe('bt.lc.failure.unknown');
    for (const l of LOCALES)
      expect(missingKeys(l).filter((k) => k.startsWith('bt.lc.'))).toEqual([]);
  });
});

const view = (over: Partial<LifecycleView> = {}): LifecycleView => ({
  ...viewFromEvents([...CLEAN, step('plan', 'started')])!,
  ...over,
});

describe.each(LOCALES)('LifecyclePanel (%s)', (locale) => {
  it('loading, empty, error (with retry), offline and forbidden are explicit states', () => {
    const retry = vi.fn();
    const { rerender } = render(
      <LifecyclePanel locale={locale} state="loading" view={null} simulated />,
    );
    expect(txt(screen.getByRole('status'))).toContain(t(locale, 'bt.state.loading'));
    rerender(<LifecyclePanel locale={locale} state="empty" view={null} simulated />);
    expect(screen.getByText(t(locale, 'bt.lc.state.empty'))).toBeTruthy();
    rerender(
      <LifecyclePanel locale={locale} state="error" view={null} simulated onRetry={retry} />,
    );
    expect(txt(screen.getByRole('alert'))).toContain(t(locale, 'bt.state.error'));
    fireEvent.click(screen.getByRole('button', { name: t(locale, 'bt.lc.state.retry') }));
    expect(retry).toHaveBeenCalledOnce();
    rerender(<LifecyclePanel locale={locale} state="offline" view={null} simulated />);
    expect(txt(screen.getByRole('alert'))).toContain(t(locale, 'bt.lc.state.offline'));
    rerender(<LifecyclePanel locale={locale} state="forbidden" view={null} simulated />);
    expect(txt(screen.getByRole('alert'))).toContain(t(locale, 'bt.state.forbidden'));
  });
  it('shows progress as a labelled progress element, the steps as an ordered list with a TEXT status each, and the simulated banner', () => {
    render(
      <LifecyclePanel
        locale={locale}
        state="ready"
        view={view()}
        simulated
        onCancel={() => undefined}
      />,
    );
    const bar = screen.getByRole('progressbar', { name: t(locale, 'bt.lc.progress.label') });
    expect(attr(bar, 'value')).toBe('21');
    expect(screen.getByText(t(locale, 'bt.lc.simulated'))).toBeTruthy();
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items).toHaveLength(18);
    for (const li of items) expect(txt(li).length).toBeGreaterThan(5);
    expect(txt(items[0]!)).toContain(t(locale, 'bt.lc.st.succeeded'));
    expect(attr(items[3]!, 'aria-current')).toBe('step');
    expect(txt(items[3]!)).toContain(t(locale, 'bt.lc.st.running'));
    // the numbers stay left to right inside the Arabic layout
    expect(document.querySelectorAll('bdi[dir="ltr"]').length).toBeGreaterThan(0);
  });
  it('a failed run says why in words, and never prints a raw code or server text', () => {
    render(
      <LifecyclePanel
        locale={locale}
        state="ready"
        view={view({
          status: 'failed',
          failureCode: 'repair_exhausted',
          failureStep: 'rebuild',
          current: null,
        })}
        simulated={false}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(txt(alert)).toContain(t(locale, 'bt.lc.failure.repair_exhausted'));
    expect(txt(alert)).toContain(t(locale, 'bt.lc.step.rebuild'));
    expect(txt(alert)).not.toContain('repair_exhausted');
    expect(screen.queryByText(t(locale, 'bt.lc.simulated'))).toBeNull();
    expect(screen.queryByRole('button', { name: t(locale, 'bt.lc.cancel') })).toBeNull();
  });
  it('waiting for the deployment approval explains that nothing is deployed and links to the inbox; the cancel button works', () => {
    const cancel = vi.fn();
    render(
      <LifecyclePanel
        locale={locale}
        state="ready"
        view={view({ status: 'waiting_approval', current: null })}
        simulated
        approvalsHref={`/${locale}/approvals`}
        deployment={{
          target: 'node-web',
          readiness: 'needs_attention',
          blockers: ['simulated_evidence', 'tests_not_passed'],
        }}
        onCancel={cancel}
      />,
    );
    expect(screen.getByText(t(locale, 'bt.lc.approval.body'))).toBeTruthy();
    expect(attr(screen.getByRole('link', { name: t(locale, 'bt.lc.approval.link') }), 'href')).toBe(
      `/${locale}/approvals`,
    );
    expect(screen.getByText(t(locale, 'bt.lc.target.node-web'))).toBeTruthy();
    expect(screen.getByText(t(locale, 'bt.lc.blocker.simulated_evidence'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t(locale, 'bt.lc.cancel') }));
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('the cancel button is disabled while cancelling', () => {
    render(
      <LifecyclePanel
        locale={locale}
        state="ready"
        view={view()}
        simulated
        cancelling
        onCancel={() => undefined}
      />,
    );
    expect(disabled(screen.getByRole('button', { name: t(locale, 'bt.lc.cancelling') }))).toBe(
      true,
    );
  });
});

describe.each(LOCALES)('LifecycleStart (%s)', (locale) => {
  it('refuses an empty brief on the client, passes a trimmed one with the chosen rounds, and is labelled', () => {
    const onStart = vi.fn();
    render(<LifecycleStart locale={locale} busy={false} disabled={false} onStart={onStart} />);
    const box = screen.getByLabelText(t(locale, 'bt.lc.start.prompt'));
    fireEvent.click(screen.getByRole('button', { name: t(locale, 'bt.lc.start.submit') }));
    expect(onStart).not.toHaveBeenCalled();
    expect(txt(screen.getByRole('alert'))).toContain(t(locale, 'bt.lc.failure.invalid_input'));
    expect(attr(box, 'aria-invalid')).toBe('true');
    fireEvent.change(box, { target: { value: '  متجر إلكتروني  ' } });
    fireEvent.change(screen.getByLabelText(t(locale, 'bt.lc.start.rounds')), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('button', { name: t(locale, 'bt.lc.start.submit') }));
    expect(onStart).toHaveBeenCalledWith({ prompt: 'متجر إلكتروني', maxRepairRounds: 2 });
  });
  it('is disabled with an explanation when the feature is off, and while starting', () => {
    const { rerender } = render(
      <LifecycleStart locale={locale} busy={false} disabled onStart={vi.fn()} />,
    );
    expect(screen.getByText(t(locale, 'bt.lc.start.off'))).toBeTruthy();
    expect(disabled(screen.getByRole('button', { name: t(locale, 'bt.lc.start.submit') }))).toBe(
      true,
    );
    expect(disabled(screen.getByLabelText(t(locale, 'bt.lc.start.prompt')))).toBe(true);
    rerender(<LifecycleStart locale={locale} busy disabled={false} onStart={vi.fn()} />);
    expect(
      disabled(screen.getByRole('button', { name: t(locale, 'bt.lc.start.submitting') })),
    ).toBe(true);
  });
  it('shows a start error as an alert', () => {
    render(
      <LifecycleStart
        locale={locale}
        busy={false}
        disabled={false}
        error="boom"
        onStart={vi.fn()}
      />,
    );
    expect(txt(screen.getByRole('alert'))).toContain('boom');
  });
});
