import { expect, test } from '@playwright/test';
import { T, audit, loc, signIn, totp } from './helpers';

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
  await expect(page.getByRole('heading', { name: T(info, 'home.noOrg.title') })).toBeVisible();
  await audit(page, info, 'home-empty');
  await page.getByRole('link', { name: create }).click();
  await audit(page, info, 'org-new');
  await page.getByLabel(name).fill(orgName);
  await page.getByRole('button', { name: create }).click();
  await expect(page.getByText(T(info, 'home.org', { org: orgName }))).toBeVisible();
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
  await go('/account/security/mfa');
  await page.getByRole('button', { name: T(info, 'mfa.start') }).click();
  await expect(page.getByRole('img', { name: T(info, 'mfa.qr') })).toBeVisible();
  await audit(page, info, 'mfa-enrol', [
    page.locator('main bdi'),
    page.getByRole('img', { name: T(info, 'mfa.qr') }),
  ]);
  const secret = (await page.locator('main bdi').first().innerText()).trim();
  await page.getByLabel(T(info, 'field.code')).fill(totp(secret));
  await page.getByRole('button', { name: T(info, 'action.verify') }).click();
  await expect(page.getByText(T(info, 'mfa.done'))).toBeVisible();

  await go('/account/security/recovery-codes');
  await page.getByRole('button', { name: T(info, 'recovery.generate') }).click();
  await expect(page.getByText(T(info, 'recovery.done'))).toBeVisible();
  await expect(page.locator('section[role="status"] li')).toHaveCount(10);
  await audit(page, info, 'recovery-codes', [page.locator('section[role="status"] li')]);

  await go('/settings/api-keys');
  await page.getByLabel(T(info, 'field.keyName')).fill('ci-key');
  await page.getByLabel('project:read').check();
  await page.getByRole('button', { name: create }).click();
  await expect(page.getByRole('heading', { name: T(info, 'apikeys.secret.title') })).toBeVisible();
  const key = await page.locator('section[role="status"] code').innerText();
  expect(key).toMatch(/^nzk_/);
  await audit(page, info, 'api-keys-secret', [page.locator('section[role="status"] code')]);
  await go('/settings/api-keys'); // the secret is shown once: a reload must not show it again
  await expect(page.getByText(key)).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'ci-key', exact: true })).toBeVisible();
  await audit(page, info, 'api-keys');

  // --- team: members, invitations, organization settings
  await go('/settings/members');
  await expect(page.getByRole('cell', { name: email })).toBeVisible();
  await audit(page, info, 'members');

  await go('/settings/invitations');
  await page.getByLabel(T(info, 'field.email')).fill('new.hire@example.test');
  await page.getByRole('button', { name: T(info, 'action.invite') }).click();
  await expect(page.getByRole('cell', { name: 'new.hire@example.test' })).toBeVisible();
  await audit(page, info, 'invitations');
  await page.getByRole('button', { name: T(info, 'action.revoke') }).click();
  await expect(page.getByText(T(info, 'status.revoked'), { exact: true })).toBeVisible();

  await go('/settings/organization');
  await page.getByLabel(name).fill(`${orgName} 2`);
  await page.getByRole('button', { name: T(info, 'action.save') }).click();
  await expect(page.getByText(T(info, 'settings.saved'))).toBeVisible();
  await audit(page, info, 'org-settings');

  // --- read-only screens
  await go('/account/sessions');
  await expect(page.getByText(T(info, 'session.current'))).toBeVisible();
  await audit(page, info, 'sessions');
  await go('/notifications');
  await audit(page, info, 'notifications');
  await go('/operations');
  await audit(page, info, 'operations');
  await go('/resources');
  await audit(page, info, 'resources');
  await go('/audit-logs');
  await expect(page.getByText('tenancy.workspace.created')).toBeVisible();
  await audit(page, info, 'audit-logs');
  await page.getByLabel(T(info, 'audit.filter.action')).fill('identity.*');
  await page.getByRole('button', { name: T(info, 'action.search') }).click();
  await expect(page.getByText('identity.api_key.created')).toBeVisible();
  await expect(page.getByText('tenancy.workspace.created')).toHaveCount(0);
});
