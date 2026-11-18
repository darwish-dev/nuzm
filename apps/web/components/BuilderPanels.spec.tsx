// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

const post = vi.fn();
const get = vi.fn();
const del = vi.fn();
const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock('../lib/client', () => ({ browserApi: () => ({ POST: post, GET: get, DELETE: del }) }));
const ask = vi.fn();
vi.mock('./StepUp', () => ({ useStepUp: () => ({ ask, panel: null }) }));
import { AppWizard } from './AppWizard';
import { ApprovalDecision, ApprovalsInbox } from './ApprovalPanels';
import { Deployments } from './BuilderDeployments';
import { RunPanel } from './BuilderIde';
import { BudgetMeters, SandboxRuntime } from './BuilderParts';
import { RunStep, RunViewer } from './RunViewer';
import { ChangeComposer } from './BuilderChanges';
import { Exports } from './BuilderExports';
import { TerminalScreen } from './BuilderTerminal';

const ok = (data: unknown = {}, status = 200) => ({ response: { ok: true, status }, data });
const fail = (status: number, error: unknown = {}) => ({ response: { ok: false, status }, error });
const button = (name: string) => screen.getByRole('button', { name });
const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const UUID = '0194a1b2-1111-7222-8333-444455556666';
const HASH = 'f'.repeat(64);

beforeEach(() => {
  [post, get, del, push, refresh, ask].forEach((m) => m.mockReset());
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const approval = {
  id: 'ap-1',
  type: 'production_deploy',
  scopeHash: HASH,
  expiresAt: '2999-01-01T00:00:00Z',
  action: { op: 'deploy', env: 'production', apiKey: 'should-not-show' },
};

describe('sandbox honesty (UI-M10-03/04)', () => {
  it('names the runtime and says plainly that a stand-in is NOT isolated', () => {
    render(<SandboxRuntime locale="en" runtime={{ kind: 'local-dev', isolation: 'none' }} />);
    expect(screen.getByText('local-dev')).toBeTruthy();
    expect(screen.getByText('none')).toBeTruthy();
    expect(screen.getByText(t('en', 'm10.sbx.notIsolated'))).toBeTruthy();
  });
  it('shows the notice in Arabic too, and none for a verified runtime', () => {
    const { unmount } = render(
      <SandboxRuntime locale="ar" runtime={{ kind: 'mock', isolation: 'simulated' }} />,
    );
    expect(screen.getByText(t('ar', 'm10.sbx.notIsolated'))).toBeTruthy();
    unmount();
    render(<SandboxRuntime locale="en" runtime={{ kind: 'isolated', isolation: 'verified' }} />);
    expect(screen.queryByText(t('en', 'm10.sbx.notIsolated'))).toBeNull();
  });
  it('the terminal screen has no input, says the transport is not enabled, and still labels the runtime', () => {
    render(
      <TerminalScreen
        locale="en"
        projectId={UUID}
        sandbox={
          {
            id: UUID,
            projectId: UUID,
            state: 'terminated',
            runtime: { kind: 'mock', isolation: 'none' },
          } as never
        }
      />,
    );
    expect(screen.getByText(t('en', 'm10.term.notEnabled'))).toBeTruthy();
    expect(screen.getByText(t('en', 'm10.term.sessionEnded'))).toBeTruthy();
    expect(screen.getByText(t('en', 'm10.term.egressDenied'))).toBeTruthy();
    expect(screen.getByText(t('en', 'm10.sbx.notIsolated'))).toBeTruthy();
    expect(document.querySelector('input, textarea')).toBeNull();
  });
});

describe('budget meter (UI-M10-06)', () => {
  const base = {
    budget: { maxTokens: 1000, maxCostMinor: 5000, maxMinutes: 30 },
    budgetRemaining: { tokens: 0, costMinor: 0, minutes: 30, steps: 5 },
  };
  it('no warning below 80 %', () => {
    render(
      <BudgetMeters
        locale="en"
        run={
          { ...base, usage: { tokensIn: 500, tokensOut: 0, costMinor: 1000, steps: 1 } } as never
        }
      />,
    );
    expect(screen.queryByText(t('en', 'm10.run.budgetWarn'))).toBeNull();
  });
  it('warns at 80 % and shows money as SAR from minor units', () => {
    render(
      <BudgetMeters
        locale="en"
        run={
          { ...base, usage: { tokensIn: 800, tokensOut: 0, costMinor: 4000, steps: 1 } } as never
        }
      />,
    );
    expect(screen.getByText(t('en', 'm10.run.budgetWarn'))).toBeTruthy();
    expect(screen.getAllByText(t('en', 'm10.run.warn80')).length).toBeGreaterThan(0);
    expect(screen.getByText(/SAR\s?40\.00 \/ SAR\s?50\.00/)).toBeTruthy();
  });
});

describe('run steps (UI-M10-06)', () => {
  it('shows agent, status, attempt, tokens, cost and masks tool-call arguments', () => {
    render(
      <RunStep
        locale="en"
        step={{
          seq: 2,
          agent: 'coder',
          status: 'succeeded',
          attempt: 2,
          tokensIn: 10,
          tokensOut: 5,
          costMinor: 150,
          toolCalls: [
            {
              tool: 'write_file',
              status: 'succeeded',
              durationMs: 12,
              args: { path: 'a.ts', token: 'abcdefghijklmnopqrstuvwxyz' },
            },
          ],
        }}
      />,
    );
    expect(screen.getByText(/2\. coder/)).toBeTruthy();
    expect(screen.getByText('10 + 5 = 15')).toBeTruthy();
    expect(screen.getByText(/SAR\s?1\.50/)).toBeTruthy();
    expect(screen.getByText(t('en', 'm10.step.redacted'))).toBeTruthy();
    const code = document.querySelector('pre')!.textContent!;
    expect(code).toContain('[REDACTED]');
    expect(code).not.toContain('abcdefghijklmnop');
  });
});

describe('approval decision (UI-M10-06/07)', () => {
  it('quotes the exact action and scopeHash, masks secrets, and decides with that hash and an Idempotency-Key', async () => {
    post.mockResolvedValueOnce(ok({ ...approval, status: 'approved' }));
    const onDecided = vi.fn();
    render(
      <ApprovalDecision
        locale="en"
        mfaFactorId={null}
        approval={approval}
        canDecide
        onDecided={onDecided}
      />,
    );
    fireEvent.click(button(t('en', 'm10.apr.approve')));
    expect(screen.getByText(HASH)).toBeTruthy();
    const json = document.querySelector('dialog pre')!.textContent!;
    expect(json).toContain('"env": "production"');
    expect(json).toContain('[REDACTED]');
    expect(json).not.toContain('should-not-show');
    fireEvent.click(button(t('en', 'm10.apr.confirmApprove')));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]!;
    expect(path).toBe('/v1/ai/approvals/{approvalId}/decisions');
    expect(init.params.path.approvalId).toBe('ap-1');
    expect(init.params.header['Idempotency-Key']).toBeTruthy();
    expect(init.body).toEqual({ decision: 'approve', scopeHash: HASH });
    await waitFor(() =>
      expect(onDecided).toHaveBeenCalledWith('approve', expect.objectContaining({ id: 'ap-1' })),
    );
  });
  it('through a run it posts to the run route with the approvalId', async () => {
    post.mockResolvedValueOnce(ok({ ...approval, status: 'rejected' }));
    render(
      <ApprovalDecision
        locale="en"
        mfaFactorId={null}
        approval={approval}
        canDecide
        runId="run-1"
        onDecided={vi.fn()}
      />,
    );
    fireEvent.click(button(t('en', 'm10.apr.reject')));
    fill(t('en', 'm10.apr.note'), 'not now');
    fireEvent.click(button(t('en', 'm10.apr.confirmReject')));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, init] = post.mock.calls[0]!;
    expect(path).toBe('/v1/ai/runs/{id}/approvals');
    expect(init.body).toEqual({
      approvalId: 'ap-1',
      decision: 'reject',
      scopeHash: HASH,
      note: 'not now',
    });
  });
  it('409 stale_approval_hash: says so, reloads the action and makes the person review it again', async () => {
    post.mockResolvedValueOnce(fail(409, { code: 'stale_approval_hash' }));
    get.mockResolvedValueOnce(
      ok({ ...approval, scopeHash: 'e'.repeat(64), action: { op: 'deploy', env: 'staging' } }),
    );
    render(
      <ApprovalDecision
        locale="en"
        mfaFactorId={null}
        approval={approval}
        canDecide
        onDecided={vi.fn()}
      />,
    );
    fireEvent.click(button(t('en', 'm10.apr.approve')));
    fireEvent.click(button(t('en', 'm10.apr.confirmApprove')));
    expect(await screen.findByText(t('en', 'm10.apr.err.stale'))).toBeTruthy();
    await waitFor(() => expect(screen.getByText('e'.repeat(64))).toBeTruthy());
    expect(screen.getByText(t('en', 'm10.apr.reviewAgain'))).toBeTruthy();
    expect((button(t('en', 'm10.apr.confirmApprove')) as HTMLButtonElement).disabled).toBe(true);
  });
  it('410 and 403 get their own messages', async () => {
    post
      .mockResolvedValueOnce(fail(410, { code: 'gone' }))
      .mockResolvedValueOnce(fail(403, { code: 'forbidden' }));
    render(
      <ApprovalDecision
        locale="en"
        mfaFactorId={null}
        approval={approval}
        canDecide
        onDecided={vi.fn()}
      />,
    );
    fireEvent.click(button(t('en', 'm10.apr.approve')));
    fireEvent.click(button(t('en', 'm10.apr.confirmApprove')));
    expect(await screen.findByText(t('en', 'm10.apr.err.expired'))).toBeTruthy();
    fireEvent.click(button(t('en', 'm10.apr.confirmApprove')));
    expect(await screen.findByText(t('en', 'm10.apr.err.role'))).toBeTruthy();
  });
  it('cannot approve an action it cannot show (the load failed), but may reject', async () => {
    get.mockResolvedValueOnce(fail(500));
    render(
      <ApprovalDecision
        locale="en"
        mfaFactorId={null}
        approval={{ id: 'ap-2', type: 'paid_resource', scopeHash: HASH }}
        canDecide
        onDecided={vi.fn()}
      />,
    );
    fireEvent.click(button(t('en', 'm10.apr.approve')));
    expect(
      await screen.findByText(t('en', 'm10.apr.actionLoadFailed'), { exact: false }),
    ).toBeTruthy();
    expect((button(t('en', 'm10.apr.confirmApprove')) as HTMLButtonElement).disabled).toBe(true);
  });
  it('a member without ai:approve gets no buttons', () => {
    render(
      <ApprovalDecision
        locale="en"
        mfaFactorId={null}
        approval={approval}
        canDecide={false}
        onDecided={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(t('en', 'm10.apr.cannotDecide'))).toBeTruthy();
  });
});

describe('approvals inbox (UI-M10-07)', () => {
  const row = {
    id: 'ap-1',
    type: 'production_deploy',
    status: 'pending',
    scopeHash: HASH,
    action: { a: 1 },
    expiresAt: '2999-01-01T00:00:00Z',
    requestedByKind: 'ai',
    subjectType: 'run',
    subjectId: UUID,
  };
  it('lists, filters by status through the API and opens the drawer with the action and expiry', async () => {
    get.mockResolvedValueOnce(ok({ items: [] }));
    render(<ApprovalsInbox locale="en" initial={[row] as never} canDecide mfaFactorId={null} />);
    fireEvent.click(
      screen.getByRole('button', {
        name: t('en', 'm10.apr.open', { type: t('en', 'm10.apr.type.production_deploy') }),
      }),
    );
    expect(screen.getByText(HASH)).toBeTruthy();
    expect(screen.getAllByText(t('en', 'm10.apr.expires')).length).toBeGreaterThan(1); // column header + the drawer fact
    cleanup();
    render(<ApprovalsInbox locale="en" initial={[row] as never} canDecide mfaFactorId={null} />);
    fill(t('en', 'm10.apr.filter'), 'approved');
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(get.mock.calls[0]![0]).toBe('/v1/ai/approvals');
    expect(get.mock.calls[0]![1].params.query).toEqual({ status: 'approved' });
    expect(await screen.findByText(t('en', 'm10.apr.empty'))).toBeTruthy();
  });
});

describe('run viewer (UI-M10-06)', () => {
  const live = (state: string, extra: Record<string, unknown> = {}) => ({
    id: 'run-1',
    kind: 'webapp',
    state,
    budget: { maxTokens: 1000, maxCostMinor: 5000, maxMinutes: 30 },
    usage: { tokensIn: 0, tokensOut: 0, costMinor: 0, steps: 0 },
    budgetRemaining: { tokens: 1000, costMinor: 5000, minutes: 30, steps: 10 },
    steps: [],
    ...extra,
  });
  it('polls while the run is live and stops when it ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    get.mockResolvedValueOnce(ok(live('running'))).mockResolvedValueOnce(ok(live('succeeded')));
    render(
      <RunViewer
        locale="en"
        projectId={UUID}
        initial={live('queued') as never}
        canApprove
        canRun
        mfaFactorId={null}
        pollMs={50}
      />,
    );
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2), { timeout: 3000 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(get).toHaveBeenCalledTimes(2); // terminal state: no further polling
    expect(get.mock.calls[0]![0]).toBe('/v1/ai/runs/{id}');
    expect(screen.getAllByText(t('en', 'm10.run.state.succeeded')).length).toBeGreaterThan(0);
  });
  it('a terminal run is not polled and has no cancel button', () => {
    render(
      <RunViewer
        locale="en"
        projectId={UUID}
        initial={live('failed') as never}
        canApprove
        canRun
        mfaFactorId={null}
        pollMs={20}
      />,
    );
    expect(screen.queryByRole('button', { name: t('en', 'm10.run.cancel') })).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
  it('cancel asks first, then posts the cancellation with an Idempotency-Key', async () => {
    post.mockResolvedValueOnce(ok(live('cancelled'), 202));
    get.mockResolvedValue(ok(live('running')));
    render(
      <RunViewer
        locale="en"
        projectId={UUID}
        initial={live('running') as never}
        canApprove
        canRun
        mfaFactorId={null}
        pollMs={60000}
      />,
    );
    fireEvent.click(button(t('en', 'm10.run.cancel')));
    expect(screen.getByText(t('en', 'm10.run.cancelBody'))).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(button(t('en', 'm10.run.cancelConfirm')));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]![0]).toBe('/v1/ai/runs/{id}/cancellation');
    expect(post.mock.calls[0]![1].params.header['Idempotency-Key']).toBeTruthy();
  });
  it('lists pending approvals with the exact hash', () => {
    render(
      <RunViewer
        locale="en"
        projectId={UUID}
        initial={
          live('waiting_approval', {
            pendingApprovals: [
              {
                id: 'ap-1',
                type: 'paid_resource',
                scopeHash: HASH,
                expiresAt: '2999-01-01T00:00:00Z',
              },
            ],
          }) as never
        }
        canApprove
        canRun
        mfaFactorId={null}
        pollMs={60000}
      />,
    );
    expect(screen.getByText(HASH)).toBeTruthy();
    expect(screen.getByRole('button', { name: t('en', 'm10.apr.approve') })).toBeTruthy();
  });
});

describe('wizard (UI-M10-01)', () => {
  const defaults = { maxTokens: 1_000_000, maxCostMinor: 50_000, maxMinutes: 30 };
  function toBudget() {
    fill(t('en', 'm10.wiz.prompt'), 'A CRM for a small clinic with appointments');
    fireEvent.click(button(t('en', 'action.next')));
    fill(t('en', 'm10.wiz.entities'), 'Patient\nAppointment');
    fill(t('en', 'm10.wiz.roles'), 'Doctor');
    fireEvent.click(screen.getByLabelText(t('en', 'm10.wiz.confirmList')));
    fireEvent.click(button(t('en', 'action.next')));
  }
  it('says the prompt is DATA, and blocks a too-short prompt', () => {
    render(
      <AppWizard locale="en" mfaFactorId={null} defaults={defaults} orgRemainingMinor={null} />,
    );
    expect(screen.getByText(t('en', 'm10.wiz.promptData'))).toBeTruthy();
    fireEvent.click(button(t('en', 'action.next')));
    expect(screen.getByText(t('en', 'm10.wiz.err.prompt'))).toBeTruthy();
  });
  it('needs the requirements to be confirmed', () => {
    render(
      <AppWizard locale="en" mfaFactorId={null} defaults={defaults} orgRemainingMinor={null} />,
    );
    fill(t('en', 'm10.wiz.prompt'), 'A CRM for a small clinic');
    fireEvent.click(button(t('en', 'action.next')));
    fill(t('en', 'm10.wiz.entities'), 'Patient');
    fireEvent.click(button(t('en', 'action.next')));
    expect(screen.getByText(t('en', 'm10.wiz.err.confirm'))).toBeTruthy();
  });
  it('refuses a budget above the ceilings without calling the API', () => {
    render(
      <AppWizard locale="en" mfaFactorId={null} defaults={defaults} orgRemainingMinor={12345} />,
    );
    toBudget();
    expect(screen.getByText(/12[,.]?345|123\.45/)).toBeTruthy();
    fill(t('en', 'm10.wiz.tokens'), '2000001');
    fireEvent.click(button(t('en', 'm10.wiz.start')));
    expect(screen.getByText(t('en', 'm10.wiz.err.tokens'))).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });
  it('creates the project, then the webapp run with the budget in minor units and the brief as data, and opens the viewer', async () => {
    post
      .mockResolvedValueOnce(ok({ id: UUID }, 201))
      .mockResolvedValueOnce(ok({ id: 'run-9' }, 202));
    render(
      <AppWizard locale="en" mfaFactorId={null} defaults={defaults} orgRemainingMinor={null} />,
    );
    toBudget();
    fireEvent.click(button(t('en', 'm10.wiz.start')));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[0]![0]).toBe('/v1/builder/projects');
    expect(post.mock.calls[0]![1].body).toMatchObject({ type: 'webapp' });
    const [path, init] = post.mock.calls[1]!;
    expect(path).toBe('/v1/ai/runs');
    expect(init.body.kind).toBe('webapp');
    expect(init.body.projectId).toBe(UUID);
    expect(init.body.budget).toEqual({
      maxTokens: 1_000_000,
      maxCostMinor: 50_000,
      maxMinutes: 30,
    });
    expect(init.body.brief).toEqual({
      prompt: 'A CRM for a small clinic with appointments',
      locales: ['ar', 'en'],
      entities: ['Patient', 'Appointment'],
      roles: ['Doctor'],
    });
    expect(init.params.header['Idempotency-Key']).toBeTruthy();
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(`/en/builder/projects/${UUID}/runs/run-9`),
    );
  });
  it('402 budget_required shows the credit message and does not create a second project on retry', async () => {
    post
      .mockResolvedValueOnce(ok({ id: UUID }, 201))
      .mockResolvedValueOnce(fail(402, { code: 'budget_required' }))
      .mockResolvedValueOnce(ok({ id: 'run-9' }, 202));
    render(
      <AppWizard locale="en" mfaFactorId={null} defaults={defaults} orgRemainingMinor={null} />,
    );
    toBudget();
    fireEvent.click(button(t('en', 'm10.wiz.start')));
    expect(
      await screen.findByText(t('en', 'm10.err.budgetRequired'), { exact: false }),
    ).toBeTruthy();
    fireEvent.click(button(t('en', 'm10.wiz.start')));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    expect(post.mock.calls[2]![0]).toBe('/v1/ai/runs');
  });
  it('422 unsupported_capability shows the reason', async () => {
    post
      .mockResolvedValueOnce(ok({ id: UUID }, 201))
      .mockResolvedValueOnce(
        fail(422, { code: 'unsupported_capability', detail: 'kind not available' }),
      );
    render(
      <AppWizard locale="en" mfaFactorId={null} defaults={defaults} orgRemainingMinor={null} />,
    );
    toBudget();
    fireEvent.click(button(t('en', 'm10.wiz.start')));
    expect(await screen.findByText(t('en', 'm10.err.unsupported'), { exact: false })).toBeTruthy();
    expect(screen.getByText('kind not available')).toBeTruthy();
  });
});

describe('run panel: sandbox states (UI-M10-03)', () => {
  const box = {
    id: UUID,
    projectId: UUID,
    state: 'ready',
    runtime: { kind: 'local-dev', isolation: 'none' },
  };
  const start = () => fireEvent.click(button(t('en', 'm10.sbx.start')));
  it('shows every sandbox with its runtime label and the stand-in notice', () => {
    render(
      <RunPanel
        locale="en"
        projectId={UUID}
        initial={[box] as never}
        canUse
        canTest
        mfaFactorId={null}
      />,
    );
    expect(screen.getByText(t('en', 'm10.sbx.notIsolated'))).toBeTruthy();
    expect(screen.getByText(t('en', 'm10.ide.previewNote'))).toBeTruthy();
  });
  it('409 sandbox_quota_exceeded disables the button', async () => {
    post.mockResolvedValueOnce(fail(409, { code: 'sandbox_quota_exceeded' }));
    render(
      <RunPanel locale="en" projectId={UUID} initial={[]} canUse canTest mfaFactorId={null} />,
    );
    start();
    expect(await screen.findByText(t('en', 'm10.err.sandboxQuota'))).toBeTruthy();
    expect((button(t('en', 'm10.sbx.start')) as HTMLButtonElement).disabled).toBe(true);
  });
  it('503 no capacity offers a retry; a network failure is the offline state', async () => {
    post
      .mockResolvedValueOnce(fail(503, { code: 'sandbox_no_capacity' }))
      .mockRejectedValueOnce(new TypeError('x'));
    render(
      <RunPanel locale="en" projectId={UUID} initial={[]} canUse canTest mfaFactorId={null} />,
    );
    start();
    expect(
      await screen.findByText(t('en', 'm10.err.sandboxCapacity'), { exact: false }),
    ).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: t('en', 'action.retry') })[0]!);
    expect(await screen.findByText(t('en', 'm10.err.offline'), { exact: false })).toBeTruthy();
  });
  it('a started sandbox is shown as starting', async () => {
    post.mockResolvedValueOnce(ok({ ...box, state: 'starting' }, 202));
    get.mockResolvedValue(ok({ ...box, state: 'starting' }));
    render(
      <RunPanel locale="en" projectId={UUID} initial={[]} canUse canTest mfaFactorId={null} />,
    );
    start();
    expect(await screen.findByText(t('en', 'm10.sbx.starting'))).toBeTruthy();
    expect(post.mock.calls[0]![1].params.header['Idempotency-Key']).toBeTruthy();
  });
});

describe('changes (UI-M10-05)', () => {
  const versions = [{ id: UUID }];
  function compose(props: Partial<{ hash: string }> = {}) {
    render(
      <ChangeComposer
        locale="en"
        projectId={UUID}
        versions={versions}
        headVersionId={UUID}
        mfaFactorId={null}
        prefill={{ op: 'modify', path: 'src/a.ts', hash: props.hash ?? HASH }}
      />,
    );
    fill(t('en', 'm10.chg.content'), 'export const a = 1;');
  }
  it('posts the patch with baseVersion, expectedHash and an Idempotency-Key, then shows the diff and risks', async () => {
    post.mockResolvedValueOnce(
      ok(
        {
          versionId: UUID,
          commit: 'abcdef1234567890',
          branch: 'main',
          diff: { added: [], modified: ['src/a.ts'], deleted: [], renamed: [] },
          risks: [{ code: 'removes_tests', message: 'tests are modified' }],
        },
        201,
      ),
    );
    compose();
    fireEvent.click(button(t('en', 'm10.chg.submit')));
    expect(await screen.findByText(t('en', 'm10.chg.applied'))).toBeTruthy();
    const [path, init] = post.mock.calls[0]!;
    expect(path).toBe('/v1/builder/projects/{projectId}/changes');
    expect(init.body).toMatchObject({
      baseVersion: UUID,
      source: 'user',
      patches: [{ op: 'modify', path: 'src/a.ts', expectedHash: HASH }],
    });
    expect(init.params.header['Idempotency-Key']).toBeTruthy();
    expect(screen.getByText('src/a.ts', { selector: 'bdi' })).toBeTruthy();
    expect(screen.getByText('removes_tests')).toBeTruthy();
  });
  it('rejects an unsafe path in the browser, without calling the API', () => {
    compose();
    fill(t('en', 'm10.chg.path'), '../etc/passwd');
    fireEvent.click(button(t('en', 'm10.chg.submit')));
    expect(screen.getByText(t('en', 'm10.chg.err.path'))).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });
  it('409 base_mismatch offers a reload', async () => {
    post.mockResolvedValueOnce(fail(409, { code: 'base_mismatch' }));
    compose();
    fireEvent.click(button(t('en', 'm10.chg.submit')));
    expect(await screen.findByText(t('en', 'm10.err.baseMismatch'), { exact: false })).toBeTruthy();
    fireEvent.click(button(t('en', 'm10.chg.reload')));
    expect(refresh).toHaveBeenCalled();
  });
  it('422 change_rejected lists field errors and never echoes a secret', async () => {
    post.mockResolvedValueOnce(
      fail(422, {
        code: 'change_rejected',
        errors: [
          { path: 'patches[0].content', message: 'secret pattern AKIAABCDEFGHIJKLMNOPQRSTUVWX' },
        ],
      }),
    );
    compose();
    fireEvent.click(button(t('en', 'm10.chg.submit')));
    expect(await screen.findByText('patches[0].content')).toBeTruthy();
    expect(document.body.textContent).not.toContain('AKIAABCDEFGHIJKLMNOPQRSTUVWX');
    expect(document.body.textContent).toContain('[REDACTED]');
  });
});

describe('deployments (UI-M10-09)', () => {
  const dep = (over: Record<string, unknown> = {}) => ({
    id: 'd1111111-1111-7222-8333-444455556666',
    environment: 'production',
    target: { type: 'site', id: UUID },
    state: 'live',
    healthCheck: { attempts: 2, autoRolledBack: false },
    createdAt: '2026-11-18T10:00:00Z',
    ...over,
  });
  const props = {
    locale: 'en' as const,
    projectId: UUID,
    versions: [],
    headVersionId: null,
    canCreate: true,
    canRoll: true,
    mfaFactorId: null,
  };
  it('403 approval_required lists the approvals with a link to the inbox', async () => {
    get.mockResolvedValue(ok({ items: [] }));
    post.mockResolvedValueOnce(
      fail(403, {
        code: 'approval_required',
        approvals: [{ id: 'ap-1', type: 'production_deploy', scopeHash: HASH }],
      }),
    );
    render(<Deployments {...props} initial={[]} />);
    fill(t('en', 'm10.dep.targetId'), UUID);
    fill(t('en', 'm10.dep.env'), 'production');
    fireEvent.click(button(t('en', 'm10.dep.create')));
    expect(await screen.findByText(t('en', 'm10.dep.approvalNeeded'))).toBeTruthy();
    expect(screen.getByText(HASH)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: t('en', 'm10.dep.openApprovals') }).getAttribute('href'),
    ).toBe('/en/approvals');
    const [path, init] = post.mock.calls[0]!;
    expect(path).toBe('/v1/deployments');
    expect(init.body).toMatchObject({
      projectId: UUID,
      target: { type: 'site', id: UUID },
      env: 'production',
    });
    expect(init.params.header['Idempotency-Key']).toBeTruthy();
  });
  it('validates the target id before calling', () => {
    render(<Deployments {...props} initial={[]} />);
    fill(t('en', 'm10.dep.targetId'), 'nope');
    fireEvent.click(button(t('en', 'm10.dep.create')));
    expect(screen.getByText(t('en', 'm10.dep.err.target'))).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });
  it('shows the health-gate result and the logs of the selected deployment', async () => {
    get.mockResolvedValue(ok({ items: [{ seq: 1, level: 'info', message: 'release activated' }] }));
    render(
      <Deployments
        {...props}
        initial={
          [
            dep({
              state: 'failed',
              failureCode: 'health_gate_failed',
              healthCheck: {
                attempts: 3,
                autoRolledBack: true,
                restoredDeploymentId: 'abcdef12-0000',
              },
            }),
          ] as never
        }
      />,
    );
    expect(screen.getAllByText(t('en', 'm10.dep.gateFailed')).length).toBeGreaterThan(0);
    expect(screen.getByText(t('en', 'm10.dep.restored', { id: 'abcdef12' }))).toBeTruthy();
    expect(await screen.findByText(/release activated/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('en', 'm10.dep.rollback') })).toBeNull(); // only a live deployment can be rolled back
  });
  it('rollback asks to confirm, posts with an Idempotency-Key, and handles approval_required', async () => {
    get.mockResolvedValue(ok({ items: [] }));
    post.mockResolvedValueOnce(
      fail(403, {
        code: 'approval_required',
        approvals: [{ id: 'ap-9', type: 'production_rollback', scopeHash: HASH }],
      }),
    );
    render(<Deployments {...props} initial={[dep()] as never} />);
    fireEvent.click(button(t('en', 'm10.dep.rollback')));
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(button(t('en', 'm10.dep.rollbackConfirm')));
    expect(await screen.findByText(t('en', 'm10.dep.approvalNeeded'))).toBeTruthy();
    const [path, init] = post.mock.calls[0]!;
    expect(path).toBe('/v1/deployments/{id}/rollback');
    expect(init.params.header['Idempotency-Key']).toBeTruthy();
  });
  it('rollback in a state that does not allow it shows invalid_state', async () => {
    get.mockResolvedValue(ok({ items: [] }));
    post.mockResolvedValueOnce(fail(409, { code: 'invalid_state' }));
    render(<Deployments {...props} initial={[dep()] as never} />);
    fireEvent.click(button(t('en', 'm10.dep.rollback')));
    fireEvent.click(button(t('en', 'm10.dep.rollbackConfirm')));
    expect(await screen.findByText(t('en', 'm10.err.invalidState'))).toBeTruthy();
  });
});

describe('exports (UI-M10-10)', () => {
  const ready = (over: Record<string, unknown> = {}) => ({
    id: 'e1111111-1111-7222-8333-444455556666',
    status: 'ready',
    sha256: 'ab'.repeat(32),
    sbomRef: 'sbom://x',
    downloadUrl: 'https://files.example.test/x.zip',
    downloadUrlExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    ...over,
  });
  it('offers the download only while the signed URL is valid and shows its expiry', () => {
    render(
      <Exports
        locale="en"
        projectId={UUID}
        initial={[ready()] as never}
        canExport
        mfaFactorId={null}
      />,
    );
    expect(
      screen.getByRole('link', { name: t('en', 'm10.exp.download') }).getAttribute('href'),
    ).toBe('https://files.example.test/x.zip');
    expect(screen.getByText('ab'.repeat(32))).toBeTruthy();
    expect(screen.getByText(/Link valid until/)).toBeTruthy();
  });
  it('an expired link is not offered; a new one can be requested', async () => {
    get.mockResolvedValueOnce(ok(ready()));
    render(
      <Exports
        locale="en"
        projectId={UUID}
        initial={[ready({ downloadUrlExpiresAt: '2020-01-01T00:00:00Z' })] as never}
        canExport
        mfaFactorId={null}
      />,
    );
    expect(screen.queryByRole('link', { name: t('en', 'm10.exp.download') })).toBeNull();
    fireEvent.click(button(t('en', 'm10.exp.newLink')));
    expect(await screen.findByRole('link', { name: t('en', 'm10.exp.download') })).toBeTruthy();
  });
  it('a blocked export lists the rule and the path, and has no download', () => {
    render(
      <Exports
        locale="en"
        projectId={UUID}
        initial={
          [
            {
              id: 'e2',
              status: 'blocked',
              blockedReasons: [{ rule: 'secret_pattern', path: 'src/.env', line: 3 }],
            },
          ] as never
        }
        canExport
        mfaFactorId={null}
      />,
    );
    expect(screen.getByText('secret_pattern')).toBeTruthy();
    expect(screen.getByText('src/.env')).toBeTruthy();
    expect(screen.queryByRole('link', { name: t('en', 'm10.exp.download') })).toBeNull();
  });
});
