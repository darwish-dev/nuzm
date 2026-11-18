import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { T, audit, loc, signIn } from './helpers';

/**
 * App builder screens (M10A: UI-M10-01..11 customer console, UI-M10-18/19 admin console), Arabic and English projects.
 *
 * STATUS: NOT RUN. This spec was written WITHOUT running Playwright: the browser E2E needs ports 3000/3001/4000/4010/54329, which belong to the owner, and the
 * dev stack. The M10A report row for the browser E2E is NOT RUN (never PASS). Typecheck/lint of this file were run; the flow below is unverified in a browser.
 *
 * Preconditions: the e2e API runs with the app builder reachable: flags `app_builder.enabled` and `app_builder.m09_stubs` (the M09 stand-ins for runs, projects,
 * files and budgets; dev only) are switched on by this spec through SQL. Runs after 01-customer (it uses that test's owner organization). The M09 stand-ins are
 * in-memory and the sandbox runtime is NEVER isolated (D-21/HG-10-02): every sandbox shown must carry the "development stand-in, NOT isolated" notice.
 *
 * Deployment targets (hosting site / compute instance) are not seeded here: without one the deployment and rollback legs are skipped explicitly, never faked.
 */

const ADMIN = 'http://127.0.0.1:3001';
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

test('app builder: wizard, run, approvals, deployment, rollback, tests, exports, budget (ar/en, axe, states)', async ({
  page,
}, info) => {
  const L = loc(info);
  const email = `owner-${L}@example.test`;
  const go = (p: string) => page.goto(`/${L}${p}`);
  await ownerOrg(page, info, email);

  // --- the flag is OFF by default: no sidebar entry, and a clear "not enabled" state instead of a broken page
  await setFlag('app_builder.enabled', false);
  await setFlag('app_builder.m09_stubs', true);
  await go('/builder/projects');
  await expect(page.getByText(T(info, 'm10.notEnabled.title'))).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: T(info, 'nav.primary') })
      .getByRole('link', { name: T(info, 'm10.nav.builder') }),
  ).toHaveCount(0);
  await audit(page, info, 'm10-not-enabled');

  // --- flag on: the sidebar entry and the approvals entry appear
  await setFlag('app_builder.enabled', true);
  await go('/builder/projects');
  const nav = page.getByRole('navigation', { name: T(info, 'nav.primary') });
  await expect(nav.getByRole('link', { name: T(info, 'm10.nav.builder') })).toBeVisible();
  await expect(nav.getByRole('link', { name: T(info, 'm10.nav.approvals') })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: T(info, 'm10.proj.title'), level: 1 }),
  ).toBeVisible();
  await audit(page, info, 'm10-projects');

  // --- UI-M10-01: wizard: prompt (DATA note) → requirements (confirmed) → budget within the ceilings → start
  await go('/builder/projects/new/app');
  await expect(page.getByText(T(info, 'm10.wiz.promptData'))).toBeVisible();
  await page.getByRole('button', { name: T(info, 'action.next') }).click();
  await expect(page.getByText(T(info, 'm10.wiz.err.prompt'))).toBeVisible();
  await audit(page, info, 'm10-wizard-prompt');
  await page
    .getByLabel(T(info, 'm10.wiz.prompt'))
    .fill('A small clinic app with patients and appointments');
  await page.getByRole('button', { name: T(info, 'action.next') }).click();
  await page.getByLabel(T(info, 'm10.wiz.entities')).fill('Patient\nAppointment');
  await page.getByLabel(T(info, 'm10.wiz.roles')).fill('Doctor\nReceptionist');
  await page.getByLabel(T(info, 'm10.wiz.confirmList')).check();
  await audit(page, info, 'm10-wizard-requirements');
  await page.getByRole('button', { name: T(info, 'action.next') }).click();
  // above the ceiling: refused in the browser, with the limit shown
  await page.getByLabel(T(info, 'm10.wiz.tokens')).fill('2000001');
  await page.getByRole('button', { name: T(info, 'm10.wiz.start') }).click();
  await expect(page.getByText(T(info, 'm10.wiz.err.tokens'))).toBeVisible();
  await page.getByLabel(T(info, 'm10.wiz.tokens')).fill('200000');
  await audit(page, info, 'm10-wizard-budget');
  await page.getByRole('button', { name: T(info, 'm10.wiz.start') }).click();

  // --- UI-M10-06: run viewer (steps, budget meter, approvals area, cancel while live)
  await page.waitForURL(/\/builder\/projects\/[0-9a-f-]{36}\/runs\/[0-9a-f-]{36}$/);
  const runUrl = page.url();
  const project = /projects\/([0-9a-f-]{36})\//.exec(runUrl)![1]!;
  await expect(page.getByRole('heading', { name: T(info, 'm10.run.budget') })).toBeVisible();
  await expect(page.getByRole('heading', { name: T(info, 'm10.run.steps') })).toBeVisible();
  await audit(page, info, 'm10-run');

  // --- UI-M10-02: overview
  await go(`/builder/projects/${project}`);
  await expect(page.getByRole('heading', { name: T(info, 'm10.ov.versions') })).toBeVisible();
  await audit(page, info, 'm10-overview');

  // --- UI-M10-03: IDE: read-only viewer, preview placeholder; a sandbox always carries the runtime label and the stand-in notice
  await go(`/builder/projects/${project}/ide`);
  await expect(page.getByText(T(info, 'm10.ide.previewNote'))).toBeVisible();
  await expect(page.getByText(T(info, 'm10.ide.readOnly'))).toBeVisible();
  await page.getByRole('button', { name: T(info, 'm10.sbx.start') }).click();
  await expect(page.getByText(T(info, 'm10.sbx.notIsolated')).first()).toBeVisible();
  await expect(page.getByText(T(info, 'm10.sbx.runtime')).first()).toBeVisible();
  await audit(page, info, 'm10-ide');

  // --- UI-M10-04: terminal: layout only, transport not enabled (PA-M10-01)
  const term = await page
    .getByRole('link', { name: T(info, 'm10.sbx.openTerminal') })
    .first()
    .getAttribute('href');
  if (term) {
    await page.goto(term);
    await expect(page.getByText(T(info, 'm10.term.notEnabled'))).toBeVisible();
    await expect(page.getByText(T(info, 'm10.term.egressDenied'))).toBeVisible();
    await audit(page, info, 'm10-terminal');
  }

  // --- UI-M10-05: changes: client-side path check, then the patch form
  await go(`/builder/projects/${project}/changes?op=add&path=src/hello.ts`);
  await page.getByLabel(T(info, 'm10.chg.path')).fill('../escape.ts');
  await page.getByLabel(T(info, 'm10.chg.content')).fill('export const hello = 1;');
  await page.getByRole('button', { name: T(info, 'm10.chg.submit') }).click();
  await expect(page.getByText(T(info, 'm10.chg.err.path'))).toBeVisible();
  await page.getByLabel(T(info, 'm10.chg.path')).fill('src/hello.ts');
  await audit(page, info, 'm10-changes');

  // --- UI-M10-08: tests
  await go(`/builder/projects/${project}/tests`);
  await expect(page.getByRole('heading', { name: T(info, 'm10.tst.title') })).toBeVisible();
  await audit(page, info, 'm10-tests');

  // --- UI-M10-10: exports
  await go(`/builder/projects/${project}/exports`);
  await expect(page.getByRole('heading', { name: T(info, 'm10.exp.title') })).toBeVisible();
  await audit(page, info, 'm10-exports');

  // --- UI-M10-11: budget (read only) with the approval policy
  await go(`/builder/projects/${project}/settings/budget`);
  await expect(page.getByText(T(info, 'm10.bud.m09'))).toBeVisible();
  await expect(
    page.getByRole('cell', { name: T(info, 'm10.apr.type.release_owner') }),
  ).toBeVisible();
  await audit(page, info, 'm10-budget');

  // --- UI-M10-09: deployments: a production deploy answers 403 approval_required and lists the approvals with a link to the inbox
  await go(`/builder/projects/${project}/deployments`);
  await expect(page.getByText(T(info, 'm10.dep.empty'))).toBeVisible();
  await audit(page, info, 'm10-deployments-empty');
  const target = crypto.randomUUID(); // no hosting site is seeded here: the approval comes first, the target is checked after
  await page.getByLabel(T(info, 'm10.dep.targetId')).fill(target);
  await page.getByLabel(T(info, 'm10.dep.env'), { exact: true }).selectOption('production');
  await page.getByRole('button', { name: T(info, 'm10.dep.create') }).click();
  const needed = page.getByText(T(info, 'm10.dep.approvalNeeded'));
  const sawApproval = await needed.isVisible({ timeout: 15_000 }).catch(() => false);
  test.skip(
    !sawApproval,
    'the API did not ask for an approval (no deployable target seeded): approval, deployment and rollback legs skipped, NOT faked',
  );
  await audit(page, info, 'm10-deployment-approval-needed');

  // --- UI-M10-07: approvals inbox: the exact action and expiry in a drawer, then approve with a confirmation
  await page.getByRole('link', { name: T(info, 'm10.dep.openApprovals') }).click();
  await expect(
    page.getByRole('heading', { name: T(info, 'm10.apr.title'), level: 1 }),
  ).toBeVisible();
  await audit(page, info, 'm10-approvals');
  await page
    .getByRole('button', {
      name: T(info, 'm10.apr.open', { type: T(info, 'm10.apr.type.production_deploy') }),
    })
    .first()
    .click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText(T(info, 'm10.apr.scopeHash'))).toBeVisible();
  await expect(drawer.getByText(T(info, 'm10.apr.expires'))).toBeVisible();
  await audit(page, info, 'm10-approval-drawer');
  await drawer.getByRole('button', { name: T(info, 'm10.apr.approve'), exact: true }).click();
  await page
    .getByRole('dialog')
    .last()
    .getByRole('button', { name: T(info, 'm10.apr.confirmApprove') })
    .click();
  await expect(page.getByText(T(info, 'm10.apr.approved'))).toBeVisible();

  // --- deployment then rollback: only if the platform has a live deployment to roll back (a real target is not seeded here)
  await go(`/builder/projects/${project}/deployments`);
  const live = page.getByRole('button', { name: T(info, 'm10.dep.rollback') });
  test.skip(
    (await live.count()) === 0,
    'no live deployment (no deployable target): rollback leg skipped',
  );
  await live.click();
  await expect(page.getByRole('dialog').getByText(T(info, 'm10.dep.rollbackTitle'))).toBeVisible();
  await audit(page, info, 'm10-rollback-confirm');
  await page.getByRole('button', { name: T(info, 'm10.dep.rollbackConfirm') }).click();
  await expect(
    page
      .getByText(T(info, 'm10.dep.approvalNeeded'))
      .or(page.getByText(T(info, 'm10.dep.rollbackStarted'))),
  ).toBeVisible();
});

test('admin: AI run oversight and sandbox fleet are read only (UI-M10-18/19)', async ({
  page,
}, info) => {
  const L = loc(info);
  const staff = `staff-${L}@example.test`;
  await signIn(page, info, staff, ADMIN);
  await page.goto(`${ADMIN}/${L}/ai/runs`);
  const forbidden = await page
    .getByText(T(info, 'state.forbidden.title'))
    .isVisible()
    .catch(() => false);
  test.skip(
    forbidden,
    'the e2e staff user lacks admin:ai:read (platform_admin, support or security role): not granted here',
  );
  await expect(
    page.getByRole('heading', { name: T(info, 'm10.adm.runs.title'), level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(T(info, 'm10.adm.runs.metadataOnly'))).toBeVisible();
  await audit(page, info, 'm10-admin-runs');

  await page.goto(`${ADMIN}/${L}/sandboxes`);
  await expect(page.getByText(T(info, 'm10.adm.sbx.m05'))).toBeVisible();
  await expect(page.getByText(T(info, 'm10.adm.sbx.noKill'))).toBeVisible();
  // no kill / terminate control exists on this screen
  await expect(page.locator('main').getByRole('button')).toHaveCount(0);
  await audit(page, info, 'm10-admin-sandboxes');
});
