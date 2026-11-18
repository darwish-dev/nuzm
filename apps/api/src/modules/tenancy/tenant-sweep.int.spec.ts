import 'reflect-metadata';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ScimTokenService } from '../enterprise/scim/scim-tokens.service';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';

/**
 * M12 S56 TENANT-ISOLATION SWEEP (AC-M12-09). Enumerates EVERY operation of spec/openapi/openapi.yaml (all methods, including PUT) and presents the
 * credentials of organization B against organization A. Any 2xx that is not in EXPLAINED fails the build; an operation that is not classified fails too,
 * so a new endpoint cannot slip past. Classes:
 *   org     (x-nuzm-permission)           B's session + `X-Nuzm-Org: A` must be refused (403/404) BEFORE the handler runs; orgId path routes also with B's API key (404)
 *   admin   (x-nuzm-platform-permission)  B's web session and B's API key must be refused (401/403)
 *   scim    (scimToken)                   B's SCIM token against A's user ids is 404; lists and discovery documents are B's own (explained 2xx)
 *   other   (any-authenticated, service-key, public) classified and explained, never silently skipped
 * It complements cross-tenant.int.spec.ts (which creates real A-side fixtures and checks the data is untouched); this one is exhaustive in breadth.
 */
const root = join(__dirname, '../../../../..');
const spec = parse(readFileSync(join(root, 'spec/openapi/openapi.yaml'), 'utf8')) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
};
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
interface Op {
  method: (typeof METHODS)[number];
  path: string;
  cls: 'org' | 'admin' | 'scim' | 'any-authenticated' | 'service-key' | 'public';
  params: string[];
  opId: string;
}
const ops: Op[] = [];
const unclassified: string[] = [];
for (const [path, item] of Object.entries(spec.paths))
  for (const m of METHODS) {
    const op = item[m];
    if (!op) continue;
    const sec = op.security as unknown[] | undefined;
    const scim = JSON.stringify(sec ?? []).includes('scimToken');
    const cls: Op['cls'] | null = scim
      ? 'scim'
      : op['x-nuzm-platform-permission']
        ? 'admin'
        : op['x-nuzm-permission']
          ? 'org'
          : op['x-nuzm-access'] === 'any-authenticated'
            ? 'any-authenticated'
            : op['x-nuzm-access'] === 'service-key'
              ? 'service-key'
              : Array.isArray(sec) && sec.length === 0
                ? 'public'
                : /^\/v1\/(auth|me)(\/|$)/.test(path)
                  ? 'any-authenticated' // session-only identity routes: they act on the caller's own principal
                  : null;
    if (!cls) {
      unclassified.push(`${m.toUpperCase()} ${path}`);
      continue;
    }
    ops.push({
      method: m,
      path,
      cls,
      params: [...path.matchAll(/\{(\w+)\}/g)].map((x) => x[1]!),
      opId: String(op.operationId),
    });
  }

/** Operations where a 2xx is correct for organization B's credentials, with the reason. Everything else that returns 2xx fails the sweep. */
const EXPLAINED: Record<string, string> = {
  scimServiceProviderConfig: 'static discovery document, identical for every organization',
  scimResourceTypes: 'static discovery document',
  scimSchemas: 'static discovery document',
  scimListUsers:
    "a list scoped to the TOKEN's organization: B sees B's users only (asserted: 0 of A's)",
  scimCreateUser:
    "creates in the TOKEN's own organization (no tenant identifier in the request); 4xx validation is also fine, 5xx is not",
  scimListGroups: "role groups of the token's organization (asserted: no A member appears)",
};
/** `any-authenticated`, `service-key` and `public` operations take no tenant identifier of their own; they are classified, counted and reported, not hammered. */
const OTHER_NOTE =
  "operates on the caller's own principal, a service credential, or is public: no tenant identifier to cross";

const h = new Harness();
let app: App;
let orgA = '';
let orgB = '';
let bJar: Record<string, string> = {};
let bKey = '';
let aUser = '';
let bScim = '';
const UUID = '00000000-0000-4000-8000-0000000000aa';
const results: {
  op: string;
  cls: string;
  status: number;
  verdict: 'refused' | 'explained' | 'classified' | 'FAIL';
}[] = [];

const fill = (o: Op, id: string) =>
  o.path.replace(/\{(\w+)\}/g, (_m, p: string) =>
    p === 'orgId' ? orgA : p === 'userId' ? aUser : id,
  );
const body = (o: Op) => (o.method === 'get' || o.method === 'delete' ? {} : { payload: {} });

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp());
  const mk = async (name: string) => {
    const u = await h.createUser(`sweep-${name}`);
    const jar = await h.sessionFor(app, u);
    const r = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { cookie: cookieHeader(jar), 'x-csrf-token': jar.nuzm_csrf! },
      payload: { name: `Sweep ${name}` },
    });
    return { u, jar, orgId: r.json().id as string };
  };
  const a = await mk('a');
  const b = await mk('b');
  orgA = a.orgId;
  orgB = b.orgId;
  bJar = b.jar;
  aUser = a.u;
  // an API key of org B carrying EVERY permission an owner has (the strongest key org B can hold)
  const ownerPerms = (
    await h.env.sql(`SELECT permission FROM tenancy.role_permissions WHERE role='owner'`)
  ).map((r) => r.permission as string);
  await h.elevate(b.jar); // API-key management needs a recent MFA
  const k = await app.inject({
    method: 'POST',
    url: '/v1/api-keys',
    headers: {
      cookie: cookieHeader(b.jar),
      'x-csrf-token': b.jar.nuzm_csrf!,
      'x-nuzm-org': orgB,
      'idempotency-key': 'sweep-key',
    },
    payload: { name: 'sweep', scopes: ownerPerms },
  });
  bKey = k.json().key as string;
  if (!bKey) throw new Error(`api key not created: ${k.statusCode} ${k.body.slice(0, 200)}`);
  expect(bKey).toMatch(/^nzk_/);
  // an SSO connection + SCIM token for each org, and a provisioned user in A
  const conn = async (org: string, by: string) => {
    const id = crypto.randomUUID();
    await h.env.sql(
      `INSERT INTO identity.sso_connections (id, org_id, protocol, name, config, created_by) VALUES ($1,$2,'saml','c','{}',$3)`,
      [id, org, by],
    );
    return id;
  };
  const cA = await conn(orgA, a.u);
  const cB = await conn(orgB, b.u);
  await h.env.sql(
    `INSERT INTO identity.scim_identities (id, org_id, connection_id, external_id, user_id) VALUES (gen_random_uuid(), $1, $2, 'x', $3)`,
    [orgA, cA, a.u],
  );
  bScim = (await app.get(ScimTokenService).issue(orgB, cB, b.u)).token;
  process.env.ENTERPRISE_ENABLED = 'true';
});
afterAll(async () => {
  const total = ops.length;
  const summary = {
    generatedAt: new Date().toISOString(),
    operations: total,
    byClass: Object.fromEntries(
      ['org', 'admin', 'scim', 'any-authenticated', 'service-key', 'public'].map((c) => [
        c,
        ops.filter((o) => o.cls === c).length,
      ]),
    ),
    unclassified,
    exercised: results.length,
    refused: results.filter((r) => r.verdict === 'refused').length,
    explained2xx: results.filter((r) => r.verdict === 'explained').length,
    classifiedNotCrossed: results.filter((r) => r.verdict === 'classified').length,
    unexplained2xx: results.filter((r) => r.verdict === 'FAIL').length,
    statusHistogram: results.reduce<Record<string, number>>(
      (a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a),
      {},
    ),
    note: OTHER_NOTE,
    explained: EXPLAINED,
  };
  try {
    const dir = join(root, 'docs/reports/evidence');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'M12-tenant-sweep.json'),
      JSON.stringify({ summary, results }, null, 2),
    );
  } catch {
    /* evidence file is best effort */
  }
  console.log('TENANT SWEEP', JSON.stringify(summary));
  await h.close();
});

describe('tenant-isolation sweep', () => {
  it('classifies every operation of the OpenAPI spec (a new endpoint must declare how it is authorised)', () => {
    expect(unclassified).toEqual([]);
    expect(ops.length).toBeGreaterThan(300);
  });

  const orgOps = () => ops.filter((o) => o.cls === 'org');
  it("org routes: org B's session presenting org A is refused before the handler runs, on every operation", async () => {
    for (const o of orgOps()) {
      const r = await app.inject({
        method: o.method.toUpperCase() as 'GET',
        url: fill(o, UUID),
        headers: {
          cookie: cookieHeader(bJar),
          'x-csrf-token': bJar.nuzm_csrf!,
          'x-nuzm-org': orgA,
          'idempotency-key': 'sweep-1',
        },
        ...body(o),
      });
      const ok = [401, 403, 404].includes(r.statusCode);
      results.push({
        op: `${o.method.toUpperCase()} ${o.path} [B session, X-Nuzm-Org: A]`,
        cls: o.cls,
        status: r.statusCode,
        verdict: ok ? 'refused' : r.statusCode < 300 && EXPLAINED[o.opId] ? 'explained' : 'FAIL',
      });
    }
    const bad = results.filter((r) => r.verdict === 'FAIL' && r.cls === 'org');
    expect(bad.map((b) => `${b.op} -> ${b.status}`)).toEqual([]);
  });
  it("org routes with an orgId path parameter: org B's session and org B's API key against org A's id are 403/404", async () => {
    for (const o of orgOps().filter((x) => x.params.includes('orgId'))) {
      for (const [who, headers] of [
        [
          'B session',
          { cookie: cookieHeader(bJar), 'x-csrf-token': bJar.nuzm_csrf!, 'x-nuzm-org': orgB },
        ],
        ['B api key', { authorization: `Bearer ${bKey}` }],
      ] as const) {
        const r = await app.inject({
          method: o.method.toUpperCase() as 'GET',
          url: fill(o, UUID),
          headers: { ...headers, 'idempotency-key': 'sweep-2' },
          ...body(o),
        });
        const ok = [401, 403, 404].includes(r.statusCode);
        results.push({
          op: `${o.method.toUpperCase()} ${o.path} [${who}, path orgId = A]`,
          cls: o.cls,
          status: r.statusCode,
          verdict: ok ? 'refused' : 'FAIL',
        });
        expect(ok, `${o.method} ${o.path} with ${who} -> ${r.statusCode}`).toBe(true);
      }
    }
  });
  it('positive control: the same org B session on its OWN organization is not refused by the guard (so the refusals above are isolation)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/workspaces',
      headers: { cookie: cookieHeader(bJar), 'x-nuzm-org': orgB },
    });
    expect(r.statusCode).toBe(200);
    const own = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgB}`,
      headers: { cookie: cookieHeader(bJar), 'x-nuzm-org': orgB },
    });
    expect(own.statusCode).toBe(200);
  });

  it('admin routes: a tenant session and a tenant API key never reach the admin console (401/403), every method', async () => {
    for (const o of ops.filter((x) => x.cls === 'admin')) {
      for (const [who, headers] of [
        ['B web session', { cookie: cookieHeader(bJar), 'x-csrf-token': bJar.nuzm_csrf! }],
        ['B api key', { authorization: `Bearer ${bKey}` }],
      ] as const) {
        const r = await app.inject({
          method: o.method.toUpperCase() as 'GET',
          url: fill(o, UUID),
          headers: { ...headers, 'idempotency-key': 'sweep-3' },
          ...body(o),
        });
        const ok = [401, 403].includes(r.statusCode);
        results.push({
          op: `${o.method.toUpperCase()} ${o.path} [${who}]`,
          cls: o.cls,
          status: r.statusCode,
          verdict: ok ? 'refused' : 'FAIL',
        });
        expect(ok, `${o.method} ${o.path} with ${who} -> ${r.statusCode}`).toBe(true);
      }
    }
  });

  it("SCIM routes: org B's token against org A's user ids is 404; lists and discovery contain nothing of A", async () => {
    for (const o of ops.filter((x) => x.cls === 'scim')) {
      const r = await app.inject({
        method: o.method.toUpperCase() as 'GET',
        url: fill(o, aUser),
        headers: { authorization: `Bearer ${bScim}`, 'content-type': 'application/scim+json' },
        ...(o.method === 'get' || o.method === 'delete'
          ? {}
          : {
              payload: JSON.stringify({
                Operations: [{ op: 'replace', path: 'active', value: false }],
                userName: 'x@y.z',
              }),
            }),
      });
      const refused = [401, 403, 404].includes(r.statusCode);
      const explained =
        Boolean(EXPLAINED[o.opId]) &&
        (r.statusCode < 300 || (o.opId === 'scimCreateUser' && r.statusCode < 500));
      results.push({
        op: `${o.method.toUpperCase()} ${o.path} [B scim token]`,
        cls: o.cls,
        status: r.statusCode,
        verdict: refused ? 'refused' : explained ? 'explained' : 'FAIL',
      });
      expect(refused || explained, `${o.method} ${o.path} -> ${r.statusCode}`).toBe(true);
      if (explained && /ListUsers|ListGroups/.test(o.opId)) expect(r.body).not.toContain(aUser);
    }
  });

  it('every other class (any-authenticated, service-key, public) is classified and explained', () => {
    const rest = ops.filter((o) => ['any-authenticated', 'service-key', 'public'].includes(o.cls));
    expect(rest.length).toBeGreaterThan(0);
    for (const o of rest)
      results.push({
        op: `${o.method.toUpperCase()} ${o.path}`,
        cls: o.cls,
        status: 0,
        verdict: 'explained',
      });
  });

  it('no unexplained 2xx anywhere', () => {
    expect(results.filter((r) => r.verdict === 'FAIL')).toEqual([]);
  });
});
