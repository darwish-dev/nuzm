import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockModelAdapter } from '@nuzm/adapter-model';
import { RunService } from '../ai';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { ResidencyService } from '../compliance';
import { MobileProjectService } from '../builder';
import { setupAiEnv, type AiEnv, type Row } from '../ai/testing/ai-harness';
import { ArtifactBytesPort, MemoryArtifactBytes } from './internal/builds/blobs';
import { BuildService, DEFAULT_BUILD_CONFIG, redactLog } from './internal/builds/build.service';
import { BuildRunnerPort, buildEnv, MockBuildRunner, type BuildInput, type BuildOutput } from './internal/builds/runner';
import { SAMPLE_MOBILE_SPEC } from './internal/fixtures/sample-spec';
import { PubAdvisoryPort } from './internal/policy/pub-policy';
import { ReleaseService } from './internal/releases/release.service';
import { SigningService, SigningStagePort } from './internal/signing/signing.service';

let e: AiEnv;
let runs: RunService;
let spec: unknown = SAMPLE_MOBILE_SPEC;
const kk = (...p: string[]) => p.join('');
const A = () => e.org.A!;
const B = () => e.org.B!;
const j = (r: { json(): unknown }) => r.json() as Row;
const flag = (orgId: string | null, on: boolean) =>
  e.sql(`INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'mobile_builder.enabled', $1, $2::jsonb)`, [orgId, JSON.stringify(on)]);
const mkProject = async (name: string, who = 'alice', org = A()) => {
  const r = await e.call(who, 'POST', '/v1/builder/projects', { type: 'mobile', name, locale: ['ar', 'en'] }, org);
  if (r.statusCode !== 201) throw new Error(`project: ${r.statusCode} ${r.body}`);
  return j(r);
};
const session = async (title: string) => (await e.call('alice', 'POST', '/v1/ai/sessions', { title })).json().id as string;
const drive = async (runId: string) => {
  const r = (await e.sql(`SELECT operation_id FROM ai.runs WHERE id=$1`, [runId]))[0]!;
  await runs.runOne(A(), r.operation_id as string);
  return j(await e.call('alice', 'GET', `/v1/ai/runs/${runId}`));
};
/** a generated project: run kind=mobile through the real run engine with the scripted model */
const generate = async (name: string) => {
  const p = await mkProject(name);
  const run = j(await e.call('alice', 'POST', '/v1/ai/runs', { sessionId: await session(name), kind: 'mobile', projectId: p.id, input: { description: 'تطبيق لمتابعة مهام الفرق الميدانية' } }));
  const w = await drive(run.id as string);
  expect(w.state, JSON.stringify(w.error)).toBe('waiting_approval');
  const ap = await e.call('dave', 'POST', `/v1/ai/runs/${run.id}/approvals`, { approvalId: w.pendingApproval.id, decision: 'approve' });
  expect(ap.statusCode).toBe(200);
  const done = await drive(run.id as string);
  expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
  return { p, run, done };
};
const post = (who: string, url: string, body: object, org = A(), key?: string) => e.call(who, 'POST', url, body, org, key ? { 'idempotency-key': key } : {});
const buildSvc = () => e.app.get(BuildService, { strict: false });
const bytes = () => e.app.get(ArtifactBytesPort, { strict: false }) as MemoryArtifactBytes;

beforeAll(async () => {
  process.env.MOBILE_BUILD_RUNNER = 'mock';
  process.env.MOBILE_KICK = 'off';
  e = await setupAiEnv();
  runs = e.app.get(RunService);
  await e.enableMock('mock-model', {
    adapter: new MockModelAdapter({
      id: 'mock-model',
      handler: (req) => JSON.stringify({ result: (req as unknown as { task: string }).task === 'mobile_design' ? spec : {} }),
    }),
  });
  await e.fund(A(), '100000000');
  await e.call('alice', 'PUT', '/v1/ai/budgets', { org: {} }, A(), { 'if-match': '"0"' });
}, 120_000);
afterAll(() => e.h.close());

describe('feature flag mobile_builder.enabled (default OFF)', () => {
  it('everything answers 404 until the flag is on, then a mobile project can be created', async () => {
    expect((await e.call('alice', 'POST', '/v1/builder/projects', { type: 'mobile', name: 'Flag Off' })).statusCode).toBe(404);
    for (const [m, u] of [['GET', '/v1/mobile/builds'], ['GET', '/v1/mobile/signing-credentials'], ['GET', '/v1/mobile/releases']] as const)
      expect((await e.call('alice', m, u)).statusCode, u).toBe(404);
    await flag(A(), true);
    expect((await e.call('alice', 'GET', '/v1/mobile/builds')).statusCode).toBe(200);
    // org B has no flag row: still off
    expect((await e.call('bob', 'GET', '/v1/mobile/builds', undefined, B())).statusCode).toBe(404);
    await flag(B(), true); // org B is enabled from here on, so the cross-tenant checks below test isolation, not the flag
  });
});

describe('S48: mobile projects and `kind=mobile` runs', () => {
  it('creates a mobile project: type mobile, empty manifest, website-only operations refused, preview refused honestly', async () => {
    const p = await mkProject('Plain Mobile');
    expect(p.type).toBe('mobile');
    expect(p.headSeq).toBe(1);
    const g = j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}`));
    expect(g.manifest).toMatchObject({ kind: 'mobile', fileCount: 0 });
    expect(g.siteModel).toBeNull();
    const ch = await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/changes`, { baseVersion: p.headVersionId, ops: [], source: 'user', label: 'x' });
    expect(ch.statusCode).toBe(422);
    expect(ch.json().code ?? ch.json().type).toMatch(/unsupported_capability/);
    const pv = await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/previews`, {});
    expect(pv.statusCode).toBe(422);
    expect(pv.body).toMatch(/never a guarantee/);
    // cross-tenant: org B sees nothing
    expect((await e.call('bob', 'GET', `/v1/builder/projects/${p.id}`, undefined, B())).statusCode).toBe(404);
    // only the types of docs/04
    expect((await e.call('alice', 'POST', '/v1/builder/projects', { type: 'desktop', name: 'x' })).statusCode).toBe(422);
  });

  it('run: design -> plan approval (human) -> Flutter project written as a NEW version with the spec, files and pinned toolchain', async () => {
    const { p, done } = await generate('Generated Field App');
    expect(done.artifacts as Row[]).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'architecture' })]));
    const g = j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}`));
    expect(g.versionSeq).toBe(2);
    expect(g.manifest.fileCount).toBeGreaterThan(15);
    expect(g.manifest.generator.flutter).toBe('3.35.7');
    expect(g.manifest.spec.app.packageId).toBe('sa.nuzm.field_tasks');
    const files = j(await e.call('carol', 'GET', `/v1/builder/projects/${p.id}/files`));
    expect(JSON.stringify(files)).toContain('lib/main.dart');
    const content = j(await e.call('carol', 'GET', `/v1/builder/projects/${p.id}/files/content?path=${encodeURIComponent('lib/generated/app_spec.dart')}`));
    expect(JSON.stringify(content)).toContain('مهام الميدان');
    expect(
      (await e.sql(`SELECT source, run_id FROM builder.project_versions WHERE project_id=$1 AND seq=2`, [p.id]))[0],
    ).toMatchObject({ source: 'ai', run_id: (await e.sql(`SELECT id FROM ai.runs WHERE project_id=$1`, [p.id]))[0]!.id });
  });

  it('a denied design leaves the project untouched; a viewer cannot approve', async () => {
    const p = await mkProject('Denied Design');
    const run = j(await e.call('alice', 'POST', '/v1/ai/runs', { sessionId: await session('d'), kind: 'mobile', projectId: p.id, input: { description: 'a delivery app' } }));
    const w = await drive(run.id as string);
    expect((await e.call('carol', 'POST', `/v1/ai/runs/${run.id}/approvals`, { approvalId: w.pendingApproval.id, decision: 'approve' })).statusCode).toBe(403);
    const r = await e.call('alice', 'POST', `/v1/ai/runs/${run.id}/approvals`, { approvalId: w.pendingApproval.id, decision: 'deny' });
    expect(r.json().state).toBe('cancelled');
    expect(j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}`)).versionSeq).toBe(1);
  });

  it('an invalid design from the model fails the run before anything is written', async () => {
    const bad = JSON.parse(JSON.stringify(SAMPLE_MOBILE_SPEC));
    bad.navigation.tabs = ['home', 'ghost'];
    spec = bad;
    try {
      const p = await mkProject('Bad Design');
      const run = j(await e.call('alice', 'POST', '/v1/ai/runs', { sessionId: await session('b'), kind: 'mobile', projectId: p.id, input: { description: 'anything at all' } }));
      const w = await drive(run.id as string);
      expect(w.state).toBe('failed');
      expect(j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}`)).versionSeq).toBe(1);
    } finally {
      spec = SAMPLE_MOBILE_SPEC;
    }
  });

  it('run input is validated and a website project is not a mobile project', async () => {
    const p = await mkProject('Input Check');
    const sid = await session('i');
    expect((await e.call('alice', 'POST', '/v1/ai/runs', { sessionId: sid, kind: 'mobile', projectId: p.id, input: {} })).statusCode).toBe(422);
    expect((await e.call('alice', 'POST', '/v1/ai/runs', { sessionId: sid, kind: 'mobile', projectId: p.id, input: { description: 'ok ok', spec: {} } })).statusCode).toBe(422);
    const site = j(await e.call('alice', 'POST', '/v1/builder/projects', { type: 'website', name: 'A Website', locale: ['ar', 'en'], templateId: 'landing' }));
    const run = j(await e.call('alice', 'POST', '/v1/ai/runs', { sessionId: await session('w'), kind: 'mobile', projectId: site.id, input: { description: 'not for a website' } }));
    expect((await drive(run.id as string)).state).toBe('failed');
  });
});

describe('S49: builds (mock runner: plumbing only), iOS BLOCKED, signing stage absent', () => {
  let projectId: string;
  let versionId: string;
  beforeAll(async () => {
    const { p } = await generate('Build Target');
    projectId = p.id as string;
    versionId = j(await e.call('alice', 'GET', `/v1/builder/projects/${projectId}`)).versionId as string;
  });

  it('an Android debug build: 202, executes once, artifact with sha256, retention, metering event, audit; labelled unsigned and mock', async () => {
    const r = await post('dave', '/v1/mobile/builds', { projectId, platform: 'android', profile: 'debug' }, A(), 'build-1');
    expect(r.statusCode).toBe(202);
    const b = j(r);
    expect(b.status).toBe('queued');
    expect(b.notices).toEqual(expect.arrayContaining(['unsigned']));
    // idempotent: same key, same build
    expect(j(await post('dave', '/v1/mobile/builds', { projectId, platform: 'android', profile: 'debug' }, A(), 'build-1')).id).toBe(b.id);
    const done = await buildSvc().execute(A(), b.id as string);
    expect(done?.status).toBe('succeeded');
    expect(await buildSvc().execute(A(), b.id as string)).toBeNull(); // the claim is won once
    const got = j(await e.call('dave', 'GET', `/v1/mobile/builds/${b.id}`));
    expect(got).toMatchObject({ status: 'succeeded', signed: false, runner: 'mock', isolation: 'none' });
    expect(got.notices).toEqual(expect.arrayContaining(['mock runner: not a real build']));
    const arts = (j(await e.call('dave', 'GET', `/v1/mobile/builds/${b.id}/artifacts`)).items as Row[]);
    expect(arts).toHaveLength(1);
    const stored = await bytes().get(`mem://${A()}/${b.id}/app-debug.apk`);
    expect(stored).not.toBeNull();
    const { createHash } = await import('node:crypto');
    expect(arts[0]!.sha256).toBe(createHash('sha256').update(stored!).digest('hex'));
    const days = Number((await e.sql(`SELECT extract(day FROM retention_until - created_at) d FROM mobile.artifacts WHERE build_id=$1`, [b.id]))[0]!.d);
    expect(days).toBeGreaterThanOrEqual(29);
    expect(days).toBeLessThanOrEqual(30);
    const usage = await e.sql(`SELECT payload FROM platform.outbox WHERE topic = 'usage.recorded' AND payload->>'meterId' = 'mobile.build_minutes' AND payload->>'resourceId' = $1`, [b.id]);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.payload).toMatchObject({ meterId: 'mobile.build_minutes', dimensions: { platform: 'android' } });
    expect(e.sink.events.some((x) => x.action === 'mobile.build.finished')).toBe(true);
    // minutes billed on the build row = the metered quantity
    expect(Number((await e.sql(`SELECT minutes_billed m FROM mobile.builds WHERE id=$1`, [b.id]))[0]!.m)).toBeCloseTo(Number((usage[0]!.payload as Row).quantity), 5);
  });

  it('concurrency: three simultaneous executions of one queued build run it exactly once (atomic claim), one artifact, one metering event', async () => {
    const b = j(await post('dave', '/v1/mobile/builds', { projectId, platform: 'android', profile: 'debug' }));
    const rs = await Promise.all([1, 2, 3].map(() => buildSvc().execute(A(), b.id as string)));
    expect(rs.filter((x) => x !== null)).toHaveLength(1);
    expect(Number((await e.sql(`SELECT count(*) n FROM mobile.artifacts WHERE build_id=$1`, [b.id]))[0]!.n)).toBe(1);
    expect(Number((await e.sql(`SELECT count(*) n FROM platform.outbox WHERE topic='usage.recorded' AND payload->>'resourceId'=$1`, [b.id]))[0]!.n)).toBe(1);
    // a finished build cannot be changed back (DB state machine)
    await expect(e.sql(`UPDATE mobile.builds SET status='queued' WHERE id=$1`, [b.id])).rejects.toThrow(/finished build/);
  });

  it('iOS: 503 no_macos_capacity, never a simulated success', async () => {
    const r = await post('dave', '/v1/mobile/builds', { projectId, platform: 'ios', profile: 'debug' });
    expect(r.statusCode).toBe(503);
    expect(r.body).toMatch(/no_macos_capacity|macOS/);
    expect(Number((await e.sql(`SELECT count(*) n FROM mobile.builds WHERE platform='ios'`))[0]!.n)).toBe(0);
  });

  it('release: 422 signing_not_authorized without a credential; with one, 503 signing_unavailable (no signing stage exists)', async () => {
    const r1 = await post('dave', '/v1/mobile/builds', { projectId, platform: 'android', profile: 'release' });
    expect(r1.statusCode).toBe(422);
    expect(r1.body).toMatch(/signing_not_authorized|signing credential/);
    const c = await post('alice', '/v1/mobile/signing-credentials', { platform: 'android', label: 'upload key', vaultRef: 'vault://org-a/mobile/android-upload', authorizedBy: e.ids.alice });
    expect(c.statusCode).toBe(201);
    const r2 = await post('dave', '/v1/mobile/builds', { projectId, platform: 'android', profile: 'release' });
    expect(r2.statusCode).toBe(503);
    expect(r2.body).toMatch(/signing_unavailable|signing stage/);
    expect(Number((await e.sql(`SELECT count(*) n FROM mobile.builds WHERE profile='release'`))[0]!.n)).toBe(0);
  });

  it('authorization and tenancy: viewer 403, org B 404 on project, build and artifacts; validation 422', async () => {
    expect((await post('carol', '/v1/mobile/builds', { projectId, platform: 'android', profile: 'debug' })).statusCode).toBe(403);
    const mine = j(await post('dave', '/v1/mobile/builds', { projectId, platform: 'android', profile: 'debug' }));
    expect((await post('bob', '/v1/mobile/builds', { projectId, platform: 'android', profile: 'debug' }, B())).statusCode).toBe(404);
    expect((await e.call('bob', 'GET', `/v1/mobile/builds/${mine.id}`, undefined, B())).statusCode).toBe(404);
    expect((await e.call('bob', 'GET', `/v1/mobile/builds/${mine.id}/artifacts`, undefined, B())).statusCode).toBe(404);
    expect(((await e.call('bob', 'GET', '/v1/mobile/builds', undefined, B())).json().items as unknown[]).length).toBe(0);
    for (const bad of [{ projectId, platform: 'windows', profile: 'debug' }, { projectId, platform: 'android', profile: 'nightly' }, { projectId: 'x', platform: 'android', profile: 'debug' }, { projectId, platform: 'android', profile: 'debug', extra: 1 }])
      expect((await post('dave', '/v1/mobile/builds', bad)).statusCode).toBe(422);
    // a version that is not generated yet cannot be built
    const empty = await mkProject('Empty Project');
    expect((await post('dave', '/v1/mobile/builds', { projectId: empty.id, platform: 'android', profile: 'debug' })).statusCode).toBe(422);
    void versionId;
  });

  it('a failing runner records a failed build with its code and still meters; the supply-chain gate blocks a bad lockfile before compiling', async () => {
    const mk = async (runner: BuildRunnerPort) => {
      const svc = new BuildService(
        e.app.get(DB, { strict: false }),
        e.app.get(AuditSink, { strict: false }),
        e.app.get(MobileProjectService, { strict: false }),
        e.app.get(SigningService, { strict: false }),
        e.app.get(SigningStagePort, { strict: false }),
        runner,
        bytes(),
        e.app.get(PubAdvisoryPort, { strict: false }),
        e.app.get(ResidencyService, { strict: false }),
        DEFAULT_BUILD_CONFIG,
      );
      const b = await svc.create(A(), e.ids.dave!, { projectId, platform: 'android', profile: 'debug' });
      return { svc, b };
    };
    const f = await mk(new MockBuildRunner({ fail: 'build_timeout' }));
    const fd = await f.svc.execute(A(), f.b.id);
    expect(fd).toMatchObject({ status: 'failed', errorCode: 'build_timeout' });
    expect((await f.svc.artifacts(A(), f.b.id)).length).toBe(0);
    expect(Number((await e.sql(`SELECT count(*) n FROM platform.outbox WHERE topic='usage.recorded' AND payload->>'resourceId'=$1`, [f.b.id]))[0]!.n)).toBe(1);
    // a runner whose resolved lock comes from a git source
    class BadLock extends MockBuildRunner {
      override async run(i: BuildInput): Promise<BuildOutput> {
        await i.verifyLock('packages:\n  evil:\n    dependency: transitive\n    description:\n      url: "https://github.com/x/evil.git"\n    source: git\n    version: "1.0.0"\n');
        throw new Error('unreachable: the gate must stop the build');
      }
    }
    const g = await mk(new BadLock());
    const gd = await g.svc.execute(A(), g.b.id);
    expect(gd).toMatchObject({ status: 'failed', errorCode: 'dependency_blocked' });
    expect(gd?.log).toMatch(/supply-chain: lock_source/);
  });

  it('AC-M10-13 scan: no secret or canary in a build log, the environment handed to a build process, artifacts, audit events', async () => {
    const canary = 'CANARY-PLATFORM-SECRET-0001';
    expect(Object.values(buildEnv({ PATH: '/bin', HOME: '/h', DATABASE_URL: `postgres://u:${canary}@h/db`, AI_SECRET_CANARIES: canary, NUZM_TOKEN: 'abc' })).join('|')).not.toMatch(/CANARY|postgres|abc/);
    class Leaky extends MockBuildRunner {
      override async run(i: BuildInput, log: (l: string) => void): Promise<BuildOutput> {
        log(`password = ${'x'.repeat(24)}`);
        log(`using key ${canary}`);
        log('vault ref vault://org-a/mobile/android-upload');
        log(`-----BEGIN ${'PRIVATE'} KEY-----`);
        log('plain progress line');
        return super.run(i, log);
      }
    }
    const svc = new BuildService(e.app.get(DB, { strict: false }), e.app.get(AuditSink, { strict: false }), e.app.get(MobileProjectService, { strict: false }), e.app.get(SigningService, { strict: false }), e.app.get(SigningStagePort, { strict: false }), new Leaky(), bytes(), e.app.get(PubAdvisoryPort, { strict: false }), e.app.get(ResidencyService, { strict: false }), DEFAULT_BUILD_CONFIG);
    const b = await svc.create(A(), e.ids.dave!, { projectId, platform: 'android', profile: 'debug' });
    const d = await svc.execute(A(), b.id);
    expect(d?.log).toContain('plain progress line');
    expect(d?.log).not.toMatch(/CANARY|BEGIN PRIVATE|vault:\/\/|password =/);
    expect((d?.log?.match(/line removed/g) ?? []).length).toBe(4);
    const everything = JSON.stringify(e.sink.events) + [...bytes().blobs.values()].map((x) => x.toString('latin1')).join('');
    expect(everything).not.toMatch(/CANARY-PLATFORM-SECRET|BEGIN PRIVATE|vault:\/\/org-a/);
    expect(redactLog(['ok', 'Bearer abcdefghijklmnopqrstuvwxyz0123456789'])).toBe('ok\n[line removed: possible secret]');
  });
});

describe('S49: signing credential references (vault references only)', () => {
  const body = (o: Row = {}) => ({ platform: 'android', label: `key-${Math.random().toString(36).slice(2, 8)}`, vaultRef: 'vault://org-a/mobile/k1', authorizedBy: e.ids.alice, ...o });
  it('stores a reference, lists it, audits it without the reference value; owner/admin only', async () => {
    const r = await post('alice', '/v1/mobile/signing-credentials', body({ label: 'prod upload' }));
    expect(r.statusCode).toBe(201);
    expect(j(r)).toMatchObject({ platform: 'android', label: 'prod upload', usable: true, authorizedBy: e.ids.alice });
    expect((await post('erin', '/v1/mobile/signing-credentials', { ...body(), authorizedBy: e.ids.erin })).statusCode).toBe(201); // admin
    expect((await post('dave', '/v1/mobile/signing-credentials', { ...body(), authorizedBy: e.ids.dave })).statusCode).toBe(403); // developer
    expect((await post('carol', '/v1/mobile/signing-credentials', { ...body(), authorizedBy: e.ids.carol })).statusCode).toBe(403);
    expect((await e.call('dave', 'GET', '/v1/mobile/signing-credentials')).statusCode).toBe(403);
    const list = j(await e.call('alice', 'GET', '/v1/mobile/signing-credentials')).items as Row[];
    expect(list.length).toBeGreaterThanOrEqual(2);
    const ev = e.sink.events.filter((x) => x.action === 'signing.credential.authorized');
    expect(ev.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(ev)).not.toMatch(/vault:\/\//);
    // other organization sees none
    expect(((await e.call('bob', 'GET', '/v1/mobile/signing-credentials', undefined, B())).json().items as unknown[]).length).toBe(0);
  });
  it('rejects key material, passwords, PEM, tokens and unknown members with 422 raw_secret_rejected and never echoes the value', async () => {
    const secrets: Row[] = [
      { keystore: 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC' },
      { [kk('pass', 'word')]: 'x'.repeat(14) },
      { [kk('store', 'Pass', 'word')]: 'abc' },
      { label: `-----BEGIN ${'PRIVATE'} KEY-----MIIE` },
      { vaultRef: 'vault://org/' + 'A1b2C3d4'.repeat(8) },
      { label: 'Bearer abcdefghijklmnopqrstuvwxyz012345' },
      { label: 'AKIA' + 'ABCDEFGHIJKLMNOP' },
    ];
    for (const s of secrets) {
      const r = await post('alice', '/v1/mobile/signing-credentials', body(s));
      expect(r.statusCode, JSON.stringify(s)).toBe(422);
      expect(r.body).toMatch(/raw_secret_rejected|secret|vault/);
      for (const v of Object.values(s)) expect(r.body.includes(String(v)), 'the value must not be echoed').toBe(false);
    }
    expect((await post('alice', '/v1/mobile/signing-credentials', body({ vaultRef: 'file:///etc/key.p12' }))).statusCode).toBe(422);
    expect((await post('alice', '/v1/mobile/signing-credentials', body({ authorizedBy: e.ids.bob }))).statusCode).toBe(422); // not on behalf of another person
    expect((await post('alice', '/v1/mobile/signing-credentials', body({ platform: 'web' }))).statusCode).toBe(422);
    // nothing stored for the rejected ones: only vault:// references exist in the table
    expect(Number((await e.sql(`SELECT count(*) n FROM mobile.signing_credential_refs WHERE vault_ref !~ '^vault://'`))[0]!.n)).toBe(0);
  });
  it('a duplicate active label is a conflict; rows are never deleted or edited (DB guard)', async () => {
    const b = body({ label: 'dup-label' });
    expect((await post('alice', '/v1/mobile/signing-credentials', b)).statusCode).toBe(201);
    expect((await post('alice', '/v1/mobile/signing-credentials', b)).statusCode).toBe(409);
    await expect(e.sql(`DELETE FROM mobile.signing_credential_refs WHERE label='dup-label'`)).rejects.toThrow(/never deleted/);
    await expect(e.sql(`UPDATE mobile.signing_credential_refs SET vault_ref='vault://other/ref' WHERE label='dup-label'`)).rejects.toThrow(/immutable/);
  });
});

describe('S50: release preparation (owner approval before anything leaves; no submission action exists)', () => {
  let projectId: string;
  let debugBuildId: string;
  let signedBuildId: string;
  const shots = (loc: string) => [1, 2].map((n) => ({ locale: loc, device: 'phone', ref: `shots/${loc}-${n}.png`, sha256: String(n).repeat(64).slice(0, 64) }));
  const full = (): Row => ({
    privacyPolicyUrl: 'https://example.com/privacy',
    permissions: [{ permission: 'internet', justification: 'sign in and load your data' }],
    screenshots: [...shots('ar'), ...shots('en')],
    compliance: { dataSafetyReviewed: true, ageRatingReviewed: true, contentRightsConfirmed: true, exportComplianceReviewed: true, iapPolicy: 'not_applicable' },
  });
  const meta = (): Row => ({
    title: { ar: 'مهام الميدان', en: 'Field Tasks' },
    shortDescription: { ar: 'تابع مهام فريقك', en: 'Track your team tasks' },
    fullDescription: { ar: 'تطبيق لمتابعة المهام الميدانية.', en: 'An app to follow field tasks.' },
    supportUrl: 'https://example.com/support',
  });
  const rel = (o: Row = {}) => ({ projectId, buildId: debugBuildId, versionName: '1.0.0', versionCode: Math.floor(Math.random() * 1e6) + 10, store: 'google_play', checklist: full(), metadata: meta(), ...o });

  beforeAll(async () => {
    const { p } = await generate('Release Target');
    projectId = p.id as string;
    const vid = j(await e.call('alice', 'GET', `/v1/builder/projects/${projectId}`)).versionId as string;
    const b = j(await post('dave', '/v1/mobile/builds', { projectId, platform: 'android', profile: 'debug' }));
    await buildSvc().execute(A(), b.id as string);
    debugBuildId = b.id as string;
    // FIXTURE: a SIGNED build. No signing stage exists (HG-10-01), so no real signed build can be produced; this row is inserted directly, labelled as a fixture, only to exercise the record flow.
    const cred = (await e.sql(`SELECT id FROM mobile.signing_credential_refs WHERE org_id=$1 LIMIT 1`, [A()]))[0]!.id as string;
    signedBuildId = (await e.sql(
      `INSERT INTO mobile.builds (id, org_id, project_id, version_id, platform, profile, status, runner_kind, isolation, signing_credential_id, signed, data_region, finished_at, toolchain)
       VALUES (gen_random_uuid(), $1, $2, $3, 'android', 'release', 'succeeded', 'test-fixture', 'none', $4, true, 'sa-central', now(), '{"fixture":true}') RETURNING id`,
      [A(), projectId, vid, cred],
    ))[0]!.id as string;
  });

  it('a draft keeps what was entered and reports what is missing for `prepared`; a debug (unsigned) build is never preparable', async () => {
    const r = await post('dave', '/v1/mobile/releases', rel({ checklist: { privacyPolicyUrl: 'http://insecure.example' }, metadata: {} }));
    expect(r.statusCode).toBe(201);
    const d = j(r);
    expect(d.status).toBe('draft');
    expect(d.missing).toEqual(expect.arrayContaining(['signed_release_build', 'privacy_policy_url', 'screenshots_ar', 'screenshots_en', 'compliance.iapPolicy', 'metadata.title']));
    expect(d.notices).toEqual(expect.arrayContaining([expect.stringMatching(/does not submit/)]));
    const p = await post('dave', '/v1/mobile/releases', rel({ status: 'prepared' }));
    expect(p.statusCode).toBe(422);
    expect(p.body).toMatch(/signed_release_build/);
  });

  it('prepared needs every item: each missing item is named; copy that promises approval is refused', async () => {
    const lacking = rel({ buildId: signedBuildId, status: 'prepared', checklist: { ...full(), screenshots: shots('ar'), permissions: [] } });
    const r = await post('dave', '/v1/mobile/releases', lacking);
    expect(r.statusCode).toBe(422);
    expect(r.body).toMatch(/screenshots_en/);
    expect(r.body).toMatch(/permission_declarations_match_the_app/);
    const promise = rel({ buildId: signedBuildId, metadata: { ...meta(), shortDescription: { ar: 'نضمن لك الموافقة', en: 'We guarantee approval by the App Store' } } });
    const c = await post('dave', '/v1/mobile/releases', promise);
    expect(c.statusCode).toBe(422);
    expect(c.body).toMatch(/promises store approval/);
    // a store/platform mismatch
    expect((await post('dave', '/v1/mobile/releases', rel({ buildId: signedBuildId, store: 'app_store', status: 'prepared' }))).body).toMatch(/ios_build_for_app_store/);
    // unknown members are refused
    expect((await post('dave', '/v1/mobile/releases', rel({ submit: true }))).statusCode).toBe(422);
    expect((await post('dave', '/v1/mobile/releases', rel({ status: 'owner_approved' }))).statusCode).toBe(422);
  });

  it('prepared -> owner approval bound to the content hash; only the owner; stale hash 409; final and immutable; export only after approval; never a store call', async () => {
    const svc = e.app.get(ReleaseService, { strict: false });
    const body = rel({ buildId: signedBuildId, status: 'prepared' });
    const r = await post('dave', '/v1/mobile/releases', body);
    expect(r.statusCode, r.body).toBe(201);
    const rec = j(r);
    expect(rec.status).toBe('prepared');
    expect(rec.scopeHash).toMatch(/^[0-9a-f]{64}$/);
    // duplicate (store, versionCode)
    expect((await post('dave', '/v1/mobile/releases', body)).statusCode).toBe(409);
    await expect(svc.submissionExport(A(), rec.id as string)).rejects.toMatchObject({ code: 'owner_approval_required' });
    await expect(svc.ownerApprove(A(), { userId: e.ids.dave!, isOwner: false }, rec.id as string, rec.scopeHash)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(svc.ownerApprove(A(), { userId: e.ids.alice!, isOwner: true }, rec.id as string, 'f'.repeat(64))).rejects.toMatchObject({ code: 'conflict' });
    const ok = await svc.ownerApprove(A(), { userId: e.ids.alice!, isOwner: true }, rec.id as string, rec.scopeHash);
    expect(ok).toMatchObject({ status: 'owner_approved', ownerApprovedBy: e.ids.alice });
    expect((await svc.ownerApprove(A(), { userId: e.ids.alice!, isOwner: true }, rec.id as string, rec.scopeHash)).status).toBe('owner_approved'); // idempotent
    await expect(e.sql(`UPDATE mobile.releases SET metadata='{}' WHERE id=$1`, [rec.id])).rejects.toThrow(/immutable/);
    await expect(e.sql(`DELETE FROM mobile.releases WHERE id=$1`, [rec.id])).rejects.toThrow(/never deleted/);
    const exp = await svc.submissionExport(A(), rec.id as string);
    expect(exp).toMatchObject({ releaseId: rec.id, store: 'google_play', versionCode: body.versionCode });
    expect(JSON.stringify(exp)).toMatch(/does not submit/);
    expect(e.sink.events.some((x) => x.action === 'release.owner.approved')).toBe(true);
    // no HTTP route promises submission or approval
    for (const u of [`/v1/mobile/releases/${rec.id}/submission`, `/v1/mobile/releases/${rec.id}/approval`, `/v1/mobile/releases/${rec.id}`])
      expect((await e.call('alice', 'POST', u, {})).statusCode, u).toBe(404);
  });

  it('cross-tenant: org B sees no release, cannot create one against org A project/build; viewer 403', async () => {
    expect(((await e.call('bob', 'GET', '/v1/mobile/releases', undefined, B())).json().items as unknown[]).length).toBe(0);
    expect((await post('bob', '/v1/mobile/releases', rel(), B())).statusCode).toBe(404);
    expect((await post('carol', '/v1/mobile/releases', rel())).statusCode).toBe(403);
    expect(((await e.call('alice', 'GET', `/v1/mobile/releases?projectId=${projectId}`)).json().items as unknown[]).length).toBeGreaterThanOrEqual(2);
  });
});
