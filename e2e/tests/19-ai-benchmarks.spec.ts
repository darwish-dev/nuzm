import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import type { MessageKey } from '@nuzm/i18n';
import { T, audit, loc, signIn } from './helpers';
import { ADMIN, DB_URL as DB } from './env';
import { ensureOwnerOrg } from './fixtures/templates';
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
 * Also covered (Session 07 review E-1..E-4, plus the role/tenant/id negatives): the functional dimension cell is asserted by row and column, no "LIVE-VERIFIED" wording appears for an
 * offline run, the support session is refused by the API itself (403) and not only by the missing button, an unauthenticated visit lands on the login page, a customer-organization
 * user (a different tenant, not staff) neither sees the dashboard nor gets data from the API, a malformed and an unknown run id answer 404 without a stack trace, and the threshold
 * governance form enforces four eyes (the proposer's own review and an acceptance without a review are refused, and the state stays PROPOSED on the server).
 * Not covered: the live runner (it cannot run: every precondition is missing, and the route that evaluates them is covered by the API tests); reviewer-roster, review-plan and
 * qualification actions have no form yet (API only, covered by the service and integration tests); an owner acceptance by a SECOND person (the spec has one staff identity).
 */
test('admin benchmarks: switched off, staged plan and scorecard, offline replay, threshold governance, read-only, forbidden, cross-tenant, unauthenticated and malformed-id negatives (ar/en, axe)', async ({
  page,
  browser,
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

  /** a request made by the page's own session (cookies and CSRF token included), as the browser would make it */
  const api = (p: Page, method: 'GET' | 'POST', path: string, body?: unknown) =>
    p.evaluate(
      async ({ method, path, body }) => {
        const csrf = document.cookie.match(/(?:^|; )nuzm_admin_csrf=([^;]*)/)?.[1];
        const r = await fetch(path, {
          method,
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            'x-nuzm-realm': 'admin',
            ...(csrf ? { 'x-csrf-token': decodeURIComponent(csrf) } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: r.status, text: await r.text() };
      },
      { method, path, body },
    );
  const thresholdStatus = async () =>
    (
      JSON.parse((await api(page, 'GET', '/v1/admin/ai/benchmarks')).text) as {
        thresholds: { status: string };
      }
    ).thresholds.status;

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

    // ---- threshold governance: propose; the proposer cannot review their own proposal, and nothing can be accepted without an approving review (four eyes); the server state stays PROPOSED
    const gov = sectionOf(page, 'bench-gov-thresholds');
    await expect(gov.locator('form')).toBeVisible();
    await expect(gov.locator('#gov-action option')).toHaveCount(1); // only "propose" makes sense before a proposal
    await gov.locator('#gov-text').fill('recommended set (e2e)');
    await gov.locator('button[type=submit]').click();
    await expect(gov.locator('#gov-action option')).toHaveCount(4); // proposed: review, accept, reject, propose
    expect(await thresholdStatus()).toBe('PROPOSED');
    await gov.locator('#gov-action').selectOption('accept');
    await gov.locator('button[type=submit]').click();
    await expect(gov.getByText(k('failed'))).toBeVisible(); // no approving review yet
    await gov.locator('#gov-action').selectOption('review');
    await gov.locator('#gov-text').fill('my own proposal');
    await gov.locator('button[type=submit]').click();
    await expect(gov.getByText(k('failed'))).toBeVisible(); // the proposer cannot review their own proposal
    expect(await thresholdStatus()).toBe('PROPOSED'); // nothing was accepted, on the server
    await audit(page, info, 'ai-benchmarks-governance-proposed');

    // ---- record an offline replay of the reference oracle (never a model)
    await page.getByRole('button', { name: k('record') }).click();
    await expect(page.getByText(k('recorded'))).toBeVisible();
    const runs = sectionOf(page, 'bench-runs');
    await expect(runs.getByText(k('evidenceLabel_OFFLINE_REFERENCE_ORACLE'))).toBeVisible();
    // the scorecard of that run: the seven dimensions, each with its thresholds
    const card = sectionOf(page, 'bench-score');
    await expect(card.getByRole('row')).toHaveCount(8); // header + seven dimensions
    // the functional dimension is the first row; its value cell (second column) says 100 for the reference oracle: asserted by row and column, not by any "100" in the card
    await expect(card.getByRole('row').nth(1).getByRole('cell').nth(1)).toContainText('100');
    await expect(card.getByRole('row').nth(1).getByRole('cell').nth(2)).toContainText('83'); // the 83 tasks behind it
    // an offline run is never presented as verified or live evidence (language-neutral ids)
    await expect(runs).not.toContainText(/LIVE-VERIFIED|RECORDED_RUN/);
    await expect(page.locator('main')).not.toContainText('LIVE-VERIFIED');
    // the id of the run just recorded: a malformed id and an unknown id answer 404 without a database error or a stack trace
    const bad = await api(page, 'GET', '/v1/admin/ai/benchmarks/runs/not-a-uuid');
    expect(bad.status).toBe(404);
    expect(bad.text).not.toMatch(/invalid input syntax|stack|at \w+ \(|SELECT /i);
    expect(
      (await api(page, 'GET', '/v1/admin/ai/benchmarks/runs/00000000-0000-4000-8000-000000000000'))
        .status,
    ).toBe(404);
    expect((await api(page, 'GET', "/v1/admin/ai/benchmarks/runs/1'%20OR%20'1'='1")).status).toBe(
      404,
    );
    await audit(page, info, 'ai-benchmarks-run-recorded');

    // ---- support: reads everything, records nothing
    await setRoles(['support']);
    await open();
    await expect(page.getByRole('button', { name: k('record') })).toHaveCount(0);
    await expect(stages.getByRole('row')).toHaveCount(6); // the plan is read-only information
    await expect(gov.locator('form')).toHaveCount(0); // a reader has no governance form either
    // the API refuses the same session itself, not only the missing button: every mutating action is 403 for a read-only role (and nothing was recorded)
    for (const body of [
      { action: 'run_offline', source: 'reference', requestId: crypto.randomUUID() },
      {
        action: 'propose_thresholds',
        version: '2-proposed',
        summary: 'x',
        requestId: crypto.randomUUID(),
      },
      { action: 'accept_thresholds', version: '2-proposed', requestId: crypto.randomUUID() },
      {
        action: 'reject_thresholds',
        version: '2-proposed',
        reason: 'x',
        requestId: crypto.randomUUID(),
      },
      {
        action: 'set_budget',
        ref: 'B',
        currency: 'USD',
        maxCostMinor: '1',
        maxTokens: 1,
        maxRequests: 1,
        requestId: crypto.randomUUID(),
      },
    ])
      expect((await api(page, 'POST', '/v1/admin/ai/benchmarks', body)).status, body.action).toBe(
        403,
      );
    expect((await api(page, 'GET', '/v1/admin/ai/benchmarks')).status).toBe(200); // reading stays allowed
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
    expect((await api(page, 'GET', '/v1/admin/ai/benchmarks')).status).toBe(403); // no admin:ai:read: not even the overview
    expect(
      (await api(page, 'GET', '/v1/admin/ai/benchmarks/runs/00000000-0000-4000-8000-000000000000'))
        .status,
    ).toBe(403);
    await audit(page, info, 'ai-benchmarks-forbidden');

    // ---- a customer-organization user (another tenant, not staff) gets nothing from the admin console or its API
    const customer = await browser.newContext({ locale: L === 'ar' ? 'ar-SA' : 'en-GB' });
    try {
      await ensureOwnerOrg(await customer.newPage(), info, `Bench ${L}`);
      const cp = await customer.newPage();
      await signIn(cp, info, `owner-${L}@example.test`, ADMIN);
      await cp.goto(`${ADMIN}/${L}/ai/benchmarks`);
      await expect(cp.getByRole('heading', { name: k('title'), level: 1 })).toHaveCount(0);
      await expect(cp.locator('#bench-stages')).toHaveCount(0);
      const r = await api(cp, 'GET', '/v1/admin/ai/benchmarks');
      expect([401, 403]).toContain(r.status);
      expect(r.text).not.toContain('Staged'); // no dashboard data in the body
      const w = await api(cp, 'POST', '/v1/admin/ai/benchmarks', {
        action: 'run_offline',
        source: 'reference',
        requestId: crypto.randomUUID(),
      });
      expect([401, 403]).toContain(w.status);
    } finally {
      await customer.close();
    }

    // ---- unauthenticated: no session at all lands on the login page and shows nothing
    await page.context().clearCookies();
    await page.goto(`${ADMIN}/${L}/ai/benchmarks`);
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('#bench-stages')).toHaveCount(0);
    expect((await api(page, 'GET', '/v1/admin/ai/benchmarks')).status).toBe(401);
  } finally {
    await setRoles(roles.length > 0 ? roles : ['platform_admin']);
    await setFlag(false);
  }
});
