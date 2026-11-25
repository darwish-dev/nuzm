import { expect, test, type Page } from '@playwright/test';
import { T, audit, loc, signIn } from './helpers';
import { WEB } from './env';
import { creditAiWallet, ensureOwnerOrg, sql } from './fixtures/templates';
import {
  createDeployableWebapp,
  createWebsite,
  enableDeployFlags,
  seedHostingSite,
  seedQueuedWebsiteDeployment,
  sessionHeaders,
} from './fixtures/deploy';
import { resetDatabase } from './reset';

test.beforeAll(resetDatabase);

/**
 * Deployment of a generated app and of a website to a SIMULATED local hosting target (Session 06).
 *
 * This file has NO dependency on an AI build: the projects are created through the product's own API (`POST /v1/builder/projects`, then the safe-diff `changes` API) and the
 * hosting target is a node, plan and ACTIVE site written with SQL (`fixtures/deploy.ts`). The API of the e2e stack runs with `AI_LOCAL_REFERENCE=true`: the site publisher
 * is the in-memory fake node (its URLs end in `.invalid`, nothing is reachable) and the health probe answers SIMULATED for those names. Every deployment shown here carries the
 * SIMULATED notice, and a passing run proves the console + API + pipeline plumbing only: it is NOT evidence about a real hosting node (needs HG-05/HG-06).
 *
 * Cases: success, status synchronization, supersede and rollback (UI); a failing build (UI); cancellation of a queued deployment (UI); the viewer and the other organization
 * (API, through the signed-in sessions of those people). Deeper API-level variants (cancel at every checkpoint, orphan recovery, API-key confirmation) are in
 * `apps/api/src/modules/deploy/deploy-s06.int.spec.ts`.
 */

const base = (info: Parameters<typeof loc>[0]) => `${WEB}/${loc(info)}`;

/** Polls the API (as the signed-in session of `page`) until `ok` holds for the project's deployments. */
async function pollDeployments(
  page: Page,
  orgId: string,
  projectId: string,
  ok: (items: { state: string; failureCode?: string | null }[]) => boolean,
) {
  await expect
    .poll(
      async () => {
        const r = await page.request.get(`/v1/deployments?projectId=${projectId}`, {
          headers: await sessionHeaders(page, orgId),
        });
        const items = ((await r.json()) as { items?: { state: string }[] }).items ?? [];
        return ok(items);
      },
      {
        timeout: 120_000,
        message: `the deployments of project ${projectId} reach the expected states`,
      },
    )
    .toBe(true);
}

/** The create button of the deployment FORM (the workspace top bar has a "Deploy" button of its own: an unscoped name match is ambiguous in English). */
const createButton = (page: Page, info: Parameters<typeof loc>[0]) =>
  page
    .getByRole('form', { name: T(info, 'm10a.dep.new') })
    .getByRole('button', { name: T(info, 'm10a.dep.create'), exact: true });

async function ownerContext(page: Page, info: Parameters<typeof loc>[0], name: string) {
  await ensureOwnerOrg(page, info, name);
  const owner = `owner-${loc(info)}@example.test`;
  const org = (
    await sql<{ id: string; user_id: string }>(
      `SELECT m.org_id AS id, m.user_id FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`,
      [owner],
    )
  )[0]!;
  await enableDeployFlags();
  // the build of a release runs in a sandbox, and a sandbox needs AI credit on the organization's wallet (`budget_required` otherwise): the credit is test data
  await creditAiWallet(org.id, '1000000').catch(() => undefined); // already credited by an earlier test of this file: fine
  return org;
}

test('web app: a SIMULATED deployment succeeds, status syncs without a reload, a second release supersedes, rollback restores (ar/en, axe, states)', async ({
  page,
}, info) => {
  const L = loc(info);
  const org = await ownerContext(page, info, `Deploy ${L}`);
  const siteId = await seedHostingSite(org.id, org.user_id, `ok-${L}`);
  const projectId = await createDeployableWebapp(page, org.id, `deployable-${L}`);

  await page.goto(`${base(info)}/builder/projects/${projectId}/deployments`);
  await expect(page.getByRole('heading', { name: T(info, 'm10a.dep.new') })).toBeVisible();
  const target = page.getByLabel(T(info, 'm10a.dep.target'));
  await target.selectOption(siteId);
  await audit(page, info, 'deploy-sim-form');

  // production needs a human approval bound to the exact release: nothing is deployed by the first call
  await page.getByLabel(T(info, 'bld.dep.environment')).selectOption('production');
  await createButton(page, info).click();
  await expect(page.getByText(T(info, 'm10a.dep.approvalNeeded'))).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('table', { name: T(info, 'bld.dep.list') })).toHaveCount(0);
  await audit(page, info, 'deploy-sim-approval-needed');

  // staging: queued -> live WITHOUT a reload (status synchronization by polling), labelled SIMULATED
  const list = page.getByRole('table', { name: T(info, 'bld.dep.list') });
  const live = list.getByText(T(info, 'm10a.dep.state.live'), { exact: true });
  await page.getByLabel(T(info, 'bld.dep.environment')).selectOption('staging');
  await createButton(page, info).click();
  await expect(list).toBeVisible({ timeout: 30_000 });
  await expect(live).toHaveCount(1, { timeout: 120_000 });
  await expect(page.getByText(T(info, 'dep.simulated.title')).first()).toBeVisible();
  await expect(page.getByText(/\.invalid/).first()).toBeVisible(); // the simulated node URL, never a real host
  await audit(page, info, 'deploy-sim-live');
  // the console agrees with the API (status sync): exactly one release is live
  await pollDeployments(
    page,
    org.id,
    projectId,
    (items) => items.filter((d) => d.state === 'live').length === 1,
  );

  // a second release supersedes the first (the first one becomes the rollback target)
  await createButton(page, info).click();
  await expect(list.getByText(T(info, 'm10a.dep.state.superseded'), { exact: true })).toBeVisible({
    timeout: 120_000,
  });
  await expect(live).toHaveCount(1);

  // rollback behind a confirmation: the live release is rolled back to the earlier one
  const rollback = page.getByRole('button', { name: T(info, 'bld.dep.rollback') });
  await expect(rollback.first()).toBeVisible({ timeout: 120_000 });
  await rollback.first().click();
  await expect(page.getByRole('dialog').getByText(T(info, 'm10a.dep.rollbackTitle'))).toBeVisible();
  await audit(page, info, 'deploy-sim-rollback-confirm');
  await page.getByRole('button', { name: T(info, 'm10a.dep.rollbackConfirm') }).click();
  await expect(list.getByText(T(info, 'm10a.dep.state.rolled_back'), { exact: true })).toBeVisible({
    timeout: 120_000,
  });
  await expect(live).toHaveCount(1); // the earlier release is live again, never zero and never two
  await audit(page, info, 'deploy-sim-rolled-back');
  await pollDeployments(
    page,
    org.id,
    projectId,
    (items) =>
      items.some((d) => d.state === 'rolled_back') &&
      items.filter((d) => d.state === 'live').length === 1,
  );
});

test('web app: a failing build ends FAILED and nothing goes live (ar/en)', async ({
  page,
}, info) => {
  const L = loc(info);
  const org = await ownerContext(page, info, `Deploy ${L}`);
  const siteId = await seedHostingSite(org.id, org.user_id, `fail-${L}`);
  const projectId = await createDeployableWebapp(page, org.id, `failing-${L}`, {
    failingBuild: true,
  });

  await page.goto(`${base(info)}/builder/projects/${projectId}/deployments`);
  await expect(page.getByRole('heading', { name: T(info, 'm10a.dep.new') })).toBeVisible();
  await page.getByLabel(T(info, 'm10a.dep.target')).selectOption(siteId);
  await page.getByLabel(T(info, 'bld.dep.environment')).selectOption('staging');
  await createButton(page, info).click();

  await pollDeployments(page, org.id, projectId, (items) =>
    items.some((d) => d.state === 'failed' && d.failureCode === 'build_failed'),
  );
  // the reason is the build itself, not something around it (for instance a missing AI credit for the sandbox)
  const failed = (
    (await (
      await page.request.get(`/v1/deployments?projectId=${projectId}`, {
        headers: await sessionHeaders(page, org.id),
      })
    ).json()) as { items: { id: string; state: string }[] }
  ).items.find((d) => d.state === 'failed')!;
  const logs = await page.request.get(`/v1/deployments/${failed.id}/logs`, {
    headers: await sessionHeaders(page, org.id),
  });
  const logText = JSON.stringify(await logs.json());
  expect(logText).toMatch(/build/i);
  expect(logText).not.toMatch(/AI credit|budget/i);
  // the console shows the failed release (after a reload: the list is the truth), and no live one
  await page.reload();
  const list = page.getByRole('table', { name: T(info, 'bld.dep.list') });
  await expect(list.getByText(T(info, 'm10a.dep.state.failed'), { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(list.getByText(T(info, 'm10a.dep.state.live'), { exact: true })).toHaveCount(0);
  await audit(page, info, 'deploy-sim-failed');
});

test('website: a queued SIMULATED deployment is cancelled from the console and nothing goes live (ar/en)', async ({
  page,
}, info) => {
  const L = loc(info);
  const org = await ownerContext(page, info, `Deploy ${L}`);
  const siteId = await seedHostingSite(org.id, org.user_id, `cancel-${L}`);
  const { projectId, versionId } = await createWebsite(page, org.id, `cancel-site-${L}`);
  const deploymentId = await seedQueuedWebsiteDeployment({
    orgId: org.id,
    userId: org.user_id,
    projectId,
    versionId,
    siteId,
  });

  await page.goto(`${base(info)}/builder/projects/${projectId}/deployments`);
  const list = page.getByRole('table', { name: T(info, 'bld.dep.list') });
  await expect(list.getByText(T(info, 'bld.dep.state.queued'), { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  // the details carry the SIMULATED notice
  await list.getByRole('button', { name: T(info, 'bld.dep.details') }).click();
  await expect(page.getByText(T(info, 'dep.simulated.title')).first()).toBeVisible();
  await audit(page, info, 'deploy-sim-queued');

  await list.getByRole('button', { name: T(info, 'dep.cancel') }).click();
  await expect(list.getByText(T(info, 'bld.dep.state.cancelled'), { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(list.getByRole('button', { name: T(info, 'dep.cancel') })).toHaveCount(0); // a finished deployment has nothing to cancel
  await audit(page, info, 'deploy-sim-cancelled');

  // the API agrees: cancelled, its operation is cancelled too, and a second cancel is refused (409), nothing is live
  const headers = await sessionHeaders(page, org.id);
  const d = await page.request.get(`/v1/deployments/${deploymentId}`, { headers });
  expect(d.status()).toBe(200);
  expect(await d.json()).toMatchObject({ state: 'cancelled', simulated: true });
  const op = await sql<{ state: string }>(
    `SELECT state FROM platform.operations WHERE resource_id = $1`,
    [deploymentId],
  );
  expect(op[0]?.state).toBe('cancelled');
  const again = await page.request.post(`/v1/deployments/${deploymentId}/cancel`, {
    headers: { ...headers, 'idempotency-key': `e2e-cancel-again-${deploymentId}` },
  });
  expect(again.status()).toBe(409);
  const live = await sql<{ n: string }>(
    `SELECT count(*) n FROM deploy.deployments WHERE project_id = $1 AND state = 'succeeded'`,
    [projectId],
  );
  expect(Number(live[0]!.n)).toBe(0);
});

test('authorization and tenant isolation: a viewer cannot deploy, roll back or cancel; another organization cannot see or touch a deployment (API, ar/en)', async ({
  page,
  browser,
}, info) => {
  const L = loc(info);
  const org = await ownerContext(page, info, `Deploy ${L}`);
  const siteId = await seedHostingSite(org.id, org.user_id, `authz-${L}`);
  const projectId = await createDeployableWebapp(page, org.id, `authz-${L}`);

  // a deployment of the owner's organization, deployed through the API as the owner (staging: no approval)
  const created = await page.request.post(`/v1/deployments`, {
    headers: await sessionHeaders(page, org.id, `e2e-authz-${L}`),
    data: { projectId, environment: 'staging', target: { type: 'site', id: siteId } },
  });
  expect(created.status(), (await created.text()).slice(0, 300)).toBeLessThan(300);
  const deploymentId = ((await created.json()) as { id: string }).id;
  await pollDeployments(page, org.id, projectId, (items) => items.some((d) => d.state === 'live'));

  // ---- the same person is (a) a VIEWER of the owner's organization and (b) the owner of an organization of their own
  const email = `billing-${L}@example.test`;
  const ctx = await browser.newContext({
    locale: info.project.use.locale ?? 'en-GB',
    viewport: { width: 1280, height: 900 },
  });
  const p = await ctx.newPage();
  try {
    await signIn(p, info, email);
    const uid = (
      await sql<{ id: string }>(`SELECT id FROM identity.users WHERE email = $1`, [email])
    )[0]!.id;
    await sql(
      `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, 'viewer')`,
      [org.id, uid],
    );
    const own = crypto.randomUUID();
    await sql(
      `INSERT INTO tenancy.organizations (id, name, slug, type, country, created_by) VALUES ($1,$2,$2,'customer','SA',$3)`,
      [own, `e2e-own-${own.slice(0, 8)}`, uid],
    );
    await sql(
      `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, 'owner')`,
      [own, uid],
    );
    const keyN = () => `e2e-authz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // (a) viewer in the owner's organization: reads are allowed or refused by role, writes are refused and nothing changes
    const asViewer = async () => ({
      ...(await sessionHeaders(p, org.id)),
      'idempotency-key': keyN(),
    });
    const before = await sql<{ n: string }>(
      `SELECT count(*) n FROM deploy.app_deployments WHERE project_id = $1`,
      [projectId],
    );
    const writes = [
      await p.request.post(`${WEB}/v1/deployments`, {
        headers: await asViewer(),
        data: { projectId, environment: 'staging', target: { type: 'site', id: siteId } },
      }),
      await p.request.post(`${WEB}/v1/deployments/${deploymentId}/rollback`, {
        headers: await asViewer(),
      }),
      await p.request.post(`${WEB}/v1/deployments/${deploymentId}/cancel`, {
        headers: await asViewer(),
      }),
    ];
    for (const r of writes) expect(r.status()).toBe(403);
    const after = await sql<{ n: string }>(
      `SELECT count(*) n FROM deploy.app_deployments WHERE project_id = $1`,
      [projectId],
    );
    expect(after[0]!.n).toBe(before[0]!.n);

    // (b) the same person in THEIR OWN organization: the owner's deployment does not exist for them (404, never 403/200), lists are empty, writes find nothing
    const asOther = async () => ({
      ...(await sessionHeaders(p, own)),
      'idempotency-key': keyN(),
    });
    const get = await p.request.get(`${WEB}/v1/deployments/${deploymentId}`, {
      headers: await sessionHeaders(p, own),
    });
    expect(get.status()).toBe(404);
    const logs = await p.request.get(`${WEB}/v1/deployments/${deploymentId}/logs`, {
      headers: await sessionHeaders(p, own),
    });
    expect(logs.status()).toBe(404);
    const list = await p.request.get(`${WEB}/v1/deployments?projectId=${projectId}`, {
      headers: await sessionHeaders(p, own),
    });
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(0);
    const crossWrites = [
      await p.request.post(`${WEB}/v1/deployments/${deploymentId}/rollback`, {
        headers: await asOther(),
      }),
      await p.request.post(`${WEB}/v1/deployments/${deploymentId}/cancel`, {
        headers: await asOther(),
      }),
      await p.request.post(`${WEB}/v1/deployments`, {
        headers: await asOther(),
        data: { projectId, environment: 'staging', target: { type: 'site', id: siteId } },
      }),
    ];
    for (const r of crossWrites) expect([403, 404]).toContain(r.status());
    for (const r of crossWrites) expect(await r.text()).not.toContain(deploymentId);
  } finally {
    await ctx.close();
  }

  // nothing the other people did changed the deployment
  const d = await page.request.get(`/v1/deployments/${deploymentId}`, {
    headers: await sessionHeaders(page, org.id),
  });
  expect((await d.json()) as { state: string }).toMatchObject({ state: 'live' });
});
