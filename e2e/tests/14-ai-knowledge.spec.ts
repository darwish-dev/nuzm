import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
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

/**
 * AI Intelligence Center → Knowledge Library (ADR-065, SCR-K-01, slice S-K1), Arabic (RTL) and English: the flag, the empty library, a real upload through the
 * browser (hashing, verified parts, completion), the resource page, editing with optimistic concurrency, a second version, disable, archive, and the read-only
 * and forbidden roles; axe + a stored screenshot per state.
 *
 * Preconditions: runs after 02-admin (the staff user enrolled MFA there). The database is fresh per run (global setup), so the library starts empty.
 * Fixtures written with SQL: the global flag `knowledge.library` (removed in `finally`); the staff user's platform roles are swapped for `support`
 * (read-only) and `finance` (no `admin:ai_knowledge:read`) and restored in a `finally`. The package is random bytes named `theme.zip`: nothing opens it (S-K1 only
 * quarantines it). Not covered: validation, analysis and activation (slice S-K2 onwards), a multi-part upload through the browser (the engine is covered by unit
 * tests and the API by integration tests with a 9 MiB package).
 */
test('admin AI knowledge library: flag, empty, upload, resource page, edit, new version, disable, archive, read-only and forbidden (ar/en, axe)', async ({
  page,
}, info) => {
  const L = loc(info);
  const staff = `staff-${L}@example.test`;
  await sql(
    `DELETE FROM platform.feature_flags WHERE key = 'knowledge.library' AND org_id IS NULL`,
  );
  await signIn(page, info, staff, ADMIN);
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
  const library = `${ADMIN}/${L}/ai-intelligence/library`;
  const heading = () => page.getByRole('heading', { name: T(info, 'kn.title'), level: 1 });

  try {
    // ================================================================ the flag is off: the page says so and nothing is offered
    await page.goto(library);
    await expect(heading()).toBeVisible();
    await expect(page.getByText(T(info, 'kn.off.title'))).toBeVisible();
    await expect(page.getByRole('button', { name: T(info, 'kn.up.button') })).toHaveCount(0);
    await audit(page, info, 'ai-knowledge-flag-off');

    // ================================================================ flag on: navigation, notice, empty library
    await sql(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'knowledge.library', NULL, 'true'::jsonb)`,
    );
    await page.goto(library);
    await expect(heading()).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: T(info, 'nav.primary') })
        .getByRole('link', { name: T(info, 'kn.cat'), exact: true }),
    ).toBeVisible();
    await expect(page.getByText(T(info, 'kn.notice'))).toBeVisible();
    await expect(page.getByText(T(info, 'kn.empty.title'))).toBeVisible();
    await audit(page, info, 'ai-knowledge-empty');

    // ================================================================ upload a package through the browser
    await page.getByRole('button', { name: T(info, 'kn.up.button') }).click();
    await page
      .getByLabel(T(info, 'kn.up.file'))
      .setInputFiles({
        name: 'tool.exe',
        mimeType: 'application/octet-stream',
        buffer: randomBytes(100),
      });
    await expect(page.getByText(T(info, 'kn.up.err.type'))).toBeVisible(); // an executable is refused before anything is sent
    await page
      .getByLabel(T(info, 'kn.up.file'))
      .setInputFiles({
        name: 'theme.zip',
        mimeType: 'application/zip',
        buffer: randomBytes(300_000),
      });
    await page.getByRole('button', { name: T(info, 'kn.up.start') }).click();
    await expect(page.getByText(T(info, 'kn.up.err.name'))).toBeVisible();
    await page.getByLabel(T(info, 'kn.up.name')).fill('Modern SaaS E2E');
    await page.getByLabel(T(info, 'kn.up.frameworks')).fill('nextjs, tailwind');
    await page.getByLabel(T(info, 'kn.up.tags')).fill('saas, admin');
    await page.getByLabel(T(info, 'kn.up.license')).fill('MIT');
    await audit(page, info, 'ai-knowledge-upload-form');
    await page.getByRole('button', { name: T(info, 'kn.up.start') }).click();
    await expect(page.getByText(T(info, 'kn.up.done'), { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: T(info, 'kn.up.open') })).toBeVisible();
    const row = (
      await sql<{
        status: string;
        visibility: string;
        archive_key: string;
        ai: boolean;
        licence: string;
      }>(
        `SELECT r.status, r.visibility, v.archive_key, p.ai_processing AS ai, v.license_verdict AS licence
         FROM knowledge.resources r JOIN knowledge.resource_versions v ON v.resource_id = r.id JOIN knowledge.resource_permissions p ON p.resource_id = r.id WHERE r.name = 'Modern SaaS E2E'`,
      )
    )[0]!;
    expect(row).toMatchObject({
      status: 'QUARANTINED',
      visibility: 'PLATFORM_PRIVATE',
      ai: false,
      licence: 'UNKNOWN',
    });
    expect(row.archive_key).toMatch(/^archives\/[0-9a-f]{64}$/);
    await audit(page, info, 'ai-knowledge-upload-done');

    // ================================================================ the list shows it; the resource page
    await page.goto(library);
    await expect(page.getByText('Modern SaaS E2E')).toBeVisible();
    await audit(page, info, 'ai-knowledge-list');
    await page
      .getByRole('link', { name: /Modern SaaS E2E|manage|إدارة/i })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: 'Modern SaaS E2E', level: 1 })).toBeVisible();
    await expect(
      page.getByText(T(info, 'kn.status.QUARANTINED'), { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText(T(info, 'kn.d.manifest.none'))).toBeVisible();
    await expect(page.getByText(T(info, 'kn.d.licenseNote'))).toBeVisible();
    await audit(page, info, 'ai-knowledge-resource');

    // ---- edit: only changed fields are sent; a second save with nothing changed says so
    await page.getByLabel(T(info, 'kn.d.category')).fill('dashboard');
    await page.getByRole('button', { name: T(info, 'kn.d.save') }).click();
    await expect(page.getByText(T(info, 'kn.d.saved'))).toBeVisible();
    await page.getByRole('button', { name: T(info, 'kn.d.save') }).click();
    await expect(page.getByText(T(info, 'kn.d.noChange'))).toBeVisible();
    expect(
      (
        await sql<{ category: string }>(
          `SELECT category FROM knowledge.resources WHERE name = 'Modern SaaS E2E'`,
        )
      )[0]!.category,
    ).toBe('dashboard');

    // ---- a second version through the same panel; the first stays
    await page.getByRole('button', { name: T(info, 'kn.up.versionTitle') }).click();
    await page
      .getByLabel(T(info, 'kn.up.file'))
      .setInputFiles({
        name: 'theme-v2.zip',
        mimeType: 'application/zip',
        buffer: randomBytes(120_000),
      });
    await page.getByRole('button', { name: T(info, 'kn.up.start') }).click();
    await expect(page.getByText(T(info, 'kn.up.done'), { exact: false })).toBeVisible();
    await expect
      .poll(
        async () =>
          (
            await sql<{ n: string }>(
              `SELECT count(*)::text AS n FROM knowledge.resource_versions v JOIN knowledge.resources r ON r.id = v.resource_id WHERE r.name = 'Modern SaaS E2E'`,
            )
          )[0]!.n,
      )
      .toBe('2');

    // ---- disable needs a reason
    await page.reload();
    await page.getByRole('button', { name: T(info, 'kn.d.disable') }).click();
    await page.getByRole('button', { name: T(info, 'kn.d.confirm') }).click();
    await expect(page.getByText(T(info, 'kn.d.reasonRequired'))).toBeVisible();
    await page.getByLabel(T(info, 'kn.d.reason')).fill('licence under review');
    await audit(page, info, 'ai-knowledge-disable-confirm');
    await page.getByRole('button', { name: T(info, 'kn.d.confirm') }).click();
    await expect(page.getByText(T(info, 'kn.d.disabled'))).toBeVisible();
    expect(
      (
        await sql<{ status: string }>(
          `SELECT status FROM knowledge.resources WHERE name = 'Modern SaaS E2E'`,
        )
      )[0]!.status,
    ).toBe('DISABLED');

    // ================================================================ read-only staff (support): can read, cannot change
    await setRoles(['support']);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Modern SaaS E2E', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: T(info, 'kn.d.save') })).toHaveCount(0);
    await expect(page.getByRole('button', { name: T(info, 'kn.d.archive') })).toHaveCount(0);
    await page.goto(library);
    await expect(page.getByRole('button', { name: T(info, 'kn.up.button') })).toHaveCount(0);
    await audit(page, info, 'ai-knowledge-readonly');

    // ================================================================ staff without the knowledge permission: forbidden
    await setRoles(['finance']);
    await page.goto(library);
    await expect(page.getByText(T(info, 'kn.forbidden.title'))).toBeVisible();
    await audit(page, info, 'ai-knowledge-forbidden');

    // ================================================================ archive (back to full rights)
    await setRoles(roles);
    await page.goto(library);
    await page
      .getByRole('link', { name: /manage|إدارة/i })
      .first()
      .click();
    await page.getByRole('button', { name: T(info, 'kn.d.archive') }).click();
    await page.getByLabel(T(info, 'kn.d.reason')).fill('e2e cleanup');
    await page.getByRole('button', { name: T(info, 'kn.d.confirm') }).click();
    await expect(heading()).toBeVisible();
    await expect(page.getByText(T(info, 'kn.empty.title'))).toBeVisible();
    expect(
      (
        await sql<{ deleted: boolean }>(
          `SELECT deleted_at IS NOT NULL AS deleted FROM knowledge.resources WHERE name = 'Modern SaaS E2E'`,
        )
      )[0]!.deleted,
    ).toBe(true);
    // the audit trail has the whole story
    const actions = (
      await sql<{ action: string }>(
        `SELECT action FROM audit.audit_logs WHERE action LIKE 'knowledge.%' ORDER BY created_at`,
      )
    ).map((r) => r.action);
    for (const a of [
      'knowledge.upload.opened',
      'knowledge.upload.completed',
      'knowledge.resource.updated',
      'knowledge.resource.disabled',
      'knowledge.resource.archived',
    ])
      expect(actions).toContain(a);
  } finally {
    await setRoles(roles);
    await sql(
      `DELETE FROM platform.feature_flags WHERE key = 'knowledge.library' AND org_id IS NULL`,
    );
  }
});
