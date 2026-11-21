import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { Client } from 'pg';
import { ADMIN, DB_URL as DB, PG_PORT, E2E_DB, STORE_DIR } from './env';
import { zip } from './fixtures/zip';
import { SAMPLES, type Sample } from './fixtures/samples';
import { T, audit, loc, signIn } from './helpers';

/**
 * AI Intelligence Center, slice S-K2a (SCR-K-02): secure project ingestion END TO END across processes, in Arabic (RTL) and English, with real browsers:
 * admin console -> API -> object store -> the REAL worker process (`apps/worker`, role nuzm_worker, scope `knowledge`) -> database -> admin console.
 *  1. a clean sample project is validated, extracted and scanned, reaches review, and is activated by two OTHER people (the uploader cannot approve a third-party upload);
 *  2. hostile and unsafe packages (path traversal, a package with a secret) are rejected / quarantined with a plain reason, and leave nothing in the object store;
 *  3. what the worker wrote contains no secret and no file content: logs, findings, job rows and the stored snapshots are checked byte for byte.
 * The worker is started by this file (not by the shared stack) so that 14-ai-knowledge keeps proving the S-K1 behaviour (a completed upload stays quarantined while no
 * worker runs). Nothing from any package is executed: the test additionally plants a marker command in a lifecycle script and proves it never ran.
 */
const sql = async <R extends Record<string, unknown>>(q: string, args: unknown[] = []) => {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(q, args)).rows as R[];
  } finally {
    await c.end();
  }
};
const flag = (on: boolean) =>
  sql(`DELETE FROM platform.feature_flags WHERE key = 'knowledge.library' AND org_id IS NULL`).then(
    () =>
      on
        ? sql(
            `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'knowledge.library', NULL, 'true'::jsonb)`,
          )
        : undefined,
  );
const clearLibrary = () =>
  sql(
    `UPDATE knowledge.resources SET status = 'ARCHIVED', deleted_at = now() WHERE org_id IS NULL AND deleted_at IS NULL`,
  );
/** Test tooling: marks the person's session as MFA-verified, as 14-ai-knowledge does for the staff user. */
const elevate = (email: string) =>
  sql(
    `UPDATE identity.sessions SET mfa_level = 'totp', mfa_verified_at = now() WHERE user_id = (SELECT id FROM identity.users WHERE email = $1)`,
    [email],
  );

// ---- the worker process ------------------------------------------------------------------------------------------------------------
let worker: ChildProcess | null = null;
let workerLog = '';
async function startWorker() {
  // dev-only logins of the runtime roles (the same thing `pnpm db:dev-logins` does); the cluster is the project-local throwaway one
  await sql(`ALTER ROLE nuzm_worker LOGIN PASSWORD 'nuzm_dev_only'`);
  workerLog = '';
  worker = spawn('pnpm', ['--filter', '@nuzm/worker', 'run', 'dev'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WORKER_DATABASE_URL: `postgres://nuzm_worker:nuzm_dev_only@127.0.0.1:${PG_PORT}/${E2E_DB}`,
      KNOWLEDGE_INGEST_ENABLED: 'true',
      KNOWLEDGE_DETECT_ENABLED: 'true',
      KNOWLEDGE_COMPONENTS_ENABLED: 'true',
      KNOWLEDGE_DESIGN_ENABLED: 'true',
      KNOWLEDGE_STORE_DRIVER: 'fs',
      KNOWLEDGE_STORE_DIR: STORE_DIR,
      OTEL_SDK_DISABLED: 'true',
    },
  });
  worker.stdout!.on('data', (d: Buffer) => (workerLog += d.toString()));
  worker.stderr!.on('data', (d: Buffer) => (workerLog += d.toString()));
  await expect
    .poll(() => workerLog, { timeout: 90_000, message: 'the worker did not start' })
    .toContain('knowledge_ingest_enabled');
}
function stopWorker() {
  if (worker?.pid) {
    try {
      process.kill(-worker.pid, 'SIGTERM'); // the process group this test started, nothing else
    } catch {
      /* already gone */
    }
  }
  worker = null;
}

// ---- helpers shared with the upload UI (same selectors as 14-ai-knowledge) -----------------------------------------------------------
const library = (info: TestInfo) => `${ADMIN}/${loc(info)}/ai-intelligence/library`;
async function person(
  browser: Browser,
  info: TestInfo,
  who: 'staff' | 'approver1' | 'approver2',
): Promise<{ page: Page; ctx: BrowserContext; email: string }> {
  const email = `${who}-${loc(info)}@example.test`;
  const ctx = await browser.newContext({
    locale: info.project.use.locale,
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  await signIn(page, info, email, ADMIN);
  await expect(page.locator('body')).toBeVisible();
  await elevate(email);
  return { page, ctx, email };
}
async function upload(
  page: Page,
  info: TestInfo,
  filename: string,
  buffer: Buffer,
  s: Sample,
  name: string,
) {
  await page.goto(library(info));
  await expect(page.getByRole('heading', { name: T(info, 'kn.title'), level: 1 })).toBeVisible();
  await page.getByRole('button', { name: T(info, 'kn.up.button') }).click();
  const up = page.locator('.knu');
  const label = (k: Parameters<typeof T>[1]) => up.getByLabel(T(info, k), { exact: true });
  await up
    .getByLabel(T(info, 'kn.up.file'), { exact: true })
    .setInputFiles({ name: filename, mimeType: 'application/zip', buffer });
  await label('kn.up.name').fill(name);
  await label('kn.up.type').selectOption(s.resourceType);
  await label('kn.up.platform').selectOption(s.platform);
  await label('kn.up.category').fill(s.category);
  await label('kn.up.frameworks').fill(s.frameworks.join(', '));
  await label('kn.up.languages').fill(s.languages.join(', '));
  await label('kn.up.tags').fill(s.tags.join(', '));
  await label('kn.up.license').fill(s.license);
  await page.getByRole('button', { name: T(info, 'kn.up.start') }).click();
  await expect(page.getByText(T(info, 'kn.up.done'), { exact: false })).toBeVisible({
    timeout: 60_000,
  });
  const r = (
    await sql<{ id: string; vid: string }>(
      `SELECT r.id, v.id AS vid FROM knowledge.resources r JOIN knowledge.resource_versions v ON v.resource_id = r.id WHERE r.name = $1 AND r.deleted_at IS NULL`,
      [name],
    )
  )[0]!;
  return { id: r.id, vid: r.vid };
}
const stateOf = async (vid: string) =>
  (
    await sql<{ state: string; state_reason: string | null }>(
      `SELECT state, state_reason FROM knowledge.resource_versions WHERE id = $1`,
      [vid],
    )
  )[0]!;
const settled = (vid: string, want: string[]) =>
  expect
    .poll(async () => (await stateOf(vid)).state, {
      timeout: 90_000,
      intervals: [500, 1000],
      message: `the version never reached ${want.join(' or ')}`,
    })
    .toMatch(new RegExp(`^(${want.join('|')})$`));
const resourcePage = (info: TestInfo, id: string) =>
  `${ADMIN}/${loc(info)}/ai-intelligence/library/${id}`;
const snapshots = () => {
  const dir = join(STORE_DIR, 'snapshots');
  return existsSync(dir)
    ? readdirSync(dir, { recursive: true })
        .map(String)
        .filter((f) => statSync(join(dir, f)).isFile())
    : [];
};
const storeContains = (needle: string) =>
  (readdirSync(STORE_DIR, { recursive: true }).map(String) as string[]).filter(
    (f) =>
      f.startsWith('snapshots/') &&
      statSync(join(STORE_DIR, f)).isFile() &&
      readFileSync(join(STORE_DIR, f)).includes(Buffer.from(needle)),
  );

const nextjs = SAMPLES.find((s) => s.key === 'nextjs')!;
const MARKER = '/tmp/nuzm-e2e-k2a-must-not-exist';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  await flag(true);
  await clearLibrary();
  await startWorker();
});
test.afterAll(async () => {
  stopWorker();
  await flag(false);
});

test('1. a clean Next.js sample is validated, extracted and scanned, then activated by two OTHER people (ar/en, axe)', async ({
  browser,
}, info) => {
  const L = loc(info);
  const name = `${nextjs.name} ${L} ingest`;
  const staff = await person(browser, info, 'staff');
  // a lifecycle script that, if anything ever ran it, would leave a marker file behind
  const bytes = zip([
    ...nextjs.entries(),
    {
      path: 'modern-saas/scripts/postinstall.js',
      data: `require('fs').writeFileSync('${MARKER}', 'ran');\n`,
    },
  ]);
  const { id, vid } = await upload(staff.page, info, nextjs.filename, bytes, nextjs, name);
  await settled(vid, ['AWAITING_REVIEW']);
  expect(existsSync(MARKER)).toBe(false);

  // ---- the uploader's view: facts, evidence, and no way to review their own third-party upload
  await staff.page.goto(resourcePage(info, id));
  const kni = staff.page.locator('.kni');
  await expect(kni.getByText(T(info, 'ki.approvals.count', { n: 0, need: 2 }))).toBeVisible();
  await expect(kni.getByText(T(info, 'ki.prov.THIRD_PARTY'))).toBeVisible();
  await expect(kni.getByText('MIT', { exact: true })).toBeVisible();
  await expect(kni.getByText(T(info, 'ki.blocker.approvals_missing'))).toBeVisible();
  await expect(kni.getByText(T(info, 'ki.you.uploader'))).toBeVisible();
  await expect(kni.getByRole('button', { name: T(info, 'ki.approve') })).toHaveCount(0);
  // jobs: both stages succeeded; the log of the extraction says what happened and nothing about content
  await expect(kni.getByText(T(info, 'ki.kind.VALIDATE'))).toBeVisible();
  await expect(kni.getByText(T(info, 'ki.kind.EXTRACT'))).toBeVisible();
  await expect(kni.getByText(T(info, 'ki.kind.DETECT'))).toBeVisible();
  await expect(kni.getByText(T(info, 'ki.kind.COMPONENTS'), { exact: true })).toBeVisible();
  await expect(kni.getByText(T(info, 'ki.kind.DESIGN'), { exact: true })).toBeVisible();
  await expect(kni.getByText(T(info, 'ki.job.SUCCEEDED'))).toHaveCount(5);
  await kni
    .getByRole('button', { name: T(info, 'ki.logs'), exact: true })
    .first()
    .click();
  await expect(
    kni.getByText(
      /design analysis started over \d+ style, token and theme files .*nothing from the package is executed/,
    ),
  ).toBeVisible();
  // findings: the planted lifecycle script is reported, never run
  await expect(
    kni.getByText('dependencies/lifecycle_script').or(kni.getByText(T(info, 'ki.findings.none'))),
  ).toBeVisible();
  // inventory: files are listed, stored or not, never shown
  const inventory = kni.getByLabel(T(info, 'ki.files'));
  await expect(inventory.getByText('modern-saas/package.json', { exact: true })).toBeVisible();
  await expect(inventory.getByText('modern-saas/LICENSE', { exact: true })).toBeVisible();
  // the detected project: Next.js proven by the dependency, the config and the app folder; routes from the folder convention
  const proj = staff.page.getByLabel(T(info, 'km.title'));
  await expect(proj.locator('strong', { hasText: 'Next.js' })).toBeVisible();
  await expect(proj.getByText('modern-saas/package.json', { exact: false }).first()).toBeVisible();
  await expect(proj.getByText('/dashboard', { exact: true })).toBeVisible();
  await expect(
    proj.locator('.nz-badge', { hasText: T(info, 'km.kind.application') }),
  ).toBeVisible();
  // components and architecture (parse-only AST analysis): components with props, their kind from the folder convention, relationships with evidence
  const kc = staff.page.getByLabel(T(info, 'kc.title'));
  await expect(kc.getByText('Sidebar', { exact: true }).first()).toBeVisible();
  await expect(
    kc.locator('.nz-badge', { hasText: T(info, 'kc.kind.next-page') }).first(),
  ).toBeVisible();
  await expect(kc.getByText(T(info, 'kc.arch'), { exact: true })).toBeVisible();
  await expect(kc.getByText(T(info, 'kc.arch.cycles.none'))).toBeVisible();
  await kc
    .getByRole('button', { name: T(info, 'kc.details') })
    .first()
    .click();
  await expect(kc.getByText(T(info, 'kc.reuse.no'))).toBeVisible();
  // Design DNA (static reading of the stylesheet and the Tailwind configuration): roles with evidence, contrast, traits, tokens with their mode
  const kd = staff.page.getByLabel(T(info, 'kd.title'));
  await expect(kd.getByText(T(info, 'kd.role.background'), { exact: true })).toBeVisible();
  await expect(kd.getByText(T(info, 'kd.role.primary'), { exact: true })).toBeVisible();
  await expect(
    kd.getByText('modern-saas/app/globals.css:4', { exact: false }).first(),
  ).toBeVisible();
  await expect(kd.getByRole('table', { name: T(info, 'kd.contrast') })).toBeVisible();
  await expect(kd.locator('.nz-badge', { hasText: T(info, 'kd.trait.rtl') })).toBeVisible();
  await expect(kd.locator('.nz-badge', { hasText: T(info, 'kd.trait.arabicFont') })).toBeVisible();
  await expect(kd.locator('.nz-badge', { hasText: T(info, 'kd.trait.tailwind') })).toBeVisible();
  const tokenTable = kd.getByRole('table', { name: T(info, 'kd.tokens') });
  await expect(tokenTable.getByText('--primary', { exact: true }).first()).toBeVisible();
  await expect(kd.getByText(T(info, 'kc.reuse.no'))).toBeVisible();
  await audit(staff.page, info, 'ai-ingestion-review-uploader');
  expect(
    (
      await sql(
        `SELECT 1 FROM knowledge.resource_files WHERE version_id = $1 AND path LIKE '%postinstall.js'`,
        [vid],
      )
    ).length,
  ).toBe(1); // inventoried ...
  expect(existsSync(MARKER)).toBe(false); // ... and never run

  // ---- the first approver (a security reviewer): both confirmations are required
  const a1 = await person(browser, info, 'approver1');
  await a1.page.goto(resourcePage(info, id));
  const k1 = a1.page.locator('.kni');
  const approve1 = k1.getByRole('button', { name: T(info, 'ki.approve') });
  await expect(approve1).toBeDisabled();
  await k1.getByLabel(T(info, 'ki.check.findings')).check();
  await expect(approve1).toBeDisabled();
  await k1.getByLabel(T(info, 'ki.check.license')).check();
  await approve1.click();
  await expect(k1.getByText(T(info, 'ki.done.approved'))).toBeVisible();
  await expect(k1.getByText(T(info, 'ki.approvals.count', { n: 1, need: 2 }))).toBeVisible();
  await expect(k1.getByRole('button', { name: T(info, 'ki.activate') })).toBeDisabled(); // one approval is not enough
  await expect(k1.getByText(T(info, 'ki.you.approved'))).toBeVisible();

  // ---- the second approver completes the gate and activates
  const a2 = await person(browser, info, 'approver2');
  await a2.page.goto(resourcePage(info, id));
  const k2 = a2.page.locator('.kni');
  await expect(k2.getByText(T(info, 'ki.approvals.count', { n: 1, need: 2 }))).toBeVisible();
  await k2.getByLabel(T(info, 'ki.check.findings')).check();
  await k2.getByLabel(T(info, 'ki.check.license')).check();
  await k2.getByRole('button', { name: T(info, 'ki.approve') }).click();
  await expect(k2.getByText(T(info, 'ki.approvals.count', { n: 2, need: 2 }))).toBeVisible();
  await expect(k2.getByText(T(info, 'ki.blockers.none'))).toBeVisible();
  await k2.getByRole('button', { name: T(info, 'ki.activate') }).click();
  await expect(k2.getByText(T(info, 'ki.done.activated'))).toBeVisible();
  await expect(
    k2.locator('.nz-badge', { hasText: T(info, 'kn.status.ACTIVE') }).first(),
  ).toBeVisible();
  await audit(a2.page, info, 'ai-ingestion-activated');

  // ---- the database agrees: two different approvers, neither the uploader; activation did not publish
  const reviews = await sql<{ reviewer_id: string; decision: string }>(
    `SELECT reviewer_id, decision FROM knowledge.resource_reviews WHERE version_id = $1 ORDER BY created_at`,
    [vid],
  );
  expect(reviews.map((r) => r.decision)).toEqual(['APPROVE', 'APPROVE']);
  expect(new Set(reviews.map((r) => r.reviewer_id)).size).toBe(2);
  const up = (
    await sql<{ created_by: string }>(
      `SELECT created_by FROM knowledge.resource_versions WHERE id = $1`,
      [vid],
    )
  )[0]!.created_by;
  expect(reviews.map((r) => r.reviewer_id)).not.toContain(up);
  expect((await stateOf(vid)).state).toBe('ACTIVE');
  expect(
    (
      await sql<{ visibility: string; status: string }>(
        `SELECT visibility, status FROM knowledge.resources WHERE id = $1`,
        [id],
      )
    )[0],
  ).toMatchObject({ visibility: 'PLATFORM_PRIVATE', status: 'ACTIVE' });
  expect((await sql(`SELECT 1 FROM knowledge.v_published_templates`)).length).toBe(0); // private: customers see nothing
  const acts = await sql<{ action: string }>(
    `SELECT action FROM audit.audit_logs WHERE resource_id = $1 AND action LIKE 'knowledge.version.%' ORDER BY occurred_at`,
    [id],
  );
  expect(acts.map((a) => a.action)).toEqual([
    'knowledge.version.approved',
    'knowledge.version.approved',
    'knowledge.version.activated',
  ]);
  await staff.ctx.close();
  await a1.ctx.close();
  await a2.ctx.close();
});

test('1b. the Flutter and full-stack samples are detected from their files, with evidence (ar/en, axe)', async ({
  browser,
}, info) => {
  const L = loc(info);
  const staff = await person(browser, info, 'staff');
  const pick = (k: string) => SAMPLES.find((x) => x.key === k)!;
  const flutter = pick('flutter');
  const fullstack = pick('fullstack');
  const f = await upload(
    staff.page,
    info,
    flutter.filename,
    flutter.build(),
    flutter,
    `${flutter.name} ${L} detect`,
  );
  const s = await upload(
    staff.page,
    info,
    fullstack.filename,
    fullstack.build(),
    fullstack,
    `${fullstack.name} ${L} detect`,
  );
  await settled(f.vid, ['AWAITING_REVIEW']);
  await settled(s.vid, ['AWAITING_REVIEW']);

  await staff.page.goto(resourcePage(info, f.id));
  const fk = staff.page.getByLabel(T(info, 'km.title'));
  await expect(fk.locator('strong', { hasText: 'Flutter' })).toBeVisible();
  await expect(fk.locator('strong', { hasText: 'Dart' })).toBeVisible();
  await expect(fk.getByText('gym_app/pubspec.yaml', { exact: false }).first()).toBeVisible();
  await expect(fk.getByText('HomeScreen')).toBeVisible();
  await expect(fk.getByText(T(info, 'km.role.mobile'))).toBeVisible();
  const fc = staff.page.getByLabel(T(info, 'kc.title'));
  await expect(fc.getByText('HomeScreen', { exact: true }).first()).toBeVisible();
  await expect(
    fc.locator('.nz-badge', { hasText: T(info, 'kc.kind.flutter-widget') }).first(),
  ).toBeVisible();
  const fd = staff.page.getByLabel(T(info, 'kd.title'));
  await expect(fd.getByText(T(info, 'kd.role.primary'), { exact: true })).toBeVisible();
  await expect(fd.getByText('#1e88e5', { exact: true }).first()).toBeVisible();
  await expect(fd.locator('.nz-badge', { hasText: T(info, 'kd.trait.material3') })).toBeVisible();
  await audit(staff.page, info, 'ai-ingestion-manifest-flutter');

  await staff.page.goto(resourcePage(info, s.id));
  const sk = staff.page.getByLabel(T(info, 'km.title'));
  await expect(sk.locator('strong', { hasText: 'Next.js' })).toBeVisible();
  await expect(sk.locator('strong', { hasText: 'NestJS' })).toBeVisible();
  const sc = staff.page.getByLabel(T(info, 'kc.title'));
  await expect(sc.getByText('PropertiesController', { exact: true }).first()).toBeVisible();
  await expect(
    sc.locator('.nz-badge', { hasText: T(info, 'kc.kind.nest-controller') }).first(),
  ).toBeVisible();
  await audit(staff.page, info, 'ai-ingestion-manifest-fullstack');

  // the stored manifests: evidence for everything, nothing executed, nothing invented
  const mf = (
    await sql<{ manifest: Record<string, unknown> }>(
      `SELECT manifest FROM knowledge.resource_manifests WHERE version_id = $1`,
      [f.vid],
    )
  )[0]!.manifest as {
    frameworks: string[];
    routes: { path: string }[];
    capabilities: { evidence: unknown[] }[];
    analyzer: { id: string };
  };
  expect(mf.analyzer.id).toBe('project-detect');
  expect(mf.frameworks).toEqual(['flutter']);
  expect(mf.routes.length).toBeGreaterThan(0);
  expect(mf.capabilities.every((c) => c.evidence.length > 0)).toBe(true);
  const ms = (
    await sql<{ manifest: { frameworks: string[] } }>(
      `SELECT manifest FROM knowledge.resource_manifests WHERE version_id = $1`,
      [s.vid],
    )
  )[0]!.manifest;
  expect(ms.frameworks).toEqual(expect.arrayContaining(['nextjs', 'nestjs']));
  expect(
    (
      await sql(
        `SELECT 1 FROM knowledge.analysis_results WHERE version_id IN ($1,$2) AND analyzer = 'project-detect'`,
        [f.vid, s.vid],
      )
    ).length,
  ).toBe(2);
  // components and relationships were written by the worker, none of them reusable, with the schema-2 manifest beside the schema-1 one
  for (const v of [f.vid, s.vid]) {
    const rows = await sql<{ n: string; reuse: string }>(
      `SELECT count(*)::text AS n, count(*) FILTER (WHERE reuse_allowed)::text AS reuse FROM knowledge.resource_components WHERE version_id = $1`,
      [v],
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
    expect(rows[0]!.reuse).toBe('0');
    expect(
      (await sql(`SELECT 1 FROM knowledge.resource_relationships WHERE version_id = $1`, [v]))
        .length,
    ).toBeGreaterThan(0);
    expect(
      (
        await sql<{ schema_version: string }>(
          `SELECT schema_version FROM knowledge.resource_manifests WHERE version_id = $1 ORDER BY schema_version`,
          [v],
        )
      ).map((x) => x.schema_version),
    ).toEqual(['1', '2', '3']);
  }
  // design tokens, variants and the Design DNA were written by the worker: platform rows, dynamic tokens without a value, every token with its file and mode
  const dt = await sql<{ n: string; bad: string }>(
    `SELECT count(*)::text AS n, count(*) FILTER (WHERE (value IS NULL AND NOT dynamic) OR source_path IS NULL OR mode = '' OR org_id IS NOT NULL)::text AS bad FROM knowledge.theme_tokens WHERE version_id = $1`,
    [f.vid],
  );
  expect(Number(dt[0]!.n)).toBeGreaterThan(3);
  expect(dt[0]!.bad).toBe('0');
  expect(
    (
      await sql(
        `SELECT 1 FROM knowledge.analysis_results WHERE version_id IN ($1,$2) AND analyzer = 'design-dna'`,
        [f.vid, s.vid],
      )
    ).length,
  ).toBe(2);
  expect(
    (await sql(`SELECT 1 FROM knowledge.theme_variants WHERE version_id = $1`, [f.vid])).length,
  ).toBeGreaterThan(0);
  await staff.ctx.close();
});

test('2. a path-traversal archive is rejected and a package with a secret is quarantined; neither leaves anything in the object store (ar/en, axe)', async ({
  browser,
}, info) => {
  const L = loc(info);
  const staff = await person(browser, info, 'staff');
  const before = snapshots().length;

  // ---- hostile: an entry that climbs out of the package
  const evil = zip([
    { path: 'ok/readme.md', data: '# harmless\n' },
    { path: '../../etc/cron.d/evil', data: '* * * * * root true\n' },
  ]);
  const h = await upload(staff.page, info, 'traversal.zip', evil, nextjs, `Hostile ${L}`);
  await settled(h.vid, ['FAILED']);
  expect(await stateOf(h.vid)).toMatchObject({ state: 'FAILED', state_reason: 'path_traversal' });
  await staff.page.goto(resourcePage(info, h.id));
  const k = staff.page.locator('.kni');
  await expect(k.getByText(T(info, 'ki.reason.archive'), { exact: false })).toBeVisible();
  await expect(k.getByText('path_traversal').first()).toBeVisible();
  await expect(k.locator('.nz-badge', { hasText: T(info, 'ki.job.FAILED') }).first()).toBeVisible();
  await expect(k.getByText('archive/path_traversal')).toBeVisible();
  await expect(k.getByRole('button', { name: T(info, 'ki.approve') })).toHaveCount(0);
  await expect(k.getByRole('button', { name: T(info, 'ki.activate') })).toHaveCount(0);
  await expect(k.getByRole('button', { name: T(info, 'ki.retry') })).toHaveCount(0); // a rejected package is fixed and uploaded again, never retried
  await audit(staff.page, info, 'ai-ingestion-rejected');
  expect(
    (await sql(`SELECT 1 FROM knowledge.resource_files WHERE version_id = $1`, [h.vid])).length,
  ).toBe(0);

  // ---- unsafe: a package that contains a live-looking credential
  const secret = `AKIA${L === 'ar' ? 'Q7W8E9R2T3Y4U5I6' : 'Z1X2C3V4B5N6M7L8'}`;
  const leaky = zip([
    ...nextjs.entries(),
    { path: 'modern-saas/src/config.ts', data: `export const awsKey = "${secret}";\n` },
  ]);
  const s = await upload(staff.page, info, 'leaky.zip', leaky, nextjs, `Leaky ${L}`);
  await settled(s.vid, ['QUARANTINED']);
  await expect
    .poll(async () => (await stateOf(s.vid)).state_reason, { timeout: 30_000 })
    .toBe('secrets_found');
  await staff.page.goto(resourcePage(info, s.id));
  const q = staff.page.locator('.kni');
  await expect(q.getByText(T(info, 'ki.reason.secrets_found'))).toBeVisible();
  await expect(q.getByText('secrets/secret_found')).toBeVisible();
  await expect(q.getByText('modern-saas/src/config.ts:1').first()).toBeVisible();
  await expect(q.getByText(T(info, 'ki.blocker.blocking_findings'))).toBeVisible();
  await expect(q.getByRole('button', { name: T(info, 'ki.approve') })).toHaveCount(0);
  await expect(q.getByRole('button', { name: T(info, 'ki.activate') })).toHaveCount(0);
  await expect(staff.page.locator('body')).not.toContainText(secret); // the page never shows the matched text
  await audit(staff.page, info, 'ai-ingestion-quarantined-secret');

  // ---- what was (not) written
  const leakyFiles = await sql<{
    path: string;
    object_key: string | null;
    secret_findings: number;
  }>(
    `SELECT path, object_key, secret_findings FROM knowledge.resource_files WHERE version_id = $1 ORDER BY path`,
    [s.vid],
  );
  expect(leakyFiles.find((f) => f.path.endsWith('src/config.ts'))).toMatchObject({
    object_key: null,
    secret_findings: 1,
  });
  expect(leakyFiles.every((f) => f.object_key === null)).toBe(true); // a quarantined package is not unpacked into storage at all
  expect(snapshots().length).toBe(before); // neither package added a single snapshot object
  expect(storeContains(secret)).toEqual([]);
  // the secret is in no log, finding, job or summary row: kinds and path:line only
  const dump = JSON.stringify([
    await sql(`SELECT * FROM knowledge.processing_logs WHERE version_id IN ($1,$2)`, [
      h.vid,
      s.vid,
    ]),
    await sql(`SELECT * FROM knowledge.scan_findings WHERE version_id IN ($1,$2)`, [h.vid, s.vid]),
    await sql(`SELECT * FROM knowledge.processing_jobs WHERE version_id IN ($1,$2)`, [
      h.vid,
      s.vid,
    ]),
    await sql(
      `SELECT ingest_summary, license_proposal, state_reason FROM knowledge.resource_versions WHERE id IN ($1,$2)`,
      [h.vid, s.vid],
    ),
  ]);
  expect(dump).not.toContain(secret);
  // the database refuses every road from QUARANTINED to ACTIVE, for any role
  await expect(
    sql(`UPDATE knowledge.resource_versions SET state = 'ACTIVE' WHERE id = $1`, [s.vid]),
  ).rejects.toThrow(/not allowed/);
  await staff.ctx.close();
});

test('3. the worker role is confined: platform rows only, no licence verdict, no review, no activation', async () => {
  const c = new Client({
    connectionString: `postgres://nuzm_worker:nuzm_dev_only@127.0.0.1:${PG_PORT}/${E2E_DB}`,
  });
  await c.connect();
  try {
    const attempt = async (q: string, scope: string | null = 'knowledge') => {
      await c.query('BEGIN');
      if (scope) await c.query(`SELECT set_config('app.worker_scope', $1, true)`, [scope]);
      try {
        const r = await c.query(q);
        return { ok: true as const, rows: r.rowCount };
      } catch (e) {
        return { ok: false as const, error: (e as Error).message };
      } finally {
        await c.query('ROLLBACK');
      }
    };
    expect((await attempt(`SELECT 1 FROM knowledge.resource_versions`, null)).rows).toBe(0); // no scope: nothing
    expect((await attempt(`SELECT 1 FROM knowledge.resource_versions`, 'claim')).rows).toBe(0); // the generic claim scope opens nothing here
    expect((await attempt(`SELECT 1 FROM knowledge.resource_versions`)).rows).toBeGreaterThan(0);
    expect(
      await attempt(`UPDATE knowledge.resource_versions SET license_verdict = 'ALLOWED'`),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/permission denied/) });
    expect(
      await attempt(`UPDATE knowledge.resource_versions SET activated_by = gen_random_uuid()`),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/permission denied/) });
    expect(
      await attempt(
        `INSERT INTO knowledge.resource_reviews (id, version_id, resource_id, analysis_job_id, decision, reviewer_id) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'APPROVE', gen_random_uuid())`,
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/permission denied/) });
    expect(
      await attempt(
        `UPDATE knowledge.resource_versions SET state = 'ACTIVE' WHERE state = 'AWAITING_REVIEW'`,
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/activation needs/) }); // versions DO await review here (1b): the database gate refuses the worker
    expect(await attempt(`DELETE FROM knowledge.resource_versions`)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/permission denied/),
    });
  } finally {
    await c.end();
  }
});
