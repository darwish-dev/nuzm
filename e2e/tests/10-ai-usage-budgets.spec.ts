import { expect, test } from '@playwright/test';
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

/** A prepaid credit on the organization's wallet (ledger recipe shape of billing.post, as in 03-billing and 10-builder-customer). */
async function creditWallet(orgId: string, minor: string) {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
    await c.query(
      `SELECT * FROM billing.post(gen_random_uuid(), $1, $2, 'credit_grant', 'e2e ai usage credit', NULL, NULL, $3::jsonb, NULL)`,
      [
        orgId,
        `e2e-ai-usage-credit-${orgId}`,
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

/**
 * Customer AI screens UI-M09-10 (`/ai/usage`: credit balance, usage by model and project, top-up quote) and UI-M09-11 (`/ai/budgets`: caps, thresholds,
 * prompt-body logging, auto-apply, ETag conflict), Arabic (RTL) and English projects, axe + a stored screenshot per state.
 *
 * STATUS: written, NOT RUN. Browser E2E cannot run in the environment this was built in (the E2E ports, the local database and Chrome belong to another
 * session), so no screenshot was produced and the UI rows of AC-M09 stay NOT VERIFIED until `pnpm test:e2e` has run it.
 *
 * Preconditions: runs after 01-customer (it uses that test's owner organization) and after 03-billing (the `billing-{locale}` user it re-uses for the
 * read-only and auto-apply checks is created by signing in; its membership is set here and restored at the end). Fixtures written here with SQL: the
 * `ai.enabled` flag, a funded wallet, two `ai.model_usage` rows and a project budget row. The top-up card only REQUESTS A QUOTE (there is no credit-purchase
 * order yet, PA-16): the spec accepts either the quote (price book present) or the clear refusal, and never expects a purchase.
 * Not covered: the 403 on enabling auto-apply by a role that may write budgets but not AI (a billing admin cannot even tick the box: asserted as disabled).
 */
test('customer AI usage and budgets: balance, usage tables, top-up quote, budgets save, stale ETag, roles, flag off (ar/en, axe)', async ({
  page,
  browser,
}, info) => {
  const L = loc(info);
  const owner = `owner-${L}@example.test`;
  const base = `http://127.0.0.1:3000/${L}/ai`;
  const org = (
    await sql<{ id: string; user_id: string }>(
      `SELECT m.org_id AS id, m.user_id FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`,
      [owner],
    )
  )[0];
  if (!org) throw new Error('run 01-customer first: no owner organization');

  await sql(
    `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'ai.enabled', NULL, 'true') ON CONFLICT DO NOTHING`,
  );
  await sql(
    `UPDATE platform.feature_flags SET value = 'true' WHERE key = 'ai.enabled' AND org_id IS NULL`,
  );
  await sql(`DELETE FROM ai.budgets WHERE org_id = $1`, [org.id]);

  await signIn(page, info, owner);

  // ---- UI-M09-10 empty state: no wallet credit and no usage → the low-credit banner and the empty tables
  await page.goto(`${base}/usage`);
  await expect(page.getByRole('heading', { name: T(info, 'aiu.title'), level: 1 })).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: T(info, 'nav.primary') })
      .getByRole('link', { name: T(info, 'aiu.nav.ai'), exact: true }),
  ).toBeVisible();
  await expect(page.getByText(T(info, 'aiu.low', { credits: '0' }))).toBeVisible();
  await expect(page.getByText(T(info, 'aiu.empty.title'))).toHaveCount(2); // by model and by project
  await expect(page.getByText(T(info, 'aiu.topup.unavailable'))).toBeVisible();
  await audit(page, info, 'ai-usage-empty');

  // ---- funded wallet and two usage rows (one against a project that has a cap)
  await creditWallet(org.id, '1000000').catch(() => undefined); // already credited by an earlier run of this locale: fine
  const project = crypto.randomUUID();
  await sql(
    `INSERT INTO ai.model_usage (id, org_id, project_id, call_id, provider_code, model_ref, tokens_in, tokens_out, credits, outcome, data_region)
     VALUES (gen_random_uuid(), $1, $2, $3, 'mock-model', 'mock-chat-1', 1200, 800, 12, 'ok', 'sa-central')
     ON CONFLICT DO NOTHING`,
    [org.id, project, `e2e-usage-${L}-1`],
  );
  await sql(
    `INSERT INTO ai.model_usage (id, org_id, project_id, call_id, provider_code, model_ref, tokens_in, tokens_out, credits, outcome, data_region)
     VALUES (gen_random_uuid(), $1, NULL, $2, 'mock-model', 'mock-long-1', 5000, 100, 7, 'ok', 'sa-central')
     ON CONFLICT DO NOTHING`,
    [org.id, `e2e-usage-${L}-2`],
  );
  await page.goto(`${base}/usage`);
  await expect(page.getByText(T(info, 'aiu.low', { credits: '0' }))).toHaveCount(0);
  await expect(page.getByText('1,000,000').first()).toBeVisible(); // wallet credits, grouped digits
  const modelRow = page.getByRole('row').filter({ hasText: 'mock-chat-1' });
  await expect(modelRow).toContainText('1,200');
  await expect(modelRow).toContainText('12');
  await expect(page.getByRole('row').filter({ hasText: project })).toBeVisible(); // no project:read name map in this fixture: the id is shown
  await expect(page.getByRole('row').filter({ hasText: T(info, 'aiu.noProject') })).toBeVisible();
  await audit(page, info, 'ai-usage');

  // ---- top-up: a quote request only. Either the quote is shown with the "not charged" notice, or the refusal is explained; never a purchase
  await page.getByLabel(T(info, 'aiu.topup.credits')).fill('1.5');
  await page.getByRole('button', { name: T(info, 'aiu.topup.quote') }).click();
  await expect(page.getByText(T(info, 'aiu.topup.invalid'))).toBeVisible();
  await page.getByLabel(T(info, 'aiu.topup.credits')).fill('1000');
  await page.getByRole('button', { name: T(info, 'aiu.topup.quote') }).click();
  const quoted = page.getByText(T(info, 'aiu.topup.notCharged'));
  const refused = page.getByRole('alert').filter({ hasText: T(info, 'aiu.topup.refused') });
  await expect(quoted.or(refused)).toBeVisible();
  await expect(page.getByRole('button', { name: /checkout|pay|buy|شراء|ادفع/i })).toHaveCount(0);
  await audit(page, info, 'ai-usage-topup');

  // ---- UI-M09-11 budgets: never set → defaults; bodies off by default
  await page.getByRole('link', { name: T(info, 'aiu.tab.budgets') }).click();
  await expect(
    page.getByRole('heading', { name: T(info, 'aiu.budgets.title'), level: 1 }),
  ).toBeVisible();
  await expect(page.getByLabel(T(info, 'aiu.budgets.thresholds'))).toHaveValue('50, 80, 100');
  await expect(page.getByLabel(T(info, 'aiu.budgets.logToggle'))).not.toBeChecked();
  await expect(page.getByLabel(T(info, 'aiu.budgets.retention'))).toBeDisabled();
  await expect(page.getByLabel(T(info, 'aiu.budgets.autoToggle'))).not.toBeChecked();
  await audit(page, info, 'ai-budgets');

  // client-side validation: nothing is sent for an invalid cap
  await page.getByLabel(T(info, 'aiu.budgets.dailyCredits')).fill('-5');
  await page.getByRole('button', { name: T(info, 'action.save') }).click();
  await expect(page.getByText(T(info, 'aiu.budgets.err.cap'))).toBeVisible();

  // logging bodies needs a retention period
  await page.getByLabel(T(info, 'aiu.budgets.dailyCredits')).fill('250');
  await page.getByLabel(T(info, 'aiu.budgets.logToggle')).check();
  await page.getByRole('button', { name: T(info, 'action.save') }).click();
  await expect(page.getByText(T(info, 'aiu.budgets.err.retention'))).toBeVisible();

  // a valid save (caps + bodies with retention + auto-apply as owner)
  await page.getByLabel(T(info, 'aiu.budgets.retention')).fill('30');
  await page.getByLabel(T(info, 'aiu.budgets.autoToggle')).check();
  await page.getByRole('button', { name: T(info, 'action.save') }).click();
  await expect(page.getByText(T(info, 'aiu.budgets.saved'))).toBeVisible();
  const stored = (
    await sql<{
      daily_credits: string;
      log_bodies: boolean;
      body_retention_days: number;
      auto_apply_low_risk: boolean;
      version: number;
    }>(
      `SELECT daily_credits, log_bodies, body_retention_days, auto_apply_low_risk, version FROM ai.budgets WHERE org_id = $1 AND scope = 'org'`,
      [org.id],
    )
  )[0]!;
  expect(stored).toMatchObject({
    daily_credits: '250',
    log_bodies: true,
    body_retention_days: 30,
    auto_apply_low_risk: true,
  });
  await page.reload();
  await expect(page.getByLabel(T(info, 'aiu.budgets.dailyCredits'))).toHaveValue('250');
  await expect(page.getByLabel(T(info, 'aiu.budgets.retention'))).toHaveValue('30');

  // ---- stale ETag: another editor changes the budgets after this page loaded → 412 → the reload banner; nothing is overwritten
  await sql(
    `UPDATE ai.budgets SET daily_credits = 999, version = version + 1 WHERE org_id = $1 AND scope = 'org'`,
    [org.id],
  );
  await page.getByLabel(T(info, 'aiu.budgets.dailyCredits')).fill('123');
  await page.getByRole('button', { name: T(info, 'action.save') }).click();
  await expect(page.getByText(T(info, 'aiu.budgets.stale'))).toBeVisible();
  await audit(page, info, 'ai-budgets-stale');
  await page.getByRole('button', { name: T(info, 'aiu.budgets.reload') }).click();
  await expect(page.getByLabel(T(info, 'aiu.budgets.dailyCredits'))).toHaveValue('999');
  await expect(page.getByText(T(info, 'aiu.budgets.stale'))).toHaveCount(0);

  // ---- project caps: a project that already has a cap row is listed with it
  await sql(
    `INSERT INTO ai.budgets (id, org_id, scope, project_id, total_credits) VALUES (gen_random_uuid(), $1, 'project', $2, 40) ON CONFLICT DO NOTHING`,
    [org.id, project],
  );
  await page.reload();
  await expect(page.getByText(project)).toBeVisible();
  await expect(page.getByLabel(T(info, 'aiu.budgets.totalCredits')).last()).toHaveValue('40');

  // ---- other roles: a billing admin may change budgets but not switch auto-apply on; a viewer sees everything read-only
  const ctx = await browser.newContext({
    locale: info.project.use.locale ?? 'en-GB',
    viewport: { width: 1280, height: 900 },
  });
  const page2 = await ctx.newPage();
  const email2 = `billing-${L}@example.test`;
  await signIn(page2, info, email2);
  const user2 = (
    await sql<{ id: string }>(`SELECT id FROM identity.users WHERE email = $1`, [email2])
  )[0]!;
  const before = (
    await sql<{ role: string }>(
      `SELECT role FROM tenancy.memberships WHERE org_id = $1 AND user_id = $2`,
      [org.id, user2.id],
    )
  )[0];
  const setRole = async (role: string) => {
    await sql(`DELETE FROM tenancy.memberships WHERE org_id = $1 AND user_id = $2`, [
      org.id,
      user2.id,
    ]);
    await sql(
      `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, $3)`,
      [org.id, user2.id, role],
    );
  };
  try {
    await setRole('billing_admin');
    await page2.goto(`${base}/budgets`);
    await expect(page2.getByRole('button', { name: T(info, 'action.save') })).toBeVisible();
    await expect(page2.getByLabel(T(info, 'aiu.budgets.autoToggle'))).toBeChecked(); // set by the owner above; a billing admin may switch it off, not on
    await expect(page2.getByText(T(info, 'aiu.budgets.autoRoles'))).toBeVisible();
    await page2.goto(`${base}/usage`);
    await expect(page2.getByLabel(T(info, 'aiu.topup.credits'))).toBeVisible(); // billing admins may request a quote
    await audit(page2, info, 'ai-usage-billing-admin');

    await setRole('viewer');
    await page2.goto(`${base}/budgets`);
    await expect(page2.getByText(T(info, 'aiu.budgets.readOnly'))).toBeVisible();
    await expect(page2.getByRole('button', { name: T(info, 'action.save') })).toHaveCount(0);
    await expect(page2.getByLabel(T(info, 'aiu.budgets.dailyCredits'))).toBeDisabled();
    await audit(page2, info, 'ai-budgets-read-only');
    await page2.goto(`${base}/usage`);
    await expect(page2.getByText(T(info, 'aiu.topup.noPermission'))).toBeVisible(); // visible to every role; the top-up action is not
    await expect(page2.getByLabel(T(info, 'aiu.topup.credits'))).toHaveCount(0);
  } finally {
    if (before) await setRole(before.role);
    else
      await sql(`DELETE FROM tenancy.memberships WHERE org_id = $1 AND user_id = $2`, [
        org.id,
        user2.id,
      ]);
    await ctx.close();
  }

  // ---- the feature flag off: the API answers 404, the screens show the error state and the sidebar entry is gone
  await sql(
    `UPDATE platform.feature_flags SET value = 'false' WHERE key = 'ai.enabled' AND org_id IS NULL`,
  );
  await page.goto(`${base}/usage`);
  await expect(page.getByRole('heading', { name: T(info, 'state.error.title') })).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: T(info, 'nav.primary') })
      .getByRole('link', { name: T(info, 'aiu.nav.ai'), exact: true }),
  ).toHaveCount(0);
  await page.goto(`${base}/budgets`);
  await expect(page.getByRole('heading', { name: T(info, 'state.error.title') })).toBeVisible();
  await sql(
    `UPDATE platform.feature_flags SET value = 'true' WHERE key = 'ai.enabled' AND org_id IS NULL`,
  );
});
