import { expect, test } from '@playwright/test';
import { T, audit, loc, signIn, totp } from './helpers';
import { resetDatabase } from './reset';

test.beforeAll(resetDatabase);

test('customer console: onboarding, projects, security and team screens', async ({
  page,
}, info) => {
  const L = loc(info);
  const email = `owner-${L}@example.test`;
  const go = (path: string) => page.goto(`/${L}${path}`);
  const orgName = L === 'ar' ? 'شركة الأفق' : 'Horizon Cloud';
  const name = T(info, 'field.name');
  const create = T(info, 'action.create');

  // --- sign in, empty state, create organization
  await signIn(page, info, email);
  // a person with no organization is taken straight to creating one (the console redirects `/` to `/orgs/new` until an organization exists)
  await expect(page).toHaveURL(/\/orgs\/new$/);
  await expect(
    page.getByRole('heading', { name: T(info, 'org.new.title'), level: 1 }),
  ).toBeVisible();
  await audit(page, info, 'org-new');
  await page.getByLabel(name).fill(orgName);
  await page.getByRole('button', { name: create }).click();
  // the dashboard greets the person and the header's organization switcher shows the new organization
  await expect(
    page.getByRole('heading', { name: T(info, 'home.title', { name: 'Layla Owner' }), level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('combobox', { name: T(info, 'field.orgSwitcher') })).toContainText(
    orgName,
  );
  await audit(page, info, 'home');

  // --- workspaces → projects → environments
  await go('/workspaces');
  await page.getByLabel(name).fill('Main');
  await page.getByRole('button', { name: create }).click();
  await expect(page.getByRole('cell', { name: 'Main', exact: true })).toBeVisible();
  await audit(page, info, 'workspaces');

  await go('/projects');
  await page.getByLabel(name).fill('Website');
  await page.getByRole('button', { name: create }).click();
  await expect(page.getByRole('link', { name: 'Website' })).toBeVisible();
  await audit(page, info, 'projects');
  await page.getByRole('link', { name: 'Website' }).click();
  await page.getByLabel(name).fill('production');
  await page.getByLabel(T(info, 'field.kind')).selectOption('prod');
  await page.getByRole('button', { name: create }).click();
  await expect(page.getByRole('cell', { name: 'production', exact: true })).toBeVisible();
  await audit(page, info, 'environments');

  // --- two-factor enrolment (QR + manual key) → recovery codes and API keys (both need a fresh MFA)
  // the account is one page: profile, sessions, two-step, password and recovery codes are sections on it
  await go('/account');
  await page.getByRole('button', { name: T(info, 'mfa.start') }).click();
  await expect(page.getByRole('img', { name: T(info, 'mfa.qr') })).toBeVisible();
  await audit(page, info, 'mfa-enrol', [
    page.locator('#mfa bdi'),
    page.getByRole('img', { name: T(info, 'mfa.qr') }),
  ]);
  const secret = (await page.locator('#mfa bdi').first().innerText()).trim();
  await page.getByLabel(T(info, 'field.code')).fill(totp(secret));
  await page.getByRole('button', { name: T(info, 'action.verify') }).click();
  await expect(page.getByText(T(info, 'mfa.done'))).toBeVisible();

  await page.getByRole('button', { name: T(info, 'recovery.generate') }).click();
  await expect(page.getByText(T(info, 'recovery.done'))).toBeVisible();
  await expect(page.locator('section[role="status"] li')).toHaveCount(10);
  await audit(page, info, 'recovery-codes', [page.locator('section[role="status"] li')]);

  // team and access is one page: members, invitations and API keys are sections on it
  await go('/settings/team');
  const keys = page.locator('#apikeys');
  await keys.getByLabel(T(info, 'field.keyName')).fill('ci-key');
  await keys.getByLabel('project:read').check();
  await keys.getByRole('button', { name: create }).click();
  await expect(page.getByRole('heading', { name: T(info, 'apikeys.secret.title') })).toBeVisible();
  const key = await page.locator('section[role="status"] code').innerText();
  expect(key).toMatch(/^nzk_/);
  await audit(page, info, 'api-keys-secret', [page.locator('section[role="status"] code')]);
  await go('/settings/api-keys'); // the old route lands on the section; the secret is shown once, so a reload must not show it again
  await expect(page).toHaveURL(/\/settings\/team#apikeys$/);
  await expect(page.getByText(key)).toHaveCount(0);
  await expect(
    page.locator('#apikeys').getByRole('cell', { name: 'ci-key', exact: true }),
  ).toBeVisible();
  await audit(page, info, 'api-keys');

  // --- team: members, invitations, organization settings
  await go('/settings/team');
  await expect(page.locator('#members').getByRole('cell', { name: email })).toBeVisible();
  await audit(page, info, 'members');

  const inv = page.locator('#invitations');
  await inv.getByLabel(T(info, 'field.email')).fill('new.hire@example.test');
  await inv.getByRole('button', { name: T(info, 'action.invite') }).click();
  await expect(inv.getByRole('cell', { name: 'new.hire@example.test' })).toBeVisible();
  await audit(page, info, 'invitations');
  await inv.getByRole('button', { name: T(info, 'action.revoke') }).click();
  await expect(inv.getByText(T(info, 'status.revoked'), { exact: true })).toBeVisible();

  // the organization page stacks its settings and the audit log
  await go('/settings/organization');
  const org = page.locator('#settings');
  await org.getByLabel(name).fill(`${orgName} 2`);
  await org.getByRole('button', { name: T(info, 'action.save') }).click();
  await expect(org.getByText(T(info, 'settings.saved'))).toBeVisible();
  await audit(page, info, 'org-settings');

  // --- read-only screens
  await go('/account/sessions'); // the old route lands on the account page's sessions section
  await expect(page).toHaveURL(/\/account#sessions$/);
  await expect(page.locator('#sessions').getByText(T(info, 'session.current'))).toBeVisible();
  await audit(page, info, 'sessions');
  await go('/notifications');
  await audit(page, info, 'notifications');
  await go('/operations');
  await audit(page, info, 'operations');
  await go('/resources');
  await audit(page, info, 'resources');
  await go('/audit-logs'); // the old route lands on the organization page's audit section
  await expect(page).toHaveURL(/\/settings\/organization#audit$/);
  await expect(page.locator('#audit').getByText('tenancy.workspace.created')).toBeVisible();
  await audit(page, info, 'audit-logs');
  await page.getByLabel(T(info, 'audit.filter.action')).fill('identity.*');
  await page.getByRole('button', { name: T(info, 'action.search') }).click();
  await expect(page.getByText('identity.api_key.created')).toBeVisible();
  await expect(page.getByText('tenancy.workspace.created')).toHaveCount(0);
});
