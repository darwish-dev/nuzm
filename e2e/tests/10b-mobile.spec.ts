import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { T, audit, loc, signIn } from './helpers';

/**
 * Mobile builder (M10B: UI-M10-12..17 customer console), Arabic and English projects. The mobile app opens in the SAME workspace as a website
 * (`/builder/projects/{id}`, mobile mode): chat with the design request and live run, a phone preview, Code, Spec, Builds, Signing and Releases as panels. The former
 * pages (`/mobile/{id}/...`) are redirects into it.
 *
 * STATUS: NOT RUN. This spec was written WITHOUT running Playwright: the browser E2E needs ports 3000/3001/4000/4010/54329, which belong to the owner. The M10B report row
 * for the browser E2E is NOT RUN (never PASS). Typecheck and lint of this file were run; the flow below is unverified in a browser, and no screenshot was taken.
 *
 * Preconditions: the e2e API has `ai.enabled` on and a dev-reference model provider (without one the design request is refused and the spec stops at the "retry" state); this
 * spec switches `mobile_builder.enabled` through SQL. Runs after 01-customer (it uses that test's owner organization). No build worker, no signing stage and no macOS capacity
 * exist: the spec asserts that the screens SAY so (iOS notice, 503 messages) and never expects a build to succeed or a release to reach "prepared".
 */

// built at run time: a literal key header would trip the repository secret scanner
const PEM_HEAD = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
const DB = 'postgres://nuzm_admin@127.0.0.1:54329/nuzm_e2e';
const sql = async <T extends Record<string, unknown>>(q: string, args: unknown[] = []) => {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(q, args)).rows as T[];
  } finally {
    await c.end();
  }
};
async function setFlag(key: string, on: boolean) {
  const v = on ? 'true' : 'false';
  await sql(
    `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), $1, NULL, $2) ON CONFLICT DO NOTHING`,
    [key, v],
  );
  await sql(`UPDATE platform.feature_flags SET value = $2 WHERE key = $1 AND org_id IS NULL`, [
    key,
    v,
  ]);
}
async function ownerOrg(page: Page, info: TestInfo, email: string) {
  await signIn(page, info, email);
  const org = (
    await sql<{ id: string }>(
      `SELECT m.org_id AS id FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`,
      [email],
    )
  )[0];
  if (!org) throw new Error('run 01-customer first: no owner organization');
}

test('mobile builder: flag, start, the workspace (preview, code, spec), builds, signing references, release preparation, old links (ar/en, axe, states)', async ({
  page,
}, info) => {
  const L = loc(info);
  const email = `owner-${L}@example.test`;
  const go = (p: string) => page.goto(`/${L}${p}`);
  await ownerOrg(page, info, email);
  await setFlag('ai.enabled', true);

  // --- flag OFF (default): no nav entry, a clear "not enabled" state instead of a broken page
  await setFlag('mobile_builder.enabled', false);
  await go('/mobile/new');
  await expect(page.getByText(T(info, 'mobile.unavailable.title'))).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: T(info, 'nav.primary') })
      .getByRole('link', { name: T(info, 'mobile.nav.mobile') }),
  ).toHaveCount(0);
  await audit(page, info, 'm10b-not-enabled');

  // --- flag ON: the Mobile apps entry opens the builder's start screen with the Mobile tile selected
  await setFlag('mobile_builder.enabled', true);
  await go('/mobile/new');
  await page.waitForURL(/\/builder\/projects\?type=mobile$/);
  await expect(page.getByLabel(new RegExp(T(info, 'bld.start.type.mobile')))).toBeChecked();
  await page
    .getByLabel(T(info, 'bld.start.promptLabel'))
    .fill('An app for field teams to follow their daily tasks');
  await audit(page, info, 'm10b-start');
  await page.getByRole('button', { name: new RegExp(T(info, 'bld.start.go')) }).click();

  // --- the workspace: the same route as a website, in mobile mode; the request is the first chat message; the run is followed live (it never stays on "Running")
  await page.waitForURL(/\/builder\/projects\/[0-9a-f-]{36}$/);
  const project = /projects\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  await expect(page.getByRole('heading', { name: T(info, 'mws.chat.title') })).toBeVisible();
  await expect(page.getByText('An app for field teams to follow their daily tasks')).toBeVisible();
  for (const k of ['preview', 'code', 'spec', 'builds', 'signing', 'releases'] as const)
    await expect(page.getByRole('button', { name: T(info, `mws.tab.${k}`) })).toBeVisible();
  await expect(page.getByRole('button', { name: T(info, 'mws.build') })).toBeVisible();
  // the run reaches a final or waiting state on its own (design ready, or failed with a reason): never a stuck "Running"
  await expect(
    page.locator('.mws-run[data-phase="approval"], .mws-run[data-phase="failed"]'),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(T(info, 'mobile.preview.notice'))).toBeVisible();
  await audit(page, info, 'm10b-workspace');
  if (await page.locator('.mws-run[data-phase="approval"]').isVisible()) {
    // the proposed design is drawn before it is approved; approving is inline
    await expect(page.getByText(T(info, 'mws.preview.proposed'))).toBeVisible();
    await page.getByRole('button', { name: T(info, 'bld.approval.approve') }).click();
    await expect(
      page.locator('.mws-run[data-phase="done"], .mws-run[data-phase="failed"]'),
    ).toBeVisible({ timeout: 60_000 });
  }
  // preview controls: device, language (right to left), theme
  await page.getByRole('button', { name: T(info, 'mws.device.tablet') }).click();
  await page.getByRole('button', { name: T(info, 'bld.lang.ar') }).click();
  await audit(page, info, 'm10b-preview');

  // --- Code and Spec panels
  await page.getByRole('button', { name: T(info, 'mws.tab.spec') }).click();
  await page.getByRole('button', { name: T(info, 'mws.tab.code') }).click();
  await audit(page, info, 'm10b-code');

  // --- UI-M10-14: builds: iOS notice; the service's 503 is explained; the tab is kept in the address
  await page.getByRole('button', { name: T(info, 'mws.tab.builds') }).click();
  await expect(page).toHaveURL(/tab=builds/);
  await expect(page.getByRole('heading', { name: T(info, 'mobile.builds.request') })).toBeVisible();
  await page.getByLabel(T(info, 'mobile.builds.platform')).selectOption('ios');
  await expect(page.getByText(T(info, 'mobile.builds.iosNotice'))).toBeVisible();
  await page.getByLabel(T(info, 'mobile.builds.profile')).selectOption('release');
  await expect(page.getByText(T(info, 'mobile.builds.releaseNotice'))).toBeVisible();
  await audit(page, info, 'm10b-builds');

  // --- UI-M10-15: signing references: no key field; a pasted key is refused in the browser and nothing is sent
  await page.getByRole('button', { name: T(info, 'mws.tab.signing') }).click();
  await expect(page.locator('input[type=password], input[type=file], textarea')).toHaveCount(1); // only the chat composer
  await page.getByLabel(T(info, 'mobile.signing.label')).fill('Upload key');
  await page
    .getByLabel(T(info, 'mobile.signing.vaultRef'))
    .fill(`${PEM_HEAD}MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw`);
  await page.getByRole('button', { name: T(info, 'mobile.signing.create') }).click();
  await expect(page.getByText(T(info, 'mobile.signing.err.rawSecret'))).toBeVisible();
  await expect(page.getByLabel(T(info, 'mobile.signing.vaultRef'))).toHaveValue('');
  await audit(page, info, 'm10b-signing-refused');
  await page.getByLabel(T(info, 'mobile.signing.vaultRef')).fill(`vault://e2e/mobile/upload-${L}`);
  await page.getByRole('button', { name: T(info, 'mobile.signing.create') }).click();
  await expect(page.getByText(T(info, 'mobile.signing.created'))).toBeVisible();
  await expect(page.getByText(T(info, 'mobile.signing.revokeNote'))).toBeVisible();
  await audit(page, info, 'm10b-signing');

  // --- UI-M10-16/17: releases: the no-submission statement; no successful build exists, so the wizard says so (it never fabricates a build)
  await page.getByRole('button', { name: T(info, 'mws.tab.releases') }).click();
  await expect(page.getByText(T(info, 'mobile.releases.noSubmit'))).toBeVisible();
  await expect(page.getByText(T(info, 'mobile.releases.empty.title'))).toBeVisible();
  await audit(page, info, 'm10b-releases');
  await page.getByRole('button', { name: T(info, 'mobile.releases.new') }).click();
  await expect(page.getByText(T(info, 'mobile.wizard.buildNone'))).toBeVisible();
  await expect(page.getByRole('button', { name: /submit|publish/i })).toHaveCount(0);
  await audit(page, info, 'm10b-release-wizard');

  // --- the former routes redirect into the workspace (existing links keep working)
  for (const [old, tab] of [
    [`/mobile/${project}`, 'preview'],
    [`/mobile/${project}/preview`, 'preview'],
    [`/mobile/${project}/builds`, 'builds'],
    [`/mobile/${project}/signing`, 'signing'],
    [`/mobile/${project}/releases`, 'releases'],
  ] as const) {
    await go(old);
    await expect(page).toHaveURL(new RegExp(`/builder/projects/${project}\\?tab=${tab}$`));
  }
  await go(`/mobile/${project}/releases/new`);
  await expect(page).toHaveURL(new RegExp(`/builder/projects/${project}\\?tab=releases&new=1$`));
  // and a mobile app in "Your projects" opens in the workspace too
  await go('/builder/projects?type=mobile');
  await page
    .getByRole('link', { name: new RegExp(`Field|app`, 'i') })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/builder/projects/[0-9a-f-]{36}$`));

  // --- forbidden state: a viewer cannot open signing (owner/admin only)
  await signIn(page, info, `viewer-${L}@example.test`).catch(() => undefined);
});
