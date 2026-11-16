import { expect, test } from '@playwright/test';
import { T, audit, loc, signIn, totp } from './helpers';

const ADMIN = 'http://127.0.0.1:3001';

test('admin console: staff sign-in with mandatory MFA, suspend/reinstate, audit viewer', async ({
  page,
  browser,
}, info) => {
  const L = loc(info);
  const adm = (path: string) => `${ADMIN}/${L}${path}`;
  const orgName = L === 'ar' ? 'شركة الأفق 2' : 'Horizon Cloud 2';

  // --- sign-in → MFA is mandatory: the first screen is enrolment (QR + manual key)
  await signIn(page, info, `staff-${L}@example.test`, ADMIN);
  await expect(page.getByRole('heading', { name: T(info, 'mfa.title') })).toBeVisible();
  await page.getByRole('button', { name: T(info, 'mfa.start') }).click();
  await expect(page.getByRole('img', { name: T(info, 'mfa.qr') })).toBeVisible();
  await audit(page, info, 'admin-mfa-enrol', [
    page.locator('main bdi'),
    page.getByRole('img', { name: T(info, 'mfa.qr') }),
  ]);
  const secret = (await page.locator('main bdi').first().innerText()).trim();
  await page.getByLabel(T(info, 'field.code')).fill(totp(secret));
  await page.getByRole('button', { name: T(info, 'action.verify') }).click();

  // --- organizations (cross-tenant), suspend with a reason
  await expect(page.getByRole('heading', { name: T(info, 'admin.orgs.title') })).toBeVisible();
  await expect(page.getByRole('cell', { name: new RegExp(orgName) })).toBeVisible();
  await audit(page, info, 'admin-organizations');
  // both locales' organizations live in the same database: act on this run's row only
  const row = page.getByRole('row', { name: new RegExp(orgName) });
  await row.getByRole('button', { name: T(info, 'action.suspend') }).click();
  await audit(page, info, 'admin-suspend-form');
  await row.getByLabel(T(info, 'admin.suspend.reason')).fill('Abuse report 4821 under review');
  await row
    .getByRole('button', { name: T(info, 'action.suspend') })
    .last()
    .click();
  await expect(row.getByText(T(info, 'status.suspended'), { exact: true })).toBeVisible();

  // --- the customer sees the suspension (separate browser context = separate cookies)
  const owner = await browser.newContext({ locale: L === 'ar' ? 'ar-SA' : 'en-GB' });
  const op = await owner.newPage();
  await signIn(op, info, `owner-${L}@example.test`);
  await op.goto(`http://127.0.0.1:3000/${L}/workspaces`);
  await expect(op.getByRole('heading', { name: T(info, 'state.suspended.title') })).toBeVisible();
  await audit(op, info, 'customer-suspended');
  await owner.close();

  // --- reinstate (MFA is still fresh), then users + audit viewer + flags
  await row.getByRole('button', { name: T(info, 'action.reinstate') }).click();
  await expect(row.getByText(T(info, 'status.active'), { exact: true })).toBeVisible();

  await page.goto(adm('/users'));
  await expect(page.getByRole('heading', { name: T(info, 'admin.users.title') })).toBeVisible();
  await expect(page.getByRole('cell', { name: `owner-${L}@example.test` })).toBeVisible();
  await audit(page, info, 'admin-users');
  await page
    .getByRole('button', { name: T(info, 'action.impersonate') })
    .first()
    .click();
  await audit(page, info, 'admin-impersonate-form');

  await page.goto(adm('/audit-logs'));
  await expect(page.getByText('admin.organization.suspended').first()).toBeVisible();
  await audit(page, info, 'admin-audit-logs');

  await page.goto(adm('/feature-flags'));
  await page.getByLabel(T(info, 'field.name')).fill('beta.dashboard');
  await page.getByRole('button', { name: T(info, 'action.save') }).click();
  await expect(page.getByRole('cell', { name: 'beta.dashboard' })).toBeVisible();
  await audit(page, info, 'admin-feature-flags');

  // --- a fresh sign-in is CHALLENGED (not asked to enrol again)
  await page.context().clearCookies();
  await signIn(page, info, `staff-${L}@example.test`, ADMIN);
  await expect(page.getByRole('heading', { name: T(info, 'mfa.challenge.title') })).toBeVisible();
  await audit(page, info, 'admin-mfa-challenge');
});
