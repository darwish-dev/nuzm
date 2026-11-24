import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import type { MessageKey } from '@nuzm/i18n';
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
const elevate = (email: string) =>
  sql(
    `UPDATE identity.sessions SET mfa_level = 'totp', mfa_verified_at = now() WHERE user_id = (SELECT id FROM identity.users WHERE email = $1)`,
    [email],
  );
const setFlag = (on: boolean) =>
  sql(
    `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'ai.benchmarks', NULL, $1::jsonb)
     ON CONFLICT (key, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE SET value = EXCLUDED.value`,
    [on ? 'true' : 'false'],
  );
const sectionOf = (page: Page, id: string) => page.locator(`section:has(#${id})`);

/**
 * Admin benchmark dashboard (S-AG5, `/ai/benchmarks`), Arabic (RTL) and English projects, axe + a stored screenshot per state.
 *
 * STATUS: written, NOT RUN (Session 03, Phase 2). Browser E2E cannot run in the environment this was built in (4 CPUs and 8 GB shared by seven sessions; the E2E ports, the local
 * database and Chrome are not ours), so no screenshot exists and the UI rows of the benchmark acceptance stay NOT VERIFIED until `pnpm test:e2e` (or the isolated variant) has run it
 * under the heavy lock. Session 07 reviews it. It never calls a model: the only action is an OFFLINE replay of the reference oracle.
 *
 * Preconditions: runs after 02-admin (the staff user enrolled MFA there; this spec marks the session as freshly verified). The database is fresh per run. The feature flag
 * `ai.benchmarks` is switched ON and OFF through SQL (an admin toggle for it does not exist); it is forced OFF again in the `finally`. The staff user's platform roles are swapped for
 * `support` (read-only) and `finance` (no `admin:ai:read`) and restored in the `finally`.
 * Covered: flag off (switched-off state), flag on (notice banner, dataset, thresholds PROPOSED, staged plan A-E all blocked with the rate marked unconfirmed, empty runs and scorecard),
 * recording an offline reference run (evidence label OFFLINE_REFERENCE_ORACLE, scorecard of seven dimensions), read-only (no form), forbidden (no sidebar entry).
 * Not covered: the live runner (it cannot run: every precondition is missing, and the route that evaluates them is covered by the API tests), reviewer and qualification actions
 * (API-only, covered by the integration tests; the dashboard offers no form for them yet).
 */
test('admin benchmarks: switched off, staged plan and scorecard, offline replay, read-only and forbidden roles (ar/en, axe)', async ({
  page,
}, info: TestInfo) => {
  const L = loc(info);
  const staff = `staff-${L}@example.test`;
  // texts of the shared message catalogue only: an app may not import another app, and the Phase 2 texts live in the admin app until the Master folds them into the catalogue (CONTRACT-S03-4),
  // so those sections are asserted by structure (ids, row counts, language-neutral numbers), which also holds in both languages
  const k = (key: string) => T(info, `bench.${key}` as MessageKey);
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
  const open = async () => {
    await page.goto(`${ADMIN}/${L}/ai/benchmarks`);
    await expect(page.getByRole('heading', { name: k('title'), level: 1 })).toBeVisible();
  };

  try {
    // ---- flag off (the default): the switched-off state, nothing else
    await setFlag(false);
    await open();
    await expect(page.getByText(k('disabled'))).toBeVisible();
    await expect(page.getByRole('button', { name: k('record') })).toHaveCount(0);
    await audit(page, info, 'ai-benchmarks-disabled');

    // ---- flag on: the dashboard, with nothing recorded yet
    await setFlag(true);
    await open();
    await expect(page.getByText(k('notice'))).toBeVisible();
    // thresholds are PROPOSED: nobody has accepted them
    await expect(page.getByText(k('thresholdsProposed'))).toBeVisible();
    // the staged plan: five stages, each BLOCKED, the rate is a labelled list price and not an approved one
    const stages = sectionOf(page, 'bench-stages');
    await expect(stages.getByRole('heading', { level: 2 })).toBeVisible();
    await expect(stages.getByRole('row')).toHaveCount(6); // header + stages A-E
    await expect(stages.getByRole('status')).toHaveCount(1); // the banner that says the rate is an unconfirmed list price
    await expect(stages.locator('tbody tr:nth-child(3)')).toContainText('C'); // stage C
    await expect(stages.getByText('USD').first()).toBeVisible();
    // the maximum of the full suite at the list price is exact integer arithmetic: 83.60 USD
    await expect(stages.getByText('83.60 USD')).toBeVisible();
    await expect(page.getByText(k('runsEmpty'))).toBeVisible();
    await expect(sectionOf(page, 'bench-score').getByRole('row')).toHaveCount(0); // no run yet: no scorecard
    await expect(page.getByText(k('qualificationEmpty'))).toBeVisible();
    await audit(page, info, 'ai-benchmarks-empty');

    // ---- record an offline replay of the reference oracle (never a model)
    await page.getByRole('button', { name: k('record') }).click();
    await expect(page.getByText(k('recorded'))).toBeVisible();
    const runs = sectionOf(page, 'bench-runs');
    await expect(runs.getByText(k('evidenceLabel_OFFLINE_REFERENCE_ORACLE'))).toBeVisible();
    // the scorecard of that run: the seven dimensions, each with its thresholds
    const card = sectionOf(page, 'bench-score');
    await expect(card.getByRole('row')).toHaveCount(8); // header + seven dimensions
    await expect(card.getByText('100').first()).toBeVisible(); // the reference oracle is perfect on the functional dimension
    await audit(page, info, 'ai-benchmarks-run-recorded');

    // ---- support: reads everything, records nothing
    await setRoles(['support']);
    await open();
    await expect(page.getByRole('button', { name: k('record') })).toHaveCount(0);
    await expect(stages.getByRole('row')).toHaveCount(6); // the plan is read-only information
    await audit(page, info, 'ai-benchmarks-read-only');

    // ---- finance: no admin:ai:read: the forbidden state, no sidebar entry
    await setRoles(['finance']);
    await page.goto(`${ADMIN}/${L}/ai/benchmarks`);
    await expect(page.getByRole('heading', { name: k('title'), level: 1 })).toBeVisible();
    await expect(page.getByText(k('forbidden')).first()).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: T(info, 'nc.nav.rail') })
        .getByRole('link', { name: T(info, 'aia.nav.ai'), exact: true }),
    ).toHaveCount(0);
    await audit(page, info, 'ai-benchmarks-forbidden');
  } finally {
    await setRoles(roles.length > 0 ? roles : ['platform_admin']);
    await setFlag(false);
  }
});
