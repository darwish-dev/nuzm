import { expect, test } from '@playwright/test';
import { WEB } from './env';
import { T, audit, loc } from './helpers';
import { ensureOwnerOrg, orgFlag, publishTemplate, sql } from './fixtures/templates';
import { resetDatabase } from './reset';

test.beforeAll(resetDatabase);

/**
 * AI Intelligence Center, slice S-AG3 (SCR-K-10): the customer's read-only agent execution timeline END TO END in Arabic (RTL) and English with real browsers.
 *  1. flag `knowledge.agentic_generation` OFF (default): the workspace does not offer the agent;
 *  2. flag ON: the option is offered, unchecked by default, and explained;
 *  3. the timeline of a run: this stack has no model provider (and S-AG3 never uses a live one), so the run's rows (steps, read-only tool calls, outcome) are written with SQL
 *     exactly as the loop writes them, and the browser's start request is answered with the plan as the API reports it after that run exists. Everything the timeline shows is read
 *     for real by the API from those rows: the loop itself, the quota, tenant isolation and the fallback are covered by the API integration tests (agent-loop.int.spec.ts).
 * The template is written with SQL and the object store (as in 16/17); the organization is created through the sign-up screen.
 */
const NAME = 'E2E Agent Starter';
let seeded: { rid: string; vid: string };

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  await sql(
    `UPDATE knowledge.resources SET status = 'ARCHIVED', deleted_at = now() WHERE org_id IS NULL AND deleted_at IS NULL AND name = $1`,
    [NAME],
  );
  seeded = await publishTemplate({
    name: NAME,
    slug: `e2e-agent-${Date.now()}`,
    published: true,
    description: 'A starter for the agent timeline',
    aiProcessing: true,
  });
});
test.afterAll(async () => {
  await sql(
    `UPDATE knowledge.resources SET status = 'ARCHIVED', deleted_at = now() WHERE org_id IS NULL AND deleted_at IS NULL AND name = $1`,
    [NAME],
  );
});

test('the agent option follows the flag, and the timeline of a run is read-only, bilingual and accessible (ar/en, axe)', async ({
  page,
}, info) => {
  const L = loc(info);
  const org = await ensureOwnerOrg(page, info);
  for (const [k, v] of [
    ['ai.enabled', true],
    ['app_builder.enabled', true],
    ['knowledge.customer_templates', true],
    ['knowledge.generation', true],
    ['knowledge.agentic_generation', null],
  ] as const)
    await orgFlag(org, k, v);

  await page.goto(`${WEB}/${L}/builder/templates/${seeded.rid}`);
  const project = `E2E Agent ${L} ${Date.now()}`;
  await page.getByLabel(T(info, 'tpl.start.name'), { exact: true }).fill(project);
  await page.getByRole('button', { name: T(info, 'tpl.start.submit') }).click();
  await expect(page.getByTestId('tpl-done')).toBeVisible({ timeout: 60_000 });
  const id = (
    await sql<{ id: string; data_region: string; created_by: string }>(
      `SELECT id, data_region, created_by FROM builder.projects WHERE org_id = $1 AND name = $2`,
      [org, project],
    )
  )[0]!;

  const makePlan = async () => {
    await page.goto(`${WEB}/${L}/builder/projects/${id.id}/template`);
    await page
      .getByLabel(T(info, 'gen.plan.text'), { exact: true })
      .fill(L === 'ar' ? 'أضف صفحة أسعار' : 'add a pricing page');
    await page.getByRole('button', { name: T(info, 'gen.plan.create') }).click();
    await expect(page.getByTestId('gen-plan')).toBeVisible();
  };

  // ---- flag OFF (default): no agent option
  await makePlan();
  await expect(page.getByRole('button', { name: T(info, 'gen.run.start') })).toBeVisible();
  await expect(page.getByLabel(T(info, 'agt.opt.label'))).toHaveCount(0);
  await audit(page, info, 'ai-agent-off');

  // ---- flag ON: offered, unchecked by default, explained
  await orgFlag(org, 'knowledge.agentic_generation', true);
  // a plan starts once, so the ON phase uses a new project
  await page.goto(`${WEB}/${L}/builder/templates/${seeded.rid}`);
  const project2 = `${project} two`;
  await page.getByLabel(T(info, 'tpl.start.name'), { exact: true }).fill(project2);
  await page.getByRole('button', { name: T(info, 'tpl.start.submit') }).click();
  await expect(page.getByTestId('tpl-done')).toBeVisible({ timeout: 60_000 });
  const p2 = (
    await sql<{ id: string; data_region: string; created_by: string }>(
      `SELECT id, data_region, created_by FROM builder.projects WHERE org_id = $1 AND name = $2`,
      [org, project2],
    )
  )[0]!;
  await page.goto(`${WEB}/${L}/builder/projects/${p2.id}/template`);
  await page
    .getByLabel(T(info, 'gen.plan.text'), { exact: true })
    .fill(L === 'ar' ? 'أضف صفحة أسعار' : 'add a pricing page');
  await page.getByRole('button', { name: T(info, 'gen.plan.create') }).click();
  await expect(page.getByTestId('gen-plan')).toBeVisible();
  const box = page.getByLabel(T(info, 'agt.opt.label'));
  await expect(box).toBeVisible();
  await expect(box).not.toBeChecked();
  await expect(page.getByText(T(info, 'agt.opt.help'))).toBeVisible();
  await audit(page, info, 'ai-agent-option');

  // ---- seed the run the loop would have written (see the header), then start with the agent chosen
  const plan = (
    await sql<{ id: string }>(`SELECT id FROM knowledge.generation_plans WHERE project_id = $1`, [
      p2.id,
    ])
  )[0]!.id;
  const session = (
    await sql<{ id: string }>(
      `INSERT INTO ai.sessions (id, org_id, project_id, title, data_region, created_by)
       VALUES (gen_random_uuid(), $1, $2, 'E2E agent', $3, $4) RETURNING id`,
      [org, p2.id, p2.data_region, p2.created_by],
    )
  )[0]!.id;
  const run = (
    await sql<{ id: string }>(
      `INSERT INTO ai.runs (id, org_id, session_id, project_id, kind, state, input, data_region, checkpoint, result, created_by, started_at, finished_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'webapp', 'succeeded', $4::jsonb, $5,
               '{"agent":{"plan":"Read the layout, then add a pricing page."}}'::jsonb,
               '{"outcome":"adapted","summary":"Added a pricing page","patches":2,"branch":"work/ai","agentic":true}'::jsonb,
               $6, now() - interval '4 seconds', now())
       RETURNING id`,
      [
        org,
        session,
        p2.id,
        JSON.stringify({ templatePlanId: plan, agentic: true }),
        p2.data_region,
        p2.created_by,
      ],
    )
  )[0]!.id;
  const step = async (seq: number, node: string, phase: string, tin: number, tout: number) =>
    (
      await sql<{ id: string }>(
        `INSERT INTO ai.run_steps (id, org_id, run_id, seq, node, agent, status, input_ref, checkpoint_ref, tokens_in, tokens_out, data_region, started_at, finished_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'agent', 'succeeded', $5, 'seed', $6, $7, $8, now(), now()) RETURNING id`,
        [org, run, seq, node, phase, tin, tout, p2.data_region],
      )
    )[0]!.id;
  const s1 = await step(0, 'turn-1', 'plan', 420, 80);
  await step(1, 'turn-2', 'explore', 900, 120);
  await step(100, 'validate', 'validate', 0, 0);
  await step(200, 'apply', 'apply', 0, 0);
  const call = (
    stepId: string,
    callId: string,
    tool: string,
    args: object,
    status: string,
    code: string | null,
    bytes: number,
  ) =>
    sql(
      `INSERT INTO ai.tool_calls (id, org_id, run_id, step_id, tool, args_redacted, status, duration_ms, data_region, call_id, result_bytes, error_code)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6, 3, $7, $8, $9, $10)`,
      [org, run, stepId, tool, JSON.stringify(args), status, p2.data_region, callId, bytes, code],
    );
  await call(s1, 'c1', 'list_files', {}, 'succeeded', null, 640);
  await call(s1, 'c2', 'read_file', { path: 'src/app/page.tsx' }, 'succeeded', null, 1536);
  await call(s1, 'c3', 'read_file', { path: '.env' }, 'denied', 'not_permitted', 0);
  await sql(
    `UPDATE knowledge.generation_plans SET status = 'COMPLETED', run_id = $2 WHERE id = $1`,
    [plan, run],
  );

  await page.route('**/v1/builder/generation-plans/*/runs', async (route) => {
    const real = await page.request.get(`${WEB}/v1/builder/generation-plans/${plan}`, {
      headers: { 'x-nuzm-org': org, 'x-nuzm-realm': 'web' },
    });
    await route.fulfill({ status: 201, contentType: 'application/json', body: await real.text() });
  });
  await box.check();
  await page.getByRole('button', { name: T(info, 'gen.run.start') }).click();

  const tl = page.getByTestId('agt');
  await expect(tl.getByTestId('agt-steps')).toBeVisible();
  await expect(tl.getByTestId('agt-plan')).toContainText(
    'Read the layout, then add a pricing page.',
  );
  await expect(tl.getByTestId('agt-step-turn-1')).toContainText(T(info, 'agt.phase.plan'));
  await expect(tl.getByTestId('agt-step-turn-2')).toContainText(T(info, 'agt.phase.explore'));
  await expect(tl.getByTestId('agt-step-apply')).toContainText(T(info, 'agt.phase.apply'));
  await expect(tl.getByTestId('agt-limits')).toBeVisible();
  await expect(tl.getByTestId('agt-outcome')).toContainText(T(info, 'agt.outcome.adapted'));
  await expect(tl.getByTestId('agt-outcome')).toContainText('work/ai');
  for (const d of await tl.getByTestId('agt-step-turn-1').locator('details').all())
    await d.locator('summary').click();
  await expect(tl.getByTestId('agt-call')).toHaveCount(3);
  await expect(tl.getByTestId('agt-call').nth(2)).toContainText('not_permitted');
  await expect(tl.getByText(T(info, 'agt.callStatus.denied'))).toBeVisible();
  expect(await page.content()).not.toContain('MY_SECRET'); // no file content is ever on the timeline
  // read-only: the only control of the whole timeline card is its refresh button
  const card = page.getByRole('region', { name: T(info, 'agt.title') });
  await expect(card.getByRole('button')).toHaveCount(1);
  await expect(card.getByRole('button', { name: T(info, 'agt.refresh') })).toBeVisible();
  await audit(page, info, 'ai-agent-timeline');

  // the timeline reads again on demand and changes nothing
  const before = (
    await sql(`SELECT count(*)::int n FROM ai.tool_calls WHERE run_id = $1`, [run])
  )[0]!.n;
  await card.getByRole('button', { name: T(info, 'agt.refresh') }).click();
  await expect(tl.getByTestId('agt-call').first()).toBeVisible();
  expect(
    (await sql(`SELECT count(*)::int n FROM ai.tool_calls WHERE run_id = $1`, [run]))[0]!.n,
  ).toBe(before);

  await orgFlag(org, 'knowledge.generation', null);
  await orgFlag(org, 'knowledge.agentic_generation', null);
});
