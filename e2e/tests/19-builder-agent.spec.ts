import { expect, test } from '@playwright/test';
import { WEB } from './env';
import { T, audit, loc } from './helpers';
import { ensureOwnerOrg, orgFlag, sql } from './fixtures/templates';
import { resetDatabase } from './reset';

test.beforeAll(resetDatabase);

/**
 * PHASE-2 S05, SCR "builder agent" END TO END in Arabic (RTL) and English with real browsers (axe WCAG A/AA, screenshots). NOT RUN BY ITS AUTHOR: it is written for the heavy slot and
 * reviewed by Session 07.
 *  1. the feature flags `builder_tools.enabled` and `builder_lifecycle.enabled` are OFF by default: the start form is there, and starting says "not enabled" (this stack has no model
 *     provider, so the run API refuses with the same `unsupported_capability`); nothing is created;
 *  2. a run parked at the deployment approval: this stack runs no model and no execution runtime (S-AG6 is security-blocked), so the run's rows (session, run, events) are written with SQL
 *     exactly as the lifecycle runner writes them (event names and fields of `lifecycle.runner.ts`), and everything the screen shows is read for real by the API through the same SSE
 *     route the browser uses. The lifecycle itself, the approvals, cancellation and the billing gates are proved by `builder-lifecycle.int.spec.ts` on the real run engine;
 *  Strengthened after Session 07's review (docs/security/PHASE2-E2E-REVIEW.md): hostile extra event fields never reach the DOM (E-10), malformed and unknown run ids (E-8), a read-only role (E-6), fixture aligned to the runner's real events (E-9). NOT added: a cross-tenant browser case (E-7: needs a second signed-in organization; proved at HTTP level by `builder-lifecycle.int.spec.ts` "another organization sees nothing") and E-5 (rendering only, stated above).
 *  3. a stopped run says why in words (never a raw code), a finished run shows the deployment preparation and the version it made; every result is labelled SIMULATED.
 */
test.describe.configure({ mode: 'serial' });

const STEPS = [
  'requirements',
  'project_analysis',
  'architecture',
  'plan',
  'tasks',
  'file_generation',
  'change_apply',
  'review',
  'execution_request',
  'build',
  'tests',
  'preview',
  'deployment_preparation',
];

test('the builder agent screen: flags off, a run waiting for approval, a stopped run, a finished run (ar/en, axe, screenshots)', async ({
  page,
}, info) => {
  const L = loc(info);
  const org = await ensureOwnerOrg(page, info);
  const owner = (
    await sql<{ user_id: string }>(
      `SELECT user_id FROM tenancy.memberships WHERE org_id = $1 AND role = 'owner' LIMIT 1`,
      [org],
    )
  )[0]!.user_id;
  for (const [k, v] of [
    ['app_builder.enabled', true],
    ['builder_tools.enabled', null],
    ['builder_lifecycle.enabled', null],
  ] as const)
    await orgFlag(org, k, v);

  const name = `E2E Agent ${L} ${Date.now()}`;
  const project = (
    await sql<{ id: string }>(
      `INSERT INTO builder.projects (id, org_id, type, name, locales, data_region, created_by)
       VALUES (gen_random_uuid(), $1, 'webapp', $2, ARRAY['ar','en'], 'sa-central', $3) RETURNING id`,
      [org, name, owner],
    )
  )[0]!.id;
  const session = (
    await sql<{ id: string }>(
      `INSERT INTO ai.sessions (id, org_id, project_id, title, data_region, created_by)
       VALUES (gen_random_uuid(), $1, $2, 'E2E agent', 'sa-central', $3) RETURNING id`,
      [org, project, owner],
    )
  )[0]!.id;

  // ---- 1. flags off: the form is there; starting says "not enabled" and creates nothing
  await page.goto(`${WEB}/${L}/builder/projects/${project}/agent`);
  await expect(page.getByRole('heading', { name: T(info, 'bt.lc.title') })).toBeVisible();
  await expect(page.getByText(T(info, 'bt.lc.intro'))).toBeVisible();
  await page
    .getByLabel(T(info, 'bt.lc.start.prompt'), { exact: true })
    .fill(L === 'ar' ? 'متجر إلكتروني للقهوة' : 'An online store for coffee');
  await page.getByRole('button', { name: T(info, 'bt.lc.start.submit'), exact: true }).click();
  await expect(page.getByText(T(info, 'bt.lc.start.off'))).toBeVisible();
  expect(
    (await sql(`SELECT count(*)::int n FROM ai.runs WHERE project_id = $1`, [project]))[0]!.n,
  ).toBe(0);
  await audit(page, info, 'builder-agent-off');

  // ---- 2. a run parked at the deployment approval
  const mkRun = async (state: string, result: object | null) =>
    (
      await sql<{ id: string }>(
        `INSERT INTO ai.runs (id, org_id, session_id, project_id, kind, state, input, data_region, checkpoint, result, created_by, started_at, finished_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'webapp', $4, '{"builderLifecycle":true,"brief":{"prompt":"x"}}'::jsonb, 'sa-central', '{}'::jsonb, $5::jsonb, $6, now() - interval '9 seconds',
                 CASE WHEN $4 IN ('succeeded','failed','cancelled') THEN now() ELSE NULL END)
         RETURNING id`,
        [org, session, project, state, result ? JSON.stringify(result) : null, owner],
      )
    )[0]!.id;
  const events = async (run: string, evs: [string, object][]) => {
    let seq = 0;
    for (const [type, data] of evs)
      await sql(
        `INSERT INTO ai.run_events (run_id, seq, org_id, type, data) VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [run, ++seq, org, type, JSON.stringify(data)],
      );
  };
  const prog = (done: number, repairRound = 0) => ({
    percent: Math.round((done / 14) * 100),
    done,
    total: 14,
    repairRound,
    tokens: 0,
    credits: '0',
  });
  const clean = (): [string, object][] => [
    ['lifecycle_started', { steps: 18 }],
    ...STEPS.flatMap((s, i): [string, object][] => [
      ['lifecycle_step', { step: s, status: 'started', round: 0, attempt: 1 }],
      [
        'lifecycle_step',
        { step: s, status: 'succeeded', round: 0, summary: `${s} ok`, progress: prog(i + 1) },
      ],
    ]),
  ];

  const MARK = 'LEAK-MARKER-7f3a';
  const parked = await mkRun('waiting_approval', null);
  await events(parked, [
    // hostile extra fields on an event (a prompt, a model output, a file path): only the declared fields are ever rendered
    [
      'lifecycle_step',
      {
        step: 'plan',
        status: 'started',
        round: 0,
        prompt: MARK,
        output: MARK,
        path: `../../${MARK}`,
      },
    ],
    ...clean(),
    [
      'lifecycle_step',
      { step: 'deployment_approval', status: 'waiting_approval', approvalId: 'e2e-approval' },
    ],
  ]);
  await page.goto(`${WEB}/${L}/builder/projects/${project}/agent?run=${parked}`);
  await expect(page.getByText(T(info, 'bt.lc.run.waiting_approval'))).toBeVisible();
  await expect(
    page.getByRole('progressbar', { name: T(info, 'bt.lc.progress.label') }),
  ).toBeVisible();
  await expect(
    page.getByRole('listitem').filter({ hasText: T(info, 'bt.lc.step.build') }),
  ).toContainText(T(info, 'bt.lc.st.succeeded'));
  // the repair steps were never needed: shown as skipped, not as pending forever
  await expect(
    page.getByRole('listitem').filter({ hasText: T(info, 'bt.lc.step.repair') }),
  ).toContainText(T(info, 'bt.lc.st.skipped'));
  await expect(page.getByText(T(info, 'bt.lc.approval.body'))).toBeVisible();
  await expect(page.getByRole('link', { name: T(info, 'bt.lc.approval.link') })).toHaveAttribute(
    'href',
    `/${L}/approvals`,
  );
  await expect(page.getByText(T(info, 'bt.lc.simulated'))).toBeVisible();
  await expect(page.getByRole('button', { name: T(info, 'bt.lc.cancel') })).toBeVisible();
  expect(await page.content()).not.toContain(MARK);
  await audit(page, info, 'builder-agent-waiting');

  // ---- 3. a run that stopped: the reason in words, no raw code, no cancel button
  const failed = await mkRun('failed', null);
  await events(failed, [
    ...clean().slice(0, 21),
    [
      'lifecycle_step',
      { step: 'build', status: 'succeeded', passed: false, round: 0, progress: prog(10, 1) },
    ],
    [
      'lifecycle_step',
      { step: 'rebuild', status: 'succeeded', passed: false, round: 3, progress: prog(10, 3) },
    ],
    ['lifecycle_finished', { status: 'failed', code: 'repair_exhausted', progress: prog(10, 3) }],
  ]);
  await page.goto(`${WEB}/${L}/builder/projects/${project}/agent?run=${failed}`);
  await expect(
    page.getByRole('alert').filter({ hasText: T(info, 'bt.lc.failure.title') }),
  ).toContainText(T(info, 'bt.lc.failure.repair_exhausted'));
  expect(await page.content()).not.toContain('repair_exhausted');
  await expect(page.getByRole('button', { name: T(info, 'bt.lc.cancel') })).toHaveCount(0);
  await audit(page, info, 'builder-agent-failed');

  // ---- a finished run: the deployment preparation and the version, labelled simulated
  const version = '0198a3c0-aaaa-7000-8000-000000000001';
  const done = await mkRun('succeeded', {
    outcome: 'lifecycle',
    status: 'succeeded',
    simulated: true,
    versionId: version,
    deployment: {
      target: 'node-web',
      readiness: 'needs_attention',
      blockers: ['simulated_evidence'],
    },
  });
  await events(done, [
    ...clean(),
    ['lifecycle_finished', { status: 'succeeded', progress: prog(14) }],
  ]);
  await page.goto(`${WEB}/${L}/builder/projects/${project}/agent?run=${done}`);
  await expect(page.getByText(T(info, 'bt.lc.run.succeeded'))).toBeVisible();
  await expect(page.getByText(T(info, 'bt.lc.target.node-web'))).toBeVisible();
  await expect(page.getByText(T(info, 'bt.lc.blocker.simulated_evidence'))).toBeVisible();
  await expect(page.getByText(version)).toBeVisible();
  await expect(page.getByText(T(info, 'bt.lc.simulated'))).toBeVisible();
  // a run that is over offers a new start
  await expect(
    page.getByRole('button', { name: T(info, 'bt.lc.start.submit'), exact: true }),
  ).toBeVisible();
  await audit(page, info, 'builder-agent-done');

  // ---- E-8: a malformed id and an unknown run never show a blank page, a stack trace or step names
  await page.goto(`${WEB}/${L}/builder/projects/${project}/agent?run=not-a-uuid`);
  await expect(page.getByText(T(info, 'bt.lc.state.empty'))).toBeVisible();
  expect(await page.content()).not.toMatch(/at \w+ \(|TypeError|undefined/);
  await page.goto(
    `${WEB}/${L}/builder/projects/${project}/agent?run=0198a3c0-aaaa-7000-8000-00000000dead`,
  );
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(
    page.getByRole('listitem').filter({ hasText: T(info, 'bt.lc.step.build') }),
  ).toHaveCount(0);
  await audit(page, info, 'builder-agent-unknown-run');

  // ---- E-6: a viewer (read-only role) sees the run but has no way to start or cancel anything
  await sql(`UPDATE tenancy.memberships SET role = 'viewer' WHERE org_id = $1 AND user_id = $2`, [
    org,
    owner,
  ]);
  try {
    await page.goto(`${WEB}/${L}/builder/projects/${project}/agent?run=${parked}`);
    await expect(page.getByText(T(info, 'bt.lc.run.waiting_approval'))).toBeVisible();
    await expect(page.getByRole('button', { name: T(info, 'bt.lc.cancel') })).toHaveCount(0);
    // an active run hides the start form, so a read-only member has no way to start anything either
    await expect(
      page.getByRole('button', { name: T(info, 'bt.lc.start.submit'), exact: true }),
    ).toHaveCount(0);
    await audit(page, info, 'builder-agent-viewer');
  } finally {
    await sql(`UPDATE tenancy.memberships SET role = 'owner' WHERE org_id = $1 AND user_id = $2`, [
      org,
      owner,
    ]);
  }

  await orgFlag(org, 'app_builder.enabled', null);
});
