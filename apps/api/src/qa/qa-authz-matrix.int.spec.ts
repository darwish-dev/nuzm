import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionCovers } from '../modules/identity';
import { setupAiEnv, type AiEnv } from '../modules/ai/testing/ai-harness';
import { has, key, routes, type Route } from './qa-route-scan';

/**
 * Session 07 (QA) - the live authorization matrix of EVERY organization-scoped route against the real guard (own Postgres, in-process server; nothing leaves the process).
 * For each route that declares `@RequirePermission(p)` and each principal:
 *   - an unauthenticated request            -> 401 (the handler never runs)
 *   - a signed-in user who is NOT a member  -> 404 (existence hiding: "not a member == no such organization")
 *   - a member whose role lacks `p`         -> 403 (viewer, billing_admin, developer, admin, owner are checked against the role-permission table that is in the database)
 * These calls are all refused by the global guard before any handler or side effect, so the matrix is safe to run over the whole API; it covers the routes the parallel
 * sessions add the day they are merged (the route list is scanned from source). A second block sweeps the read-only routes as the owner and requires "no server error".
 * The expectation for a role that HOLDS the permission is deliberately not asserted for writes (a handler may answer 404/409/422 for a made-up id).
 */
let e: AiEnv;
const ROLES = [
  ['carol', 'viewer'],
  ['frank', 'billing_admin'],
  ['dave', 'developer'],
  ['erin', 'admin'],
  ['alice', 'owner'],
] as const;
const rolePerms = new Map<string, Set<string>>();

const needed = (r: Route): string | null => {
  const d = r.decos.find((x) => x.startsWith('@RequirePermission('));
  const m = d ? /@RequirePermission\(\s*['"`]([^'"`]+)['"`]/.exec(d) : null;
  return m ? m[1]! : null;
};
const fill = (path: string, orgId: string): string =>
  path.replace(/:([A-Za-z]+)/g, (_m, name: string) => (name === 'orgId' ? orgId : randomUUID()));

const orgRoutes = routes().filter(
  (r) =>
    !has(r, 'Public') &&
    !has(r, 'RequirePlatformPermission') &&
    needed(r) !== null &&
    r.path.startsWith('/v1/') &&
    !r.path.includes('*'),
);

beforeAll(async () => {
  e = await setupAiEnv();
  const rows = await e.sql(`SELECT role, permission FROM tenancy.role_permissions`);
  for (const r of rows as { role: string; permission: string }[]) {
    if (!rolePerms.has(r.role)) rolePerms.set(r.role, new Set());
    rolePerms.get(r.role)!.add(r.permission);
  }
}, 180_000);
afterAll(() => e.h.close());

const send = (who: string | null, r: Route, org: string) => {
  const url = fill(r.path, org);
  const body = r.method === 'POST' || r.method === 'PUT' || r.method === 'PATCH' ? {} : undefined;
  if (who) return e.call(who, r.method as 'GET', url, body, org);
  return e.app.inject({
    method: r.method as 'GET',
    url,
    headers: { 'x-nuzm-org': org, 'idempotency-key': `k-${Math.random()}` },
    ...(body ? { payload: body } : {}),
  });
};

describe('QA authz matrix: the scanner and the role table are sane', () => {
  it('scans a few hundred organization routes', () => {
    expect(orgRoutes.length).toBeGreaterThan(250);
  });
  it('the role table is the one the matrix assumes (owner holds more than viewer; viewer cannot write AI, builder or deploy)', () => {
    const viewer = rolePerms.get('viewer')!;
    for (const p of [
      'ai:write',
      'ai:approve',
      'deploy:write',
      'builder:write',
      'sandbox:use',
      'ai:budgets:write',
    ])
      expect(permissionCovers(viewer, p), `viewer holds ${p}`).toBe(false);
    expect(permissionCovers(rolePerms.get('owner')!, 'ai:write')).toBe(true);
    expect(permissionCovers(rolePerms.get('billing_admin')!, 'deploy:write')).toBe(false);
  });
});

describe('QA authz matrix: unauthenticated and non-member callers', () => {
  it('every organization route answers 401 without a session', async () => {
    const bad: string[] = [];
    for (const r of orgRoutes) {
      const res = await send(null, r, e.org.A!);
      if (res.statusCode !== 401) bad.push(`${key(r)} -> ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  }, 300_000);

  it('every organization route answers 404 to a signed-in user who is not a member (no existence oracle, no data)', async () => {
    const bad: string[] = [];
    for (const r of orgRoutes) {
      const res = await send('bob', r, e.org.A!); // bob owns org B only
      if (res.statusCode !== 404) bad.push(`${key(r)} -> ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  }, 300_000);
});

describe('QA authz matrix: a member whose role lacks the permission is refused with 403', () => {
  for (const [who, role] of ROLES) {
    it(`${role}: every route whose permission the role does not hold answers 403`, async () => {
      const perms = rolePerms.get(role)!;
      const denied = orgRoutes.filter((r) => !permissionCovers(perms, needed(r)!));
      const bad: string[] = [];
      for (const r of denied) {
        const res = await send(who, r, e.org.A!);
        if (res.statusCode !== 403) bad.push(`${key(r)} needs ${needed(r)} -> ${res.statusCode}`);
      }
      // the three restricted roles must be refused somewhere, otherwise the matrix would pass vacuously (owner and admin hold every organization permission: 0 denied)
      if (!['owner', 'admin'].includes(role)) expect(denied.length).toBeGreaterThan(20);
      expect(bad).toEqual([]);
    }, 300_000);
  }
});

describe('QA authz matrix: read-only routes never answer with a server error for the owner (garbage ids, empty query)', () => {
  it('GET routes: no 5xx', async () => {
    const gets = orgRoutes.filter((r) => r.method === 'GET');
    const bad: string[] = [];
    for (const r of gets) {
      const res = await send('alice', r, e.org.A!);
      if (res.statusCode >= 500)
        bad.push(`${key(r)} -> ${res.statusCode} ${res.body.slice(0, 120)}`);
    }
    expect(bad).toEqual([]);
  }, 300_000);
});
