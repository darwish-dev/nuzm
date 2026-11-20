import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { ADMIN, DB_URL as DB, STORE_DIR, WEB } from './env';
import { SAMPLES, type Sample } from './fixtures/samples';
import { T, audit, loc, signIn } from './helpers';

const sql = async <R extends Record<string, unknown>>(q: string, args: unknown[] = []) => {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(q, args)).rows as R[];
  } finally {
    await c.end();
  }
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const PART = 8 * 1024 * 1024;
const partsOf = (b: Buffer) =>
  Array.from({ length: Math.ceil(b.length / PART) }, (_, i) =>
    b.subarray(i * PART, (i + 1) * PART),
  );

/** Test tooling: the staff session is marked as MFA-verified (the staff user enrolled MFA in 02-admin), as 10-ai-admin does. */
const elevate = (email: string) =>
  sql(
    `UPDATE identity.sessions SET mfa_level = 'totp', mfa_verified_at = now() WHERE user_id = (SELECT id FROM identity.users WHERE email = $1)`,
    [email],
  );
const flag = (on: boolean) =>
  sql(`DELETE FROM platform.feature_flags WHERE key = 'knowledge.library' AND org_id IS NULL`).then(
    () =>
      on
        ? sql(
            `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'knowledge.library', NULL, 'true'::jsonb)`,
          )
        : undefined,
  );
/** Starts every test from an empty library without deleting evidence: archived rows are soft-deleted, which the guards allow. */
const clearLibrary = () =>
  sql(
    `UPDATE knowledge.resources SET status = 'ARCHIVED', deleted_at = now() WHERE org_id IS NULL AND deleted_at IS NULL`,
  );
const library = (info: TestInfo) => `${ADMIN}/${loc(info)}/ai-intelligence/library`;

async function startStaff(page: Page, info: TestInfo) {
  const staff = `staff-${loc(info)}@example.test`;
  await signIn(page, info, staff, ADMIN);
  await elevate(staff);
  return staff;
}
const openPanel = async (page: Page, info: TestInfo) => {
  await page.goto(library(info));
  await expect(page.getByRole('heading', { name: T(info, 'kn.title'), level: 1 })).toBeVisible();
  await page.getByRole('button', { name: T(info, 'kn.up.button') }).click();
};
async function fillForm(page: Page, info: TestInfo, s: Sample, name: string) {
  // the upload panel shares words with the filter form above it ("Name", "Type"): every field is looked up inside the panel, by its exact label
  const up = page.locator('.knu');
  const label = (k: Parameters<typeof T>[1]) => up.getByLabel(T(info, k), { exact: true });
  await label('kn.up.name').fill(name);
  await label('kn.up.type').selectOption(s.resourceType);
  await label('kn.up.platform').selectOption(s.platform);
  await label('kn.up.category').fill(s.category);
  await label('kn.up.frameworks').fill(s.frameworks.join(', '));
  await label('kn.up.languages').fill(s.languages.join(', '));
  await label('kn.up.tags').fill(s.tags.join(', '));
  await label('kn.up.license').fill(s.license);
}
const choose = (page: Page, info: TestInfo, filename: string, buffer: Buffer) =>
  page
    .getByLabel(T(info, 'kn.up.file'))
    .setInputFiles({ name: filename, mimeType: 'application/zip', buffer });
/** A file selected from DISK: its name, size and modified time stay the same however often it is chosen, which is what makes "choose the same file again" resumable. */
const chooseFile = (page: Page, info: TestInfo, path: string) =>
  page.locator('.knu').getByLabel(T(info, 'kn.up.file'), { exact: true }).setInputFiles(path);
const done = (page: Page, info: TestInfo) =>
  expect(page.getByText(T(info, 'kn.up.done'), { exact: false })).toBeVisible({ timeout: 60_000 });
const archiveSha = (key: string) => sha(readFileSync(join(STORE_DIR, key)));

/**
 * AI Intelligence Center → Knowledge Library (ADR-065, SCR-K-01, slice S-K1), Arabic (RTL) and English, against the REAL API and database (throwaway DB, own ports):
 *  1. the UI flow: flag, empty, upload, resource page, edit, new version, disable, archive, read-only and forbidden staff;
 *  2. the real upload of three safe sample projects (Next.js, Flutter, full-stack): metadata, SHA-256, stored object, quarantine, filters;
 *  3. the upload engine on a 17 MB package: progress, retry, resume after an interruption and a reload, cancel;
 *  4. permissions at the API (support read-only, finance forbidden, a customer session refused) and tenant isolation of the tables.
 * No package is ever activated or opened: S-K1 only quarantines it (validation arrives with S-K2).
 *
 * Preconditions: runs after 02-admin (the staff user enrolled MFA there). Each test starts from an empty library (rows are archived, never deleted) and removes the
 * global flag `knowledge.library` in `finally`; the staff user's platform roles are restored in a `finally`.
 */
test('1. library UI: flag, empty, upload, resource page, edit, new version, disable, archive, read-only and forbidden (ar/en, axe)', async ({
  page,
}, info) => {
  const L = loc(info);
  const staff = await startStaff(page, info);
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
  const heading = () => page.getByRole('heading', { name: T(info, 'kn.title'), level: 1 });
  const next = SAMPLES[0]!;
  const name = `Modern SaaS UI ${L}`;
  await clearLibrary();
  try {
    await flag(false);
    await page.goto(library(info));
    await expect(heading()).toBeVisible();
    await expect(page.getByText(T(info, 'kn.off.title'))).toBeVisible();
    await expect(page.getByRole('button', { name: T(info, 'kn.up.button') })).toHaveCount(0);
    await audit(page, info, 'ai-knowledge-flag-off');

    await flag(true);
    await page.goto(library(info));
    await expect(heading()).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: T(info, 'nc.nav.rail') })
        .getByRole('link', { name: T(info, 'kn.cat'), exact: true }),
    ).toBeVisible();
    await expect(page.getByText(T(info, 'kn.notice'))).toBeVisible();
    await expect(page.getByText(T(info, 'kn.empty.title'))).toBeVisible();
    await audit(page, info, 'ai-knowledge-empty');

    // ---- upload through the browser; an executable is refused before anything is sent
    await page.getByRole('button', { name: T(info, 'kn.up.button') }).click();
    await page
      .locator('.knu')
      .getByLabel(T(info, 'kn.up.file'), { exact: true })
      .setInputFiles({
        name: 'tool.exe',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from('MZ'),
      });
    await expect(page.getByText(T(info, 'kn.up.err.type'))).toBeVisible();
    const zipBytes = next.build();
    await choose(page, info, next.filename, zipBytes);
    await page.getByRole('button', { name: T(info, 'kn.up.start') }).click();
    await expect(page.getByText(T(info, 'kn.up.err.name'))).toBeVisible();
    await fillForm(page, info, next, name);
    await audit(page, info, 'ai-knowledge-upload-form');
    await page.getByRole('button', { name: T(info, 'kn.up.start') }).click();
    await done(page, info);
    await expect(page.getByRole('link', { name: T(info, 'kn.up.open') })).toBeVisible();
    await audit(page, info, 'ai-knowledge-upload-done');

    // ---- the list and the resource page
    await page.goto(library(info));
    await expect(page.getByText(name)).toBeVisible();
    await audit(page, info, 'ai-knowledge-list');
    await page
      .getByRole('link', { name: /manage|إدارة/i })
      .first()
      .click();
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    await expect(page.getByText(T(info, 'kn.d.manifest.none'))).toBeVisible();
    await expect(page.getByText(T(info, 'kn.d.licenseNote'))).toBeVisible();
    await audit(page, info, 'ai-knowledge-resource');

    // ---- edit: only changed fields are sent; saving again with nothing changed says so
    await page.getByLabel(T(info, 'kn.d.category')).fill('crm');
    await page.getByRole('button', { name: T(info, 'kn.d.save') }).click();
    await expect(page.getByText(T(info, 'kn.d.saved'))).toBeVisible();
    await page.getByRole('button', { name: T(info, 'kn.d.save') }).click();
    await expect(page.getByText(T(info, 'kn.d.noChange'))).toBeVisible();
    expect(
      (
        await sql<{ category: string }>(
          `SELECT category FROM knowledge.resources WHERE name = $1`,
          [name],
        )
      )[0]!.category,
    ).toBe('crm');

    // ---- a second version through the same panel; the first stays
    await page.getByRole('button', { name: T(info, 'kn.up.versionTitle') }).click();
    await choose(page, info, 'modern-saas-v2.zip', next.build({ padBytes: 40_000 }));
    await page.getByRole('button', { name: T(info, 'kn.up.start') }).click();
    await done(page, info);
    await expect
      .poll(
        async () =>
          (
            await sql<{ n: string }>(
              `SELECT count(*)::text AS n FROM knowledge.resource_versions v JOIN knowledge.resources r ON r.id = v.resource_id WHERE r.name = $1`,
              [name],
            )
          )[0]!.n,
      )
      .toBe('2');
    await page.reload();
    await expect(page.getByRole('region', { name: T(info, 'kn.d.versions') })).toHaveCount(1); // the table is the one landmark
    await expect(page.getByRole('region', { name: T(info, 'kn.d.versions') })).toBeVisible();
    await audit(page, info, 'ai-knowledge-versions');

    // ---- disable needs a reason
    await page.getByRole('button', { name: T(info, 'kn.d.disable') }).click();
    await page.getByRole('button', { name: T(info, 'kn.d.confirm') }).click();
    await expect(page.getByText(T(info, 'kn.d.reasonRequired'))).toBeVisible();
    await page.getByLabel(T(info, 'kn.d.reason')).fill('licence under review');
    await audit(page, info, 'ai-knowledge-disable-confirm');
    await page.getByRole('button', { name: T(info, 'kn.d.confirm') }).click();
    await expect(page.getByText(T(info, 'kn.d.disabled'))).toBeVisible();
    expect(
      (
        await sql<{ status: string }>(`SELECT status FROM knowledge.resources WHERE name = $1`, [
          name,
        ])
      )[0]!.status,
    ).toBe('DISABLED');

    // ---- read-only staff (support) read but cannot change; staff without the permission see the forbidden state
    await setRoles(['support']);
    await page.reload();
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: T(info, 'kn.d.save') })).toHaveCount(0);
    await expect(page.getByRole('button', { name: T(info, 'kn.d.archive') })).toHaveCount(0);
    await page.goto(library(info));
    await expect(page.getByRole('button', { name: T(info, 'kn.up.button') })).toHaveCount(0);
    await audit(page, info, 'ai-knowledge-readonly');
    await setRoles(['finance']);
    await page.goto(library(info));
    await expect(page.getByText(T(info, 'kn.forbidden.title'))).toBeVisible();
    await audit(page, info, 'ai-knowledge-forbidden');

    // ---- archive: gone from the list, kept in the database
    await setRoles(roles);
    await page.goto(library(info));
    await page
      .getByRole('link', { name: /manage|إدارة/i })
      .first()
      .click();
    await page.getByRole('button', { name: T(info, 'kn.d.archive') }).click();
    await page.getByLabel(T(info, 'kn.d.reason')).fill('e2e cleanup');
    await page.getByRole('button', { name: T(info, 'kn.d.confirm') }).click();
    await expect(heading()).toBeVisible();
    await expect(page.getByText(T(info, 'kn.empty.title'))).toBeVisible();
    const kept = (
      await sql<{ n: string; soft: boolean }>(
        `SELECT count(v.id)::text AS n, bool_and(r.deleted_at IS NOT NULL) AS soft FROM knowledge.resources r JOIN knowledge.resource_versions v ON v.resource_id = r.id WHERE r.name = $1`,
        [name],
      )
    )[0]!;
    expect(kept).toMatchObject({ n: '2', soft: true });
    const actions = (
      await sql<{ action: string }>(
        `SELECT action FROM audit.audit_logs WHERE action LIKE 'knowledge.%'`,
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
    await flag(false);
  }
});

test('2. real upload of safe Next.js, Flutter and full-stack sample projects: metadata, SHA-256, stored object, quarantine, filters', async ({
  page,
}, info) => {
  const L = loc(info);
  await startStaff(page, info);
  await clearLibrary();
  await flag(true);
  try {
    for (const s of SAMPLES) {
      const bytes = s.build();
      const name = `${s.name} ${L}`;
      await openPanel(page, info);
      await choose(page, info, s.filename, bytes);
      await fillForm(page, info, s, name);
      const puts: string[] = [];
      page.on('request', (r) => {
        if (r.method() === 'PUT' && r.url().includes('/parts/'))
          puts.push(r.headers()['x-part-sha256']!);
      });
      await page.getByRole('button', { name: T(info, 'kn.up.start') }).click();
      await done(page, info);
      page.removeAllListeners('request');
      // SHA-256: the part checksum sent equals the real one; the stored object and the database record equal the file
      expect(puts).toEqual(partsOf(bytes).map(sha));
      const r = (
        await sql<Record<string, unknown>>(
          `SELECT r.resource_type, r.platform, r.frameworks, r.languages, r.category, r.tags, r.visibility, r.source_kind, r.status, r.data_region, r.default_eligible,
                v.seq, v.state, v.checksum_sha256, v.bytes::text AS bytes, v.archive_key, v.license_verdict, v.provenance,
                p.license_spdx, p.ai_processing, p.reuse_scope, p.starter_eligible
           FROM knowledge.resources r JOIN knowledge.resource_versions v ON v.resource_id = r.id JOIN knowledge.resource_permissions p ON p.resource_id = r.id WHERE r.name = $1`,
          [name],
        )
      )[0]!;
      expect(r).toMatchObject({
        resource_type: s.resourceType,
        platform: s.platform,
        frameworks: s.frameworks,
        languages: s.languages,
        category: s.category,
        tags: s.tags,
        visibility: 'PLATFORM_PRIVATE',
        source_kind: 'upload',
        status: 'QUARANTINED',
        data_region: 'sa-central',
        default_eligible: false,
        seq: 1,
        state: 'QUARANTINED',
        checksum_sha256: sha(bytes),
        bytes: String(bytes.length),
        license_verdict: 'UNKNOWN',
        license_spdx: 'MIT',
        ai_processing: false,
        reuse_scope: 'NONE',
        starter_eligible: false,
      });
      expect(r.archive_key).toBe(`archives/${sha(bytes)}`);
      expect(archiveSha(String(r.archive_key))).toBe(sha(bytes)); // the object in the store is the file, byte for byte
      expect(r.provenance).toMatchObject({ sourceKind: 'upload', filename: s.filename });
    }
    // nothing was activated, opened or exposed: no ACTIVE row, nothing in the customer view
    expect(
      (
        await sql<{ n: string }>(
          `SELECT count(*)::text AS n FROM knowledge.resource_versions WHERE state = 'ACTIVE'`,
        )
      )[0]!.n,
    ).toBe('0');
    expect(
      (
        await sql<{ n: string }>(`SELECT count(*)::text AS n FROM knowledge.v_published_templates`)
      )[0]!.n,
    ).toBe('0');
    expect(
      (await sql<{ n: string }>(`SELECT count(*)::text AS n FROM knowledge.resource_files`))[0]!.n,
    ).toBe('0'); // nothing was unpacked

    // ---- the list: three quarantined resources, and the filters find the right one
    await page.goto(library(info));
    for (const s of SAMPLES) await expect(page.getByText(`${s.name} ${L}`)).toBeVisible();
    await expect(
      page.locator('.nz-badge', { hasText: T(info, 'kn.status.QUARANTINED') }),
    ).toHaveCount(3);
    await audit(page, info, 'ai-knowledge-three-samples');
    const filtered = async (qs: string, expected: string[]) => {
      await page.goto(`${library(info)}?${qs}`);
      for (const s of SAMPLES) {
        const want = expected.includes(s.key);
        await expect(page.getByText(`${s.name} ${L}`)).toHaveCount(want ? 1 : 0);
      }
    };
    await filtered('framework=flutter', ['flutter']);
    await filtered('platform=MOBILE', ['flutter']);
    await filtered('type=PROJECT', ['fullstack']);
    await filtered('framework=nextjs', ['nextjs', 'fullstack']);
    await filtered('q=property', ['fullstack']);
    await filtered('status=ACTIVE', []);
    await expect(page.getByText(T(info, 'kn.empty.filtered.title'))).toBeVisible();
    await audit(page, info, 'ai-knowledge-filtered-empty');
  } finally {
    await flag(false);
  }
});

test('3. upload engine on a 17 MB package: progress, retry, resume after an interruption and a reload, cancel', async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  const L = loc(info);
  await startStaff(page, info);
  await clearLibrary();
  await flag(true);
  const s = SAMPLES[0]!;
  const big = s.build({ padBytes: 17 * 1024 * 1024 });
  const bigPath = join(tmpdir(), `nuzm-e2e-knowledge-big-${L}.zip`);
  writeFileSync(bigPath, big);
  const parts = partsOf(big);
  expect(parts.length).toBe(3);
  const partUrl = '**/v1/admin/knowledge/uploads/*/parts/*';
  const partNo = (url: string) => Number(url.split('/').pop());
  try {
    // ================================================================ progress (part 2 is held for a few seconds so the states can be seen)
    {
      const seenHeaders: Record<number, string> = {};
      await page.route(partUrl, async (route) => {
        const n = partNo(route.request().url());
        seenHeaders[n] = route.request().headers()['x-part-sha256']!;
        if (n === 2) await new Promise((r) => setTimeout(r, 3500));
        await route.continue();
      });
      await openPanel(page, info);
      await chooseFile(page, info, bigPath);
      await fillForm(page, info, s, `Big Progress ${L}`);
      await page.getByRole('button', { name: T(info, 'kn.up.start') }).click();
      const meter = page.locator('meter.nz-meter');
      await expect(meter).toBeVisible();
      await expect(page.getByText(T(info, 'kn.up.sending', { done: 2, total: 3 }))).toBeVisible({
        timeout: 30_000,
      });
      expect(Number(await meter.getAttribute('value'))).toBeGreaterThan(0);
      expect(Number(await meter.getAttribute('value'))).toBeLessThan(100);
      await audit(page, info, 'ai-knowledge-upload-progress');
      await done(page, info);
      await page.unroute(partUrl);
      expect(Object.values(seenHeaders)).toEqual(parts.map(sha)); // every part carried its own SHA-256
      const row = (
        await sql<{ sha: string; key: string }>(
          `SELECT v.checksum_sha256 AS sha, v.archive_key AS key FROM knowledge.resources r JOIN knowledge.resource_versions v ON v.resource_id = r.id WHERE r.name = $1`,
          [`Big Progress ${L}`],
        )
      )[0]!;
      expect(row.sha).toBe(sha(big));
      expect(archiveSha(row.key)).toBe(sha(big));
      expect(
        existsSync(
          join(
            STORE_DIR,
            'uploads',
            (
              await sql<{ id: string }>(
                `SELECT id FROM knowledge.uploads WHERE state = 'COMPLETED' ORDER BY created_at DESC LIMIT 1`,
              )
            )[0]!.id,
          ),
        ),
      ).toBe(false); // parts are discarded after assembly
    }

    // ================================================================ retry: part 1 dies once (connection reset), part 2 answers 503 once; both are retried and the upload succeeds
    {
      const attempts: Record<number, number> = {};
      await page.route(partUrl, async (route) => {
        const n = partNo(route.request().url());
        attempts[n] = (attempts[n] ?? 0) + 1;
        if (n === 1 && attempts[n] === 1) return route.abort('connectionreset');
        if (n === 2 && attempts[n] === 1) return route.fulfill({ status: 503, body: '' });
        return route.continue();
      });
      await openPanel(page, info);
      await chooseFile(page, info, bigPath);
      await fillForm(page, info, s, `Big Retry ${L}`);
      await page.getByRole('button', { name: T(info, 'kn.up.start') }).click();
      await done(page, info);
      await page.unroute(partUrl);
      expect(attempts).toEqual({ 1: 2, 2: 2, 3: 1 });
      expect(
        (
          await sql<{ sha: string }>(
            `SELECT v.checksum_sha256 AS sha FROM knowledge.resources r JOIN knowledge.resource_versions v ON v.resource_id = r.id WHERE r.name = $1`,
            [`Big Retry ${L}`],
          )
        )[0]!.sha,
      ).toBe(sha(big));
    }

    // ================================================================ resume: part 2 never gets through; the error says how to resume; after a RELOAD the same file continues from part 2
    {
      await page.route(partUrl, (route) =>
        partNo(route.request().url()) === 2 ? route.abort('connectionreset') : route.continue(),
      );
      await openPanel(page, info);
      await chooseFile(page, info, bigPath);
      await fillForm(page, info, s, `Big Resume ${L}`);
      await page.getByRole('button', { name: T(info, 'kn.up.start') }).click();
      await expect(page.getByText(T(info, 'kn.up.err.network'))).toBeVisible({ timeout: 60_000 });
      await audit(page, info, 'ai-knowledge-upload-interrupted');
      const open = (
        await sql<{ id: string; n: string }>(
          `SELECT id, jsonb_array_length(parts)::text AS n FROM knowledge.uploads WHERE state = 'OPEN' ORDER BY created_at DESC LIMIT 1`,
        )
      )[0]!;
      expect(open.n).toBe('1'); // part 1 is safe on the server
      expect(await page.evaluate(() => localStorage.getItem('nuzm.knowledge.upload'))).toContain(
        open.id,
      );
      await page.unroute(partUrl);
      await page.reload(); // a new page, a new engine: only the browser's memory of the session survives
      // the remaining parts take a moment (as on a real network) so the "resuming" notice can be seen
      await page.route(partUrl, async (route) => {
        await new Promise((r) => setTimeout(r, 3000));
        await route.continue();
      });
      const sent: number[] = [];
      page.on('request', (r) => {
        if (r.method() === 'PUT' && r.url().includes('/parts/')) sent.push(partNo(r.url()));
        if (r.method() === 'POST' && r.url().endsWith('/uploads')) sent.push(-1); // would be a NEW session: must not happen
      });
      await page.getByRole('button', { name: T(info, 'kn.up.button') }).click();
      await chooseFile(page, info, bigPath);
      await fillForm(page, info, s, `Big Resume ${L}`);
      await page.getByRole('button', { name: T(info, 'kn.up.start') }).click();
      await expect(page.getByText(T(info, 'kn.up.resumed', { done: 1, total: 3 }))).toBeVisible({
        timeout: 30_000,
      });
      await audit(page, info, 'ai-knowledge-upload-resumed');
      await done(page, info);
      page.removeAllListeners('request');
      await page.unroute(partUrl);
      expect(sent).toEqual([2, 3]); // part 1 was not sent again, and no new session was opened
      const r = (
        await sql<{ sha: string; session: string }>(
          `SELECT v.checksum_sha256 AS sha, (v.provenance->>'uploadId') AS session FROM knowledge.resources r JOIN knowledge.resource_versions v ON v.resource_id = r.id WHERE r.name = $1`,
          [`Big Resume ${L}`],
        )
      )[0]!;
      expect(r.sha).toBe(sha(big));
      expect(r.session).toBe(open.id); // the same session finished the job
      expect(await page.evaluate(() => localStorage.getItem('nuzm.knowledge.upload'))).toBeNull();
    }

    // ================================================================ cancel: a part is in flight; Cancel aborts it and the server discards the session and its parts
    {
      await page.route(partUrl, async (route) => {
        if (partNo(route.request().url()) === 2) await new Promise((r) => setTimeout(r, 20_000)); // part 2 hangs
        await route.continue().catch(() => undefined);
      });
      await openPanel(page, info);
      await chooseFile(page, info, bigPath);
      await fillForm(page, info, s, `Big Cancel ${L}`);
      await page.getByRole('button', { name: T(info, 'kn.up.start') }).click();
      await expect(page.getByText(T(info, 'kn.up.sending', { done: 2, total: 3 }))).toBeVisible({
        timeout: 30_000,
      });
      const del = page.waitForRequest(
        (r) => r.method() === 'DELETE' && r.url().includes('/v1/admin/knowledge/uploads/'),
      );
      await page.getByRole('button', { name: T(info, 'kn.up.cancel') }).click();
      const id = (await del).url().split('/').pop()!;
      await expect(page.getByText(T(info, 'kn.up.cancelled'))).toBeVisible();
      await audit(page, info, 'ai-knowledge-upload-cancelled');
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await expect
        .poll(
          async () =>
            (
              await sql<{ state: string }>(`SELECT state FROM knowledge.uploads WHERE id = $1`, [
                id,
              ])
            )[0]!.state,
        )
        .toBe('CANCELLED');
      expect(existsSync(join(STORE_DIR, 'uploads', id))).toBe(false); // the parts are gone from the store
      expect(
        (
          await sql<{ n: string }>(
            `SELECT count(*)::text AS n FROM knowledge.resources WHERE name = $1`,
            [`Big Cancel ${L}`],
          )
        )[0]!.n,
      ).toBe('0');
      expect(await page.evaluate(() => localStorage.getItem('nuzm.knowledge.upload'))).toBeNull();
    }
    // the large package is stored once however many resources used it (content addressed)
    expect(existsSync(join(STORE_DIR, 'archives', sha(big)))).toBe(true);
    expect(
      (
        await sql<{ n: string }>(
          `SELECT count(DISTINCT archive_key)::text AS n FROM knowledge.resource_versions WHERE checksum_sha256 = $1`,
          [sha(big)],
        )
      )[0]!.n,
    ).toBe('1');
    expect(
      (
        await sql<{ n: string }>(
          `SELECT count(*)::text AS n FROM knowledge.resource_versions WHERE state = 'ACTIVE'`,
        )
      )[0]!.n,
    ).toBe('0');
  } finally {
    rmSync(bigPath, { force: true });
    await flag(false);
  }
});

test('4. permissions at the API and tenant isolation of the library tables', async ({
  page,
  browser,
}, info) => {
  const L = loc(info);
  const staff = await startStaff(page, info);
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
  await clearLibrary();
  await flag(true);
  const s = SAMPLES[2]!;
  const name = `${s.name} Perm ${L}`;
  try {
    await openPanel(page, info);
    await choose(page, info, s.filename, s.build());
    await fillForm(page, info, s, name);
    await page.getByRole('button', { name: T(info, 'kn.up.start') }).click();
    await done(page, info);
    const id = (
      await sql<{ id: string }>(`SELECT id FROM knowledge.resources WHERE name = $1`, [name])
    )[0]!.id;
    const R = `${ADMIN}/v1/admin/knowledge`;
    const csrf = async () =>
      (await page.context().cookies(ADMIN)).find((c) => c.name === 'nuzm_admin_csrf')?.value ?? '';
    const call = async (
      method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
      url: string,
      data?: object,
    ) =>
      (
        await page.request.fetch(url, {
          method,
          data,
          headers: {
            'x-csrf-token': await csrf(),
            'idempotency-key': crypto.randomUUID(),
            'if-match': '"1"',
          },
        })
      ).status();

    // support: read only
    await setRoles(['support']);
    expect(await call('GET', `${R}/resources`)).toBe(200);
    expect(await call('GET', `${R}/resources/${id}`)).toBe(200);
    expect(await call('GET', `${R}/resources/${id}/versions`)).toBe(200);
    expect(
      await call('POST', `${R}/uploads`, {
        name: 'x',
        resourceType: 'THEME',
        declaredBytes: 10,
        sha256: 'a'.repeat(64),
        filename: 'x.zip',
      }),
    ).toBe(403);
    expect(await call('PATCH', `${R}/resources/${id}`, { category: 'x' })).toBe(403);
    expect(await call('POST', `${R}/resources/${id}/deactivation`, { reason: 'x' })).toBe(403);
    expect(await call('POST', `${R}/resources/${id}/archival`, { reason: 'x' })).toBe(403);
    expect(await call('DELETE', `${R}/uploads/${id}`)).toBe(403);
    // finance: no knowledge permission at all
    await setRoles(['finance']);
    expect(await call('GET', `${R}/resources`)).toBe(403);
    expect(await call('GET', `${R}/resources/${id}`)).toBe(403);
    await setRoles(roles);
    expect(await call('GET', `${R}/resources/${id}`)).toBe(200);
    // the resource was not changed by any refused call
    const after = (
      await sql<{ category: string; status: string }>(
        `SELECT category, status FROM knowledge.resources WHERE id = $1`,
        [id],
      )
    )[0]!;
    expect(after).toMatchObject({ category: s.category, status: 'QUARANTINED' });

    // a signed-out caller and a CUSTOMER session cannot reach the admin routes (web and admin origins)
    expect(
      await (await browser.newContext()).request.get(`${R}/resources`).then((r) => r.status()),
    ).toBe(401);
    const cust = await (await browser.newContext()).newPage();
    await signIn(cust, info, `billing-${L}@example.test`, WEB);
    for (const origin of [WEB, ADMIN]) {
      const r = await cust.request.get(`${origin}/v1/admin/knowledge/resources`);
      expect([401, 403, 404], `${origin} → ${r.status()}`).toContain(r.status());
      const w = await cust.request.post(`${origin}/v1/admin/knowledge/uploads`, { data: {} });
      expect([401, 403, 404, 400], `${origin} POST → ${w.status()}`).toContain(w.status());
    }
    await cust.context().close();

    // tenant isolation on the live tables: a customer organization (any org id) sees nothing of the platform library, staff scope sees it
    const asRole = async (gucs: Record<string, string>) => {
      const c = new Client({ connectionString: DB });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE nuzm_app');
        for (const [k, v] of Object.entries(gucs))
          await c.query('SELECT set_config($1, $2, true)', [k, v]);
        const out: Record<string, number> = {};
        for (const t of [
          'resources',
          'resource_versions',
          'resource_files',
          'resource_permissions',
          'resource_manifests',
          'uploads',
          'processing_jobs',
        ])
          out[t] = (await c.query(`SELECT 1 FROM knowledge.${t}`)).rowCount ?? 0;
        out.view = (await c.query('SELECT 1 FROM knowledge.v_published_templates')).rowCount ?? 0;
        await c.query('ROLLBACK');
        return out;
      } finally {
        await c.end();
      }
    };
    for (const org of [
      '00000000-0000-7000-8000-00000000a001',
      '00000000-0000-7000-8000-00000000a002',
    ]) {
      expect(await asRole({ 'app.org_id': org })).toEqual({
        resources: 0,
        resource_versions: 0,
        resource_files: 0,
        resource_permissions: 0,
        resource_manifests: 0,
        uploads: 0,
        processing_jobs: 0,
        view: 0,
      });
    }
    expect(await asRole({})).toMatchObject({ resources: 0, view: 0 });
    const staffView = await asRole({ 'app.platform_scope': 'admin' });
    expect(staffView.resources).toBeGreaterThan(0);
    expect(staffView.resource_versions).toBeGreaterThan(0);
    expect(staffView.view).toBe(0); // quarantined: not even staff scope puts it in the customer view
    await audit(page, info, 'ai-knowledge-permissions-done');
  } finally {
    await setRoles(roles);
    await flag(false);
  }
});
