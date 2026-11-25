import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { execSync } from 'node:child_process';
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
/** Test tooling: marks the staff session as recently MFA-verified so the step-up that admin actions require does not interrupt the flow (the MFA enrolment itself is covered by 02-admin). */
export const elevate = (email: string) =>
  sql(
    `UPDATE identity.sessions SET mfa_level = 'totp', mfa_verified_at = now() WHERE user_id = (SELECT id FROM identity.users WHERE email = $1)`,
    [email],
  );
/**
 * Test tooling: the model adapter kind's processors in the ROPA (the residency evaluator refuses a processor it does not know), so the dev-reference `mock-model` can be
 * called. Idempotent. Nothing live: the provider is the in-memory dev reference (`AI_LOCAL_REFERENCE`, NOT VERIFIED).
 */
export async function prepareAiModelRopa() {
  await sql(
    `INSERT INTO compliance.ropa_entries (id, entry_key, version, org_id, kind, adapter_kind, activity, purpose, data_classes, processors, regions, status, change_note)
     SELECT gen_random_uuid(), 'adapter:model', coalesce((SELECT max(version) FROM compliance.ropa_entries WHERE entry_key = 'adapter:model'), 0) + 1, NULL, 'adapter', 'model', 'Model providers', 'AI generation (e2e fixture)', '{customer-content,personal}',
       '[{"name":"mock-model","dataClasses":["customer-content","personal"],"region":"any","purpose":"AI model calls (e2e fixture)"}]'::jsonb, '{}', 'draft', 'e2e'
     WHERE NOT EXISTS (SELECT 1 FROM compliance.ropa_entries WHERE entry_key = 'adapter:model' AND change_note = 'e2e')`,
  );
}
/**
 * Test tooling: the in-memory dev-reference model provider (`mock-model`, NOT VERIFIED; needs `AI_LOCAL_REFERENCE` on the API) enabled with a rate card and the data-terms
 * attestation marked LOCAL-REFERENCE-NOT-VERIFIED (the customer-content gate refuses an unattested provider). Nothing live; no real attestation (HG-09-01) is claimed.
 */
export async function enableMockModel() {
  await prepareAiModelRopa();
  const models = {
    'mock-chat-1': { creditsPerMillionInput: '1000000', creditsPerMillionOutput: '2000000' },
    'mock-long-1': { creditsPerMillionInput: '1000000', creditsPerMillionOutput: '2000000' },
  };
  await sql(
    `INSERT INTO ai.model_providers (id, code, adapter, display_name, region, rate_card_version, rate_card, enabled, enabled_at, data_terms, attestation_ref, attested_at)
     VALUES (gen_random_uuid(), 'mock-model', 'mock', 'Mock model', 'sa-central', 'e2e-1', $1::jsonb, true, now(),
       '{"attested":true,"retainsPrompts":false,"trainsOnData":false}'::jsonb, 'LOCAL-REFERENCE-NOT-VERIFIED', now())
     ON CONFLICT (code) DO UPDATE SET enabled = true, enabled_at = coalesce(ai.model_providers.enabled_at, now()), rate_card = EXCLUDED.rate_card,
       data_terms = EXCLUDED.data_terms, attestation_ref = EXCLUDED.attestation_ref, attested_at = coalesce(ai.model_providers.attested_at, now())`,
    [JSON.stringify({ models })],
  );
}
/** Test tooling: AI credits in the organization's wallet (a ledger credit grant through `billing.post`, so the balance is real). Idempotent per organization. */
export async function creditAiWallet(orgId: string, minor: string) {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
    await c.query(
      `SELECT * FROM billing.post(gen_random_uuid(), $1, $2, 'credit_grant', 'e2e ai credit', NULL, NULL, $3::jsonb, NULL)`,
      [
        orgId,
        `e2e-ai-credit-${orgId}`,
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
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}
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
export async function ensureOwnerOrg(page: Page, info: TestInfo, name?: string): Promise<string> {
  const L = loc(info);
  await signIn(page, info, `owner-${L}@example.test`);
  if (!(await ownerOrg(L))) {
    await page.getByLabel(T(info, 'field.name'), { exact: true }).fill(name ?? `K7 Org ${L}`);
    await page.getByRole('button', { name: T(info, 'action.create'), exact: true }).click();
    await expect.poll(() => ownerOrg(L), { timeout: 30_000 }).toBeTruthy();
  }
  await page.goto(`${WEB}/${L}`);
  return (await ownerOrg(L))!;
}

/** The development compute catalog (provider accounts, regions, sizes, images, a price): the cloud screens have nothing to show without it. Only for the specs that look at it. */
export function seedCloudCatalog(): void {
  execSync('pnpm --filter @nuzm/db exec tsx src/cli.ts dev-seed-cloud', {
    stdio: 'ignore',
    env: { ...process.env, DATABASE_ADMIN_URL: DB },
  });
}
