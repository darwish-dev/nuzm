import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockModelAdapter } from '@nuzm/adapter-model';
import { RunService } from '../ai';
import { cookieHeader } from '../identity/testing/app-harness';
import { setupAiEnv, type AiEnv, type Row } from '../ai/testing/ai-harness';
import { InMemorySitePublisher, SitePublisherPort } from '../deploy';
import {
  AppDeploymentService,
  ApprovalService,
  AppSpecService,
  ProjectsPort,
  RunStorePort,
} from './index';
import { HealthProbePort, ScriptedHealthProbe } from './internal/deploy/ports';
import { MockSandboxRuntime } from './internal/sandbox/mock-runtime';
import { SandboxRuntime } from './internal/sandbox/runtime';
import { CRM_SPEC } from './internal/fixtures/crm-appspec';
import { packageJson } from './internal/gen/project';

/**
 * M10A on the REAL M09 services (no in-memory stand-in): projects in `builder.*`, runs in `ai.runs` driven by M09's segment engine, model calls through
 * `GatewayService` (the deterministic MOCK provider: plumbing only, model quality NOT VERIFIED), artifacts in `ai.artifacts`, credits from the wallet.
 */
let e: AiEnv;
let runs: RunService;
const probe = new ScriptedHealthProbe();
const A = () => e.org.A!;
const B = () => e.org.B!;
const call = (
  who: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: object,
  org = A(),
) => e.call(who, method, url, body, org);

/** A lockfile as the package mirror would have produced it (the generated project ships none: `npm install` runs in the sandbox, which has no real runner here). */
const fakeLock = () =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': {},
      ...Object.fromEntries(
        Object.keys({
          ...(packageJson(CRM_SPEC).dependencies as object),
          ...(packageJson(CRM_SPEC).devDependencies as object),
        }).map((n) => [
          `node_modules/${n}`,
          {
            version: '1.0.0',
            resolved: `https://npm-mirror.nuzm.internal/${n}.tgz`,
            integrity: 'sha512-AAAA',
            license: 'MIT',
          },
        ]),
      ),
    },
  });

let variant = false; // true: the model returns a spec without the Account.industry field (a destructive change against the approved spec)
const specNow = () =>
  variant
    ? {
        ...CRM_SPEC,
        entities: CRM_SPEC.entities.map((en, i) =>
          i === 0 ? { ...en, fields: en.fields.filter((f) => f.name !== 'industry') } : en,
        ),
      }
    : CRM_SPEC;
const handler = (req: { task?: string }): string => {
  if (req.task === 'requirements')
    return JSON.stringify({
      summary: 'A CRM',
      entities: CRM_SPEC.entities.map((x) => ({ name: x.name })),
      roles: CRM_SPEC.roles.map((r) => r.name),
      locales: ['ar', 'en'],
    });
  if (req.task === 'app_spec') return JSON.stringify(specNow());
  if (req.task === 'test_fix')
    return JSON.stringify({ explanation: 'add the missing marker', patches: [{ op: 'add', path: 'docs/FIXED.md', content: 'FIXED' }] });
  return JSON.stringify({ error: 'no fixture' });
};

const newProject = async (name: string, org = A(), who = 'alice') => {
  const r = await call(who, 'POST', '/v1/builder/projects', { type: 'webapp', name }, org);
  expect(r.statusCode, r.body.slice(0, 300)).toBe(201);
  return r.json() as Row;
};
const newSession = async (projectId: string, org = A(), who = 'alice') =>
  (await call(who, 'POST', '/v1/ai/sessions', { title: 'App', projectId }, org)).json()
    .id as string;
const drive = async (runId: string, org = A()) => {
  const r = (await e.sql(`SELECT operation_id FROM ai.runs WHERE id=$1`, [runId]))[0]!;
  await runs.runOne(org, r.operation_id as string);
  return (await call('alice', 'GET', `/v1/ai/runs/${runId}`, undefined, org)).json() as Row;
};

beforeAll(async () => {
  process.env.APPBUILDER_KICK = 'off';
  process.env.APPBUILDER_STUB_SWITCH_TTL_MS = '0'; // the stub flag is read live in this test
  e = await setupAiEnv({ overrides: [[HealthProbePort, probe]] });
  runs = e.app.get(RunService);
  // the dev runtime (mock, NOT isolated) starts no process: install/typecheck/build succeed; the unit suite passes once docs/FIXED.md exists
  const rt = e.app.get(SandboxRuntime) as MockSandboxRuntime;
  for (const cmd of ['npm', 'npx']) rt.register(cmd, () => ({ stdout: 'ok', exitCode: 0, cpuSeconds: 1 }));
  rt.register('node', ({ files }) => {
    const ok = files.has('docs/FIXED.md');
    return {
      stdout: `<testsuites><testsuite name="s"><testcase name="marker present" classname="tests/marker.test.ts" time="0.01">${ok ? '' : '<failure message="marker missing"/>'}</testcase></testsuite></testsuites>`,
      exitCode: ok ? 0 : 1,
      cpuSeconds: 1,
    };
  });
  await e.enableMock('mock-model', {
    adapter: new MockModelAdapter({ id: 'mock-model', handler }),
  });
  await e.fund(A(), '100000000');
  await e.fund(B(), '100000000');
  for (const org of [A(), B()])
    await e.sql(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'app_builder.enabled', $1, 'true'::jsonb)`,
      [org],
    );
}, 180_000);
afterAll(() => e.h.close());

describe('web-app projects on the M09 builder tables', () => {
  it('POST /v1/builder/projects type=webapp creates a project without a head version; website-only surfaces refuse it', async () => {
    const p = await newProject('Real CRM');
    expect(p).toMatchObject({ type: 'webapp', headVersionId: null, siteModel: null });
    const got = await call('alice', 'GET', `/v1/builder/projects/${p.id}`);
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({
      type: 'webapp',
      versionId: null,
      siteModel: null,
      seo: null,
    });
    expect((await call('alice', 'GET', `/v1/builder/projects/${p.id}/files`)).json()).toEqual({
      versionId: null,
      items: [],
    });
    for (const [m, u] of [
      ['POST', `/v1/builder/projects/${p.id}/previews`],
      ['GET', `/v1/builder/projects/${p.id}/forms`],
      ['GET', `/v1/builder/projects/${p.id}/cms-collections`],
    ] as const) {
      const r = await call('alice', m, u, m === 'POST' ? {} : undefined);
      expect(r.statusCode, `${m} ${u}`).toBe(422);
      expect(r.json().code).toBe('unsupported_capability');
    }
    // another organization sees nothing
    expect(
      (await call('bob', 'GET', `/v1/builder/projects/${p.id}`, undefined, B())).statusCode,
    ).toBe(404);
    // a viewer may read but not create
    expect((await call('carol', 'GET', `/v1/builder/projects/${p.id}`)).statusCode).toBe(200);
    expect(
      (await call('carol', 'POST', '/v1/builder/projects', { type: 'webapp', name: 'x' }))
        .statusCode,
    ).toBe(403);
    // mobile is not available before M10B
    expect(
      (await call('alice', 'POST', '/v1/builder/projects', { type: 'mobile', name: 'm' }))
        .statusCode,
    ).toBe(422);
  });

  it('ProjectsPort commits immutable versions with optimistic concurrency and reads them back', async () => {
    const port = e.app.get<ProjectsPort>(ProjectsPort);
    const p = await port.create(A(), {
      type: 'webapp',
      name: 'Port CRM',
      dataRegion: 'sa-central',
      createdBy: e.ids.alice!,
    });
    const v1 = await port.commit(A(), p.id, {
      baseVersionId: null,
      files: new Map([
        ['README.md', '# hi'],
        ['db/migrations/0001_init.sql', 'select 1;'],
      ]),
      source: 'system',
      createdBy: e.ids.alice!,
    });
    expect(Object.keys(v1.manifest).sort()).toEqual(['README.md', 'db/migrations/0001_init.sql']);
    await expect(
      port.commit(A(), p.id, {
        baseVersionId: null,
        files: new Map(),
        source: 'user',
        createdBy: null,
      }),
    ).rejects.toMatchObject({ name: 'StaleBaseError' });
    const v2 = await port.commit(A(), p.id, {
      baseVersionId: v1.id,
      files: new Map([['README.md', '# hi 2']]),
      source: 'user',
      createdBy: e.ids.alice!,
    });
    expect((await port.get(A(), p.id))!.headVersionId).toBe(v2.id);
    expect((await port.readFiles(A(), p.id, v1.id))!.get('README.md')).toBe('# hi');
    expect(await port.readFiles(B(), p.id, v1.id)).toBeNull(); // another organization
    expect((await port.listVersions(A(), p.id)).map((v) => v.id)).toEqual([v2.id, v1.id]);
    // M09's own files route serves the M10 commit
    const files = (await call('alice', 'GET', `/v1/builder/projects/${p.id}/files`)).json();
    expect(files.items.map((f: Row) => f.path)).toEqual(['README.md']);
  });
});

describe('a webapp run through M09 /v1/ai/runs (segment engine), real gateway, real artifacts', () => {
  let projectId = '';
  let runId = '';
  it('is accepted (202) as a run kind; mobile stays unsupported_kind; input is validated', async () => {
    projectId = (await newProject('Generated CRM')).id as string;
    const sessionId = await newSession(projectId);
    const bad = await call('alice', 'POST', '/v1/ai/runs', {
      sessionId,
      projectId,
      kind: 'webapp',
      input: { maxMinutes: 500 },
    });
    expect(bad.statusCode).toBe(422);
    expect(
      (await call('alice', 'POST', '/v1/ai/runs', { sessionId, projectId, kind: 'mobile' })).json()
        .code,
    ).toBe('unsupported_kind');
    const r = await call('alice', 'POST', '/v1/ai/runs', {
      sessionId,
      projectId,
      kind: 'webapp',
      budget: { maxTokens: 900_000, maxCredits: 1_000_000 },
      input: { brief: { prompt: 'A CRM for a small sales team' }, maxMinutes: 30 },
    });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(202);
    runId = r.json().id;
    expect(r.json().state).toBe('queued');
  });

  it('executes the seven agents: steps, artifacts, events, usage, spec and a committed project', async () => {
    let out = await drive(runId);
    // the dependency / approval gates of the CRM spec (if any) park the run: decide them as an admin and continue
    for (let i = 0; i < 5 && out.state === 'waiting_approval'; i++) {
      const pending = (await call('alice', 'GET', '/v1/ai/approvals?status=pending')).json()
        .items as Row[];
      expect(out.pendingApproval).toBeTruthy();
      for (const a of pending.filter((x) => x.runId === runId))
        expect(
          (
            await call('alice', 'POST', `/v1/ai/approvals/${a.id}/decisions`, {
              decision: 'approve',
              scopeHash: a.scopeHash,
            })
          ).statusCode,
        ).toBe(200);
      // the decision continued the parked run through M09 (resumeParked): a new segment is queued
      expect((await e.sql(`SELECT state FROM ai.runs WHERE id=$1`, [runId]))[0]!.state).toBe(
        'queued',
      );
      out = await drive(runId);
    }
    if (out.state !== 'succeeded')
      throw new Error(
        JSON.stringify({
          out,
          steps: await e.sql(
            `SELECT node,status,error_code FROM ai.run_steps WHERE run_id=$1 ORDER BY seq`,
            [runId],
          ),
        }),
      );
    expect(out.state).toBe('succeeded');
    expect(out.result).toMatchObject({ graph: 'webapp' });
    const kinds = (out.artifacts as { type: string }[]).map((a) => a.type);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'requirements',
        'app_spec',
        'db_schema',
        'api_contract',
        'frontend_bundle',
        'test_plan',
        'deploy_plan',
      ]),
    );
    // artifacts are served by M09's route
    const spec = (out.artifacts as { id: string; type: string }[]).find(
      (a) => a.type === 'app_spec',
    )!;
    const art = await call('alice', 'GET', `/v1/ai/runs/${runId}/artifacts/${spec.id}`);
    expect(art.json().payload.slug).toBe(CRM_SPEC.slug);
    expect(
      (await call('bob', 'GET', `/v1/ai/runs/${runId}/artifacts/${spec.id}`, undefined, B()))
        .statusCode,
    ).toBe(404);
    // every node is a persisted, checkpointed step; the event log shows them
    const steps = await e.sql(`SELECT node,status FROM ai.run_steps WHERE run_id=$1 ORDER BY seq`, [
      runId,
    ]);
    expect(steps.map((s) => s.node)).toHaveLength(7);
    expect(steps.every((s) => s.status === 'succeeded')).toBe(true);
    const events = (
      await e.sql(`SELECT type FROM ai.run_events WHERE run_id=$1 ORDER BY seq`, [runId])
    ).map((x) => x.type as string);
    expect(events).toEqual(
      expect.arrayContaining(['segment_started', 'node_started', 'node_succeeded', 'succeeded']),
    );
    // the model went through M09's gateway: usage rows, credits spent from the wallet, tokens on the run
    const usage = await e.sql(
      `SELECT count(*)::int n, coalesce(sum(credits),0)::bigint c FROM ai.model_usage WHERE run_id=$1`,
      [runId],
    );
    expect(usage[0]!.n).toBeGreaterThanOrEqual(2);
    const row = (
      await e.sql(
        `SELECT tokens_in, tokens_out, spent_credits, result, error FROM ai.runs WHERE id=$1`,
        [runId],
      )
    )[0]!;
    expect(Number(row.tokens_in)).toBeGreaterThan(0);
    expect(BigInt(String(row.spent_credits))).toBe(BigInt(String(usage[0]!.c)));
    // the generated project is the head version of the M09 project, readable through M09's files route
    const proj = (await call('alice', 'GET', `/v1/builder/projects/${projectId}`)).json();
    expect(proj.headVersionId).toBeTruthy();
    const files = (await call('alice', 'GET', `/v1/builder/projects/${projectId}/files`)).json()
      .items as Row[];
    expect(files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['package.json', 'nuzm.app.json']),
    );
    expect(
      (
        await e.sql(`SELECT count(*)::int n FROM builder.app_specs WHERE project_id=$1`, [
          projectId,
        ])
      )[0]!.n,
    ).toBe(1);
    // the app-builder view of the run store sees the same row
    const rec = await e.app.get<RunStorePort>(RunStorePort).get(A(), runId);
    expect(rec).toMatchObject({ kind: 'webapp', state: 'succeeded', projectId });
    expect(rec!.usage.costMinor).toBeGreaterThan(0);
  });

  it('sandboxes, test runs and exports work for the real builder project (they were 404 on the in-memory port)', async () => {
    const sb = await call('alice', 'POST', `/v1/builder/projects/${projectId}/sandboxes`, {
      profile: 'standard',
      ttlMinutes: 30,
    });
    expect(sb.statusCode, sb.body.slice(0, 300)).toBe(202);
    expect(sb.json()).toMatchObject({ state: 'ready', runtime: { isolation: 'simulated' } });
    expect(
      (
        await call(
          'bob',
          'GET',
          `/v1/builder/projects/${projectId}/sandboxes/${sb.json().id}`,
          undefined,
          B(),
        )
      ).statusCode,
    ).toBe(404);
    const tr = await call('alice', 'POST', `/v1/builder/projects/${projectId}/test-runs`, {
      suite: 'typecheck',
    });
    expect(tr.statusCode, tr.body.slice(0, 300)).toBe(202);
    // the export policy refuses a project without a lockfile (supply chain: lockfile mandatory); the lockfile arrives through the changes pipeline
    const blocked = await call('alice', 'POST', `/v1/builder/projects/${projectId}/exports`, {});
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().code).toBe('export_blocked');
    const head = (await call('alice', 'GET', `/v1/builder/projects/${projectId}`)).json()
      .headVersionId;
    const lock = await call('alice', 'POST', `/v1/builder/projects/${projectId}/changes`, {
      baseVersion: head,
      patches: [{ op: 'add', path: 'package-lock.json', content: fakeLock() }],
      message: 'lockfile from the package mirror',
    });
    expect(lock.statusCode, lock.body.slice(0, 300)).toBe(200);
    const ex = await call('alice', 'POST', `/v1/builder/projects/${projectId}/exports`, {});
    expect(ex.statusCode, ex.body.slice(0, 300)).toBe(202);
    const list = await call('alice', 'GET', `/v1/builder/projects/${projectId}/exports`);
    expect(list.statusCode).toBe(200);
    expect(
      (await call('alice', 'DELETE', `/v1/builder/projects/${projectId}/sandboxes/${sb.json().id}`))
        .statusCode,
    ).toBe(202);
  });

  it('the safe-diff changes route of M09 is dispatched to the web-app pipeline', async () => {
    const proj = (await call('alice', 'GET', `/v1/builder/projects/${projectId}`)).json();
    const ok = await call('alice', 'POST', `/v1/builder/projects/${projectId}/changes`, {
      baseVersion: proj.headVersionId,
      patches: [{ op: 'add', path: 'docs/NOTES.md', content: '# notes\n' }],
      message: 'add notes',
    });
    expect(ok.statusCode, ok.body.slice(0, 300)).toBe(200);
    expect(ok.json().versionId).toBeTruthy();
    const stale = await call('alice', 'POST', `/v1/builder/projects/${projectId}/changes`, {
      baseVersion: proj.headVersionId,
      patches: [{ op: 'add', path: 'docs/MORE.md', content: 'x' }],
    });
    expect(stale.statusCode).toBe(409);
    expect(
      (
        await call('alice', 'POST', `/v1/builder/projects/${projectId}/changes`, {
          baseVersion: ok.json().versionId,
          source: 'ai',
          patches: [],
        })
      ).json().code,
    ).toBe('approval_required');
  });
});

describe('deployments of a webapp project: /v1/deployments (M09 paths) dispatched to the web-app pipeline, published through SitePublisherPort', () => {
  let projectId = '';
  let siteId = '';
  const publisher = () => e.app.get(SitePublisherPort) as InMemorySitePublisher;
  const exec = async (depId: string) => {
    const dep = (await call('alice', 'GET', `/v1/deployments/${depId}`)).json();
    const project = (await e.app.get<ProjectsPort>(ProjectsPort).get(A(), dep.projectId))!;
    return e.app.get(AppDeploymentService).execute(A(), e.ids.alice!, project, depId);
  };
  const deploy = async (env: 'staging' | 'production') =>
    call('alice', 'POST', '/v1/deployments', {
      projectId,
      target: { type: 'site', id: siteId },
      env,
    });
  beforeAll(async () => {
    // the dev runtime (mock, NOT isolated) starts no process: the package install / build of the sandbox are scripted
    for (const cmd of ['npm', 'npx'])
      (e.app.get(SandboxRuntime) as MockSandboxRuntime).register(cmd, () => ({
        stdout: 'ok',
        exitCode: 0,
        cpuSeconds: 1,
      }));
    // a generated project with a lockfile (the supply-chain gate of the deployment), through the real run + changes pipeline
    projectId = (await newProject('Deployed CRM')).id as string;
    const r = await call('alice', 'POST', '/v1/ai/runs', {
      sessionId: await newSession(projectId),
      projectId,
      kind: 'webapp',
      budget: { maxTokens: 900_000, maxCredits: 1_000_000 },
      input: { brief: { prompt: 'deploy me' } },
    });
    expect((await drive(r.json().id)).state).toBe('succeeded');
    const head = (await call('alice', 'GET', `/v1/builder/projects/${projectId}`)).json()
      .headVersionId;
    expect(
      (
        await call('alice', 'POST', `/v1/builder/projects/${projectId}/changes`, {
          baseVersion: head,
          patches: [{ op: 'add', path: 'package-lock.json', content: fakeLock() }],
        })
      ).statusCode,
    ).toBe(200);
    const planId = randomUUID();
    await e.sql(
      `INSERT INTO hosting.plan_definitions (id, key, name_ar, name_en, status, quotas, runtimes, reservation) VALUES ($1, 'm10-plan', 'خطة', 'Plan', 'active', '{"diskMb":1,"inodes":1000,"bandwidthGb":1,"dbCount":1,"sitesCount":1}', '["php"]', '{"cpu_millicores":1,"memory_mb":1,"disk_mb":1}')`,
      [planId],
    );
    siteId = randomUUID();
    await e.sql(
      `INSERT INTO hosting.sites (id, org_id, name, token, node_name, plan_id, runtime, status, data_region, created_by, credentials_ref, backup_key_ref, domain_primary)
       VALUES ($1,$2,'crmsite',$3,$4,$5,'static','active','sa-central',$6,'vault://t/c','vault://t/b',NULL)`,
      [
        siteId,
        A(),
        randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
        `s-${randomUUID().replace(/-/g, '').slice(0, 14)}`,
        planId,
        e.ids.alice,
      ],
    );
  });

  it('staging: build in the sandbox, release artifact, static front end staged → smoke → live on the hosting site; the health gate passes', async () => {
    const r = await deploy('staging');
    expect(r.statusCode, r.body.slice(0, 300)).toBe(202);
    const dep = await exec(r.json().id);
    expect(dep).toMatchObject({
      state: 'live',
      environment: 'staging',
      target: { type: 'site', id: siteId },
    });
    expect(dep.url).toMatch(/^https:\/\//);
    const live = publisher().live.get(siteId)!;
    expect(live.files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['index.html', 'app.js', 'health']),
    );
    // M09's read routes serve the web-app deployment too
    expect((await call('alice', 'GET', `/v1/deployments/${dep.id}`)).json()).toMatchObject({
      id: dep.id,
      state: 'live',
    });
    expect(
      (await call('alice', 'GET', `/v1/deployments?projectId=${projectId}`)).json().items,
    ).toHaveLength(1);
    expect(
      (await call('alice', 'GET', `/v1/deployments/${dep.id}/logs`)).json().items.length,
    ).toBeGreaterThan(0);
    // another organization cannot see it
    expect((await call('bob', 'GET', `/v1/deployments/${dep.id}`, undefined, B())).statusCode).toBe(
      404,
    );
  });

  it('a failing health gate restores the previous release automatically; rollback restores the earlier release (idempotent)', async () => {
    const before = publisher().live.get(siteId)!.hash;
    const head = (await call('alice', 'GET', `/v1/builder/projects/${projectId}`)).json()
      .headVersionId;
    await call('alice', 'POST', `/v1/builder/projects/${projectId}/changes`, {
      baseVersion: head,
      patches: [{ op: 'add', path: 'public/v2.txt', content: 'second release' }],
    });
    probe.failWhen(() => true);
    const bad = await exec((await deploy('staging')).json().id);
    probe.clear();
    expect(bad).toMatchObject({ state: 'failed', failureCode: 'health_gate_failed' });
    expect(bad.healthCheck).toMatchObject({ autoRolledBack: true });
    expect(publisher().live.get(siteId)!.hash).toBe(before); // the previous release is serving again
    // a healthy second release, then rollback to the first
    const good = await exec((await deploy('staging')).json().id);
    expect(good.state).toBe('live');
    expect(publisher().live.get(siteId)!.hash).not.toBe(before);
    const rb = await call('alice', 'POST', `/v1/deployments/${good.id}/rollback`);
    expect(rb.statusCode, rb.body.slice(0, 300)).toBe(202);
    expect(publisher().live.get(siteId)!.hash).toBe(before);
    const replay = await call('alice', 'POST', `/v1/deployments/${good.id}/rollback`); // replay: the same rollback record, nothing is done twice
    expect(replay.json().id).toBe(rb.json().id);
  });

  it('production needs a human approval bound to the exact release (403 approval_required with the approvals to decide)', async () => {
    const r = await deploy('production');
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('approval_required');
    const ap = r.json().approvals as { id: string; type: string; scopeHash: string }[];
    expect(ap.map((a) => a.type)).toContain('production_deploy');
    for (const a of ap)
      expect(
        (
          await call('alice', 'POST', `/v1/ai/approvals/${a.id}/decisions`, {
            decision: 'approve',
            scopeHash: a.scopeHash,
          })
        ).statusCode,
      ).toBe(200);
    const ok = await deploy('production');
    expect(ok.statusCode, ok.body.slice(0, 300)).toBe(202);
    expect((await exec(ok.json().id)).state).toBe('live');
  });

  it('refuses a target that is not a hosting site of the organization (404) and a website project here (M09 owns it)', async () => {
    const other = await call('alice', 'POST', '/v1/deployments', {
      projectId,
      target: { type: 'site', id: randomUUID() },
      env: 'staging',
    });
    expect(other.statusCode).toBe(404);
    const inst = await call('alice', 'POST', '/v1/deployments', {
      projectId,
      target: { type: 'instance', id: randomUUID() },
      env: 'staging',
    });
    expect(inst.statusCode).toBe(404); // no compute-instance publish path exists
  });
});

describe('approvals of a webapp run (the M10 inbox) continue the run through M09 segments', () => {
  let projectId = '';
  const start = async () => {
    const sessionId = await newSession(projectId);
    const r = await call('alice', 'POST', '/v1/ai/runs', {
      sessionId,
      projectId,
      kind: 'webapp',
      budget: { maxTokens: 900_000, maxCredits: 1_000_000 },
      input: { brief: { prompt: 'change the schema' } },
    });
    expect(r.statusCode, r.body.slice(0, 200)).toBe(202);
    return r.json().id as string;
  };
  const stateOf = async (id: string) =>
    (await e.sql(`SELECT state FROM ai.runs WHERE id=$1`, [id]))[0]!.state as string;
  const waitFor = async (id: string, want: string) => {
    for (let i = 0; i < 40; i++) {
      if ((await stateOf(id)) === want) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`run ${id} is ${await stateOf(id)}, wanted ${want}`);
  };
  beforeAll(async () => {
    projectId = (await newProject('Schema change CRM')).id as string;
    variant = false;
    const first = await start();
    expect((await drive(first)).state).toBe('succeeded');
    await e.app.get(AppSpecService).approve(A(), projectId, 1, e.ids.alice!);
    variant = true;
  });
  afterAll(() => {
    variant = false;
  });

  it('a destructive migration parks the run in waiting_approval; a stale hash is 409; approving continues it to success', async () => {
    const id = await start();
    const out = await drive(id);
    expect(out.state).toBe('waiting_approval');
    expect(out.pendingApproval).toMatchObject({ kind: 'destructive_migration' });
    const ap = out.pendingApproval as { id: string; scopeHash: string };
    expect(ap.scopeHash).toMatch(/^[0-9a-f]{64}$/);
    // the run is not executed while it waits: a segment of a waiting run is skipped by M09's engine
    expect((await drive(id)).state).toBe('waiting_approval');
    const stale = await call('alice', 'POST', `/v1/ai/approvals/${ap.id}/decisions`, {
      decision: 'approve',
      scopeHash: 'f'.repeat(64),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('stale_approval_hash');
    // a viewer cannot decide; the deployer role of the type can
    expect(
      (
        await call('carol', 'POST', `/v1/ai/approvals/${ap.id}/decisions`, {
          decision: 'approve',
          scopeHash: ap.scopeHash,
        })
      ).statusCode,
    ).toBe(403);
    const ok = await call('alice', 'POST', `/v1/ai/approvals/${ap.id}/decisions`, {
      decision: 'approve',
      scopeHash: ap.scopeHash,
    });
    expect(ok.statusCode, ok.body.slice(0, 200)).toBe(200);
    await waitFor(id, 'queued');
    expect((await drive(id)).state).toBe('succeeded');
    const nodes = await e.sql(
      `SELECT node, status FROM ai.run_steps WHERE run_id=$1 ORDER BY seq`,
      [id],
    );
    expect(nodes).toHaveLength(7);
    expect(nodes.every((n) => n.status === 'succeeded')).toBe(true);
    // each node ran once: the checkpoint before the approval was not repeated
    expect(
      Number(
        (await e.sql(`SELECT count(*)::int n FROM ai.model_usage WHERE run_id=$1`, [id]))[0]!.n,
      ),
    ).toBe(2);
  });

  it('rejecting the approval fails the run with approval_rejected', async () => {
    const id = await start();
    const out = await drive(id);
    expect(out.state).toBe('waiting_approval');
    const ap = out.pendingApproval as { id: string; scopeHash: string };
    expect(
      (
        await call('alice', 'POST', `/v1/ai/approvals/${ap.id}/decisions`, {
          decision: 'reject',
          scopeHash: ap.scopeHash,
        })
      ).statusCode,
    ).toBe(200);
    await waitFor(id, 'queued');
    const done = await drive(id);
    expect(done.state).toBe('failed');
    expect(done.error).toMatchObject({ code: 'approval_rejected' });
  });

  it('an approval that expires while the run waits is swept: the run continues and fails with approval_expired (410 on a late decision)', async () => {
    const id = await start();
    const out = await drive(id);
    expect(out.state).toBe('waiting_approval');
    const ap = out.pendingApproval as { id: string; scopeHash: string };
    // 25 hours later (an approval row is immutable, so the sweep is asked "as of" a later time)
    expect(
      await e.app.get(ApprovalService).sweepExpired(200, new Date(Date.now() + 25 * 3_600_000)),
    ).toBeGreaterThanOrEqual(1);
    await waitFor(id, 'queued');
    const done = await drive(id);
    expect(done.state).toBe('failed');
    expect(done.error).toMatchObject({ code: 'approval_expired' });
    const late = await call('alice', 'POST', `/v1/ai/approvals/${ap.id}/decisions`, {
      decision: 'approve',
      scopeHash: ap.scopeHash,
    });
    expect(late.statusCode).toBe(410);
  });

  it('cancelling a waiting run is a cancellation (M09 route) and releases the project for a new run', async () => {
    const id = await start();
    expect((await drive(id)).state).toBe('waiting_approval');
    const c = await call('alice', 'POST', `/v1/ai/runs/${id}/cancellation`);
    expect(c.json().state).toBe('cancelled');
    expect(await stateOf(id)).toBe('cancelled');
    const again = await start(); // the unique "one active run per project" slot is free again
    await call('alice', 'POST', `/v1/ai/runs/${again}/cancellation`);
  });
});

describe('a test-fix run through M09 (bounded debugging loop on the real project)', () => {
  it('runs the tests, asks the model for a patch, applies it through the checked changes pipeline and ends fixed', async () => {
    const projectId = (await newProject('Fix me CRM')).id as string;
    const gen = await call('alice', 'POST', '/v1/ai/runs', {
      sessionId: await newSession(projectId),
      projectId,
      kind: 'webapp',
      budget: { maxTokens: 900_000, maxCredits: 1_000_000 },
      input: { brief: { prompt: 'fix me' } },
    });
    expect((await drive(gen.json().id)).state).toBe('succeeded');
    const head = (await call('alice', 'GET', `/v1/builder/projects/${projectId}`)).json().headVersionId;
    expect(
      (
        await call('alice', 'POST', `/v1/builder/projects/${projectId}/changes`, {
          baseVersion: head,
          patches: [{ op: 'add', path: 'package-lock.json', content: fakeLock() }],
        })
      ).statusCode,
    ).toBe(200);
    const r = await call('alice', 'POST', '/v1/ai/runs', {
      sessionId: await newSession(projectId),
      projectId,
      kind: 'test-fix',
      budget: { maxTokens: 400_000, maxCredits: 500_000 },
      input: {},
    });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(202);
    const out = await drive(r.json().id);
    if (out.state !== 'succeeded') throw new Error(JSON.stringify(out));
    expect(out.result).toMatchObject({ outcome: 'fixed', iterations: 1 });
    expect(
      (await e.sql(`SELECT count(*)::int n FROM builder.test_runs WHERE project_id=$1`, [projectId]))[0]!.n,
    ).toBeGreaterThanOrEqual(2); // failing run, then the passing one
    const files = (await call('alice', 'GET', `/v1/builder/projects/${projectId}/files`)).json().items as Row[];
    expect(files.map((f) => f.path)).toContain('docs/FIXED.md');
    expect(
      (await e.sql(`SELECT count(*)::int n FROM ai.model_usage WHERE run_id=$1`, [r.json().id]))[0]!.n,
    ).toBe(1);
  });
});

describe('failure modes of a webapp run', () => {
  it('a run on a website project fails with project_not_webapp; no model call is made', async () => {
    const site = (
      await call('alice', 'POST', '/v1/builder/projects', { name: 'Brochure', locale: ['en'] })
    ).json();
    const sessionId = await newSession(site.id);
    const r = await call('alice', 'POST', '/v1/ai/runs', {
      sessionId,
      projectId: site.id,
      kind: 'webapp',
      input: {},
    });
    expect(r.statusCode).toBe(202);
    const out = await drive(r.json().id);
    expect(out.state).toBe('failed');
    expect(
      Number(
        (
          await e.sql(`SELECT count(*)::int n FROM ai.model_usage WHERE run_id=$1`, [r.json().id])
        )[0]!.n,
      ),
    ).toBe(0);
    expect(
      (await e.sql(`SELECT error FROM ai.runs WHERE id=$1`, [r.json().id]))[0]!.error,
    ).toMatchObject({ code: 'project_not_webapp' });
  });

  it('an organization without credit is refused (402 insufficient_credits) before anything runs', async () => {
    const created = await e.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { cookie: cookieHeader(e.jars.frank!), 'x-csrf-token': e.jars.frank!.nuzm_csrf! },
      payload: { name: 'Poor Org' },
    });
    const poor = created.json().id as string;
    await e.sql(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'app_builder.enabled', $1, 'true'::jsonb)`,
      [poor],
    );
    const prj = (
      await call(
        'frank',
        'POST',
        '/v1/builder/projects',
        { type: 'webapp', name: 'Poor app' },
        poor,
      )
    ).json();
    expect(prj.type).toBe('webapp');
    const sessionId = await newSession(prj.id, poor, 'frank');
    const r = await call(
      'frank',
      'POST',
      '/v1/ai/runs',
      { sessionId, projectId: prj.id, kind: 'webapp', input: {} },
      poor,
    );
    expect(r.statusCode).toBe(402);
    expect(r.json().code).toBe('insufficient_credits');
    // sandboxes are refused for the same reason (OrgBudgetPort reads the real wallet)
    const sb = await call('frank', 'POST', `/v1/builder/projects/${prj.id}/sandboxes`, {}, poor);
    expect(sb.statusCode).toBe(402);
    expect(sb.json().code).toBe('budget_required');
  });

  it('cancelling a queued run ends it cancelled and the segment is skipped', async () => {
    const pid = (await newProject('Cancel me')).id as string;
    const sessionId = await newSession(pid);
    const r = await call('alice', 'POST', '/v1/ai/runs', {
      sessionId,
      projectId: pid,
      kind: 'webapp',
      input: { brief: { prompt: 'x' } },
    });
    expect(
      (await call('alice', 'POST', `/v1/ai/runs/${r.json().id}/cancellation`)).json().state,
    ).toBe('cancelled');
    expect((await drive(r.json().id)).state).toBe('cancelled');
  });
});

describe('dev fallback behind app_builder.m09_stubs', () => {
  it('routes the ports to the in-memory stand-ins only for an organization that has the flag, never otherwise', async () => {
    const port = e.app.get<ProjectsPort>(ProjectsPort);
    await e.sql(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'app_builder.m09_stubs', $1, 'true'::jsonb)`,
      [B()],
    );
    const stub = await port.create(B(), {
      type: 'webapp',
      name: 'In memory',
      dataRegion: 'sa-central',
      createdBy: null,
    });
    expect((await e.sql(`SELECT 1 FROM builder.projects WHERE id=$1`, [stub.id])).length).toBe(0); // not in M09's table
    expect(await port.get(B(), stub.id)).not.toBeNull();
    const real = await port.create(A(), {
      type: 'webapp',
      name: 'Persisted',
      dataRegion: 'sa-central',
      createdBy: null,
    });
    expect((await e.sql(`SELECT 1 FROM builder.projects WHERE id=$1`, [real.id])).length).toBe(1);
  });
});
