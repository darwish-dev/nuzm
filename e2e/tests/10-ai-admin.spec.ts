import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { T, audit, loc, signIn } from './helpers';

const ADMIN = 'http://127.0.0.1:3001';
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

/** Test tooling: the staff session is marked as recently MFA-verified so the step-up the provider actions require does not interrupt the flow. */
const elevate = (email: string) =>
  sql(
    `UPDATE identity.sessions SET mfa_level = 'totp', mfa_verified_at = now() WHERE user_id = (SELECT id FROM identity.users WHERE email = $1)`,
    [email],
  );

const nav = (page: Page, info: TestInfo) =>
  page
    .getByRole('navigation', { name: T(info, 'nav.primary') })
    .getByRole('link', { name: T(info, 'aia.nav.ai'), exact: true });

/**
 * Admin AI screens UI-M09-12 (`/ai/model-providers`), UI-M09-13 (`/ai/runs`) and UI-M09-14 (`/ai/quality`), Arabic (RTL) and English projects, axe + a
 * stored screenshot per state.
 *
 * STATUS: written, NOT RUN. Browser E2E cannot run in the environment this was built in (the E2E ports, the local database and Chrome belong to another
 * session), so no screenshot was produced and the UI rows of AC-M09 stay NOT VERIFIED until `pnpm test:e2e` has run it.
 *
 * Preconditions: runs after 02-admin (the staff user enrolled MFA there; this spec marks the session as freshly verified) and after 01-customer (runs are
 * seeded in its owner organization). The database is fresh per run (global setup), which the "no evaluation has run yet" assertion relies on: evaluation
 * artifacts can never be deleted. The API should have been started with `AI_LOCAL_REFERENCE=true` (registers the dev-reference `mock-model` adapter): the
 * dev-reference part asserts BOTH outcomes (enabled, or the clear refusal with its blocker), as 09-admin-data-providers does.
 * Fixtures written with SQL: model provider rows are deleted at the start and the ones this spec creates at the end; one session + three runs
 * (one carries a secret-looking prompt in its input, to prove the screen never shows it); two evaluation reports; the staff user's platform roles are swapped
 * for `support` (read-only) and `finance` (no `admin:ai:read`) and restored in a `finally`.
 * The kill switch is engaged and released through the UI and forced OFF in the `finally` so that other specs are not affected.
 * Not covered: the two-person rule (a non-dev provider needs a registered adapter, which only the dev reference has: covered by the unit tests and the API
 * integration tests), the global kill switch's effect on a real call (covered by the API tests), break-glass content access (not built).
 */
test('admin AI: providers (empty, configure, attestation gates, enable/disable, kill switch), run oversight, quality, read-only and forbidden roles (ar/en, axe)', async ({
  page,
}, info) => {
  const L = loc(info);
  const staff = `staff-${L}@example.test`;
  const owner = `owner-${L}@example.test`;
  const org = (
    await sql<{ id: string }>(
      `SELECT m.org_id AS id FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`,
      [owner],
    )
  )[0];
  if (!org) throw new Error('run 01-customer first: no owner organization');

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
  const cleanProviders = () =>
    sql(`DELETE FROM ai.model_providers WHERE code IN ('acme-e2e', 'mock-model')`);
  await cleanProviders();

  try {
    // ================================================================ UI-M09-12 model providers
    await page.goto(`${ADMIN}/${L}/ai/model-providers`);
    await expect(page.getByRole('heading', { name: T(info, 'aia.title'), level: 1 })).toBeVisible();
    await expect(nav(page, info)).toBeVisible();
    // nothing is seeded: the decision is open and the attestation is a human gate
    await expect(page.getByText(T(info, 'aia.noSelection'))).toBeVisible();
    await expect(page.getByText(T(info, 'aia.empty'))).toBeVisible();
    await expect(page.getByText(T(info, 'aia.emptyBody'))).toContainText('D-18');
    await expect(page.getByText(T(info, 'aia.emptyBody'))).toContainText('HG-09-01');
    await audit(page, info, 'ai-admin-providers-empty');

    // ---- kill switch: confirmation first; cancelling changes nothing; confirming engages it; releasing needs its own confirmation
    await page.getByRole('button', { name: T(info, 'aia.ks.engage') }).click();
    const group = page.getByRole('group', { name: T(info, 'aia.ks.confirmTitle') });
    await expect(group.getByText(T(info, 'aia.ks.confirm.on.global'))).toBeVisible();
    await audit(page, info, 'ai-admin-kill-switch-confirm');
    await group.getByRole('button', { name: T(info, 'action.cancel') }).click();
    await expect(group).toHaveCount(0);
    await page.getByLabel(T(info, 'aia.ks.org')).fill('not-a-uuid');
    await page.getByRole('button', { name: T(info, 'aia.ks.engage') }).click();
    await expect(page.getByText(T(info, 'aia.ks.orgInvalid'))).toBeVisible();
    await page.getByLabel(T(info, 'aia.ks.org')).fill('');
    await page.getByRole('button', { name: T(info, 'aia.ks.engage') }).click();
    await page.getByRole('button', { name: T(info, 'aia.ks.confirmOn') }).click();
    await expect(page.getByText(T(info, 'aia.ks.last.on.global'))).toBeVisible();
    await page.getByRole('button', { name: T(info, 'aia.ks.release') }).click();
    await page.getByRole('button', { name: T(info, 'aia.ks.confirmOff') }).click();
    await expect(page.getByText(T(info, 'aia.ks.last.off.global'))).toBeVisible();

    // ---- a pasted key never leaves the browser: the credential is a vault reference only
    const fill = (label: string, v: string) => page.getByLabel(label).fill(v);
    await fill(T(info, 'aia.cfg.code'), 'acme-e2e');
    await fill(T(info, 'aia.cfg.adapter'), 'acme');
    await fill(T(info, 'aia.cfg.displayName'), 'Acme E2E');
    await fill(T(info, 'aia.cfg.region'), 'sa-central');
    await fill(T(info, 'aia.cfg.vault'), 'sk-live-0123456789abcdef');
    await page.getByRole('button', { name: T(info, 'action.save') }).click();
    await expect(page.getByText(T(info, 'aia.cfg.err.vault'))).toBeVisible();

    // ---- configure a (non-dev) provider with a vault reference and a rate card
    await fill(T(info, 'aia.cfg.vault'), 'vault://ai/e2e-acme');
    await fill(
      T(info, 'aia.cfg.rateCard'),
      '{"models":{"acme-1":{"creditsPerMillionInput":"1000","creditsPerMillionOutput":"2000"}}}',
    );
    await page.getByRole('button', { name: T(info, 'action.save') }).click();
    await expect(page.getByText(T(info, 'aia.cfg.done'))).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: 'acme-e2e' });
    await expect(row).toBeVisible();
    await expect(row.getByText('vault://ai/e2e-acme')).toBeVisible(); // the reference, never a value
    await expect(row.getByText(T(info, 'aia.notAttested'))).toBeVisible();
    await expect(row.getByText(T(info, 'aia.blocker.adapter_not_registered'))).toBeVisible();
    await expect(row.getByText(T(info, 'aia.blocker.not_attested'))).toBeVisible();
    await expect(row.getByText(T(info, 'aia.blocker.not_requested'))).toBeVisible();
    await expect(row.getByText(T(info, 'aia.blocker.no_rate_card'))).toHaveCount(0);
    await audit(page, info, 'ai-admin-providers-configured');

    // ---- enabling is blocked and says why; the human attestation (HG-09-01) is recorded with a reference
    await row.getByText(T(info, 'aia.actions')).click();
    await expect(
      row.getByRole('button', { name: T(info, 'aia.enable'), exact: true }),
    ).toBeDisabled();
    await expect(row.getByText(T(info, 'aia.enable.blocked'))).toBeVisible();
    await expect(row.getByRole('button', { name: T(info, 'aia.request') })).toBeDisabled();
    await row.getByLabel(T(info, 'aia.att.ref')).fill('HG-09-01/e2e-reference');
    await row.getByLabel(T(info, 'aia.att.retains')).selectOption('false');
    await row.getByLabel(T(info, 'aia.att.trains')).selectOption('unknown');
    await row.getByRole('button', { name: T(info, 'aia.att.submit') }).click();
    await expect(page.getByText(T(info, 'aia.done.attest'))).toBeVisible();
    await expect(row.getByText(T(info, 'aia.attested'), { exact: true })).toBeVisible();
    await expect(row.getByText('HG-09-01/e2e-reference')).toBeVisible();
    await expect(row.getByText(T(info, 'aia.blocker.not_attested'))).toHaveCount(0);
    // still not enableable: no adapter is registered for this provider
    await expect(row.getByText(T(info, 'aia.blocker.adapter_not_registered'))).toBeVisible();
    await expect(
      row.getByRole('button', { name: T(info, 'aia.enable'), exact: true }),
    ).toBeDisabled();
    await audit(page, info, 'ai-admin-providers-attested');

    // ---- the dev-reference provider: enabled and disabled again when the local adapter is registered, otherwise a clear refusal
    await fill(T(info, 'aia.cfg.code'), 'mock-model');
    await fill(T(info, 'aia.cfg.adapter'), 'mock');
    await fill(T(info, 'aia.cfg.displayName'), 'Mock model');
    await fill(T(info, 'aia.cfg.region'), 'sa-central');
    await fill(
      T(info, 'aia.cfg.rateCard'),
      '{"models":{"mock-chat-1":{"creditsPerMillionInput":"1000","creditsPerMillionOutput":"2000"}}}',
    );
    await page.getByRole('button', { name: T(info, 'action.save') }).click();
    const saved = page.getByText(T(info, 'aia.cfg.done'));
    const refused = page.getByText(T(info, 'aia.err.refused'));
    await expect(saved.or(refused)).toBeVisible();
    if (await saved.isVisible()) {
      const mock = page.getByRole('row').filter({ hasText: 'mock-model' });
      await expect(mock.getByText(T(info, 'aia.devRef'))).toBeVisible();
      if (await mock.getByText(T(info, 'aia.noBlockers')).isVisible()) {
        await mock.getByText(T(info, 'aia.actions')).click();
        await mock.getByRole('button', { name: T(info, 'aia.enable'), exact: true }).click();
        await expect(page.getByText(T(info, 'aia.done.enable'))).toBeVisible();
        await expect(mock.getByText(T(info, 'aia.enabled'), { exact: true })).toBeVisible();
        await audit(page, info, 'ai-admin-providers-enabled');
        await mock.getByRole('button', { name: T(info, 'aia.disable') }).click();
        await expect(page.getByText(T(info, 'aia.done.disable'))).toBeVisible();
        await expect(mock.getByText(T(info, 'aia.disabled'), { exact: true })).toBeVisible();
      } else {
        // no local adapter registered in this stack: enabling stays blocked and explained
        await expect(mock.getByText(T(info, 'aia.blocker.adapter_not_registered'))).toBeVisible();
      }
    }
    await expect(page.getByText(T(info, 'aia.enableRules'))).toBeVisible();

    // ================================================================ UI-M09-13 run oversight (metadata only)
    const mk = async (state: string, error: string | null, input: string) => {
      const session = crypto.randomUUID();
      await sql(
        `INSERT INTO ai.sessions (id, org_id, title, data_region) VALUES ($1, $2, 'e2e run session', 'sa-central')`,
        [session, org.id],
      );
      const done = state !== 'running';
      await sql(
        `INSERT INTO ai.runs (id, org_id, session_id, kind, state, input, tokens_in, tokens_out, spent_credits, model_ref, data_region, error, finished_at)
         VALUES (gen_random_uuid(), $1, $2, 'website', $3, $4::jsonb, 1200, 800, 12, 'mock-chat-1', 'sa-central', $5::jsonb, ${done ? 'now()' : 'NULL'})`,
        [
          org.id,
          session,
          state,
          JSON.stringify({ prompt: input }),
          error ? JSON.stringify({ code: error }) : null,
        ],
      );
    };
    // the two locale projects share one database and the list is cross-organization: seed the runs once
    const seeded = (
      await sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM ai.runs WHERE error->>'code' = 'e2e_budget_exceeded'`,
      )
    )[0]!.n;
    if (seeded === 0) {
      await mk('failed', 'e2e_budget_exceeded', 'SECRET-PROMPT-E2E-1');
      await mk('succeeded', null, 'SECRET-PROMPT-E2E-2');
      await mk('running', null, 'SECRET-PROMPT-E2E-3');
    }
    await page.getByRole('link', { name: T(info, 'aia.tab.runs') }).click();
    await expect(
      page.getByRole('heading', { name: T(info, 'aia.runs.title'), level: 1 }),
    ).toBeVisible();
    await expect(page.getByText(T(info, 'aia.runs.noContent'))).toBeVisible();
    const failed = page.getByRole('row').filter({ hasText: 'e2e_budget_exceeded' });
    await expect(failed).toBeVisible();
    await expect(failed).toContainText('1200 / 800');
    await expect(failed).toContainText('mock-chat-1');
    expect(await page.content()).not.toContain('SECRET-PROMPT-E2E'); // prompts are never returned or shown
    await audit(page, info, 'ai-admin-runs');
    // filter by state
    await page.getByLabel(T(info, 'field.status')).selectOption('failed');
    await page.getByRole('button', { name: T(info, 'action.search') }).click();
    await expect(page.getByRole('row').filter({ hasText: 'e2e_budget_exceeded' })).toBeVisible();
    await expect(
      page.getByRole('row').filter({ hasText: T(info, 'aia.runs.state.running') }),
    ).toHaveCount(0);
    // an organization id that is not valid is refused before any request; an unknown one gives the empty state
    await page.goto(`${ADMIN}/${L}/ai/runs?orgId=nope`);
    await expect(page.getByText(T(info, 'aia.ks.orgInvalid'))).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await page.goto(`${ADMIN}/${L}/ai/runs?orgId=${crypto.randomUUID()}`);
    await expect(page.getByText(T(info, 'aia.runs.empty'))).toBeVisible();
    await audit(page, info, 'ai-admin-runs-empty');

    // ================================================================ UI-M09-14 quality
    await page.goto(`${ADMIN}/${L}/ai/quality`);
    await expect(
      page.getByRole('heading', { name: T(info, 'aia.quality.title'), level: 1 }),
    ).toBeVisible();
    await expect(page.getByText(T(info, 'aia.quality.notice'))).toBeVisible();
    // evaluation artifacts can never be deleted: the empty state is only reachable while none exists (the first locale project on a fresh database)
    const reports = (
      await sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM ai.artifacts WHERE type = 'evaluation_report'`,
      )
    )[0]!.n;
    if (reports === 0) {
      await expect(page.getByText(T(info, 'aia.quality.empty'))).toBeVisible();
      await expect(page.getByText(T(info, 'aia.quality.emptyBody'))).toContainText('HG-09-01');
      await audit(page, info, 'ai-admin-quality-empty');
    }
    const report = (cov: number, breaches: string[], ago: string) =>
      sql(
        `INSERT INTO ai.artifacts (id, org_id, type, payload, data_region, created_at)
         VALUES (gen_random_uuid(), $1, 'evaluation_report', $2::jsonb, 'sa-central', now() - $3::interval)`,
        [
          org.id,
          JSON.stringify({
            createdAt: new Date().toISOString(),
            model: 'mock-model',
            modelQuality: 'NOT VERIFIED',
            sites: 40,
            byLanguage: { ar: 20, en: 20 },
            metrics: {
              htmlErrorFreeSites: 1,
              a11yScore: 1,
              seoScore: 1,
              performanceScore: 1,
              requirementCoverage: cov,
              humanRubricMean: null,
            },
            breaches,
            thresholds: {},
            rubric: { status: 'PENDING', note: 'e2e' },
            notes: [],
            perSite: [],
          }),
          ago,
        ],
      );
    if (reports === 0) {
      await report(0.9, [], '1 day');
      await report(0.85, ['requirementCoverage'], '0 seconds');
    }
    await page.reload();
    await expect(page.getByText(T(info, 'aia.quality.breach'))).toBeVisible();
    await expect(page.getByText(T(info, 'aia.quality.breached'), { exact: true })).toHaveCount(1); // text, not colour alone
    await expect(page.getByText(T(info, 'aia.quality.notVerified')).first()).toBeVisible();
    await expect(page.getByText('-0.05')).toBeVisible(); // the trend: coverage fell since the previous report
    await expect(page.getByText(T(info, 'aia.quality.rubricPending')).first()).toBeVisible(); // the human rubric is never filled in by the harness
    await audit(page, info, 'ai-admin-quality');

    // ================================================================ roles
    // support: may read everything, may change nothing
    await setRoles(['support']);
    await page.goto(`${ADMIN}/${L}/ai/model-providers`);
    await expect(page.getByRole('row').filter({ hasText: 'acme-e2e' })).toBeVisible();
    await expect(page.getByLabel(T(info, 'aia.cfg.vault'))).toHaveCount(0);
    await expect(page.getByRole('button', { name: T(info, 'aia.ks.engage') })).toHaveCount(0);
    const ro = page.getByRole('row').filter({ hasText: 'acme-e2e' });
    await ro.getByText(T(info, 'aia.actions')).click();
    await expect(
      ro.getByRole('button', { name: T(info, 'aia.enable'), exact: true }),
    ).toBeDisabled();
    await expect(ro.getByText(T(info, 'aia.enable.noPerm'))).toBeVisible();
    await audit(page, info, 'ai-admin-providers-read-only');
    // finance: no admin:ai:read → the forbidden state on every AI screen, no sidebar entry
    await setRoles(['finance']);
    for (const [path, title] of [
      ['model-providers', 'aia.title'],
      ['runs', 'aia.runs.title'],
      ['quality', 'aia.quality.title'],
    ] as const) {
      await page.goto(`${ADMIN}/${L}/ai/${path}`);
      await expect(page.getByRole('heading', { name: T(info, title), level: 1 })).toBeVisible();
      await expect(page.getByText(T(info, 'state.forbidden.title'))).toBeVisible();
    }
    await expect(nav(page, info)).toHaveCount(0);
    await audit(page, info, 'ai-admin-forbidden');
  } finally {
    await setRoles(roles.length > 0 ? roles : ['platform_admin']);
    await cleanProviders();
    // the kill switch must never stay engaged for the specs that follow
    await sql(`UPDATE platform.feature_flags SET value = 'false' WHERE key = 'ai.killswitch'`);
  }
});
