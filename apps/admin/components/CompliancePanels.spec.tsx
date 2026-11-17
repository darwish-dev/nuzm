// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

const post = vi.fn();
const get = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('../lib/client', () => ({ browserApi: () => ({ POST: post, GET: get }) }));
import {
  BreachMovePanel,
  BreachOpenForm,
  BreachPack,
  EvidenceForm,
  ValidationForm,
} from './CompliancePanels';
import { ComplianceTabs } from './ComplianceTabs';

const ok = (data: unknown = {}) => ({ response: { ok: true, status: 200 }, data });
const CASE = '0194a1b2-1111-7222-8333-444455556666';
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  post.mockReset();
  get.mockReset();
});
afterEach(cleanup);

describe('the register never offers a way to claim compliance', () => {
  it('the tabs name sections, not verdicts', () => {
    render(<ComplianceTabs locale="en" current="controls" />);
    const links = screen.getAllByRole('link').map((a) => a.textContent);
    expect(links).toHaveLength(7);
    expect(links.join(' ').toLowerCase()).not.toMatch(/compliant|certified/);
    expect(
      screen.getByRole('link', { name: t('en', 'cmp.tab.controls') }).getAttribute('aria-current'),
    ).toBe('page');
  });
});

describe('validation form (UI-M04-13)', () => {
  const items = [
    { validationKey: 'nca-ecc', regime: 'NCA ECC', version: 2, applicability: 'to_confirm' },
  ];
  it('will not send "validated" without a document and a decided applicability', () => {
    render(<ValidationForm locale="en" mfaFactorId={null} items={items} />);
    type(t('en', 'cmp.val.col.status'), 'validated');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'cmp.val.submit') }));
    expect(screen.getByRole('alert').textContent).toBe(t('en', 'cmp.val.needsEvidence'));
    type(t('en', 'cmp.val.doc'), 'dataroom://counsel/memo.pdf');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'cmp.val.submit') }));
    expect(screen.getByRole('alert').textContent).toBe(t('en', 'cmp.val.needsEvidence')); // still to_confirm
    expect(post).not.toHaveBeenCalled();
  });
  it('sends the current version and an Idempotency-Key when the evidence is there', async () => {
    post.mockResolvedValue(ok({}));
    render(<ValidationForm locale="en" mfaFactorId={null} items={items} />);
    type(t('en', 'cmp.val.col.status'), 'validated');
    type(t('en', 'cmp.val.col.applic'), 'applicable');
    type(t('en', 'cmp.val.doc'), 'dataroom://counsel/memo.pdf');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'cmp.val.submit') }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]!;
    expect(path).toBe('/v1/admin/compliance/regulatory-validations');
    expect(init.body).toMatchObject({
      validationKey: 'nca-ecc',
      baseVersion: 2,
      status: 'validated',
      applicability: 'applicable',
      documentRef: 'dataroom://counsel/memo.pdf',
    });
    expect(init.body).not.toHaveProperty('validatedBy'); // the signed-in person is recorded by the API
    expect(init.params.header['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText(t('en', 'cmp.val.saved'))).toBeTruthy();
  });
  it('says so on a version conflict', async () => {
    post.mockResolvedValue({ response: { ok: false, status: 409 }, error: { code: 'conflict' } });
    render(<ValidationForm locale="en" mfaFactorId={null} items={items} />);
    type(t('en', 'cmp.val.answer'), 'Probably applies');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'cmp.val.submit') }));
    expect((await screen.findByRole('alert')).textContent).toBe(t('en', 'cmp.conflict'));
  });
});

describe('evidence form (UI-M04-10)', () => {
  const controls = [{ controlId: 'CTL-TST-001', title: 'A control' }];
  it('offers no automated type and asks for a reference or a note', () => {
    render(<EvidenceForm locale="en" mfaFactorId={null} controls={controls} />);
    const options = [
      ...screen.getByLabelText(t('en', 'cmp.ev.type')).querySelectorAll('option'),
    ].map((o) => o.value);
    expect(options).toEqual(['document', 'attestation', 'external-report']);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'cmp.ev.submit') }));
    expect(screen.getByRole('alert').textContent).toBe(t('en', 'cmp.invalid'));
    expect(post).not.toHaveBeenCalled();
  });
  it('sends a document with its reference', async () => {
    post.mockResolvedValue(ok({}));
    render(<EvidenceForm locale="en" mfaFactorId={null} controls={controls} />);
    type(t('en', 'cmp.ev.ref'), 'dataroom://policies/access.pdf');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'cmp.ev.submit') }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1].body).toEqual({
      controlId: 'CTL-TST-001',
      type: 'document',
      documentRef: 'dataroom://policies/access.pdf',
    });
  });
});

describe('breach screens (UI-M04-14)', () => {
  it('opens a case only with a summary and a real time', () => {
    render(<BreachOpenForm locale="en" mfaFactorId={null} />);
    type(t('en', 'cmp.br.summary'), 'Too short');
    type(t('en', 'cmp.br.detectedAt'), '2026-03-01T10:00');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'cmp.br.openSubmit') }));
    expect(screen.getByRole('alert').textContent).toBe(t('en', 'cmp.invalid'));
    expect(post).not.toHaveBeenCalled();
  });
  it('shows the next step only, and nothing for a closed case or a viewer', () => {
    const { container, rerender } = render(
      <BreachMovePanel
        locale="en"
        mfaFactorId={null}
        caseId={CASE}
        version={1}
        state="closed"
        decision={null}
        canManage
      />,
    );
    expect(container.textContent).toBe('');
    rerender(
      <BreachMovePanel
        locale="en"
        mfaFactorId={null}
        caseId={CASE}
        version={1}
        state="detected"
        decision={null}
        canManage={false}
      />,
    );
    expect(container.textContent).toBe('');
    rerender(
      <BreachMovePanel
        locale="en"
        mfaFactorId={null}
        caseId={CASE}
        version={1}
        state="assessed"
        decision={null}
        canManage
      />,
    );
    expect(
      screen.getByRole('heading', {
        name: t('en', 'cmp.br.move', { state: t('en', 'cmp.br.state.notification_decision') }),
      }),
    ).toBeTruthy();
    expect(screen.getByText(t('en', 'cmp.br.decisionOther'))).toBeTruthy();
  });
  it('sends the move with the case version and tells the assessor they cannot decide', async () => {
    post.mockResolvedValue({ response: { ok: false, status: 403 }, error: { code: 'forbidden' } });
    render(
      <BreachMovePanel
        locale="en"
        mfaFactorId={null}
        caseId={CASE}
        version={4}
        state="assessed"
        decision={null}
        canManage
      />,
    );
    type(t('en', 'cmp.br.f.rationale'), 'Counsel advised to notify');
    type(t('en', 'cmp.br.f.recipients'), 'regulator, affected customers');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'cmp.br.moveSubmit') }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1].body).toEqual({
      caseId: CASE,
      transition: 'notification_decision',
      baseVersion: 4,
      data: {
        notify: true,
        rationale: 'Counsel advised to notify',
        recipients: ['regulator', 'affected customers'],
      },
    });
    expect((await screen.findByRole('alert')).textContent).toBe(t('en', 'cmp.br.forbidden'));
  });
  it('the evidence pack needs a reason first, then shows the digest', async () => {
    get.mockResolvedValue(ok({ items: [{ evidencePack: { digest: 'abc123' } }] }));
    render(<BreachPack locale="en" caseId={CASE} />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'cmp.br.packSubmit') }));
    expect(get).not.toHaveBeenCalled();
    type(t('en', 'cmp.br.packReason'), 'Counsel pack for the incident');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'cmp.br.packSubmit') }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(get.mock.calls[0]![1].params.query).toEqual({
      id: CASE,
      pack: true,
      reason: 'Counsel pack for the incident',
    });
    expect((await screen.findByRole('status')).textContent).toContain('abc123');
  });
});
