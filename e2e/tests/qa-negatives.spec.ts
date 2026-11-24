import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { ADMIN, WEB } from './env';
import { T, audit, loc, signIn } from './helpers';
import { elevate, ensureOwnerOrg, orgFlag, sql } from './fixtures/templates';
import { resetDatabase } from './reset';

test.beforeAll(resetDatabase);
test.describe.configure({ mode: 'serial' });

/**
 * Session 07 (QA), Phase 2 - NEGATIVE cases for the three screens whose happy paths other sessions wrote (19-builder-agent, 10-ai-provider-insights, 19-ai-benchmarks): unauthenticated,
 * viewer, another tenant, malformed ids, and a staff role that may read but not act. Arabic (RTL) and English projects, axe on the states that render a page.
 *
 * STATUS: written, NOT RUN (no browser is started by Session 07 while the Master holds the heavy lock). Until it has run in the isolated E2E it is NOT VERIFIED. Read-only in spirit:
 * nothing here deploys, calls a model or provider, or changes customer data; the only writes are fixtures (SQL) and API attempts that MUST be refused, each followed by a check that
 * nothing was stored.
 *
 * Every assertion about "no leak" is language-neutral (a marker string planted in the run's events must appear in no page, in either language) and does not depend on the wording of a
 * refusal; the refusal itself is asserted through the shared message catalogue (`state.forbidden.title`, `bt.lc.start.off`, `bench.forbidden`) or through the API status.
 * Preconditions: runs after 02-admin (the staff user enrolled MFA there) like the specs it complements; the dev identity provider's users are `owner-`, `billing-`, `registrant-`
 * and `staff-` of each language (the same ones the existing specs use); `billing-<L>` is made a real viewer member of the owner's organization here, exactly as 10b-mobile does.
 */
const MARKER = `QA-NEG-MARKER-${Date.now()}`;
const csrfOf = async (p: Page, name = 'nuzm_csrf') =>
  (await p.context().cookies()).find((c) => c.name === name)?.value ?? '';
const LEAKS =
  /TypeError|ReferenceError|Unhandled|at Object\.|node_modules|stack trace|SELECT |ECONNREFUSED/i;

test('builder agent screen: unauthenticated, viewer, another tenant, malformed ids (ar/en, axe)', async ({
  page,
  browser,
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
    ['builder_tools.enabled', true],
    ['builder_lifecycle.enabled', true],
  ] as const)
    await orgFlag(org, k, v);
  const name = `QA Negative ${L} ${Date.now()}`;
  const project = (
    await sql<{ id: string }>(
      `INSERT INTO builder.projects (id, org_id, type, name, locales, data_region, created_by) VALUES (gen_random_uuid(), $1, 'webapp', $2, ARRAY['ar','en'], 'sa-central', $3) RETURNING id`,
      [org, name, owner],
    )
  )[0]!.id;
  const session = (
    await sql<{ id: string }>(
      `INSERT INTO ai.sessions (id, org_id, project_id, title, data_region, created_by) VALUES (gen_random_uuid(), $1, $2, 'qa negatives', 'sa-central', $3) RETURNING id`,
      [org, project, owner],
    )
  )[0]!.id;
  // a run parked at the deployment approval whose events carry a marker no other organization or visitor may ever see
  const run = (
    await sql<{ id: string }>(
      `INSERT INTO ai.runs (id, org_id, session_id, project_id, kind, state, input, data_region, checkpoint, created_by, started_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'webapp', 'waiting_approval', '{"builderLifecycle":true,"brief":{"prompt":"x"}}'::jsonb, 'sa-central', '{}'::jsonb, $4, now() - interval '9 seconds') RETURNING id`,
      [org, session, project, owner],
    )
  )[0]!.id;
  let seq = 0;
  for (const [type, data] of [
    ['lifecycle_started', { steps: 18 }],
    ['lifecycle_step', { step: 'plan', status: 'succeeded', round: 0, summary: MARKER }],
    [
      'lifecycle_step',
      { step: 'deployment_approval', status: 'waiting_approval', approvalId: 'qa-neg' },
    ],
  ] as [string, object][])
    await sql(
      `INSERT INTO ai.run_events (run_id, seq, org_id, type, data) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [run, ++seq, org, type, JSON.stringify(data)],
    );
  const runsBefore = Number(
    (
      await sql<{ n: string }>(`SELECT count(*) n FROM ai.runs WHERE project_id = $1`, [project])
    )[0]!.n,
  );
  const url = `${WEB}/${L}/builder/projects/${project}/agent?run=${run}`;
  const noLeak = async (p: Page, what: string) => {
    const html = await p.content();
    expect(html, `${what}: the marker must not be on the page`).not.toContain(MARKER);
    expect(html, `${what}: the project name must not be on the page`).not.toContain(name);
    expect(html, `${what}: no internal error text`).not.toMatch(LEAKS);
  };

  // ---- 1. unauthenticated: sent to sign-in, nothing of the project or run is rendered
  const anon = await browser.newContext({ locale: L === 'ar' ? 'ar-SA' : 'en-GB' });
  try {
    const ap = await anon.newPage();
    await ap.goto(url);
    await expect(ap).toHaveURL(/\/login/);
    await noLeak(ap, 'unauthenticated');
    await audit(ap, info, 'qa-neg-agent-unauthenticated');
  } finally {
    await anon.close();
  }

  // ---- 2. viewer (a real membership with the viewer role): reads, cannot start, cannot cancel; the API refuses both and nothing changes
  const viewerEmail = `billing-${L}@example.test`;
  const vctx = await browser.newContext({
    locale: L === 'ar' ? 'ar-SA' : 'en-GB',
    viewport: { width: 1280, height: 900 },
  });
  try {
    const vp = await vctx.newPage();
    await signIn(vp, info, viewerEmail);
    await vctx.addCookies([{ name: 'nuzm_org', value: org, url: WEB }]);
    const uid = (
      await sql<{ id: string }>(`SELECT id FROM identity.users WHERE email = $1`, [viewerEmail])
    )[0]!.id;
    await sql(`DELETE FROM tenancy.memberships WHERE org_id = $1 AND user_id = $2`, [org, uid]);
    await sql(
      `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, 'viewer')`,
      [org, uid],
    );
    await vp.goto(url);
    await expect(vp.getByRole('heading', { name: T(info, 'bt.lc.title') })).toBeVisible();
    await expect(vp.getByRole('button', { name: T(info, 'bt.lc.cancel') })).toHaveCount(0);
    await audit(vp, info, 'qa-neg-agent-viewer-run');
    await vp.goto(`${WEB}/${L}/builder/projects/${project}/agent`);
    await expect(vp.getByText(T(info, 'bt.lc.start.off'))).toBeVisible();
    await expect(
      vp.getByRole('button', { name: T(info, 'bt.lc.start.submit'), exact: true }),
    ).toBeDisabled();
    await audit(vp, info, 'qa-neg-agent-viewer-form');
    const headers = {
      'x-csrf-token': await csrfOf(vp),
      'x-nuzm-org': org,
      'idempotency-key': `qa-neg-${randomUUID()}`,
    };
    const start = await vp.request.post(`${WEB}/v1/ai/runs`, {
      headers,
      data: {
        sessionId: session,
        kind: 'webapp',
        projectId: project,
        input: { builderLifecycle: true, brief: { prompt: 'x' } },
      },
    });
    expect(start.status()).toBe(403);
    const cancel = await vp.request.post(`${WEB}/v1/ai/runs/${run}/cancellation`, {
      headers: { ...headers, 'idempotency-key': `qa-neg-${randomUUID()}` },
    });
    expect(cancel.status()).toBe(403);
    expect(
      (await sql<{ state: string }>(`SELECT state FROM ai.runs WHERE id = $1`, [run]))[0]!.state,
    ).toBe('waiting_approval');
    expect(
      Number(
        (
          await sql<{ n: string }>(`SELECT count(*) n FROM ai.runs WHERE project_id = $1`, [
            project,
          ])
        )[0]!.n,
      ),
    ).toBe(runsBefore);
  } finally {
    await vctx.close();
  }

  // ---- 3. another tenant: a signed-in person with NO membership of the organization gets no project, no run, no marker, from the screen or the API
  const tctx = await browser.newContext({
    locale: L === 'ar' ? 'ar-SA' : 'en-GB',
    viewport: { width: 1280, height: 900 },
  });
  try {
    const tp = await tctx.newPage();
    await signIn(tp, info, `registrant-${L}@example.test`);
    await tctx.addCookies([{ name: 'nuzm_org', value: org, url: WEB }]);
    const uid = (
      await sql<{ id: string }>(`SELECT id FROM identity.users WHERE email = $1`, [
        `registrant-${L}@example.test`,
      ])
    )[0]!.id;
    expect(
      Number(
        (
          await sql<{ n: string }>(
            `SELECT count(*) n FROM tenancy.memberships WHERE org_id = $1 AND user_id = $2`,
            [org, uid],
          )
        )[0]!.n,
      ),
    ).toBe(0);
    await tp.goto(url);
    await noLeak(tp, 'another tenant');
    await expect(tp.getByRole('button', { name: T(info, 'bt.lc.cancel') })).toHaveCount(0);
    await audit(tp, info, 'qa-neg-agent-other-tenant');
    const h = { 'x-csrf-token': await csrfOf(tp), 'x-nuzm-org': org };
    for (const path of [
      `/v1/ai/runs/${run}`,
      `/v1/builder/projects/${project}`,
      `/v1/ai/runs/${run}/events`,
    ]) {
      const r = await tp.request.get(`${WEB}${path}`, { headers: h });
      expect(r.status(), path).toBe(404); // not a member == no such organization: no existence oracle
      expect(await r.text(), path).not.toContain(MARKER);
    }
    const c = await tp.request.post(`${WEB}/v1/ai/runs/${run}/cancellation`, {
      headers: { ...h, 'idempotency-key': `qa-neg-${randomUUID()}` },
    });
    expect(c.status()).toBe(404);
    expect(
      (await sql<{ state: string }>(`SELECT state FROM ai.runs WHERE id = $1`, [run]))[0]!.state,
    ).toBe('waiting_approval');
  } finally {
    await tctx.close();
  }

  // ---- 4. malformed and unknown ids: no crash, no stack, nothing leaked; a bad project id is a 404 page, a bad run id is ignored, an unknown run shows no steps
  await signIn(page, info, `owner-${L}@example.test`);
  const bad = await page.goto(`${WEB}/${L}/builder/projects/not-a-uuid/agent`);
  expect(bad?.status()).toBe(404);
  await noLeak(page, 'malformed project id');
  await page.goto(`${WEB}/${L}/builder/projects/${project}/agent?run=not-a-uuid`);
  await expect(page.getByRole('heading', { name: T(info, 'bt.lc.title') })).toBeVisible();
  await noLeak(page, 'malformed run id');
  await expect(
    page.getByRole('button', { name: T(info, 'bt.lc.start.submit'), exact: true }),
  ).toBeVisible(); // ignored: the empty start state
  await audit(page, info, 'qa-neg-agent-malformed-run');
  await page.goto(`${WEB}/${L}/builder/projects/${project}/agent?run=${randomUUID()}`);
  await expect(page.getByRole('heading', { name: T(info, 'bt.lc.title') })).toBeVisible();
  await expect(
    page.getByRole('listitem').filter({ hasText: T(info, 'bt.lc.step.plan') }),
  ).toHaveCount(0);
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await noLeak(page, 'unknown run id');
  await audit(page, info, 'qa-neg-agent-unknown-run');
});

test('admin consoles: provider insights and benchmarks, unauthenticated, a customer, and a staff role that may read but not act (ar/en, axe)', async ({
  page,
  browser,
}, info) => {
  const L = loc(info);
  const staff = `staff-${L}@example.test`;
  const bench = `${ADMIN}/${L}/ai/benchmarks`;
  const insights = `${ADMIN}/${L}/ai/model-providers`;

  // ---- unauthenticated: both screens send the visitor to sign-in and render no data
  const anon = await browser.newContext({ locale: L === 'ar' ? 'ar-SA' : 'en-GB' });
  try {
    const ap = await anon.newPage();
    for (const u of [bench, insights]) {
      await ap.goto(u);
      await expect(ap).toHaveURL(/\/login/);
      expect(await ap.content()).not.toMatch(LEAKS);
      await expect(ap.getByTestId('ai-insights')).toHaveCount(0);
      await expect(ap.locator('#bench-stages')).toHaveCount(0);
    }
    await audit(ap, info, 'qa-neg-admin-unauthenticated');
  } finally {
    await anon.close();
  }

  // ---- a CUSTOMER (organization owner, not staff) signed in to the admin console: no staff data, no staff actions
  const cctx = await browser.newContext({
    locale: L === 'ar' ? 'ar-SA' : 'en-GB',
    viewport: { width: 1280, height: 900 },
  });
  try {
    const cp = await cctx.newPage();
    await signIn(cp, info, `owner-${L}@example.test`, ADMIN);
    for (const u of [bench, insights]) {
      await cp.goto(u);
      await expect(cp.getByTestId('ai-insights')).toHaveCount(0);
      await expect(cp.locator('#bench-stages')).toHaveCount(0);
      await expect(cp.getByRole('button', { name: T(info, 'bench.record' as never) })).toHaveCount(
        0,
      );
      expect(await cp.content()).not.toMatch(LEAKS);
    }
    const r = await cp.request.get(`${ADMIN}/v1/admin/ai/benchmarks`);
    expect([401, 403, 404]).toContain(r.status());
    await audit(cp, info, 'qa-neg-admin-customer');
  } finally {
    await cctx.close();
  }

  // ---- support (read-only staff): the API refuses the actions the screens do not offer, and nothing is stored
  await signIn(page, info, staff, ADMIN);
  await elevate(staff);
  const uid = (
    await sql<{ id: string }>(`SELECT id FROM identity.users WHERE email = $1`, [staff])
  )[0]!.id;
  const roles = (
    await sql<{ role: string }>(`SELECT role FROM tenancy.platform_roles WHERE user_id = $1`, [uid])
  ).map((x) => x.role);
  const setRoles = async (rs: string[]) => {
    await sql(`DELETE FROM tenancy.platform_roles WHERE user_id = $1`, [uid]);
    for (const x of rs)
      await sql(`INSERT INTO tenancy.platform_roles (user_id, role) VALUES ($1, $2)`, [uid, x]);
  };
  const count = async (table: string) =>
    Number((await sql<{ n: string }>(`SELECT count(*) n FROM ${table}`))[0]!.n);
  try {
    await setRoles(['support']);
    const benchBefore = await count('ai.benchmark_runs');
    const provBefore = await count('ai.model_providers');
    const h = {
      'x-csrf-token': await csrfOf(page, 'nuzm_admin_csrf'),
      'idempotency-key': `qa-neg-${randomUUID()}`,
    };
    const record = await page.request.post(`${ADMIN}/v1/admin/ai/benchmarks`, {
      headers: h,
      data: {},
    });
    expect(record.status(), await record.text()).toBeGreaterThanOrEqual(400);
    expect(record.status()).toBeLessThan(500);
    const configure = await page.request.post(`${ADMIN}/v1/admin/ai/model-providers`, {
      headers: { ...h, 'idempotency-key': `qa-neg-${randomUUID()}` },
      data: {
        action: 'configure',
        code: `qa-neg-${Date.now()}`,
        adapter: 'acme',
        displayName: 'QA negative',
        region: 'sa-central',
      },
    });
    expect(configure.status(), await configure.text()).toBeGreaterThanOrEqual(400);
    expect(configure.status()).toBeLessThan(500);
    const key = await page.request.post(`${ADMIN}/v1/admin/ai/model-providers`, {
      headers: { ...h, 'idempotency-key': `qa-neg-${randomUUID()}` },
      data: { action: 'save_claude_key', apiKey: `test-only-${'Qn4v'.repeat(8)}` },
    });
    expect(key.status()).toBeGreaterThanOrEqual(400);
    expect(key.status()).toBeLessThan(500);
    expect(await count('ai.benchmark_runs')).toBe(benchBefore);
    expect(await count('ai.model_providers')).toBe(provBefore);
    // and the screens do not offer them
    await page.goto(bench);
    await expect(page.getByRole('button', { name: T(info, 'bench.record' as never) })).toHaveCount(
      0,
    );
    await page.goto(insights);
    await expect(page.getByTestId('ins-discovery')).toHaveCount(0);
    await audit(page, info, 'qa-neg-admin-support');
  } finally {
    await setRoles(roles.length > 0 ? roles : ['platform_admin']);
  }
});
