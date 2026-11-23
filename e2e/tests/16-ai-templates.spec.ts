import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { WEB } from './env';
import { T, audit, loc, signIn } from './helpers';
import { orgFlag, ownerOrg, publishTemplate, sql } from './fixtures/templates';

/**
 * AI Intelligence Center, slice S-K7 (SCR-K-08): the customer experience, END TO END in Arabic (RTL) and English with real browsers:
 * customer console -> API -> database -> object store.
 *  1. flag OFF (default): no link, the gallery says "not available";
 *  2. flag ON for the organization: the start screen links to the gallery; the gallery lists PUBLISHED templates only; filters; one template; a recommendation for a
 *     description; starting a project copies the pinned version into a NEW web-app project (files from the object store, through the safe-change pipeline), records the
 *     customer's own usage rows, and a second start with the same name is refused with a plain message and creates nothing;
 *  3. nothing on any screen locates source: no path, no object key, no file text.
 * The templates are written with SQL and the object store directly (the ingestion pipeline has its own end-to-end test, 15-ai-ingestion); they stand for what an approved,
 * published library item looks like. The customer organization is created through the sign-up screen by the first test, so this file does not depend on another spec.
 */
const NAME = 'E2E Analytics Dashboard';
const DRAFT = 'E2E Unpublished Draft';
let seeded: { rid: string; vid: string } | null = null;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  await sql(
    `UPDATE knowledge.resources SET status = 'ARCHIVED', deleted_at = now() WHERE org_id IS NULL AND deleted_at IS NULL AND name LIKE 'E2E %'`,
  );
  seeded = await publishTemplate({
    name: NAME,
    slug: `e2e-dashboard-${Date.now()}`,
    published: true,
    description: 'A dashboard starter for analytics and reports',
  });
  await publishTemplate({
    name: DRAFT,
    slug: `e2e-draft-${Date.now()}`,
    published: false,
    description: 'Not published',
  });
});
test.afterAll(async () => {
  await sql(
    `UPDATE knowledge.resources SET status = 'ARCHIVED', deleted_at = now() WHERE org_id IS NULL AND deleted_at IS NULL AND name LIKE 'E2E %'`,
  );
});

/** No screen of the customer console ever shows where the source lives, or what is in a file. */
async function expectNoSource(page: Page) {
  const html = await page.content();
  for (const leak of [
    'snapshots/',
    'object_key',
    'objectKey',
    'E2E-SECRET-FILE-TEXT',
    'src/secret',
    'src/app/page.tsx',
    '--primary',
  ])
    expect(html, `the page shows "${leak}"`).not.toContain(leak);
}

test('1. flag OFF (default): no link on the start screen and the gallery says "not available" (ar/en, axe)', async ({
  page,
}, info) => {
  const L = loc(info);
  await signIn(page, info, `owner-${L}@example.test`);
  // a first sign-in lands on "create your organization": do that through the screen, as a customer would
  if (!(await ownerOrg(L))) {
    await page.getByLabel(T(info, 'field.name'), { exact: true }).fill(`K7 Org ${L}`);
    await page.getByRole('button', { name: T(info, 'action.create'), exact: true }).click();
    await expect.poll(() => ownerOrg(L), { timeout: 30_000 }).toBeTruthy();
  }
  const org = (await ownerOrg(L))!;
  await orgFlag(org, 'ai.enabled', true);
  await orgFlag(org, 'app_builder.enabled', true);
  await orgFlag(org, 'knowledge.customer_templates', null);
  await page.goto(`${WEB}/${L}`);
  await page.goto(`${WEB}/${L}/builder/projects`);
  await expect(page.getByRole('link', { name: T(info, 'tpl.start.link') })).toHaveCount(0);
  await page.goto(`${WEB}/${L}/builder/templates`);
  await expect(page.getByText(T(info, 'bld.unavailable.title'))).toBeVisible();
  await expect(page.getByTestId('tpl-card')).toHaveCount(0);
  await audit(page, info, 'ai-templates-off');
  // the API agrees: 404, not an empty list
  const r = await page.request.get(`${WEB}/v1/builder/templates`, {
    headers: { 'x-nuzm-org': org, 'x-nuzm-realm': 'web' },
  });
  expect(r.status()).toBe(404);
});

test('2. flag ON: gallery, filters, one template, a suggestion, and starting a project copies the pinned version (ar/en, axe, no source shown)', async ({
  page,
}, info) => {
  const L = loc(info);
  const org = (await ownerOrg(L))!;
  await orgFlag(org, 'knowledge.customer_templates', true);
  await signIn(page, info, `owner-${L}@example.test`);

  // ---- from the start screen to the gallery
  await page.goto(`${WEB}/${L}/builder/projects`);
  await page.getByRole('link', { name: T(info, 'tpl.start.link') }).click();
  await expect(page.getByRole('heading', { name: T(info, 'tpl.title'), level: 1 })).toBeVisible();

  // ---- the gallery: the published template only, with facts; the unpublished one is not there
  const card = page.getByTestId('tpl-card').filter({ hasText: NAME });
  await expect(card).toBeVisible();
  await expect(page.getByTestId('tpl-card').filter({ hasText: DRAFT })).toHaveCount(0);
  await expect(card.getByText('MIT', { exact: true })).toBeVisible();
  await expect(card.getByText(T(info, 'kr.usage.FULL_STARTER'))).toBeVisible();
  await expectNoSource(page);
  await audit(page, info, 'ai-templates-gallery');

  // ---- filters live in the URL: a search that matches nothing says so, "clear" brings the list back
  await page.getByLabel(T(info, 'tpl.filter.q'), { exact: true }).fill('zzz-nothing-matches');
  await page.getByRole('button', { name: T(info, 'tpl.filter.apply') }).click();
  await expect(page).toHaveURL(/q=zzz-nothing-matches/);
  await expect(page.getByText(T(info, 'tpl.empty.filtered'))).toBeVisible();
  await page.getByRole('link', { name: T(info, 'tpl.filter.clear') }).click();
  await expect(page.getByTestId('tpl-card').filter({ hasText: NAME })).toBeVisible();

  // ---- a suggestion for a description: ranked with the reason; it creates nothing
  const before = Number(
    (
      await sql(
        `SELECT count(*)::int n FROM builder.projects WHERE org_id = $1 AND deleted_at IS NULL`,
        [org],
      )
    )[0]!.n,
  );
  await page
    .getByLabel(T(info, 'tpl.rec.text'), { exact: true })
    .fill(L === 'ar' ? 'لوحة تحكم' : 'analytics dashboard');
  await page.getByRole('button', { name: T(info, 'tpl.rec.run') }).click();
  const rec = page.getByTestId('tpl-rec-result');
  await expect(rec).toBeVisible();
  await expect(rec.getByTestId('tpl-rec-item').filter({ hasText: NAME })).toBeVisible();
  await expect(rec.getByTestId('tpl-rec-item').filter({ hasText: DRAFT })).toHaveCount(0);
  await rec.getByText(T(info, 'tpl.rec.why')).first().click();
  await expectNoSource(page);
  await audit(page, info, 'ai-templates-recommend');
  expect(
    Number(
      (
        await sql(
          `SELECT count(*)::int n FROM builder.projects WHERE org_id = $1 AND deleted_at IS NULL`,
          [org],
        )
      )[0]!.n,
    ),
  ).toBe(before);

  // ---- one template: facts, capabilities (names only), a safe design summary
  await card.getByRole('link', { name: NAME }).click();
  await expect(page.getByRole('heading', { name: NAME, level: 1 })).toBeVisible();
  await expect(page.getByText('Authentication', { exact: true })).toBeVisible();
  await expect(page.getByText('#2563eb')).toBeVisible();
  await expect(page.getByText('Cairo')).toBeVisible();
  await expectNoSource(page);
  await audit(page, info, 'ai-templates-detail');

  // ---- start a project from it: the pinned version is copied into a NEW web-app project
  const project = `E2E Copy ${L} ${Date.now()}`;
  await page.getByLabel(T(info, 'tpl.start.name'), { exact: true }).fill(project);
  await page.getByLabel(T(info, 'tpl.start.mode'), { exact: true }).selectOption('ADAPTIVE');
  await page.getByRole('button', { name: T(info, 'tpl.start.submit') }).click();
  const done = page.getByTestId('tpl-done');
  await expect(done).toBeVisible({ timeout: 60_000 });
  await expect(done.getByText(T(info, 'tpl.done.title'))).toBeVisible();
  await expect(done.getByText(T(info, 'tpl.done.license', { spdx: 'MIT' }))).toBeVisible();
  await expect(done.getByRole('link', { name: T(info, 'tpl.done.open') })).toHaveAttribute(
    'href',
    new RegExp(`/${L}/builder/projects/[0-9a-f-]{36}$`),
  );
  await expectNoSource(page);
  await audit(page, info, 'ai-templates-started');

  // ---- the database agrees: one new web-app project of THIS organization, the customer's own usage and link rows, the template untouched
  const proj = (
    await sql<{ id: string; type: string }>(
      `SELECT id, type FROM builder.projects WHERE org_id = $1 AND name = $2 AND deleted_at IS NULL`,
      [org, project],
    )
  )[0];
  expect(proj?.type).toBe('webapp');
  expect(
    Number(
      (
        await sql(
          `SELECT count(*)::int n FROM builder.projects WHERE org_id = $1 AND deleted_at IS NULL`,
          [org],
        )
      )[0]!.n,
    ),
  ).toBe(before + 1);
  expect(
    Number(
      (
        await sql(
          `SELECT count(*)::int n FROM knowledge.usage_events WHERE org_id = $1 AND kind = 'COPIED' AND version_id = $2`,
          [org, seeded!.vid],
        )
      )[0]!.n,
    ),
  ).toBeGreaterThanOrEqual(1);
  const link = (
    await sql<{ role: string; strategy: string }>(
      `SELECT role, strategy FROM knowledge.generation_resource_links WHERE org_id = $1 AND resource_version_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [org, seeded!.vid],
    )
  )[0];
  expect(link).toMatchObject({ role: 'STARTER', strategy: 'COPY' });
  expect(
    Number(
      (
        await sql(`SELECT count(*)::int n FROM knowledge.resource_files WHERE version_id = $1`, [
          seeded!.vid,
        ])
      )[0]!.n,
    ),
  ).toBe(4);
  expect(
    Number(
      (
        await sql(
          `SELECT count(*)::int n FROM knowledge.resource_versions WHERE resource_id = $1`,
          [seeded!.rid],
        )
      )[0]!.n,
    ),
  ).toBe(1);

  // ---- the same name again is refused in plain words; nothing is created
  await page.goto(`${WEB}/${L}/builder/templates/${seeded!.rid}`);
  await page.getByLabel(T(info, 'tpl.start.name'), { exact: true }).fill(project);
  await page.getByRole('button', { name: T(info, 'tpl.start.submit') }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: T(info, 'bld.err.name_taken') }),
  ).toBeVisible();
  await expect(page.getByTestId('tpl-done')).toHaveCount(0);
  expect(
    Number(
      (
        await sql(
          `SELECT count(*)::int n FROM builder.projects WHERE org_id = $1 AND deleted_at IS NULL`,
          [org],
        )
      )[0]!.n,
    ),
  ).toBe(before + 1);
  await audit(page, info, 'ai-templates-error');
});

test('3. a template that is not published is "not available", the same as one that does not exist (ar/en)', async ({
  page,
}, info) => {
  const L = loc(info);
  const draft = (
    await sql<{ id: string }>(
      `SELECT id FROM knowledge.resources WHERE name = $1 AND deleted_at IS NULL`,
      [DRAFT],
    )
  )[0]!.id;
  await signIn(page, info, `owner-${L}@example.test`);
  await page.goto(`${WEB}/${L}/builder/templates/${draft}`);
  const a = await page.locator('main').innerText();
  await page.goto(`${WEB}/${L}/builder/templates/${randomUUID()}`);
  const b = await page.locator('main').innerText();
  expect(a).toBe(b);
  expect(a).toContain(T(info, 'bld.unavailable.title'));
  expect(a).not.toContain(DRAFT);
  await audit(page, info, 'ai-templates-unavailable');
  // the flag goes back to its default for the next specs
  const org = (await ownerOrg(L))!;
  await orgFlag(org, 'knowledge.customer_templates', null);
});
