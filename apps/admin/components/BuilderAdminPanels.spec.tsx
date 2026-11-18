// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { t } from '@nuzm/i18n';
import { AdminRunsTable, AdminSandboxNodes } from './BuilderAdminPanels';
import { adminRunOf } from '../lib/builder-admin';

afterEach(cleanup);

describe('AI run oversight', () => {
  const rows = [
    adminRunOf({
      id: 'aaaaaaaa-1',
      orgId: 'bbbbbbbb-1',
      kind: 'webapp',
      state: 'budget_exceeded',
      dataRegion: 'sa-central',
      flags: { budgetBreach: true },
    })!,
    adminRunOf({
      id: 'cccccccc-1',
      orgId: 'bbbbbbbb-1',
      kind: 'webapp',
      state: 'failed',
      reason: 'approval_rejected',
      flags: { deniedApproval: true },
    })!,
    adminRunOf({
      id: 'dddddddd-1',
      orgId: 'bbbbbbbb-1',
      kind: 'test-fix',
      state: 'failed',
      reason: 'escalated_to_human',
      flags: { escalated: true },
    })!,
  ];
  it('shows the budget-breach, denied-approval and escalated flags, and no action buttons', () => {
    render(<AdminRunsTable locale="en" rows={rows} />);
    expect(screen.getByText(t('en', 'm10.adm.flag.budgetBreach'))).toBeTruthy();
    expect(screen.getByText(t('en', 'm10.adm.flag.deniedApproval'))).toBeTruthy();
    expect(screen.getByText(t('en', 'm10.adm.flag.escalated'))).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('is readable in Arabic and shows an empty state', () => {
    const { unmount } = render(<AdminRunsTable locale="ar" rows={rows} />);
    expect(screen.getAllByText(t('ar', 'm10.adm.flag.budgetBreach')).length).toBeGreaterThan(0);
    unmount();
    render(<AdminRunsTable locale="en" rows={[]} />);
    expect(screen.getByText(t('en', 'm10.adm.runs.empty'))).toBeTruthy();
  });
});

describe('sandbox fleet', () => {
  it('states the M05 dependency and that force-kill is hidden, and renders no kill button', () => {
    render(<AdminSandboxNodes locale="en" rows={[]} />);
    expect(screen.getByText(t('en', 'm10.adm.sbx.m05'))).toBeTruthy();
    expect(screen.getByText(t('en', 'm10.adm.sbx.noKill'))).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('lists nodes without any action', () => {
    render(
      <AdminSandboxNodes
        locale="en"
        rows={[
          {
            id: 'aaaaaaaa-1',
            orgId: 'bbbbbbbb-1',
            kind: 'sandbox_node',
            providerAccountId: 'x',
            state: 'ACTIVE',
            dataRegion: 'sa-central',
            country: 'SA',
            providerRegionId: 'r',
            driftState: 'in_sync',
          },
        ]}
      />,
    );
    expect(screen.getByText('sandbox_node')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
