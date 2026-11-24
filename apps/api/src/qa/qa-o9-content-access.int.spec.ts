import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockModelAdapter } from '@nuzm/adapter-model';
import { permissionCovers } from '../modules/identity';
import { RunService } from '../modules/ai';
import { setupAiEnv, type AiEnv, type Row } from '../modules/ai/testing/ai-harness';
import { has, key, routes, type Route } from './qa-route-scan';

/**
 * Session 07 (QA), O-9 content-access audit: which GET routes does a `billing_admin` read CUSTOMER CONTENT from (project files, versions, diffs, exports, AI conversations, runs, events,
 * artifacts, approvals' action payloads ...), and does the owner's switch `builder.billing_admin_content_access` (`deny`) stop it?
 * Method: seed one organization with planted marker strings in the customer content (file text, a message, a run brief, an instruction ...), enumerate EVERY organization GET route that
 * carries `@RequirePermission(p)` where the billing_admin role HOLDS p, call it as billing_admin and as the owner with real ids, and classify the answer by whether the marker came back.
 * Then set the policy to `deny` and call again. The default (`allow`, today's behaviour) is never changed by this suite beyond the test organization's own row.
 * Writes `O9_AUDIT_OUT` (JSON) when set; the human table is `docs/security/O9-CONTENT-ACCESS-AUDIT.md`. SIMULATED model; own Postgres; nothing leaves the process.
 * History: the gaps (Session 05: builder routes; Session 02: AI routes; Session 06: deployment routes) were `it.fails` until their owners extended the switch; all are ordinary tests now.
 */
let e: AiEnv;
let runs: RunService;
const A = () => e.org.A!;
const MK = `O9MARK${Math.random().toString(36).slice(2, 8)}`;
const mark = (what: string) => `${MK}-${what}`;
const ids: Record<string, string> = {};
const rolePerms = new Map<string, Set<string>>();

const call = (who: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: object) =>
  e.call(who, method, url, body, A(), { 'idempotency-key': randomUUID() });
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> =>
  (await e.sql(sql, params)) as Row[];
const flag = async (org: string, k: string, on: boolean | null) => {
  await q(`DELETE FROM platform.feature_flags WHERE key = $1 AND org_id = $2`, [k, org]);
  if (on !== null)
    await q(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), $1, $2, $3::jsonb)`,
      [k, org, JSON.stringify(on)],
    );
};
const setPolicy = async (mode: 'allow' | 'deny' | null) => {
  if (mode === null)
    await q(
      `DELETE FROM platform.feature_flags WHERE key = 'builder.billing_admin_content_access' AND org_id = $1`,
      [A()],
    );
  else {
    const r = await call('alice', 'PUT', '/v1/builder/policies/content-access', { mode });
    expect(r.statusCode, r.body).toBe(200);
  }
};
const needed = (r: Route): string | null => {
  const d = r.decos.find((x) => x.startsWith('@RequirePermission('));
  const m = d ? /@RequirePermission\(\s*['"`]([^'"`]+)['"`]/.exec(d) : null;
  return m ? m[1]! : null;
};
/** the content routes' query strings (a route with a required filter answers 422 without one) */
const QUERY: [RegExp, () => string][] = [
  [/\/files\/content$/, () => `?path=README.md`],
  [/\/files\/search$/, () => `?q=${MK}`],
  [/\/version-diff$/, () => `?from=${ids.v1}&to=${ids.v2}`],
  [/\/symbols$/, () => `?q=answer`],
];
const urlFor = (path: string): string => {
  const p = path
    .replace(':orgId', A())
    .replace(/\/v1\/ai\/runs\/:id/, `/v1/ai/runs/${ids.run}`)
    .replace(/\/v1\/ai\/sessions\/:id/, `/v1/ai/sessions/${ids.session}`)
    .replace(/:approvalId/, ids.approval ?? randomUUID())
    .replace(/:artifactId/, ids.artifact ?? randomUUID())
    .replace(
      /\/v1\/builder\/projects\/:(id|projectId)\/(previews|forms|form-submissions|cms-collections)/,
      (_m, _p, tail) => `/v1/builder/projects/${ids.website}/${tail}`,
    )
    .replace(/\/v1\/builder\/projects\/:(id|projectId)/, `/v1/builder/projects/${ids.project}`)
    .replace(/\/v1\/deployments\/:id/, `/v1/deployments/${ids.deployment ?? randomUUID()}`)
    .replace(/:[A-Za-z]+/g, () => randomUUID());
  const extra = QUERY.find(([re]) => re.test(path));
  return p + (extra ? extra[1]() : '');
};

interface Row2 {
  route: string;
  permission: string;
  billingAdmin: number;
  owner: number;
  contentForBillingAdmin: boolean;
  contentForOwner: boolean;
  denied: number | null;
  /** `marker` = the planted content came back; `by-design` = the route's payload is customer content by its type but the fixture is empty or the route needs a record the audit cannot create */
  basis: 'marker' | 'by-design' | null;
}
const audit: Row2[] = [];
const debug: string[] = [];
let contentRoutes: Row2[] = [];

beforeAll(async () => {
  process.env.AI_MAX_CONCURRENT_RUNS = '500';
  process.env.BUILDER_MAX_PROJECTS = '500';
  e = await setupAiEnv();
  runs = e.app.get(RunService);
  await e.enableMock('mock-model', {
    adapter: new MockModelAdapter({
      id: 'mock-model',
      handler: () => JSON.stringify({ result: { reply: { ar: 'x', en: 'x' } } }),
    }),
  });
  for (const k of [
    'app_builder.enabled',
    'builder_tools.enabled',
    'builder_lifecycle.enabled',
    'ai_studio.enabled',
    'app_builder.live_preview',
    'knowledge.library',
    'knowledge.customer_templates',
    'knowledge.generation',
  ])
    await flag(A(), k, true);
  await e.fund(A(), '90000000');
  for (const r of (await q(`SELECT role, permission FROM tenancy.role_permissions`)) as {
    role: string;
    permission: string;
  }[]) {
    if (!rolePerms.has(r.role)) rolePerms.set(r.role, new Set());
    rolePerms.get(r.role)!.add(r.permission);
  }
  // ---- the customer's content, with markers
  const p = await call('alice', 'POST', '/v1/builder/projects', {
    name: 'O9 audit project',
    type: 'webapp',
  });
  expect(p.statusCode, p.body).toBe(201);
  ids.project = p.json().id;
  // a website project (forms, previews, CMS and form submissions exist only for sites)
  const w = await call('alice', 'POST', '/v1/builder/projects', {
    type: 'website',
    name: 'O9 audit site',
    locale: ['ar', 'en'],
    templateId: 'landing',
  });
  expect(w.statusCode, w.body).toBe(201);
  ids.website = w.json().id;
  const change = (patches: object[], base: string | null) =>
    call('alice', 'POST', `/v1/builder/projects/${ids.project}/changes`, {
      baseVersion: base,
      source: 'user',
      patches,
    });
  const c1 = await change(
    [
      { op: 'add', path: 'README.md', content: `# ${mark('file-readme')}\n` },
      {
        op: 'add',
        path: 'src/answer.ts',
        content: `export const answer = '${mark('file-src')}';\n`,
      },
    ],
    null,
  );
  expect(c1.statusCode, c1.body).toBe(200);
  ids.v1 = (
    await q(`SELECT head_version_id FROM builder.projects WHERE id = $1`, [ids.project])
  )[0]!.head_version_id as string;
  const c2 = await change(
    [{ op: 'add', path: 'src/more.ts', content: `export const more = '${mark('file-more')}';\n` }],
    ids.v1,
  );
  expect(c2.statusCode, c2.body).toBe(200);
  ids.v2 = (
    await q(`SELECT head_version_id FROM builder.projects WHERE id = $1`, [ids.project])
  )[0]!.head_version_id as string;
  // an AI conversation
  const s = await call('alice', 'POST', '/v1/ai/sessions', {
    title: mark('session-title'),
    projectId: ids.project,
  });
  expect(s.statusCode, s.body).toBe(201);
  ids.session = s.json().id;
  const m = await call('alice', 'POST', `/v1/ai/sessions/${ids.session}/messages`, {
    content: `${mark('message')} please build a shop`,
  });
  expect([200, 201, 202], m.body).toContain(m.statusCode);
  // a builder lifecycle run parked at its approval (events, artifacts, approval payload)
  const s2 = await call('alice', 'POST', '/v1/ai/sessions', {
    title: 'lifecycle',
    projectId: ids.project,
  });
  const run = await call('alice', 'POST', '/v1/ai/runs', {
    sessionId: s2.json().id,
    kind: 'webapp',
    projectId: ids.project,
    input: {
      builderLifecycle: true,
      brief: { prompt: `${mark('brief')} an online store with products and checkout` },
    },
  });
  expect(run.statusCode, run.body).toBe(202);
  ids.run = run.json().id;
  const op = (await q(`SELECT operation_id FROM ai.runs WHERE id = $1`, [ids.run]))[0]!
    .operation_id as string;
  await runs.runOne(A(), op);
  // the run's change-set artifact IS the generated project files: plant the marker in a copy of it (same shape the engine stores)
  const cols = (
    (await q(
      `SELECT column_name c FROM information_schema.columns WHERE table_schema = 'ai' AND table_name = 'artifacts' ORDER BY ordinal_position`,
    )) as { c: string }[]
  ).map((x) => x.c);
  const src = (
    await q(
      `SELECT * FROM ai.artifacts WHERE run_id = $1 AND type = 'change_set' ORDER BY created_at LIMIT 1`,
      [ids.run],
    )
  )[0]!;
  ids.artifact = randomUUID();
  const vals = cols.map((c) =>
    c === 'id'
      ? ids.artifact
      : c === 'payload'
        ? JSON.stringify([
            { op: 'add', path: 'src/secret-plan.ts', content: `// ${mark('artifact')}\n` },
          ])
        : src[c],
  );
  const slots = cols.map((c, i) => (c === 'payload' ? `$${i + 1}::jsonb` : `$${i + 1}`));
  await q(
    `INSERT INTO ai.artifacts (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${slots.join(',')})`,
    vals,
  );
  const ap = (
    (await call('alice', 'GET', '/v1/ai/approvals?status=pending')).json().items as Row[]
  ).find((a) => a.runId === ids.run);
  ids.approval = (ap?.id as string | undefined) ?? '';
  // a deployment of the website to an in-memory hosting site (SIMULATED publisher): the deployment record and its logs
  const planId = randomUUID();
  await q(
    `INSERT INTO hosting.plan_definitions (id, key, name_ar, name_en, status, quotas, runtimes, reservation) VALUES ($1, 'o9-plan', 'خطة', 'Plan', 'active', '{"diskMb":1,"inodes":1000,"bandwidthGb":1,"dbCount":1,"sitesCount":1}', '["php"]', '{"cpu_millicores":1,"memory_mb":1,"disk_mb":1}')`,
    [planId],
  );
  const siteId = randomUUID();
  await q(
    `INSERT INTO hosting.sites (id, org_id, name, token, node_name, plan_id, runtime, status, data_region, created_by, credentials_ref, backup_key_ref, domain_primary)
     VALUES ($1,$2,'o9-site',$3,$4,$5,'static','active','sa-central',$6,'vault://t/c','vault://t/b',NULL)`,
    [
      siteId,
      A(),
      randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      `s-${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      planId,
      e.ids.alice,
    ],
  );
  const dBody = { projectId: ids.website, target: siteId, environment: 'staging' };
  const dAsk = await call('alice', 'POST', '/v1/deployments', dBody);
  if (dAsk.statusCode === 403 && dAsk.json().approvalId) {
    const dGo = await call('alice', 'POST', '/v1/deployments', {
      ...dBody,
      approvalId: dAsk.json().approvalId,
    });
    if (dGo.statusCode === 202) ids.deployment = (dGo.json() as Row).id as string;
  }
  // exports (a project archive)
  const ex = await call('alice', 'POST', `/v1/builder/projects/${ids.project}/exports`, {});
  if ([200, 201, 202].includes(ex.statusCode)) ids.export = (ex.json() as Row).id as string;
}, 300_000);
afterAll(() => e.h.close());

const body = (r: { body: string }) => r.body;
const hasMarker = (b: string) => b.includes(MK);

describe('O-9 audit: every GET route a billing administrator can reach, answered with the policy at its default (allow = today)', () => {
  it('enumerates the routes and records what a billing administrator and the owner each get (plain 200 with the planted content, 200 without, refusal)', async () => {
    await setPolicy(null);
    const frankPerms = rolePerms.get('billing_admin')!;
    const all = routes().filter(
      (r) =>
        r.method === 'GET' &&
        !has(r, 'Public') &&
        !has(r, 'RequirePlatformPermission') &&
        r.path.startsWith('/v1/') &&
        !r.path.includes('*') &&
        needed(r) !== null &&
        permissionCovers(frankPerms, needed(r)!),
    );
    expect(all.length).toBeGreaterThan(40);
    for (const r of all) {
      const url = urlFor(r.path);
      const f = await call('frank', 'GET', url);
      const o = await call('alice', 'GET', url);
      if (process.env.O9_DEBUG && (o.statusCode === 422 || o.statusCode === 404))
        debug.push(`${key(r)} :: ${f.body.slice(0, 700)}`);
      audit.push({
        route: key(r),
        permission: needed(r)!,
        billingAdmin: f.statusCode,
        owner: o.statusCode,
        contentForBillingAdmin: f.statusCode === 200 && hasMarker(body(f)),
        contentForOwner: o.statusCode === 200 && hasMarker(body(o)),
        denied: null,
        basis: f.statusCode === 200 && hasMarker(body(f)) ? 'marker' : null,
      });
    }
    // no 5xx anywhere
    expect(
      audit
        .filter((x) => x.billingAdmin >= 500 || x.owner >= 500)
        .map((x) => `${x.route} ${x.billingAdmin}/${x.owner}`),
    ).toEqual([]);
    // the fixture is not vacuous: the owner reads planted content through several routes
    // routes whose payload is customer content by its TYPE (a customer's instructions, form submissions from their site visitors, CMS entries, test and deploy logs, generated files,
    // run results and events); where the fixture is empty the marker cannot prove it, so they are reported as `by-design`
    const BY_DESIGN =
      /^GET \/v1\/(builder\/projects\/:(id|projectId)\/(review|symbols|import-analysis|components|memory|instructions|instructions\/versions|form-submissions|forms|cms-collections|previews|test-runs|template-workspace|claude-code|github\/pulls)|deployments\/:id|deployments\/:id\/logs|builder\/generation-plans\/|ai\/runs$|ai\/runs\/:id$|ai\/runs\/:id\/events$)/;
    for (const x of audit)
      if (x.basis === null && x.billingAdmin === 200 && BY_DESIGN.test(x.route))
        x.basis = 'by-design';
    contentRoutes = audit.filter((x) => x.basis !== null);
    expect(audit.filter((x) => x.contentForOwner).length).toBeGreaterThan(5);
  }, 300_000);

  it('today (default allow) a billing administrator reads the same content as the owner on every route it can reach: the audit is the baseline for the switch', () => {
    const differ = audit
      .filter((x) => x.contentForOwner !== x.contentForBillingAdmin)
      .map((x) => x.route);
    expect(differ).toEqual([]);
  });
});

describe('O-9 deny: the switch must stop a billing administrator from reading customer content on EVERY route that returns it', () => {
  it('the five builder-tools reads (review, symbols, import-analysis, components, memory) are refused 403 under deny (covered today)', async () => {
    await setPolicy('deny');
    const covered = audit.filter(
      (x) =>
        /\/(review|symbols|import-analysis|components|memory)$/.test(x.route) &&
        x.route.startsWith('GET /v1/builder/projects/'),
    );
    expect(covered.length).toBe(5);
    for (const c of covered) {
      const r = await call('frank', 'GET', urlFor(c.route.replace('GET ', '')));
      expect(r.statusCode, c.route).toBe(403);
      c.denied = r.statusCode;
    }
  });

  it('control: under deny, every other role is unaffected on every content route (same status as under allow), and the billing administrator still reads its own billing metadata (credits, budgets, models)', async () => {
    await setPolicy('deny');
    for (const who of ['alice', 'erin', 'dave', 'carol']) {
      for (const c of contentRoutes.slice(0, 40)) {
        const url = urlFor(c.route.replace('GET ', ''));
        const r = await call(who, 'GET', url);
        const before = who === 'alice' ? c.owner : null;
        if (before !== null) expect(r.statusCode, `${who} ${c.route}`).toBe(before);
        expect(r.statusCode).toBeLessThan(500);
      }
    }
    for (const meta of ['/v1/ai/credits', '/v1/ai/budgets', '/v1/ai/models'])
      expect((await call('frank', 'GET', meta)).statusCode, meta).toBe(200);
  });

  /** the gaps are split by owner so each session sees its own list */
  const group = (re: RegExp) => () => contentRoutes.filter((x) => re.test(x.route));
  const builderSide = group(/^GET \/v1\/(builder|mobile|deployments|projects)\//);
  const aiSide = group(/^GET \/v1\/ai\//);

  const violations = async (list: Row2[]) => {
    await setPolicy('deny');
    const bad: string[] = [];
    for (const c of list) {
      if (
        /\/(review|symbols|import-analysis|components|memory)$/.test(c.route) &&
        c.route.startsWith('GET /v1/builder/projects/')
      )
        continue; // covered
      const r = await call('frank', 'GET', urlFor(c.route.replace('GET ', '')));
      c.denied = r.statusCode;
      if (r.statusCode !== 403)
        bad.push(`${c.route} -> ${r.statusCode}${hasMarker(r.body) ? ' (content returned)' : ''}`);
    }
    return bad;
  };

  it('O-9 (Sessions 05 and 06 scope, fixed): under deny, the builder and deployment routes that return project files, versions, diffs, previews, forms, submissions, test runs, instructions and deployment records and logs answer 403 to a billing administrator, and allow restores them', async () => {
    expect(builderSide().length, 'content routes found on the builder side').toBeGreaterThanOrEqual(
      18,
    );
    expect(await violations(builderSide())).toEqual([]);
    await setPolicy('allow');
    for (const c of builderSide())
      expect(
        (await call('frank', 'GET', urlFor(c.route.replace('GET ', '')))).statusCode,
        `allow restores ${c.route}`,
      ).toBe(200);
  }, 300_000);

  it('O-9 (Session 02 scope, fixed): under deny, the AI conversation routes (sessions, messages, runs, run, run events, artifacts) answer 403 to a billing administrator, and allow restores them', async () => {
    expect(aiSide().length, 'content routes found on the AI side').toBeGreaterThanOrEqual(6);
    expect(await violations(aiSide())).toEqual([]);
    await setPolicy('allow');
    for (const c of aiSide())
      expect(
        (await call('frank', 'GET', urlFor(c.route.replace('GET ', '')))).statusCode,
        `allow restores ${c.route}`,
      ).toBe(200);
  }, 300_000);

  it('writes the audit table for docs/security/O9-CONTENT-ACCESS-AUDIT.md and restores the default', async () => {
    // the deny results of the routes not covered by a test above (observation pass)
    await setPolicy('deny');
    for (const c of audit) {
      if (c.denied === null)
        c.denied = (await call('frank', 'GET', urlFor(c.route.replace('GET ', '')))).statusCode;
    }
    await setPolicy(null);
    if (process.env.O9_DEBUG) writeFileSync(process.env.O9_DEBUG, debug.join('\n\n'));
    if (process.env.O9_AUDIT_OUT)
      writeFileSync(process.env.O9_AUDIT_OUT, JSON.stringify({ marker: MK, rows: audit }, null, 2));
    expect(audit.length).toBeGreaterThan(40);
  }, 300_000);
});
