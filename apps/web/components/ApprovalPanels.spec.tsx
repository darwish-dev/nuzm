// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';
import type { Approval } from '../lib/appbuilder';
import { ApprovalsInbox } from './ApprovalPanels';

const get = vi.fn();
const post = vi.fn();
vi.mock('../lib/client', () => ({ browserApi: () => ({ GET: get, POST: post }) }));

const ok = (data: unknown) => ({ data, response: { ok: true, status: 200 } });
const fail = (status: number, error: unknown) => ({ error, response: { ok: false, status } });

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  get.mockReset();
  post.mockReset();
});

const HASH = 'a'.repeat(64);
const ID = '11111111-1111-4111-8111-111111111111';
const approval = (over: Partial<Approval> = {}): Approval =>
  ({
    id: ID,
    subjectType: 'project',
    subjectId: '22222222-2222-4222-8222-222222222222',
    runId: null,
    type: 'production_deploy',
    action: { target: 'site' },
    scopeHash: HASH,
    status: 'pending',
    requestedByKind: 'user',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...over,
  }) as Approval;

function openAndApprove() {
  fireEvent.click(
    screen.getByRole('button', {
      name: t('en', 'm10.apr.open', { type: t('en', 'm10.apr.type.production_deploy') }),
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: t('en', 'm10.apr.approve'), hidden: true }));
  fireEvent.click(
    screen.getByRole('button', { name: t('en', 'm10.apr.confirmApprove'), hidden: true }),
  );
}
const view = (canDecide = true) =>
  render(
    <ApprovalsInbox locale="en" initial={[approval()]} canDecide={canDecide} mfaFactorId={null} />,
  );

describe('approvals inbox (UI-M10-07)', () => {
  it('lists the pending approvals of the organization with type, status and expiry', () => {
    view();
    expect(screen.getByRole('table', { name: t('en', 'm10.apr.title') })).toBeTruthy();
    expect(screen.getAllByText(t('en', 'm10.apr.status.pending')).length).toBeGreaterThan(0);
  });
  it('the empty inbox says so', () => {
    render(<ApprovalsInbox locale="en" initial={[]} canDecide mfaFactorId={null} />);
    expect(screen.getByText(t('en', 'm10.apr.empty'))).toBeTruthy();
  });
  it('a decision posts decision + the scopeHash of the exact action shown, with an idempotency key, and the row is updated', async () => {
    post.mockResolvedValue(ok(approval({ status: 'approved' })));
    view();
    openAndApprove();
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, init] = post.mock.calls[0] as [
      string,
      { params: { path: { approvalId: string }; header: Record<string, string> }; body: object },
    ];
    expect(path).toBe('/v1/ai/approvals/{approvalId}/decisions');
    expect(init.params.path.approvalId).toBe(ID);
    expect(init.body).toMatchObject({ decision: 'approve', scopeHash: HASH });
    expect(init.params.header['Idempotency-Key']).toBeTruthy();
    expect(await screen.findByText(t('en', 'm10.apr.approved'))).toBeTruthy();
  });
  it('409 stale_approval_hash: says the action changed, reloads it, and makes the person review it again', async () => {
    post.mockResolvedValue(fail(409, { code: 'stale_approval_hash' }));
    get.mockResolvedValue(ok(approval({ scopeHash: 'b'.repeat(64) })));
    view();
    openAndApprove();
    expect(await screen.findByText(t('en', 'm10.apr.err.stale'))).toBeTruthy();
    expect(await screen.findByText(t('en', 'm10.apr.reviewAgain'))).toBeTruthy();
    expect(get).toHaveBeenCalledWith('/v1/ai/approvals/{approvalId}', expect.anything());
  });
  it('410 gone: the approval expired', async () => {
    post.mockResolvedValue(fail(410, { code: 'gone' }));
    view();
    openAndApprove();
    expect(await screen.findByText(t('en', 'm10.apr.err.expired'))).toBeTruthy();
  });
  it('409 conflict: already decided differently', async () => {
    post.mockResolvedValue(fail(409, { code: 'conflict' }));
    view();
    openAndApprove();
    expect(await screen.findByText(t('en', 'm10.apr.err.decided'))).toBeTruthy();
  });
  it('403: the role of this approval type is missing', async () => {
    post.mockResolvedValue(fail(403, { code: 'forbidden' }));
    view();
    openAndApprove();
    expect(await screen.findByText(t('en', 'm10.apr.err.role'))).toBeTruthy();
  });
  it('a member without ai:approve cannot decide: no approve/reject controls in the drawer', () => {
    view(false);
    fireEvent.click(
      screen.getByRole('button', {
        name: t('en', 'm10.apr.open', { type: t('en', 'm10.apr.type.production_deploy') }),
      }),
    );
    expect(screen.getByText(t('en', 'm10.apr.cannotDecide'))).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: t('en', 'm10.apr.approve'), hidden: true }),
    ).toBeNull();
  });
});
