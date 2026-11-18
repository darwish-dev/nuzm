// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

const post = vi.fn();
const put = vi.fn();
const patch = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('../lib/client', () => ({ browserApi: () => ({ POST: post, PUT: put, PATCH: patch }) }));
vi.mock('./StepUp', () => ({ useStepUp: () => ({ ask: vi.fn(), panel: null }) }));
import { PolicyPublishForm, ReviewDecision, RetentionForm } from './GovernancePanels';
import { GovernanceTabs, OpsTabs } from './M12Tabs';
import { AlertActions, IncidentUpdatePanel, RecoveryExerciseForm } from './OpsPanels';

const ok = (data: unknown = {}) => ({ response: { ok: true, status: 200 }, data });
const ID = '0194a1b2-1111-7222-8333-444455556666';
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
beforeEach(() => [post, put, patch].forEach((m) => m.mockReset()));
afterEach(cleanup);

describe('tabs list only what the staff member may read', () => {
  it('operations tabs need admin:ops:read', () => {
    render(<OpsTabs locale="en" current="health" can={() => false} />);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    cleanup();
    render(<OpsTabs locale="en" current="health" can={(p) => p === 'admin:ops:read'} />);
    expect(screen.getAllByRole('link')).toHaveLength(7);
    expect(
      screen.getByRole('link', { name: t('en', 'm12.tab.health') }).getAttribute('aria-current'),
    ).toBe('page');
  });
  it('governance tabs follow the permission of each screen', () => {
    render(
      <GovernanceTabs locale="en" current="policies" can={(p) => p === 'admin:compliance:read'} />,
    );
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual([
      t('en', 'm12.tab.policies'),
      t('en', 'm12.tab.retention'),
    ]);
  });
});

describe('recovery exercise form (UI-M12-09)', () => {
  const fill = (rpo = '120') => {
    type(t('en', 'm12.dr.col.started'), '2026-11-01T10:00');
    type(t('en', 'm12.dr.col.restored'), '2026-11-01T11:00');
    type(t('en', 'm12.dr.col.rpo'), rpo);
    type(t('en', 'm12.dr.col.evidence'), 'evidence/restore-2026-11-01.log');
  };
  it('shows the computed RTO and sends it with the two timestamps, never a result', async () => {
    post.mockResolvedValue(ok({}));
    render(<RecoveryExerciseForm locale="en" mfaFactorId={null} />);
    fill();
    expect(screen.getByText('01:00:00')).toBeTruthy();
    expect(screen.queryByLabelText(t('en', 'm12.dr.col.rto'))).toBeNull(); // there is no field to type an RTO into
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm12.dr.submit') }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]!;
    expect(path).toBe('/v1/admin/recovery-exercises');
    expect(init.body).toMatchObject({
      rtoSeconds: 3600,
      rpoSeconds: 120,
      scope: 'control_plane_db',
    });
    expect(init.body).not.toHaveProperty('result');
    expect(init.params.header['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('refuses a restore before the start without calling the API', () => {
    render(<RecoveryExerciseForm locale="en" mfaFactorId={null} />);
    fill();
    type(t('en', 'm12.dr.col.restored'), '2026-11-01T09:00');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm12.dr.submit') }));
    expect(screen.getAllByText(t('en', 'm12.dr.invalidTimes')).length).toBeGreaterThan(0);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('incident update (UI-M12-06)', () => {
  it('offers only the allowed next statuses and sends only what changed', async () => {
    patch.mockResolvedValue(ok({}));
    render(
      <IncidentUpdatePanel
        locale="en"
        mfaFactorId={null}
        id={ID}
        status="resolved"
        severity="SEV3"
        breachCaseId={null}
      />,
    );
    const status = screen.getByLabelText(t('en', 'm12.inc.col.status')) as HTMLSelectElement;
    expect([...status.options].map((o) => o.value)).toEqual(['', 'closed', 'investigating']);
    type(t('en', 'm12.inc.col.status'), 'closed');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm12.inc.update.submit') }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]![1].body).toEqual({ status: 'closed' });
    expect(patch.mock.calls[0]![1].params.path.id).toBe(ID);
  });
  it('a closed incident has no form', () => {
    render(
      <IncidentUpdatePanel
        locale="en"
        mfaFactorId={null}
        id={ID}
        status="closed"
        severity="SEV3"
        breachCaseId={null}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(t('en', 'm12.inc.closedTerminal'))).toBeTruthy();
  });
});

describe('alert actions (UI-M12-07)', () => {
  it('acknowledges only a firing alert', async () => {
    post.mockResolvedValue(ok({}));
    render(<AlertActions locale="en" mfaFactorId={null} ruleKey="queue.lag" state="firing" />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm12.al.ack') }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1].body).toEqual({ action: 'acknowledge', ruleKey: 'queue.lag' });
    cleanup();
    render(<AlertActions locale="en" mfaFactorId={null} ruleKey="queue.lag" state="ok" />);
    expect(screen.queryByRole('button', { name: t('en', 'm12.al.ack') })).toBeNull();
  });
  it('silencing needs an expiry in range', async () => {
    render(<AlertActions locale="en" mfaFactorId={null} ruleKey="queue.lag" state="firing" />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm12.al.silence') }));
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm12.al.silenceSubmit') }));
    expect(screen.getByRole('alert').textContent).toBe(t('en', 'm12.al.silenceInvalid'));
    expect(post).not.toHaveBeenCalled();
  });
});

describe('access review decision (UI-M12-11)', () => {
  it('needs a reason, then sends the item, the decision and an Idempotency-Key', async () => {
    post.mockResolvedValue(ok({}));
    render(<ReviewDecision locale="en" mfaFactorId={null} reviewId="r-1" itemId={ID} />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm12.ar.revoke') }));
    expect(screen.getByRole('alert').textContent).toBe(t('en', 'm12.ar.reasonNeeded'));
    expect(post).not.toHaveBeenCalled();
    type(t('en', 'm12.ar.reason'), 'left the company');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm12.ar.revoke') }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]!;
    expect(path).toBe('/v1/admin/access-reviews/{id}/decisions');
    expect(init.params.path.id).toBe('r-1');
    expect(init.body).toEqual({ itemId: ID, decision: 'revoke', reason: 'left the company' });
    expect(init.params.header['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('says so when the caller is not an assigned reviewer', async () => {
    post.mockResolvedValue({ response: { ok: false, status: 403 }, error: { code: 'forbidden' } });
    render(<ReviewDecision locale="en" mfaFactorId={null} reviewId="r-1" itemId={ID} />);
    type(t('en', 'm12.ar.reason'), 'still needed');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm12.ar.keep') }));
    expect(await screen.findByText(t('en', 'm12.ar.notReviewer'))).toBeTruthy();
  });
});

describe('policy publish (UI-M12-12)', () => {
  const fill = () => {
    type(t('en', 'm12.pol.col.key'), 'security');
    type(t('en', 'm12.pol.col.title'), 'Security policy');
    type(t('en', 'm12.pol.col.ref'), 'dataroom://policies/security-v3.pdf');
    type(t('en', 'm12.pol.col.effective'), '2026-12-01');
  };
  it('sends the current version as If-Match and no approval: the version is a draft', async () => {
    put.mockResolvedValue(ok({}));
    render(<PolicyPublishForm locale="en" mfaFactorId={null} versions={{ security: 2 }} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm12.pol.form.submit') }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [path, init] = put.mock.calls[0]!;
    expect(path).toBe('/v1/admin/policy-versions');
    expect(init.params.header['If-Match']).toBe('"2"');
    expect(init.body).not.toHaveProperty('approvedBy');
  });
  it('a new key starts from "0" and a stale version is explained', async () => {
    put.mockResolvedValue({
      response: { ok: false, status: 412 },
      error: { code: 'etag_mismatch' },
    });
    render(<PolicyPublishForm locale="en" mfaFactorId={null} versions={{}} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm12.pol.form.submit') }));
    expect(await screen.findByText(t('en', 'm12.pol.stale'))).toBeTruthy();
    expect(put.mock.calls[0]![1].params.header['If-Match']).toBe('"0"');
  });
});

describe('audit retention form (UI-M12-14)', () => {
  const fill = (retain: string) => {
    type(t('en', 'm12.ret.col.class'), 'security');
    type(t('en', 'm12.ret.col.retain'), retain);
    type(t('en', 'm12.ret.col.archive'), '100');
    type(t('en', 'm12.ret.col.basis'), 'proposal 13 months');
  };
  it('refuses a period below the minimum without calling the API', () => {
    render(<RetentionForm locale="en" mfaFactorId={null} minimumDays={395} policies={[]} />);
    fill('100');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm12.ret.form.submit') }));
    expect(screen.getByRole('alert').textContent).toBe(t('en', 'm12.ret.belowMinimum'));
    expect(put).not.toHaveBeenCalled();
  });
  it('sends baseVersion for an existing class and says nothing was archived', async () => {
    put.mockResolvedValue(ok({}));
    render(
      <RetentionForm
        locale="en"
        mfaFactorId={null}
        minimumDays={395}
        policies={[{ dataClass: 'security', version: 3 }]}
      />,
    );
    fill('400');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm12.ret.form.submit') }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0]![1].body).toMatchObject({
      retainDays: 400,
      baseVersion: 3,
      status: 'proposal',
    });
    expect(await screen.findByText(t('en', 'm12.ret.saved'))).toBeTruthy();
  });
});
