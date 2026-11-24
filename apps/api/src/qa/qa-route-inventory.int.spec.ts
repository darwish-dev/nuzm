import { describe, expect, it } from 'vitest';

/**
 * Session 07 (QA) - static route-security inventory of the whole API (no database, no server): every HTTP handler of every controller under `apps/api/src`.
 * It is a REGRESSION GATE for the parallel work: a route that another session adds (execution, benchmarks, builder tools, deploy, providers) is scanned automatically and the
 * suite fails until a reviewer has looked at it. Baseline taken 2026-11-24 on `f81872d5` (502 routes in 131 files).
 *
 *  1. every route carries an access declaration (the global guard also denies by default: this catches the functional bug early);
 *  2. every `/v1/admin/**` route needs a PLATFORM permission (admin realm), never an organization permission, never public;
 *  3. the set of unauthenticated (`@Public`) routes is pinned: a new public route fails the suite until it is reviewed and added here with its reason;
 *  4. a POST on an organization route must be `@Idempotent()` (CLAUDE.md section 4) unless it is in the pinned exception list (each is a state-machine or idempotent-by-
 *     construction action that the owning session must confirm; a NEW exception fails the suite). PUT/PATCH/DELETE are idempotent by HTTP semantics and are not required to be;
 *  5. no route of the AI engine areas is public (except the pinned webhooks).
 * A reviewer who adds an entry must say WHY in the pull request. Removing an entry (a fix) is always welcome: a stale entry fails the suite so the list never rots.
 */
import { has, key, routes } from './qa-route-scan';
const diff = (actual: string[], pinned: string[]) => ({
  added: actual.filter((x) => !pinned.includes(x)).sort(),
  stale: pinned.filter((x) => !actual.includes(x)).sort(),
});

/** Unauthenticated routes (each one authenticates itself: webhook signatures, tokens, credentials, SCIM bearer, preview tokens). */
const PUBLIC_ROUTES: string[] = [
  'DELETE /_preview/:token/*',
  'DELETE /scim/v2/Users/:id',
  'GET /_preview/:token',
  'GET /_preview/:token/*',
  'GET /healthz',
  'GET /scim/v2/Groups',
  'GET /scim/v2/Groups/:id',
  'GET /scim/v2/ResourceTypes',
  'GET /scim/v2/Schemas',
  'GET /scim/v2/ServiceProviderConfig',
  'GET /scim/v2/Users',
  'GET /scim/v2/Users/:id',
  'GET /v1/auth/oidc/callback',
  'GET /v1/auth/oidc/login',
  'PATCH /_preview/:token/*',
  'PATCH /scim/v2/Groups/:id',
  'PATCH /scim/v2/Users/:id',
  'POST /_preview/:token/*',
  'POST /p/:projectId/v1/public/forms/:formKey',
  'POST /scim/v2/Users',
  'POST /v1/auth/email/verification',
  'POST /v1/auth/password/forgot',
  'POST /v1/auth/password/login',
  'POST /v1/auth/password/reset',
  'POST /v1/auth/register',
  'POST /v1/internal/metering/events',
  'POST /v1/webhooks/cloud/:provider',
  'POST /v1/webhooks/email/:provider',
  'POST /v1/webhooks/github',
  'POST /v1/webhooks/payments/:provider',
  'POST /v1/webhooks/registrars/:provider',
  'POST /v1/webhooks/workflows/:token',
  'PUT /_preview/:token/*',
  'PUT /scim/v2/Users/:id',
];
/** POSTs on organization routes without `@Idempotent()` at the baseline: owners confirm each is idempotent by construction (state machine, version check) or add the decorator. */
const POST_WITHOUT_IDEMPOTENCY_KEY: string[] = [
  // builder tools (Session 05), Master decision 2026-11-24: pure dry-run computations, nothing stored, no model call, no ledger; PROVEN by qa-builder-tools.int.spec.ts (row counts unchanged)
  'POST /v1/builder/plan-previews',
  'POST /v1/builder/projects/:projectId/change-previews',
  'POST /v1/ai/runs/:id/cancellation',
  'POST /v1/auth/email/verification/resend',
  'POST /v1/auth/logout',
  'POST /v1/auth/mfa/factors',
  'POST /v1/auth/mfa/factors/:id/verification',
  'POST /v1/auth/mfa/recovery-codes',
  'POST /v1/auth/password/change',
  'POST /v1/billing/spend-approvals/:id/decision',
  'POST /v1/billing/subscriptions/:id/cancellation',
  'POST /v1/builder/github/connect',
  'POST /v1/builder/projects/:id/changes',
  'POST /v1/builder/projects/:id/cms-collections',
  'POST /v1/builder/projects/:id/forms',
  'POST /v1/builder/projects/:id/previews',
  'POST /v1/builder/projects/:projectId/claude-code/sessions',
  'POST /v1/builder/projects/:projectId/github/link',
  'POST /v1/builder/projects/:projectId/instructions/versions/:version/restore',
  'POST /v1/builder/projects/:projectId/live-preview',
  'POST /v1/builder/template-recommendations',
  'POST /v1/compliance/data-exports',
  'POST /v1/email/domains/:id/verification',
  'POST /v1/email/suppressions',
  'POST /v1/invitations/:id/acceptance',
  'POST /v1/operations/:id/cancellation',
  'POST /v1/organizations',
  'POST /v1/organizations/:orgId/sso-connections',
];

const all = routes();

describe('QA route inventory: access declarations', () => {
  it('finds the controllers (the scanner itself is not blind)', () => {
    expect(all.length).toBeGreaterThan(450);
    expect(new Set(all.map((r) => r.file)).size).toBeGreaterThan(100);
  });
  it('every route declares who may call it', () => {
    const bad = all
      .filter(
        (r) =>
          !has(r, 'RequirePermission') &&
          !has(r, 'RequirePlatformPermission') &&
          !has(r, 'Public') &&
          !has(r, 'AnyAuthenticated'),
      )
      .map((r) => `${key(r)} (${r.file})`);
    expect(bad).toEqual([]);
  });
  it('every /v1/admin route needs a platform permission and is never public', () => {
    const bad = all
      .filter((r) => r.path.startsWith('/v1/admin/'))
      .filter((r) => !has(r, 'RequirePlatformPermission') || has(r, 'Public'))
      .map((r) => `${key(r)} (${r.file})`);
    expect(bad).toEqual([]);
  });
  it('no organization-scoped route mixes in a platform permission by accident (admin permissions only under /v1/admin)', () => {
    const bad = all
      .filter((r) => has(r, 'RequirePlatformPermission') && !r.path.startsWith('/v1/admin/'))
      .map((r) => `${key(r)} (${r.file})`);
    expect(bad).toEqual([]);
  });
});

describe('QA route inventory: unauthenticated surface is pinned', () => {
  it('the public routes are exactly the reviewed ones', () => {
    const d = diff(all.filter((r) => has(r, 'Public')).map(key), PUBLIC_ROUTES);
    expect({ newPublicRoutesNeedSecurityReview: d.added, staleEntries: d.stale }).toEqual({
      newPublicRoutesNeedSecurityReview: [],
      staleEntries: [],
    });
  });
  it('the AI engine areas expose no public route except the pinned webhooks', () => {
    const area =
      /^\/(v1\/(ai|builder|deployments|execution|benchmarks|sandboxes|hosting|compute)|p\/|_preview\/)/;
    const pub = all.filter((r) => has(r, 'Public') && area.test(r.path)).map(key);
    expect(pub.sort()).toEqual(
      [
        'DELETE /_preview/:token/*',
        'GET /_preview/:token',
        'GET /_preview/:token/*',
        'PATCH /_preview/:token/*',
        'POST /_preview/:token/*',
        'POST /p/:projectId/v1/public/forms/:formKey',
        'PUT /_preview/:token/*',
      ].sort(),
    );
  });
});

describe('QA route inventory: side-effecting POSTs carry an Idempotency-Key (CLAUDE.md section 4)', () => {
  const orgPosts = all.filter(
    (r) => r.method === 'POST' && !has(r, 'Public') && !has(r, 'RequirePlatformPermission'),
  );
  it('no NEW organization POST is missing @Idempotent, and no pinned exception is stale', () => {
    const d = diff(
      orgPosts.filter((r) => !has(r, 'Idempotent')).map(key),
      POST_WITHOUT_IDEMPOTENCY_KEY,
    );
    expect({ newPostsWithoutIdempotency: d.added, staleEntries: d.stale }).toEqual({
      newPostsWithoutIdempotency: [],
      staleEntries: [],
    });
  });
  it('the AI, builder, deployment and execution POSTs that create work are idempotent', () => {
    const create = orgPosts.filter(
      (r) =>
        /^\/v1\/(ai\/(runs|sessions)|deployments|execution|benchmarks|builder\/(generation-plans|projects\/from-template))(\/|$)/.test(
          r.path,
        ) && !/(cancellation|decisions)$/.test(r.path),
    );
    expect(create.length).toBeGreaterThan(3);
    for (const r of create) expect(has(r, 'Idempotent'), key(r)).toBe(true);
  });
});
