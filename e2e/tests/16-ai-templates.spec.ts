import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';
import { DB_URL as DB, STORE_DIR, WEB } from './env';
import { T, audit, loc, signIn } from './helpers';

/**
 * AI Intelligence Center, slice S-K7 (SCR-K-08): the customer experience, END TO END in Arabic (RTL) and English with real browsers:
 * customer console -> API -> database -> object store.
 *  1. flag OFF (default): no link, the gallery says "not available";
 *  2. flag ON for the organization: the start screen links to the gallery; the gallery lists PUBLISHED templates only; filters; one template; a recommendation for a
 *     description; starting a project copies the pinned version into a NEW web-app project (files from the object store, through the safe-change pipeline), records the
 *     customer's own usage rows, and a second start with the same name is refused with a plain message and creates nothing;
 *  3. nothing on any screen locates source: no path, no object key, no file text.
 * The templates are written with SQL and the object store directly (the ingestion pipeline has its own end-to-end test, 15-ai-ingestion); they stand for what an approved,
 * published library item looks like. The customer organization is created through the sign-up screen by the first test, so this file does not depend on another spec.
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
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** An organization row beats the global one; `null` removes it. */
async function orgFlag(orgId: string, key: string, on: boolean | null) {
  await sql(`DELETE FROM platform.feature_flags WHERE key = $1 AND org_id = $2`, [key, orgId]);
  if (on !== null)
    await sql(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), $1, $2, $3::jsonb)`,
      [key, orgId, JSON.stringify(on)],
    );
}

const FILES = (name: string) => [
  {
    path: 'package.json',
    content: JSON.stringify({
      name: 'e2e-starter',
      version: '1.0.0',
      dependencies: { next: '15.0.0', react: '19.0.0' },
    }),
  },
  { path: 'README.md', content: `# ${name}\n\nA dashboard starter.\n` },
  {
    path: 'LICENSE',
    content:
      'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software',
  },
  {
    path: 'src/app/page.tsx',
    content: 'export default function Home() { return <main>E2E-SECRET-FILE-TEXT</main>; }\n',
  },
];

async function publishTemplate(o: {
  name: string;
  slug: string;
  published: boolean;
  description: string;
}) {
  const rid = randomUUID();
  const vid = randomUUID();
  await sql(
    `INSERT INTO knowledge.resources (id, org_id, slug, name, description, resource_type, platform, frameworks, category, tags, visibility, source_kind, status, data_region, current_version_id)
     VALUES ($1, NULL, $2, $3, $4, 'THEME', 'WEB', '{nextjs}', 'dashboard', '{admin,analytics}', $5, 'upload', 'ACTIVE', 'sa-central', $6)`,
    [
      rid,
      o.slug,
      o.name,
      o.description,
      o.published ? 'PLATFORM_PUBLISHED' : 'PLATFORM_PRIVATE',
      vid,
    ],
  );
  await sql(
    `INSERT INTO knowledge.resource_versions (id, resource_id, org_id, seq, semver, state, checksum_sha256, bytes, archive_key, license_verdict)
     VALUES ($1, $2, NULL, 1, '1.2.0', 'ACTIVE', $3, 100, $4, 'ALLOWED')`,
    [vid, rid, sha(o.slug), `archives/${sha(o.slug)}`],
  );
  await sql(
    `INSERT INTO knowledge.resource_permissions (id, resource_id, org_id, reuse_scope, starter_eligible, component_reuse, architecture_reference, ai_processing, license_verdict, license_spdx)
     VALUES (gen_random_uuid(), $1, NULL, 'FULL_STARTER', true, true, true, true, 'ALLOWED', 'MIT')`,
    [rid],
  );
  for (const f of FILES(o.name)) {
    const buf = Buffer.from(f.content);
    const key = `snapshots/${vid}/${sha(buf).slice(0, 16)}`;
    const p = join(STORE_DIR, key);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, buf);
    await sql(
      `INSERT INTO knowledge.resource_files (id, version_id, org_id, path, sha256, bytes, language, is_binary, object_key)
       VALUES (gen_random_uuid(), $1, NULL, $2, $3, $4, $5, false, $6)`,
      [
        vid,
        f.path,
        sha(buf),
        buf.length,
        f.path.endsWith('.json') ? 'json' : f.path.endsWith('.md') ? 'markdown' : 'typescript',
        key,
      ],
    );
  }
  await sql(
    `INSERT INTO knowledge.resource_manifests (id, version_id, org_id, schema_version, manifest)
     VALUES (gen_random_uuid(), $1, NULL, '2', $2::jsonb)`,
    [
      vid,
      JSON.stringify({
        frameworks: ['nextjs'],
        capabilities: [
          { name: 'Authentication', evidence: [{ path: 'src/secret/auth.ts', line: 1 }] },
          { name: 'Analytics dashboard', evidence: [] },
        ],
        architecture: {
          layers: [{}, {}],
          cycles: [],
          entryReachability: { roots: 1, analysedFiles: 4, unreachable: 0 },
        },
      }),
    ],
  );
  await sql(
    `INSERT INTO knowledge.analysis_results (id, version_id, org_id, analyzer, analyzer_version, content_hash, result)
     VALUES (gen_random_uuid(), $1, NULL, 'design-dna', '1.0.0', $2, $3::jsonb)`,
    [
      vid,
      'd'.repeat(64),
      JSON.stringify({
        primary: 0,
        projects: [
          {
            modes: ['base', 'dark'],
            traits: { darkMode: true, rtl: true },
            palette: [
              {
                mode: 'base',
                roles: [
                  {
                    role: 'primary',
                    hex: '#2563eb',
                    token: '--primary',
                    evidence: { path: 'src/secret/globals.css', line: 4 },
                  },
                ],
              },
            ],
            typography: { families: [{ value: 'Cairo' }] },
            spacing: { baseUnit: 4 },
          },
        ],
      }),
    ],
  );
  await sql(
    `INSERT INTO knowledge.resource_search_documents (id, version_id, org_id, doc_kind, ref, title, body, content_hash)
     VALUES (gen_random_uuid(), $1, NULL, 'SUMMARY', 'summary', $2, 'frameworks: nextjs capabilities: analytics dashboard charts tables', $3)`,
    [vid, o.name, 'c'.repeat(64)],
  );
  return { rid, vid };
}

const NAME = 'E2E Analytics Dashboard';
const DRAFT = 'E2E Unpublished Draft';
let seeded: { rid: string; vid: string } | null = null;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  await sql(
    `UPDATE knowledge.resources SET status = 'ARCHIVED', deleted_at = now() WHERE org_id IS NULL AND deleted_at IS NULL AND name LIKE 'E2E %'`,
  );
  seeded = await publishTemplate({
    name: NAME,
    slug: `e2e-dashboard-${Date.now()}`,
    published: true,
    description: 'A dashboard starter for analytics and reports',
  });
  await publishTemplate({
    name: DRAFT,
    slug: `e2e-draft-${Date.now()}`,
    published: false,
    description: 'Not published',
  });
});
test.afterAll(async () => {
  await sql(
    `UPDATE knowledge.resources SET status = 'ARCHIVED', deleted_at = now() WHERE org_id IS NULL AND deleted_at IS NULL AND name LIKE 'E2E %'`,
  );
});

const ownerOrg = async (L: string) =>
  (
    await sql<{ id: string }>(
      `SELECT m.org_id AS id FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`,
      [`owner-${L}@example.test`],
    )
  )[0]?.id;

/** No screen of the customer console ever shows where the source lives, or what is in a file. */
async function expectNoSource(page: Page) {
  const html = await page.content();
  for (const leak of [
    'snapshots/',
    'object_key',
    'objectKey',
    'E2E-SECRET-FILE-TEXT',
    'src/secret',
    'src/app/page.tsx',
    '--primary',
  ])
    expect(html, `the page shows "${leak}"`).not.toContain(leak);
}

test('1. flag OFF (default): no link on the start screen and the gallery says "not available" (ar/en, axe)', async ({
  page,
}, info) => {
  const L = loc(info);
  await signIn(page, info, `owner-${L}@example.test`);
  // a first sign-in lands on "create your organization": do that through the screen, as a customer would
  if (!(await ownerOrg(L))) {
    await page.getByLabel(T(info, 'field.name'), { exact: true }).fill(`K7 Org ${L}`);
    await page.getByRole('button', { name: T(info, 'action.create'), exact: true }).click();
    await expect.poll(() => ownerOrg(L), { timeout: 30_000 }).toBeTruthy();
  }
  const org = (await ownerOrg(L))!;
  await orgFlag(org, 'ai.enabled', true);
  await orgFlag(org, 'app_builder.enabled', true);
  await orgFlag(org, 'knowledge.customer_templates', null);
  await page.goto(`${WEB}/${L}`);
  await page.goto(`${WEB}/${L}/builder/projects`);
  await expect(page.getByRole('link', { name: T(info, 'tpl.start.link') })).toHaveCount(0);
  await page.goto(`${WEB}/${L}/builder/templates`);
  await expect(page.getByText(T(info, 'bld.unavailable.title'))).toBeVisible();
  await expect(page.getByTestId('tpl-card')).toHaveCount(0);
  await audit(page, info, 'ai-templates-off');
  // the API agrees: 404, not an empty list
  const r = await page.request.get(`${WEB}/v1/builder/templates`, {
    headers: { 'x-nuzm-org': org, 'x-nuzm-realm': 'web' },
  });
  expect(r.status()).toBe(404);
});

test('2. flag ON: gallery, filters, one template, a suggestion, and starting a project copies the pinned version (ar/en, axe, no source shown)', async ({
  page,
}, info) => {
  const L = loc(info);
  const org = (await ownerOrg(L))!;
  await orgFlag(org, 'knowledge.customer_templates', true);
  await signIn(page, info, `owner-${L}@example.test`);

  // ---- from the start screen to the gallery
  await page.goto(`${WEB}/${L}/builder/projects`);
  await page.getByRole('link', { name: T(info, 'tpl.start.link') }).click();
  await expect(page.getByRole('heading', { name: T(info, 'tpl.title'), level: 1 })).toBeVisible();

  // ---- the gallery: the published template only, with facts; the unpublished one is not there
  const card = page.getByTestId('tpl-card').filter({ hasText: NAME });
  await expect(card).toBeVisible();
  await expect(page.getByTestId('tpl-card').filter({ hasText: DRAFT })).toHaveCount(0);
  await expect(card.getByText('MIT', { exact: true })).toBeVisible();
  await expect(card.getByText(T(info, 'kr.usage.FULL_STARTER'))).toBeVisible();
  await expectNoSource(page);
  await audit(page, info, 'ai-templates-gallery');

  // ---- filters live in the URL: a search that matches nothing says so, "clear" brings the list back
  await page.getByLabel(T(info, 'tpl.filter.q'), { exact: true }).fill('zzz-nothing-matches');
  await page.getByRole('button', { name: T(info, 'tpl.filter.apply') }).click();
  await expect(page).toHaveURL(/q=zzz-nothing-matches/);
  await expect(page.getByText(T(info, 'tpl.empty.filtered'))).toBeVisible();
  await page.getByRole('link', { name: T(info, 'tpl.filter.clear') }).click();
  await expect(page.getByTestId('tpl-card').filter({ hasText: NAME })).toBeVisible();

  // ---- a suggestion for a description: ranked with the reason; it creates nothing
  const before = Number(
    (
      await sql(
        `SELECT count(*)::int n FROM builder.projects WHERE org_id = $1 AND deleted_at IS NULL`,
        [org],
      )
    )[0]!.n,
  );
  await page
    .getByLabel(T(info, 'tpl.rec.text'), { exact: true })
    .fill(L === 'ar' ? 'لوحة تحكم' : 'analytics dashboard');
  await page.getByRole('button', { name: T(info, 'tpl.rec.run') }).click();
  const rec = page.getByTestId('tpl-rec-result');
  await expect(rec).toBeVisible();
  await expect(rec.getByTestId('tpl-rec-item').filter({ hasText: NAME })).toBeVisible();
  await expect(rec.getByTestId('tpl-rec-item').filter({ hasText: DRAFT })).toHaveCount(0);
  await rec.getByText(T(info, 'tpl.rec.why')).first().click();
  await expectNoSource(page);
  await audit(page, info, 'ai-templates-recommend');
  expect(
    Number(
      (
        await sql(
          `SELECT count(*)::int n FROM builder.projects WHERE org_id = $1 AND deleted_at IS NULL`,
          [org],
        )
      )[0]!.n,
    ),
  ).toBe(before);

  // ---- one template: facts, capabilities (names only), a safe design summary
  await card.getByRole('link', { name: NAME }).click();
  await expect(page.getByRole('heading', { name: NAME, level: 1 })).toBeVisible();
  await expect(page.getByText('Authentication', { exact: true })).toBeVisible();
  await expect(page.getByText('#2563eb')).toBeVisible();
  await expect(page.getByText('Cairo')).toBeVisible();
  await expectNoSource(page);
  await audit(page, info, 'ai-templates-detail');

  // ---- start a project from it: the pinned version is copied into a NEW web-app project
  const project = `E2E Copy ${L} ${Date.now()}`;
  await page.getByLabel(T(info, 'tpl.start.name'), { exact: true }).fill(project);
  await page.getByLabel(T(info, 'tpl.start.mode'), { exact: true }).selectOption('ADAPTIVE');
  await page.getByRole('button', { name: T(info, 'tpl.start.submit') }).click();
  const done = page.getByTestId('tpl-done');
  await expect(done).toBeVisible({ timeout: 60_000 });
  await expect(done.getByText(T(info, 'tpl.done.title'))).toBeVisible();
  await expect(done.getByText(T(info, 'tpl.done.license', { spdx: 'MIT' }))).toBeVisible();
  await expect(done.getByRole('link', { name: T(info, 'tpl.done.open') })).toHaveAttribute(
    'href',
    new RegExp(`/${L}/builder/projects/[0-9a-f-]{36}$`),
  );
  await expectNoSource(page);
  await audit(page, info, 'ai-templates-started');

  // ---- the database agrees: one new web-app project of THIS organization, the customer's own usage and link rows, the template untouched
  const proj = (
    await sql<{ id: string; type: string }>(
      `SELECT id, type FROM builder.projects WHERE org_id = $1 AND name = $2 AND deleted_at IS NULL`,
      [org, project],
    )
  )[0];
  expect(proj?.type).toBe('webapp');
  expect(
    Number(
      (
        await sql(
          `SELECT count(*)::int n FROM builder.projects WHERE org_id = $1 AND deleted_at IS NULL`,
          [org],
        )
      )[0]!.n,
    ),
  ).toBe(before + 1);
  expect(
    Number(
      (
        await sql(
          `SELECT count(*)::int n FROM knowledge.usage_events WHERE org_id = $1 AND kind = 'COPIED' AND version_id = $2`,
          [org, seeded!.vid],
        )
      )[0]!.n,
    ),
  ).toBeGreaterThanOrEqual(1);
  const link = (
    await sql<{ role: string; strategy: string }>(
      `SELECT role, strategy FROM knowledge.generation_resource_links WHERE org_id = $1 AND resource_version_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [org, seeded!.vid],
    )
  )[0];
  expect(link).toMatchObject({ role: 'STARTER', strategy: 'COPY' });
  expect(
    Number(
      (
        await sql(`SELECT count(*)::int n FROM knowledge.resource_files WHERE version_id = $1`, [
          seeded!.vid,
        ])
      )[0]!.n,
    ),
  ).toBe(4);
  expect(
    Number(
      (
        await sql(
          `SELECT count(*)::int n FROM knowledge.resource_versions WHERE resource_id = $1`,
          [seeded!.rid],
        )
      )[0]!.n,
    ),
  ).toBe(1);

  // ---- the same name again is refused in plain words; nothing is created
  await page.goto(`${WEB}/${L}/builder/templates/${seeded!.rid}`);
  await page.getByLabel(T(info, 'tpl.start.name'), { exact: true }).fill(project);
  await page.getByRole('button', { name: T(info, 'tpl.start.submit') }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: T(info, 'bld.err.name_taken') }),
  ).toBeVisible();
  await expect(page.getByTestId('tpl-done')).toHaveCount(0);
  expect(
    Number(
      (
        await sql(
          `SELECT count(*)::int n FROM builder.projects WHERE org_id = $1 AND deleted_at IS NULL`,
          [org],
        )
      )[0]!.n,
    ),
  ).toBe(before + 1);
  await audit(page, info, 'ai-templates-error');
});

test('3. a template that is not published is "not available", the same as one that does not exist (ar/en)', async ({
  page,
}, info) => {
  const L = loc(info);
  const draft = (
    await sql<{ id: string }>(
      `SELECT id FROM knowledge.resources WHERE name = $1 AND deleted_at IS NULL`,
      [DRAFT],
    )
  )[0]!.id;
  await signIn(page, info, `owner-${L}@example.test`);
  await page.goto(`${WEB}/${L}/builder/templates/${draft}`);
  const a = await page.locator('main').innerText();
  await page.goto(`${WEB}/${L}/builder/templates/${randomUUID()}`);
  const b = await page.locator('main').innerText();
  expect(a).toBe(b);
  expect(a).toContain(T(info, 'bld.unavailable.title'));
  expect(a).not.toContain(DRAFT);
  await audit(page, info, 'ai-templates-unavailable');
  // the flag goes back to its default for the next specs
  const org = (await ownerOrg(L))!;
  await orgFlag(org, 'knowledge.customer_templates', null);
});
