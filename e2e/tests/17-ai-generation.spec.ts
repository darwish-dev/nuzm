import { expect, test } from '@playwright/test';
import { WEB } from './env';
import { T, audit, loc } from './helpers';
import { ensureOwnerOrg, orgFlag, publishTemplate, sql } from './fixtures/templates';

/**
 * AI Intelligence Center, slice S-K6 (SCR-K-09): the template workspace END TO END in Arabic (RTL) and English with real browsers: customer console -> API -> database.
 *  1. flag `knowledge.generation` OFF (default): the copy result has no workspace link and the page says "not available";
 *  2. flag ON: the workspace compares the project with the template copy (identical at first, then the customer's own change shows as added), a plan is recorded, and the
 *     CONTEXT PREVIEW shows exactly what a model would receive: the template does not permit AI processing, so its unchanged source is withheld (paths only) while the
 *     customer's own file is included; nothing is sent by previewing;
 *  3. starting the adaptation without a model provider (this stack has none: no mock, no real one) is refused honestly, creates no run and leaves the plan and the project
 *     as they were. The success path with a scripted MODEL (plumbing only, quality NOT VERIFIED) is covered by the API integration tests, not here.
 * The template is written with SQL and the object store (as in 16-ai-templates); the organization is created through the sign-up screen.
 */
const NAME = 'E2E Generation Starter';
let seeded: { rid: string; vid: string };

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  await sql(
    `UPDATE knowledge.resources SET status = 'ARCHIVED', deleted_at = now() WHERE org_id IS NULL AND deleted_at IS NULL AND name = $1`,
    [NAME],
  );
  seeded = await publishTemplate({
    name: NAME,
    slug: `e2e-generation-${Date.now()}`,
    published: true,
    description: 'A starter whose source may not be sent to a model',
    aiProcessing: false,
  });
});
test.afterAll(async () => {
  await sql(
    `UPDATE knowledge.resources SET status = 'ARCHIVED', deleted_at = now() WHERE org_id IS NULL AND deleted_at IS NULL AND name = $1`,
    [NAME],
  );
});

test('flag OFF then ON: the workspace compares the copy, previews what would be sent, and refuses to start without a model (ar/en, axe)', async ({
  page,
}, info) => {
  const L = loc(info);
  const org = await ensureOwnerOrg(page, info);
  for (const [k, v] of [
    ['ai.enabled', true],
    ['app_builder.enabled', true],
    ['knowledge.customer_templates', true],
    ['knowledge.generation', null],
  ] as const)
    await orgFlag(org, k, v);

  // ---- copy the template into a new project (the S-K7 screen); with the flag off there is no link to the workspace
  await page.goto(`${WEB}/${L}/builder/templates/${seeded.rid}`);
  const project = `E2E Workspace ${L} ${Date.now()}`;
  await page.getByLabel(T(info, 'tpl.start.name'), { exact: true }).fill(project);
  await page.getByRole('button', { name: T(info, 'tpl.start.submit') }).click();
  const done = page.getByTestId('tpl-done');
  await expect(done).toBeVisible({ timeout: 60_000 });
  await expect(done.getByRole('link', { name: T(info, 'gen.link') })).toHaveCount(0);
  const id = (
    await sql<{ id: string }>(`SELECT id FROM builder.projects WHERE org_id = $1 AND name = $2`, [
      org,
      project,
    ])
  )[0]!.id;
  await page.goto(`${WEB}/${L}/builder/projects/${id}/template`);
  await expect(page.getByText(T(info, 'bld.unavailable.title'))).toBeVisible();
  await audit(page, info, 'ai-generation-off');

  // ---- flag ON: the copy result links to the workspace; it is identical to the template at first
  await orgFlag(org, 'knowledge.generation', true);
  await page.goto(`${WEB}/${L}/builder/templates/${seeded.rid}`);
  const project2 = `${project} two`;
  await page.getByLabel(T(info, 'tpl.start.name'), { exact: true }).fill(project2);
  await page.getByRole('button', { name: T(info, 'tpl.start.submit') }).click();
  await expect(page.getByTestId('tpl-done')).toBeVisible({ timeout: 60_000 });
  await page
    .getByTestId('tpl-done')
    .getByRole('link', { name: T(info, 'gen.link') })
    .click();
  await expect(page.getByRole('heading', { name: T(info, 'gen.title'), level: 1 })).toBeVisible();
  await expect(page.getByText(NAME, { exact: true })).toBeVisible();
  await expect(page.getByTestId('gen-diff').getByText(T(info, 'gen.diff.none'))).toBeVisible();
  await audit(page, info, 'ai-generation-workspace');
  const id2 = (
    await sql<{ id: string }>(`SELECT id FROM builder.projects WHERE org_id = $1 AND name = $2`, [
      org,
      project2,
    ])
  )[0]!.id;

  // ---- the customer's own change shows as added (changed through the same safe-change route as every edit)
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'nuzm_csrf')?.value ?? '';
  const head = (
    await sql<{ head_version_id: string }>(
      `SELECT head_version_id FROM builder.projects WHERE id = $1`,
      [id2],
    )
  )[0]!.head_version_id;
  const r = await page.request.post(`${WEB}/v1/builder/projects/${id2}/changes`, {
    headers: {
      'x-nuzm-org': org,
      'x-nuzm-realm': 'web',
      'x-csrf-token': csrf,
      'idempotency-key': `e2e-${Date.now()}`,
    },
    data: {
      baseVersion: head,
      source: 'user',
      patches: [{ op: 'add', path: 'src/mine.ts', content: 'export const MY_OWN_WORK = 42;\n' }],
    },
  });
  expect(r.ok()).toBe(true);
  const headAfter = (
    await sql<{ head_version_id: string }>(
      `SELECT head_version_id FROM builder.projects WHERE id = $1`,
      [id2],
    )
  )[0]!.head_version_id;
  await page.reload();
  const diff = page.getByTestId('gen-diff');
  await diff.getByText(T(info, 'gen.diff.added', { n: 1 })).click();
  await expect(diff.getByText('src/mine.ts')).toBeVisible();

  // ---- a plan and the context preview: the template's unchanged source is withheld, the customer's own work is included; nothing is sent
  const runsBefore = Number(
    (await sql(`SELECT count(*)::int n FROM ai.runs WHERE org_id = $1`, [org]))[0]!.n,
  );
  await page
    .getByLabel(T(info, 'gen.plan.text'), { exact: true })
    .fill(L === 'ar' ? 'أضف صفحة أسعار' : 'add a pricing page');
  await page.getByRole('button', { name: T(info, 'gen.plan.create') }).click();
  await expect(page.getByTestId('gen-plan')).toBeVisible();
  await page.getByRole('button', { name: T(info, 'gen.ctx.preview') }).click();
  const ctx = page.getByTestId('gen-ctx');
  await expect(ctx).toBeVisible();
  await expect(ctx.getByText(T(info, 'gen.ctx.withheld'))).toBeVisible();
  await expect(
    ctx.getByText(T(info, 'gen.ctx.reason.ai_processing_not_allowed'), { exact: false }).first(),
  ).toBeVisible();
  const html = await page.content();
  expect(html).not.toContain('E2E-SECRET-FILE-TEXT'); // the template's own source is not on the screen or in the pack
  for (const d of await ctx.locator('details').all()) await d.locator('summary').click();
  await expect(ctx.getByText('MY_OWN_WORK = 42')).toBeVisible(); // the customer's own file is in the pack
  expect(
    Number((await sql(`SELECT count(*)::int n FROM ai.runs WHERE org_id = $1`, [org]))[0]!.n),
  ).toBe(runsBefore);
  await audit(page, info, 'ai-generation-preview');

  // ---- starting without a model provider: refused in plain words, no run, the plan and the project as they were
  await page.getByRole('button', { name: T(info, 'gen.run.start') }).click();
  await expect(page.getByRole('alert').filter({ hasText: /\S/ }).first()).toBeVisible();
  expect(
    Number((await sql(`SELECT count(*)::int n FROM ai.runs WHERE org_id = $1`, [org]))[0]!.n),
  ).toBe(runsBefore);
  expect(
    (
      await sql<{ status: string; run_id: string | null }>(
        `SELECT status, run_id FROM knowledge.generation_plans WHERE project_id = $1`,
        [id2],
      )
    )[0],
  ).toMatchObject({ status: 'PLANNED', run_id: null });
  expect(
    (
      await sql<{ head_version_id: string }>(
        `SELECT head_version_id FROM builder.projects WHERE id = $1`,
        [id2],
      )
    )[0]!.head_version_id,
  ).toBe(headAfter); // the refused start changed nothing
  await audit(page, info, 'ai-generation-refused');
  await orgFlag(org, 'knowledge.generation', null);
});
