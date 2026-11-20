import { expect, test } from '@playwright/test';
import { Client } from 'pg';
import { T, audit, loc, signIn } from './helpers';

/**
 * App builder (M10A): the customer-console web-app workspace, Arabic and English projects, plus the admin oversight screens (UI-M10-18/19).
 *
 * The web app opens in the SAME full-screen workspace as a website (`/builder/projects/{id}`, web-app mode): chat with the live agent progress and the approvals a
 * build waits on (decided inline), and the former pages as panels (`?tab=preview|code|spec|design|tests|deployments|exports|versions`). The former routes
 * (`/spec`, `/design`, `/ide`, `/tests`, `/deployments`, `/exports`, `/versions`) redirect there, so the `page.goto` calls below land in the workspace.
 *
 * Flow: the flag is off (no nav entry, the web-app tile is "coming soon") → on (nav entries) → "Start a project" with ONE prompt creates the web-app project, its AI
 * session and the build run → the workspace shows the seven agents and the budget meters → a human approval the run waits on is decided in the inbox → app spec,
 * data / API / access views → files and sandbox (labelled "development stand-in, NOT isolated") → tests → export → deploy (staging) and rollback → versions.
 *
 * STATUS: NOT RUN. This spec was written WITHOUT running Playwright: the browser E2E needs ports 3000/3001/4000/4010/54329, which belong to the owner's running
 * stack, and Chrome. Type-check and lint of this file were run; the flow below is unverified in a browser. The AC-M10-15 row stays NOT VERIFIED until
 * `pnpm test:e2e` has run it (never PASS from this file).
 *
 * PRECONDITIONS (data ones are written here with SQL; the process ones belong to the e2e stack in `playwright.config.ts`, NOT changed here):
 *   - API with the REAL M09 wired into the app builder (no stand-ins) and `AI_LOCAL_REFERENCE=true` (the deterministic MOCK model adapter and the in-memory FAKE
 *     publisher; never in production). Model QUALITY is NOT VERIFIED: the scripted model only proves the plumbing. If the mock model has no `webapp` fixtures the
 *     build run ends `failed`: this spec then SKIPS every leg that needs a built app (spec, design, deploy) with an explicit reason, it never fakes one.
 *   - Fixtures written here: flags `ai.enabled` + `app_builder.enabled`, an enabled `mock-model` provider row, a funded wallet. Runs after 01-customer (it uses that
 *     test's owner organization).
 *   - No deployment target is seeded (a real hosting site/instance needs HG-05/HG-06): the deploy/rollback legs run only when the page offers a hosting site,
 *     otherwise they are skipped explicitly. The sandbox runtime is NEVER isolated (D-21/HG-10-02): every sandbox shown must carry the stand-in notice.
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

/** A prepaid credit on the organization's wallet (ledger recipe shape of billing.post, as in 03-billing / 10-builder-customer). */
async function creditWallet(orgId: string, minor: string) {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
    await c.query(
      `SELECT * FROM billing.post(gen_random_uuid(), $1, $2, 'credit_grant', 'e2e app builder credit', NULL, NULL, $3::jsonb, NULL)`,
      [
        orgId,
        `e2e-appbuilder-credit-${orgId}`,
        JSON.stringify([
          {
            account: { code: '4900', org: false },
            direction: 'debit',
            amountMinor: minor,
            currency: 'SAR',
          },
          {
            account: { code: '2100', org: true },
            direction: 'credit',
            amountMinor: minor,
            currency: 'SAR',
          },
        ]),
      ],
    );
    await c.query('SELECT billing.refresh_wallet($1)', [orgId]);
    await c.query('COMMIT');
  } finally {
    await c.end();
  }
}

test('app builder: start from one prompt, agent progress, approvals, spec, data/API/access, sandbox, tests, export, deploy, rollback, versions (ar/en, axe, states)', async ({
  page,
}, info) => {
  const L = loc(info);
  const owner = `owner-${L}@example.test`;
  const base = `http://127.0.0.1:3000/${L}`;
  const org = (
    await sql<{ id: string }>(
      `SELECT m.org_id AS id FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`,
      [owner],
    )
  )[0];
  if (!org) throw new Error('run 01-customer first: no owner organization');

  // ---- fixtures
  await setFlag('ai.enabled', true);
  await sql(
    `INSERT INTO ai.model_providers (id, code, adapter, display_name, region, rate_card_version, rate_card, enabled, enabled_at)
     VALUES (gen_random_uuid(), 'mock-model', 'mock', 'Mock model', 'sa-central', 'e2e-1', $1::jsonb, true, now())
     ON CONFLICT (code) DO UPDATE SET enabled = true, enabled_at = coalesce(ai.model_providers.enabled_at, now()), rate_card = EXCLUDED.rate_card`,
    [
      JSON.stringify({
        models: {
          'mock-chat-1': { creditsPerMillionInput: '1000000', creditsPerMillionOutput: '2000000' },
          'mock-long-1': { creditsPerMillionInput: '1000000', creditsPerMillionOutput: '2000000' },
        },
      }),
    ],
  );
  await creditWallet(org.id, '1000000').catch(() => undefined); // already credited by an earlier run of this locale: fine

  await signIn(page, info, owner);
  const nav = page.getByRole('navigation', { name: T(info, 'nav.primary') });

  // ---- flag OFF: no nav entry; the web-app tile is "coming soon" and cannot be started
  await setFlag('app_builder.enabled', false);
  await page.goto(`${base}/builder/projects`);
  await expect(nav.getByRole('link', { name: T(info, 'm10.nav.builder') })).toHaveCount(0);
  await page.getByLabel(new RegExp(T(info, 'bld.start.type.webapp'))).check();
  await expect(
    page.getByRole('button', { name: new RegExp(T(info, 'bld.start.go')) }),
  ).toBeDisabled();
  await audit(page, info, 'm10a-flag-off');

  // ---- flag ON: the App builder and Approvals entries appear; the app start screen preselects the web-app type
  await setFlag('app_builder.enabled', true);
  await page.goto(`${base}/builder/apps`);
  await expect(nav.getByRole('link', { name: T(info, 'm10.nav.builder') })).toBeVisible();
  await expect(nav.getByRole('link', { name: T(info, 'm10.nav.approvals') })).toBeVisible();
  await expect(page.getByLabel(new RegExp(T(info, 'bld.start.type.webapp')))).toBeChecked();
  await audit(page, info, 'm10a-apps-start');

  // ---- UI-M10-01: ONE prompt (no wizard) → project + session + build run, then the workspace opens
  await page
    .getByLabel(T(info, 'bld.start.promptLabel'))
    .fill(
      L === 'ar'
        ? 'نظام لإدارة عيادة يضم المرضى والأطباء والمواعيد.'
        : 'A clinic app with patients, doctors and appointments.',
    );
  await page.getByRole('button', { name: new RegExp(T(info, 'bld.start.go')) }).click();
  await page.waitForURL(/\/builder\/projects\/[0-9a-f-]{36}$/);
  const projectId = page.url().split('/').pop()!;
  const project = `${base}/builder/projects/${projectId}`;

  // ---- UI-M10-06: the seven agents with their state, the budget meters, cancel while live
  const agents = page.getByRole('list', { name: T(info, 'm10a.run.agents') });
  await expect(agents).toBeVisible({ timeout: 30_000 });
  await expect(agents.getByRole('listitem')).toHaveCount(7);
  await expect(page.getByText(T(info, 'm10a.meter.tokens'))).toBeVisible();
  await audit(page, info, 'm10a-run-progress');

  // the run ends, or waits for a human: the approval it waits on is decided right here in the chat (bound to the exact action, with its confirmation)
  const waiting = page.locator('.mws-run[data-phase="approval"]');
  const finished = page.locator(
    '.mws-run[data-phase="done"], .mws-run[data-phase="failed"], .mws-run[data-phase="budget"]',
  );
  await expect(waiting.or(finished.first())).toBeVisible({ timeout: 120_000 });
  if (await waiting.isVisible()) {
    await expect(page.getByRole('heading', { name: T(info, 'm10a.run.waiting') })).toBeVisible();
    await audit(page, info, 'm10a-run-waiting-approval');
    await waiting
      .getByRole('button', { name: T(info, 'm10.apr.approve'), exact: true })
      .first()
      .click();
    await expect(page.getByText(T(info, 'm10.apr.scopeHash')).first()).toBeVisible();
    await audit(page, info, 'm10a-approval-drawer');
    await page
      .getByRole('dialog')
      .last()
      .getByRole('button', { name: T(info, 'm10.apr.confirmApprove') })
      .click();
    await expect(page.getByText(T(info, 'm10.apr.approved'))).toBeVisible();
    await expect(finished.first()).toBeVisible({ timeout: 120_000 });
  }
  const built = await page
    .locator('.mws-run[data-phase="done"]')
    .isVisible({ timeout: 90_000 })
    .catch(() => false);
  await audit(page, info, 'm10a-overview');

  // ---- UI-M10-02: app spec and the generated data / API / access views
  await page.goto(`${project}/spec`);
  if (built) {
    await expect(page.getByRole('heading', { name: T(info, 'm10a.spec.entities') })).toBeVisible();
    await expect(page.getByRole('heading', { name: T(info, 'm10a.spec.roles') })).toBeVisible();
    await audit(page, info, 'm10a-spec');
    await page.goto(`${project}/design`);
    // the Data panel: tables (columns, relations), the generated migrations with a SQL viewer, the endpoints per table, the role matrix
    await expect(page.getByRole('tab', { name: T(info, 'wsp.data.view.tables') })).toBeVisible();
    await expect(page.getByRole('table', { name: T(info, 'wsp.data.columns') })).toBeVisible();
    await audit(page, info, 'm10a-design');
    await page.getByRole('tab', { name: T(info, 'wsp.data.view.migrations') }).click();
    await expect(page.getByRole('list', { name: T(info, 'm10a.data.migrations') })).toBeVisible();
    await page.getByRole('tab', { name: T(info, 'wsp.data.view.api') }).click();
    await expect(page.getByRole('region', { name: T(info, 'm10a.api.title') })).toBeVisible();
    await page.getByRole('tab', { name: T(info, 'wsp.data.view.access') }).click();
    await expect(page.getByRole('table', { name: T(info, 'm10a.access.title') })).toBeVisible();
  } else {
    // the build did not produce a spec (no webapp fixtures in the mock model): the honest empty state, not a blank page
    await expect(page.getByText(T(info, 'm10a.bp.none.title'))).toBeVisible();
    await audit(page, info, 'm10a-spec-empty');
  }

  // ---- UI-M10-03: files and sandbox: the runtime label and the "NOT isolated" notice are ALWAYS there
  await page.goto(`${project}/ide`);
  // the Code panel opens on the files (tree, search, viewer); the sandbox is its second view
  await page.getByRole('tab', { name: T(info, 'wsp.code.sandbox') }).click();
  await page.getByRole('button', { name: T(info, 'm10.sbx.start') }).click();
  await expect(page.getByText(T(info, 'm10.sbx.notIsolated')).first()).toBeVisible();
  await expect(page.getByText(T(info, 'm10.sbx.runtime')).first()).toBeVisible();
  await audit(page, info, 'm10a-sandbox');

  // ---- UI-M10-08: tests
  await page.goto(`${project}/tests`);
  await expect(page.getByRole('heading', { name: T(info, 'm10.tst.title') })).toBeVisible();
  await audit(page, info, 'm10a-tests');

  // ---- UI-M10-10: exports
  await page.goto(`${project}/exports`);
  await expect(page.getByRole('heading', { name: T(info, 'm10.exp.title') })).toBeVisible();
  await audit(page, info, 'm10a-exports');

  // ---- UI-M10-09: deployments (web app): a target is needed; production asks for an approval
  await page.goto(`${project}/deployments`);
  await expect(page.getByRole('heading', { name: T(info, 'm10a.dep.new') })).toBeVisible();
  await audit(page, info, 'm10a-deployments');
  const hasSite = (await page.getByLabel(T(info, 'm10a.dep.target')).locator('option').count()) > 1;
  test.skip(
    !built || !hasSite,
    'no built app or no hosting site to deploy to (a real target needs HG-05/HG-06): deploy and rollback legs skipped, NOT faked',
  );
  await page.getByLabel(T(info, 'bld.dep.environment')).selectOption('production');
  await page.getByRole('button', { name: T(info, 'm10a.dep.create') }).click();
  await expect(page.getByText(T(info, 'm10a.dep.approvalNeeded'))).toBeVisible({ timeout: 30_000 });
  await audit(page, info, 'm10a-deploy-approval-needed');
  await page.getByLabel(T(info, 'bld.dep.environment')).selectOption('staging');
  await page.getByRole('button', { name: T(info, 'm10a.dep.create') }).click();
  await expect(page.getByRole('table', { name: T(info, 'bld.dep.list') })).toBeVisible({
    timeout: 30_000,
  });
  const rollback = page.getByRole('button', { name: T(info, 'bld.dep.rollback') });
  await expect(rollback.first()).toBeVisible({ timeout: 120_000 });
  await rollback.first().click();
  await expect(page.getByRole('dialog').getByText(T(info, 'm10a.dep.rollbackTitle'))).toBeVisible();
  await audit(page, info, 'm10a-rollback-confirm');
  await page.getByRole('button', { name: T(info, 'm10a.dep.rollbackConfirm') }).click();

  // ---- versions (read-only for web apps)
  await page.goto(`${project}/versions`);
  await expect(page.getByRole('table', { name: T(info, 'm10a.tab.versions') })).toBeVisible();
  await audit(page, info, 'm10a-versions');

  // ---- the project list shows the type and can be filtered
  await page.goto(`${base}/builder/projects?type=webapp`);
  await expect(page.getByText(T(info, 'm10.proj.type.webapp')).first()).toBeVisible();
  await expect(
    page.getByRole('link', { name: T(info, 'm10a.proj.filter.webapp') }),
  ).toHaveAttribute('aria-current', 'page');
  await audit(page, info, 'm10a-projects-filtered');
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
