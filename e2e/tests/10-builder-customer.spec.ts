import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { T, audit, loc, signIn } from './helpers';

const DB = 'postgres://nuzm_admin@127.0.0.1:54329/nuzm_e2e';
const sql = async <R extends Record<string, unknown>>(q: string, args: unknown[] = []) => {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(q, args)).rows as R[];
  } finally {
    await c.end();
  }
};

/** A prepaid credit on the organization's wallet (ledger recipe shape of billing.post, as in 03-billing). */
async function creditWallet(orgId: string, minor: string) {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
    await c.query(
      `SELECT * FROM billing.post(gen_random_uuid(), $1, $2, 'credit_grant', 'e2e ai credit', NULL, NULL, $3::jsonb, NULL)`,
      [
        orgId,
        `e2e-ai-credit-${orgId}`,
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

/** A regular expression for a message with `{placeholders}` (each matches digits or any text). */
const rx = (info: TestInfo, key: Parameters<typeof T>[1], names: string[] = []) => {
  const params = Object.fromEntries(names.map((n) => [n, `@@${n}@@`]));
  let src = T(info, key, params).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const n of names) src = src.replace(`@@${n}@@`, '.+');
  return new RegExp(src);
};

/** Keyboard only: press Tab until the focused control has this accessible name (or visible text); fails after `max` presses (a keyboard trap would show here). */
async function tabTo(page: Page, name: string, max = 80) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return (a?.getAttribute('aria-label') || a?.innerText || '').trim();
    });
    if (label === name) return;
  }
  throw new Error(`keyboard: "${name}" was not reachable with Tab within ${max} presses`);
}

/**
 * Customer website-builder screens UI-M09-01..09 in Arabic (RTL) and English: a non-technical journey. Create a website from a description → the workspace
 * (plan approval, generated site) → edit a heading in the inspector (diff, undo, redo) → an edit request by chat shows its approval → SEO, versions, forms and
 * content screens → publish to a fake hosting site with the two-step human approval (keyboard only) → the feature flag off hides everything.
 *
 * STATUS: written, NOT RUN. Browser E2E cannot run in the environment this milestone was built in (the E2E ports and Chrome belong to another session), so no
 * screenshot was produced and AC-M09 UI rows stay NOT VERIFIED until `pnpm test:e2e` has run it.
 *
 * PRECONDITIONS (this spec writes the data ones with SQL, like 06; the process ones are the e2e stack's, in `playwright.config.ts`, NOT changed here):
 *   - API started with `AI_LOCAL_REFERENCE=true` (registers the deterministic MOCK model adapter and the in-memory FAKE hosting publisher; both outside production
 *     only, plumbing only, NOT VERIFIED quality). Without it the wizard shows `unsupported_capability` and publishing shows the "no publish path" state.
 *   - `BUILDER_PREVIEW_DOMAIN` / `BUILDER_PREVIEW_SCHEME` set the same for the API and the built web app (the web CSP `frame-src` allows only that domain). The preview
 *     host is not resolvable in the test browser: this spec checks the iframe sandbox attributes, not the framed page.
 *   - Fixtures written here: feature flag `ai.enabled`, an enabled `mock-model` provider row (dev reference, no attestation needed), a funded wallet, an active
 *     hosting site (with a node and a plan). Runs after 01-customer (it uses that test's owner organization).
 * Not covered here: the viewer (read-only) role, the 409 stale-base banner and the SSE reconnect (covered by unit tests of their pure parts only).
 */
test('customer website builder: wizard, workspace, edit, approval, SEO, versions, forms, content, publish, flag off (ar/en, axe, keyboard)', async ({
  page,
}, info) => {
  const L = loc(info);
  const owner = `owner-${L}@example.test`;
  const base = `http://127.0.0.1:3000/${L}`;
  const org = (
    await sql<{ id: string; user_id: string }>(
      `SELECT m.org_id AS id, m.user_id FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`,
      [owner],
    )
  )[0];
  if (!org) throw new Error('run 01-customer first: no owner organization');

  // ---- fixtures
  await sql(
    `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'ai.enabled', NULL, 'true') ON CONFLICT DO NOTHING`,
  );
  await sql(
    `UPDATE platform.feature_flags SET value = 'true' WHERE key = 'ai.enabled' AND org_id IS NULL`,
  );
  const models = {
    'mock-chat-1': { creditsPerMillionInput: '1000000', creditsPerMillionOutput: '2000000' },
    'mock-long-1': { creditsPerMillionInput: '1000000', creditsPerMillionOutput: '2000000' },
  };
  await sql(
    `INSERT INTO ai.model_providers (id, code, adapter, display_name, region, rate_card_version, rate_card, enabled, enabled_at)
     VALUES (gen_random_uuid(), 'mock-model', 'mock', 'Mock model', 'sa-central', 'e2e-1', $1::jsonb, true, now())
     ON CONFLICT (code) DO UPDATE SET enabled = true, enabled_at = coalesce(ai.model_providers.enabled_at, now()), rate_card = EXCLUDED.rate_card`,
    [JSON.stringify({ models })],
  );
  await creditWallet(org.id, '1000000').catch(() => undefined); // already credited by an earlier run of this locale: fine
  const node = crypto.randomUUID();
  const plan = crypto.randomUUID();
  const site = crypto.randomUUID();
  await sql(
    `INSERT INTO hosting.nodes (id, name, compute_instance_id, region, data_region, status, health, runtimes) VALUES ($1,$2,$3,'r','sa-central','active','healthy','["php:8.3"]')`,
    [node, `e2e-b-${L}-${node.slice(0, 6)}`, `e2e-bi-${node}`],
  );
  await sql(
    `INSERT INTO hosting.plan_definitions (id, key, name_ar, name_en, status, quotas, runtimes, reservation, price_minor, placeholder) VALUES ($1,$2,'خطة اختبار','Test plan','active','{"diskMb":100,"inodes":5000,"bandwidthGb":10,"dbCount":1,"sitesCount":1}','["php"]','{"cpu_millicores":100,"memory_mb":128,"disk_mb":500}',10000,true)`,
    [plan, `e2e-b-${L}-${plan.slice(0, 6)}`],
  );
  await sql(
    `INSERT INTO hosting.sites (id, org_id, name, token, node_name, plan_id, runtime, status, data_region, node_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,'php:8.3','active','sa-central',$7,$8)`,
    [
      site,
      org.id,
      `e2e-pub-${L}`,
      'b'.repeat(64),
      `s-${site.replace(/-/g, '').slice(0, 20)}`,
      plan,
      node,
      org.user_id,
    ],
  );

  await signIn(page, info, owner);

  // ---- UI-M09-01/02 (merged): "Start a project": the prompt box and no list yet
  await page.goto(`${base}/builder/projects`);
  await expect(
    page.getByRole('heading', { level: 1, name: T(info, 'bld.start.title') }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: T(info, 'bld.start.hero') })).toBeVisible();
  await audit(page, info, 'builder-start-empty');

  // web app and mobile app are shown as "coming soon": starting is off for them
  await page.getByLabel(new RegExp(T(info, 'bld.start.type.mobile'))).check();
  await expect(
    page.getByRole('button', { name: new RegExp(T(info, 'bld.start.go')) }),
  ).toBeDisabled();
  await page.getByLabel(new RegExp(T(info, 'bld.start.type.website'))).check();

  // one prompt, one button: project + AI session + first run, then the workspace opens
  await page
    .getByLabel(T(info, 'bld.start.promptLabel'))
    .fill(
      L === 'ar'
        ? 'مطعم عائلي يقدم أطباقًا شرقية في الرياض.'
        : 'A family restaurant serving Middle Eastern dishes in Riyadh.',
    );
  await audit(page, info, 'builder-start-prompt');
  await page.getByRole('button', { name: new RegExp(T(info, 'bld.start.go')) }).click();
  await page.waitForURL(/\/builder\/projects\/[0-9a-f-]{36}$/);
  const projectId = page.url().split('/').pop()!;

  // ---- UI-M09-03: workspace; the generation run asks for the plan approval, then finishes
  await expect(
    page.getByRole('heading', { level: 1, name: T(info, 'bld.title.workspace') }),
  ).toBeVisible();
  const approve = page.getByRole('button', { name: T(info, 'bld.approval.approve') });
  await expect(approve).toBeVisible({ timeout: 60_000 });
  await audit(page, info, 'builder-plan-approval');
  await approve.click();
  await expect(page.getByText(T(info, 'bld.run.state.succeeded')).first()).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByTitle(T(info, 'bld.preview.frame'))).toHaveAttribute(
    'sandbox',
    'allow-scripts',
  );
  await expect(page.getByTitle(T(info, 'bld.preview.frame'))).toHaveAttribute(
    'referrerpolicy',
    'no-referrer',
  );
  expect(await page.getByTitle(T(info, 'bld.preview.frame')).getAttribute('sandbox')).not.toContain(
    'allow-same-origin',
  );
  await audit(page, info, 'builder-workspace');

  // viewport presets
  await page.getByRole('button', { name: rx(info, 'bld.preview.mobile', ['width']) }).click();
  await expect(page.getByTitle(T(info, 'bld.preview.frame'))).toHaveCSS('width', '375px');
  await page.getByRole('button', { name: rx(info, 'bld.preview.desktop', ['width']) }).click();

  // ---- edit a heading in the inspector (diff, undo, redo)
  await page
    .getByRole('button', { name: new RegExp(T(info, 'bld.section.hero')) })
    .first()
    .click();
  const headingLabel = `${T(info, 'bld.prop.heading')} (${T(info, L === 'ar' ? 'bld.lang.ar' : 'bld.lang.en')})`;
  await page
    .getByLabel(headingLabel, { exact: true })
    .fill(L === 'ar' ? 'أهلًا بكم في الواحة' : 'Welcome to the Oasis');
  await page.getByRole('button', { name: T(info, 'bld.insp.apply') }).click();
  await expect(
    page.getByRole('heading', { name: rx(info, 'bld.diff.title', ['seq']) }),
  ).toBeVisible();
  await audit(page, info, 'builder-inspector-diff');
  await page.getByRole('button', { name: T(info, 'bld.insp.undo') }).click();
  await expect(page.getByRole('button', { name: T(info, 'bld.insp.redo') })).toBeEnabled();
  await page.getByRole('button', { name: T(info, 'bld.insp.redo') }).click();

  // code / diff tab
  await page.getByRole('button', { name: T(info, 'bld.ws.code') }).click();
  await expect(page.getByRole('table', { name: T(info, 'bld.code.files') })).toBeVisible();
  await audit(page, info, 'builder-code');
  await page.getByRole('button', { name: T(info, 'bld.ws.preview') }).click();

  // ---- edit by chat: the run proposes, the approval card shows the diff; a human decides
  await page
    .getByLabel(T(info, 'bld.chat.input'))
    .fill(
      L === 'ar'
        ? 'غيّر عنوان الصفحة الرئيسية إلى "أطباق الواحة".'
        : 'Change the home page heading to "Oasis dishes".',
    );
  await page.getByRole('button', { name: T(info, 'bld.chat.send') }).click();
  await expect(page.getByRole('button', { name: T(info, 'bld.approval.approve') })).toBeVisible({
    timeout: 60_000,
  });
  await audit(page, info, 'builder-change-approval');
  await page.getByRole('button', { name: T(info, 'bld.approval.deny') }).click();
  await expect(page.getByText(T(info, 'bld.run.state.cancelled')).first()).toBeVisible({
    timeout: 30_000,
  });

  // ---- UI-M09-09: run detail
  await page
    .getByRole('link', { name: T(info, 'bld.run.details') })
    .first()
    .click();
  await expect(
    page.getByRole('heading', { level: 1, name: T(info, 'bld.title.run') }),
  ).toBeVisible();
  await audit(page, info, 'builder-run-detail');

  // ---- UI-M09-04 versions, UI-M09-05 SEO, UI-M09-06 forms, UI-M09-07 content
  const project = `${base}/builder/projects/${projectId}`;
  await page.goto(`${project}/versions`);
  await expect(page.getByRole('table', { name: T(info, 'bld.tab.versions') })).toBeVisible();
  await audit(page, info, 'builder-versions');
  await page.goto(`${project}/seo`);
  await expect(page.getByText(rx(info, 'bld.seo.scoreValue', ['score'])).first()).toBeVisible();
  await audit(page, info, 'builder-seo');
  await page.goto(`${project}/forms`);
  await expect(page.getByRole('heading', { name: T(info, 'bld.forms.submissions') })).toBeVisible();
  await audit(page, info, 'builder-forms');
  await page.goto(`${project}/cms`);
  await page.getByRole('button', { name: T(info, 'bld.cms.newCollection') }).click();
  await page.getByLabel(T(info, 'bld.cms.key'), { exact: true }).fill('news');
  await page
    .getByLabel(T(info, 'bld.cms.name'), { exact: true })
    .fill(L === 'ar' ? 'الأخبار' : 'News');
  await page.getByRole('button', { name: T(info, 'action.create') }).click();
  await expect(
    page.getByRole('table', {
      name: T(info, 'bld.cms.items', { name: L === 'ar' ? 'الأخبار' : 'News' }),
    }),
  ).toHaveCount(0); // no items yet
  await expect(page.getByText(T(info, 'bld.cms.noItems'))).toBeVisible();
  await audit(page, info, 'builder-cms');

  // ---- UI-M09-08: publish to the fake hosting site, KEYBOARD ONLY, with the two-step human approval
  await page.goto(`${project}/deployments`);
  await expect(page.getByRole('heading', { name: T(info, 'bld.dep.form') })).toBeVisible();
  await audit(page, info, 'builder-deployments');
  await page.locator('main#main').focus();
  await tabTo(page, T(info, 'bld.dep.publish'));
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: T(info, 'bld.dep.confirm.title') });
  await expect(dialog).toBeVisible();
  await audit(page, info, 'builder-deployments-confirm');
  // focus is inside the dialog and reaches the confirmation without leaving it
  await tabTo(page, T(info, 'bld.dep.confirm.go'), 8);
  await page.keyboard.press('Enter');
  await expect(page.getByText(T(info, 'bld.dep.state.succeeded')).first()).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByRole('table', { name: T(info, 'bld.dep.smoke') })).toBeVisible();
  await audit(page, info, 'builder-deployments-done');

  // ---- the feature flag off hides the whole surface (the API answers 404); the sidebar entry is gone
  await sql(
    `UPDATE platform.feature_flags SET value = 'false' WHERE key = 'ai.enabled' AND org_id IS NULL`,
  );
  await page.goto(`${base}/builder/projects`);
  await expect(page.getByText(T(info, 'bld.unavailable.title'))).toBeVisible();
  await expect(page.getByRole('link', { name: T(info, 'bld.nav.builder') })).toHaveCount(0);
  await sql(
    `UPDATE platform.feature_flags SET value = 'true' WHERE key = 'ai.enabled' AND org_id IS NULL`,
  );
});
