import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Client } from 'pg';
import { T, audit, loc, signIn } from './helpers';
import { ADMIN, DB_URL as DB } from './env';
import { resetDatabase } from './reset';

test.beforeAll(resetDatabase);

const sql = async <R extends Record<string, unknown>>(q: string, args: unknown[] = []) => {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(q, args)).rows as R[];
  } finally {
    await c.end();
  }
};
/** Test tooling: the staff session is marked as recently MFA-verified so a step-up never interrupts the flow. */
const elevate = (email: string) =>
  sql(
    `UPDATE identity.sessions SET mfa_level = 'totp', mfa_verified_at = now() WHERE user_id = (SELECT id FROM identity.users WHERE email = $1)`,
    [email],
  );

/**
 * Admin AI provider insights on `/ai/model-providers` (health, capability registry, usage report, rate-card history, model discovery), Arabic (RTL) and English
 * projects, axe + a stored screenshot per state.
 *
 * STATUS: written, NOT RUN. Browser E2E is run by the Master or under the heavy lock (`mkdir /private/tmp/nuzm-heavy.lock`); until it has run, no screenshot exists and the
 * UI rows of this slice stay NOT VERIFIED. Session 07 reviews it.
 *
 * The spec finds things by test id, id and role, never by text, so it is the same in Arabic and English (the language itself is asserted from the page text).
 * Fixtures are written with SQL; none is a real provider, price or usage: one provider row `acme-insight` (no adapter), two rate-card versions, three usage rows (two USD, one
 * SAR, one token count beyond 2^53 to prove the screen shows integers exactly). They stay in the database (append-only tables); every spec file starts from a fresh one.
 * The health and registry sections depend on what the API process served before (health is in memory), so they are asserted as loaded, not by content.
 * Model discovery is asserted only up to its refusal: no live call is ever made from a spec.
 */
test('admin AI provider insights: health, registry, usage (exact integers, mixed currencies), rate-card history, discovery refusal, read-only and forbidden roles (ar/en, axe)', async ({
  page,
}, info) => {
  const L = loc(info);
  const staff = `staff-ins-${L}@example.test`;
  await signIn(page, info, staff, ADMIN);
  await elevate(staff);
  const uid = (
    await sql<{ id: string }>(`SELECT id FROM identity.users WHERE email = $1`, [staff])
  )[0]!.id;
  const roles = (
    await sql<{ role: string }>(`SELECT role FROM tenancy.platform_roles WHERE user_id = $1`, [uid])
  ).map((r) => r.role);
  const setRoles = async (rs: string[]) => {
    await sql(`DELETE FROM tenancy.platform_roles WHERE user_id = $1`, [uid]);
    for (const r of rs)
      await sql(`INSERT INTO tenancy.platform_roles (user_id, role) VALUES ($1, $2)`, [uid, r]);
  };
  await setRoles(['platform_admin']);

  // ---- fixtures
  const pid = randomUUID();
  const card1 = {
    'acme-insight-model': { creditsPerMillionInput: '1500', creditsPerMillionOutput: '7500' },
  };
  const card2 = {
    'acme-insight-model': { creditsPerMillionInput: '1800', creditsPerMillionOutput: '9000' },
  };
  await sql(
    `INSERT INTO ai.model_providers (id, code, adapter, display_name, region, rate_card_version, rate_card, created_by)
     VALUES ($1,'acme-insight','acme','Insight E2E','sa-central','2',$2::jsonb,$3)`,
    [pid, JSON.stringify({ models: card2 }), uid],
  );
  for (const [i, models] of [card1, card2].entries())
    await sql(
      `INSERT INTO ai.model_rate_card_versions (id, provider_id, version, models, content_sha256, recorded_by, recorded_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6, now() - ($7 || ' hours')::interval)`,
      [
        randomUUID(),
        pid,
        String(i + 1),
        JSON.stringify(models),
        String(i + 1)
          .repeat(64)
          .slice(0, 64),
        uid,
        String(2 - i),
      ],
    );
  const org = randomUUID();
  const usage = (call: string, model: string, tin: string, cost: number, cur: string) =>
    sql(
      `INSERT INTO ai.model_usage (id, org_id, call_id, provider_code, model_ref, tokens_in, tokens_out, cost_minor, cost_currency, credits, outcome, latency_ms, data_region)
       VALUES ($1,$2,$3,'acme-insight',$4,$5,10,$6,$7,100,'ok',800,'SA')`,
      [randomUUID(), org, call, model, tin, cost, cur],
    );
  await usage('ins-1', 'acme-insight-model', '9007199254740993', 100, 'USD');
  await usage('ins-2', 'acme-insight-model', '1', 200, 'USD');
  await usage('ins-3', 'acme-insight-other', '5', 500, 'SAR');

  try {
    await page.goto(`${ADMIN}/${L}/ai/model-providers`);
    await expect(page.getByRole('heading', { name: T(info, 'aia.title'), level: 1 })).toBeVisible();
    const section = (id: string) => page.getByTestId(id);
    const insights = page.getByTestId('ai-insights');

    // ---- the five sections are there, in the language of the page
    for (const id of ['ins-health', 'ins-registry', 'ins-usage', 'ins-ratecard', 'ins-discovery'])
      await expect(section(id)).toBeVisible();
    await expect(insights).toContainText(L === 'ar' ? /[؀-ۿ]{3,}/ : /Provider health/);
    // health and registry loaded (a table or an empty state: the in-memory health depends on what this API process served before)
    await expect(section('ins-health').locator('[data-state="ok"]')).toBeVisible();
    await expect(section('ins-registry').locator('[data-state="ok"]')).toBeVisible();
    await audit(page, info, 'ai-insights-initial');

    // ---- usage: exact integers, our cost, mixed currencies are not added up
    await page.getByTestId('ins-usage-show').click();
    const usageTable = section('ins-usage').getByRole('table');
    await expect(usageTable).toBeVisible();
    await expect(usageTable.locator('[data-mixed="true"]').first()).toBeVisible();
    await page.locator('#ins-use-group').selectOption('model');
    await page.getByTestId('ins-usage-show').click();
    await expect(usageTable.getByText('9007199254740994 / 20')).toBeVisible(); // 2^53 + 3 + 1: exact, never rounded by a float
    await expect(usageTable.getByText('3.00 USD')).toBeVisible();
    await expect(usageTable.getByText('5.00 SAR')).toBeVisible();
    await audit(page, info, 'ai-insights-usage');
    // grouping by day over a shorter period still answers (a table or the empty state, never a blank section)
    await page.locator('#ins-use-range').selectOption('7');
    await page.locator('#ins-use-group').selectOption('day');
    await page.getByTestId('ins-usage-show').click();
    await expect(section('ins-usage').locator('[data-state="ok"]')).toBeVisible();

    // ---- rate card history: the button needs a provider; then both versions
    await expect(page.getByTestId('ins-ratecard-show')).toBeDisabled();
    await page.locator('#ins-rc-provider').selectOption(pid);
    await page.getByTestId('ins-ratecard-show').click();
    const history = section('ins-ratecard').getByRole('table');
    await expect(history.getByText('acme-insight-model: 1800 / 9000')).toBeVisible();
    await expect(history.getByText('acme-insight-model: 1500 / 7500')).toBeVisible();
    await audit(page, info, 'ai-insights-rate-card-history');

    // ---- discovery: a provider without an adapter is refused with a clear message (no live call is made from a spec)
    await page.locator('#ins-disc-provider').selectOption(pid);
    await page.getByTestId('ins-discovery-run').click();
    await expect(page.getByTestId('ins-discovery-note').getByRole('alert')).toBeVisible();
    await audit(page, info, 'ai-insights-discovery-refused');

    // ---- support: reads everything, cannot ask the provider anything
    await setRoles(['support']);
    await page.goto(`${ADMIN}/${L}/ai/model-providers`);
    await expect(section('ins-usage')).toBeVisible();
    await expect(section('ins-discovery')).toHaveCount(0);
    await audit(page, info, 'ai-insights-read-only');

    // ---- finance: no admin:ai:read, so the whole screen is the forbidden state and none of the insights is there
    await setRoles(['finance']);
    await page.goto(`${ADMIN}/${L}/ai/model-providers`);
    await expect(page.getByText(T(info, 'state.forbidden.title'))).toBeVisible();
    await expect(insights).toHaveCount(0);
    await audit(page, info, 'ai-insights-forbidden');
  } finally {
    await setRoles(roles.length > 0 ? roles : ['platform_admin']);
  }
});
