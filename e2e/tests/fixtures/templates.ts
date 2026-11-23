import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { DB_URL as DB, STORE_DIR, WEB } from '../env';
import { T, loc, signIn } from '../helpers';

/** Shared fixtures of the AI Intelligence Center customer specs (16, 17): published templates written with SQL and the object store, flags per organization, the owner's organization. */
export const sql = async <R extends Record<string, unknown>>(q: string, args: unknown[] = []) => {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(q, args)).rows as R[];
  } finally {
    await c.end();
  }
};
export const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** An organization row beats the global one; `null` removes it. */
export async function orgFlag(orgId: string, key: string, on: boolean | null) {
  await sql(`DELETE FROM platform.feature_flags WHERE key = $1 AND org_id = $2`, [key, orgId]);
  if (on !== null)
    await sql(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), $1, $2, $3::jsonb)`,
      [key, orgId, JSON.stringify(on)],
    );
}

export const FILES = (name: string) => [
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

export async function publishTemplate(o: {
  name: string;
  slug: string;
  published: boolean;
  description: string;
  /** the template's permission to have its source processed by a model (default: allowed) */
  aiProcessing?: boolean;
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
     VALUES (gen_random_uuid(), $1, NULL, 'FULL_STARTER', true, true, true, $2, 'ALLOWED', 'MIT')`,
    [rid, o.aiProcessing ?? true],
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

export const ownerOrg = async (L: string) =>
  (
    await sql<{ id: string }>(
      `SELECT m.org_id AS id FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`,
      [`owner-${L}@example.test`],
    )
  )[0]?.id;

/** Signs in as the locale's owner and, on a first sign-in, creates the organization through the screen, as a customer would. Returns the organization id. */
export async function ensureOwnerOrg(page: Page, info: TestInfo): Promise<string> {
  const L = loc(info);
  await signIn(page, info, `owner-${L}@example.test`);
  if (!(await ownerOrg(L))) {
    await page.getByLabel(T(info, 'field.name'), { exact: true }).fill(`K7 Org ${L}`);
    await page.getByRole('button', { name: T(info, 'action.create'), exact: true }).click();
    await expect.poll(() => ownerOrg(L), { timeout: 30_000 }).toBeTruthy();
  }
  await page.goto(`${WEB}/${L}`);
  return (await ownerOrg(L))!;
}
