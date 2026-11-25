import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTENT_AREAS,
  CONTENT_WORDS,
  hasGuard,
  loadClassification,
  scoped,
} from './gates/o9-static';
import { has, key, routes } from './qa-route-scan';

/**
 * P3-S08 CI gate (unit test, no database): the static half of the O-9 audit. Billing administrators must not read customer content (source, files, AI conversations, generated
 * artifacts, deployment logs). `qa-o9-content-access.int.spec.ts` proves it dynamically against a database (`pnpm test:integration`); this gate runs in `pnpm test` / `pnpm verify`
 * and fails when a route is added that nobody classified, or when a route classified as `content` loses its guard.
 *
 * WHEN THIS FAILS because of a NEW route: decide with the route's owner whether it returns customer content.
 *   - yes: put `@ContentRead('<operation>')` on it (builder routes) or call the AI content-access `assert` (AI routes), then add its key to `content` in docs/security/O9-ROUTE-CLASSIFICATION.json;
 *   - no: add it to `metadata` with the reason (one sentence a reviewer can check). A reason like "internal" is not enough.
 * Also re-run `qa-o9-content-access.int.spec.ts` (dynamic audit) before merging a content route.
 */
const all = routes();
const cls = loadClassification();
const roots = join(process.cwd(), '../..');
const mine = scoped(all);
const keys = mine.map(key);
const pinned = [...cls.content, ...Object.keys(cls.metadata)];

describe('O-9 static gate: every customer-content route is classified', () => {
  it('the scanner is not blind (finds the known content areas)', () => {
    expect(mine.length).toBeGreaterThan(55);
    expect(cls.content.length).toBeGreaterThanOrEqual(25);
  });
  it('no route in the customer-content areas is unclassified, and no classification is stale', () => {
    expect({
      newRoutesNeedO9Classification: keys.filter((k) => !pinned.includes(k)).sort(),
      staleEntries: pinned.filter((k) => !keys.includes(k)).sort(),
    }).toEqual({ newRoutesNeedO9Classification: [], staleEntries: [] });
  });
  it('a route is never both content and metadata', () => {
    expect(cls.content.filter((k) => k in cls.metadata)).toEqual([]);
  });
  it('every metadata entry carries a real reason', () => {
    for (const [k, reason] of Object.entries(cls.metadata)) {
      expect(reason.length, k).toBeGreaterThan(25);
      expect(reason, k).not.toMatch(/^(internal|todo|tbd|n\/a|ok|fine)\b/i);
    }
  });
});

describe('O-9 static gate: content routes carry the shared guard', () => {
  it('every route classified as content has @ContentRead or an explicit content-access assert in its handler', () => {
    const unguarded = mine
      .filter((r) => cls.content.includes(key(r)) && !hasGuard(r))
      .map((r) => `${key(r)} (${r.file})`);
    expect(unguarded).toEqual([]);
  });
  it('the guard detector is not vacuous: a metadata route without the guard is seen as unguarded', () => {
    const noGuard = mine.filter((r) => key(r) === 'GET /v1/builder/projects/:id/versions');
    expect(noGuard).toHaveLength(1);
    expect(hasGuard(noGuard[0]!)).toBe(false);
    const guarded = mine.filter((r) => key(r) === 'GET /v1/builder/projects/:id/files/content');
    expect(hasGuard(guarded[0]!)).toBe(true);
  });
  it('a route whose name says content cannot hide as metadata without being listed with a reason (path heuristic)', () => {
    // every GET whose path matches the content words and is classified `metadata` is on a short reviewed list
    const REVIEWED_NAME_MATCHES = [
      'GET /v1/builder/projects/:id/files',
      'GET /v1/builder/projects/:projectId/exports',
      'GET /v1/builder/projects/:projectId/exports/:exportId',
      'GET /v1/builder/projects/:projectId/sandboxes',
      'GET /v1/builder/projects/:projectId/sandboxes/:sid',
      'GET /v1/builder/projects/:projectId/skills',
      'GET /v1/builder/projects/:projectId/skills/recommendations',
      'GET /v1/builder/projects/:id/versions',
      'GET /v1/ai/approvals',
      'GET /v1/ai/approvals/:approvalId',
      'GET /v1/email/messages',
      'GET /v1/email/messages/:id',
      'GET /v1/email/events',
      'GET /v1/auth/sessions',
      'GET /v1/usage/events',
      'GET /v1/builder/templates',
      'GET /v1/builder/templates/:id',
      'GET /v1/mobile/builds',
      'GET /v1/mobile/builds/:id',
      'GET /v1/mobile/builds/:id/artifacts',
      'GET /v1/mobile/releases',
      'GET /v1/mobile/signing-credentials',
      'GET /v1/builder/skills',
      'GET /v1/deployments',
      'GET /v1/builder/github/repositories',
      // hosting line, reviewed at the Phase 3 reconciliation: site files and logs need hosting:files:read / hosting:logs:read, which only owner, admin and developer hold (billing_admin and viewer hold none: migration hosting/1993), so RBAC already keeps billing administrators out
      'GET /v1/hosting/sites/:id/files',
      'GET /v1/hosting/sites/:id/files/download',
      'GET /v1/hosting/sites/:id/files/text',
      'GET /v1/hosting/sites/:id/logs',
    ];
    const suspect = mine
      .filter((r) => cls.metadata[key(r)] !== undefined && CONTENT_WORDS.test(r.path))
      .map(key)
      .filter((k) => !REVIEWED_NAME_MATCHES.includes(k));
    expect(suspect).toEqual([]);
  });
});

describe('O-9 static gate: agrees with the dynamic audit document', () => {
  const doc = readFileSync(join(roots, 'docs/security/O9-CONTENT-ACCESS-AUDIT.md'), 'utf8');
  const rows = doc
    .split('\n')
    .filter((l) => /^\| `GET /.test(l))
    .map((l) => l.split('|').map((c) => c.trim()))
    .map((c) => ({ route: c[1]!.replace(/`/g, ''), underDeny: c[5] ?? '' }));
  it('the audit table has the routes (not blind)', () => {
    expect(rows.length).toBeGreaterThan(45);
  });
  it('every route the audit shows as 403 under deny is classified content here', () => {
    const missing = rows
      .filter((r) => r.underDeny.includes('**403**') && !cls.content.includes(r.route))
      .map((r) => r.route);
    expect(missing).toEqual([]);
  });
  it('every route the audit shows as readable (200/409) under deny is classified metadata here, or is outside the static scope', () => {
    const wrong = rows
      .filter((r) => /^(200|409)$/.test(r.underDeny) && cls.content.includes(r.route))
      .map((r) => r.route);
    expect(wrong).toEqual([]);
  });
});

describe('O-9 static gate: scope sanity', () => {
  it('the content areas regex covers the AI, builder, deployment, execution, benchmark and (Phase 3) mobile routes', () => {
    for (const p of [
      '/v1/ai/runs',
      '/v1/builder/projects',
      '/v1/deployments',
      '/v1/execution/jobs',
      '/v1/benchmarks/runs',
      '/v1/mobile/builds',
    ])
      expect(CONTENT_AREAS.test(p), p).toBe(true);
  });
  it('public and platform routes are out of scope (their own gates pin them)', () => {
    expect(mine.some((r) => has(r, 'Public') || has(r, 'RequirePlatformPermission'))).toBe(false);
  });
});
