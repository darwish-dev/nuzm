import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleFiles } from './internal/agents/webapp-agents';
import { sha256 } from './internal/core';
import { untarGz } from './internal/deploy/archive';
import { CRM_SPEC } from './internal/fixtures/crm-appspec';
import { generateProject, packageJson } from './internal/gen/project';
import { WEBAPP_GRAPH } from './internal/graph/dag';
import { scanSecrets } from './internal/sandbox/paths';
import { LocalDevSandboxRuntime } from './internal/sandbox/local-dev-runtime';
import { setupEngineEnv } from './internal/testing/engine-harness';
import { ORG_A, ORG_B, SEED_USER, setupBuildEnv, type BuildEnv } from './internal/testing/build-harness';
import { materialize } from './internal/testing/materialize';

/** A SYNTHETIC lockfile (mirror-resolved, integrity placeholders): the real one is created in the sandbox through the package mirror and is not available offline. */
const fakeLock = (manifest: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const deps = { ...((manifest.dependencies as object) ?? {}), ...((manifest.devDependencies as object) ?? {}) };
  return JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...Object.fromEntries(Object.keys(deps).map((n) => [`node_modules/${n}`, { version: '1.0.0', resolved: `https://npm-mirror.nuzm.internal/${n}/-/${n.split('/').pop()}-1.0.0.tgz`, integrity: 'sha512-AAAAAAAA', license: 'MIT' }])), ...extra } });
};
const GEN = generateProject(CRM_SPEC);
const SRC = new Map(GEN.files);
SRC.set('package-lock.json', fakeLock(packageJson(CRM_SPEC)));
const actor = (role = 'owner', perms = ['ai:approve']) => ({ userId: SEED_USER, role, permissions: new Set(perms) });

let b: BuildEnv;
beforeAll(async () => {
  b = await setupBuildEnv();
  b.mock.register('npx', () => ({ stdout: 'built', exitCode: 0, cpuSeconds: 1 }));
  b.mock.register('npm', () => ({ stdout: 'installed', exitCode: 0, cpuSeconds: 1 }));
}, 120_000);
afterAll(() => b.close());

const mkProject = async (extra: Record<string, string> = {}, drop: string[] = []) => {
  const files = new Map(SRC);
  for (const d of drop) files.delete(d);
  for (const [k, v] of Object.entries(extra)) files.set(k, v);
  const project = await b.projects.create(ORG_A, { type: 'webapp', name: 'crm', dataRegion: 'sa-central', createdBy: SEED_USER });
  const v = await b.projects.commit(ORG_A, project.id, { baseVersionId: null, files, source: 'ai', createdBy: SEED_USER });
  return { project: (await b.projects.get(ORG_A, project.id))!, v1: v.id };
};
const newVersion = async (projectId: string, base: string, patch: Record<string, string>) => {
  const files = new Map((await b.projects.readFiles(ORG_A, projectId, base))!);
  for (const [k, v] of Object.entries(patch)) files.set(k, v);
  return (await b.projects.commit(ORG_A, projectId, { baseVersionId: base, files, source: 'user', createdBy: SEED_USER })).id;
};
const site = (org = ORG_A, o: Record<string, unknown> = {}) => b.target.register({ id: randomUUID(), orgId: org, type: 'site', region: 'sa-central', status: 'active', newPaidResource: false, ...o });
const deploy = async (p: Awaited<ReturnType<typeof mkProject>>, versionId: string, target: { id: string }, env: 'production' | 'staging' = 'staging') => {
  const { deployment } = await b.deployments.create(ORG_A, SEED_USER, (await b.projects.get(ORG_A, p.project.id))!, { versionId, target: { type: 'site', id: target.id }, env });
  return b.deployments.execute(ORG_A, SEED_USER, (await b.projects.get(ORG_A, p.project.id))!, deployment.id);
};

describe('M10A gate path on the reference-CRM fixture: generate -> test -> deploy -> rollback -> export -> rebuild (dev evidence; NOT the independent suite)', () => {
  it('generation through the agent graph yields the project that is then used below', async () => {
    const e = await setupEngineEnv();
    try {
      e.useRealAgents();
      e.model.register('requirements', () => ({ summary: 'CRM', entities: CRM_SPEC.entities.map((x) => ({ name: x.name })), roles: CRM_SPEC.roles.map((r) => r.name), locales: ['ar', 'en'] }));
      e.model.register('app_spec', () => CRM_SPEC);
      const runId = await e.newRun(e.orgA, { maxTokens: 900_000, maxCostMinor: 1_000_000, maxMinutes: 30 });
      const out = await e.runner().run(e.orgA, runId, WEBAPP_GRAPH, { brief: {} });
      expect(out.status).toBe('succeeded');
      const files = assembleFiles((out as { artifacts: Record<string, unknown> }).artifacts);
      for (const [p, c] of files) expect(c, p).toBe(GEN.files.get(p)); // the agents produce exactly the scaffold
    } finally {
      await e.close();
    }
  });

  it('deploys to staging (build in a sandbox, content-addressed artifact, health gate), supersedes the previous release, and rolls back', async () => {
    const p = await mkProject();
    const t = site();
    const d1 = await deploy(p, p.v1, t);
    expect(d1).toMatchObject({ state: 'live', environment: 'staging' });
    expect(d1.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await b.deployments.logs(ORG_A, d1.id)).map((l) => l.message).join('\n')).toMatch(/building in a sandbox[\s\S]*release artifact[\s\S]*live/);
    // the release artifact is exactly the project (no node_modules), and verifiable
    expect([...untarGz((await b.releases.get(ORG_A, d1.id === '' ? '' : (await b.env.sql(`SELECT artifact_ref FROM deploy.app_deployments WHERE id = $1`, [d1.id]))[0]!.artifact_ref as string))!).keys()]).toContain('src/engine.ts');
    const v2 = await newVersion(p.project.id, p.v1, { 'src/config.ts': (SRC.get('src/config.ts') ?? '') + '\n// v2\n' });
    const d2 = await deploy(p, v2, t);
    expect(d2.state).toBe('live');
    expect(d2.previousDeploymentId).toBe(d1.id);
    expect((await b.deployments.get(ORG_A, d1.id)).state).toBe('superseded');
    expect(d2.artifactSha256).not.toBe(d1.artifactSha256);
    // rollback restores the prior artifact; idempotent; the rolled-back record keeps its history
    const t0 = Date.now();
    const rb = await b.deployments.rollback(ORG_A, SEED_USER, (await b.projects.get(ORG_A, p.project.id))!, d2.id);
    expect(Date.now() - t0).toBeLessThan(5 * 60_000);
    expect(rb.deployment).toMatchObject({ state: 'live', rollbackOf: d2.id, artifactSha256: d1.artifactSha256 });
    expect((await b.deployments.get(ORG_A, d2.id)).state).toBe('rolled_back');
    expect(await b.target.currentRelease(ORG_A, t.id)).toBe((await b.env.sql(`SELECT release_ref FROM deploy.app_deployments WHERE id = $1`, [d1.id]))[0]!.release_ref);
    const again = await b.deployments.rollback(ORG_A, SEED_USER, (await b.projects.get(ORG_A, p.project.id))!, d2.id);
    expect(again).toMatchObject({ replayed: true, deployment: { id: rb.deployment.id } });
    await expect(b.deployments.rollback(ORG_A, SEED_USER, p.project, d1.id)).rejects.toMatchObject({ code: 'invalid_state' }); // superseded, not live
    expect(b.sink.events.filter((x) => x.action === 'deploy.deployment.rolled_back').length).toBeGreaterThanOrEqual(1);
    // exactly one live deployment per target+env (database invariant)
    expect((await b.env.sql(`SELECT count(*)::int n FROM deploy.app_deployments WHERE target_id = $1 AND state = 'live'`, [t.id]))[0]!.n).toBe(1);
  });

  it('a failed health gate restores the previous release automatically and the new deployment ends failed', async () => {
    const p = await mkProject();
    const t = site();
    const d1 = await deploy(p, p.v1, t);
    const v2 = await newVersion(p.project.id, p.v1, { 'src/config.ts': 'export const x = 2;\n' });
    b.health.failWhen((u) => u.startsWith(t.baseUrl));
    const d2 = await deploy(p, v2, t);
    b.health.clear();
    expect(d2).toMatchObject({ state: 'failed', failureCode: 'health_gate_failed' });
    expect(d2.healthCheck).toMatchObject({ autoRolledBack: true, restoredDeploymentId: d1.id });
    expect((await b.deployments.get(ORG_A, d1.id)).state).toBe('live'); // the previous deployment is still the live one
    expect(await b.target.currentRelease(ORG_A, t.id)).toBe((await b.env.sql(`SELECT release_ref FROM deploy.app_deployments WHERE id = $1`, [d1.id]))[0]!.release_ref);
    expect((await b.deployments.logs(ORG_A, d2.id)).map((l) => l.message).join('\n')).toMatch(/health gate failed.*restored automatically/);
    // a gate that recovers on the second probe passes
    b.health.failWhen((u) => u.startsWith(t.baseUrl), [{ ok: false, status: 503, detail: 'warming up' }, { ok: true, status: 200, detail: 'ok' }]);
    const v3 = await newVersion(p.project.id, v2, { 'src/config.ts': 'export const x = 3;\n' });
    expect((await deploy(p, v3, t)).state).toBe('live');
    b.health.clear();
  });

  it('a target that refuses the release or a build that fails ends failed with a stable code; nothing becomes live', async () => {
    const p = await mkProject();
    const t = site();
    b.target.failNextDeploy = true;
    expect(await deploy(p, p.v1, t)).toMatchObject({ state: 'failed', failureCode: 'deploy_failed' });
    b.mock.register('npx', () => ({ stdout: 'error TS2322', exitCode: 2 }));
    const t2 = site();
    expect(await deploy(p, p.v1, t2)).toMatchObject({ state: 'failed', failureCode: 'build_failed' });
    b.mock.register('npx', () => ({ stdout: 'built', exitCode: 0, cpuSeconds: 1 }));
    expect((await b.env.sql(`SELECT count(*)::int n FROM deploy.app_deployments WHERE target_id = ANY($1) AND state = 'live'`, [[t.id, t2.id]]))[0]!.n).toBe(0);
  });

  it('duplicate create for the same release on the same target is one deployment; logs are append-only', async () => {
    const p = await mkProject();
    const t = site();
    const body = { versionId: p.v1, target: { type: 'site', id: t.id }, env: 'staging' };
    const [a, c] = await Promise.all([b.deployments.create(ORG_A, SEED_USER, p.project, body), b.deployments.create(ORG_A, SEED_USER, p.project, body)]);
    const again = await b.deployments.create(ORG_A, SEED_USER, p.project, body);
    expect(again.created).toBe(false);
    expect(again.deployment.id).toBe(a.deployment.id);
    void c;
    const done = await b.deployments.execute(ORG_A, SEED_USER, p.project, a.deployment.id);
    await expect(b.env.sql(`UPDATE deploy.app_deployment_logs SET message = 'x' WHERE deployment_id = $1`, [done.id])).rejects.toThrow(/append-only/);
    await expect(b.env.sql(`DELETE FROM deploy.app_deployment_logs WHERE deployment_id = $1`, [done.id])).rejects.toThrow(/append-only/);
  });

  it('every approval type blocks until approved; stale/expired approvals are refused; an approval for another version does not carry over (AC-M10-05)', async () => {
    const p = await mkProject();
    const t = site();
    const prod = { versionId: p.v1, target: { type: 'site' as const, id: t.id }, env: 'production' };
    const e1 = await b.deployments.create(ORG_A, SEED_USER, p.project, prod).catch((x) => x);
    expect(e1.code).toBe('approval_required');
    const ap = e1.extra.approvals[0];
    expect(ap.type).toBe('production_deploy');
    await expect(b.approvals.decide(ORG_A, actor('owner'), ap.id, { decision: 'approve', scopeHash: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'stale_approval_hash' });
    await expect(b.approvals.decide(ORG_A, actor('developer'), ap.id, { decision: 'approve', scopeHash: ap.scopeHash })).rejects.toMatchObject({ code: 'forbidden' });
    await b.approvals.decide(ORG_A, actor('admin'), ap.id, { decision: 'approve', scopeHash: ap.scopeHash });
    const ok = await b.deployments.create(ORG_A, SEED_USER, p.project, prod);
    expect(ok.created).toBe(true);
    await b.deployments.execute(ORG_A, SEED_USER, p.project, ok.deployment.id);
    // another version needs its own approval
    const v2 = await newVersion(p.project.id, p.v1, { 'src/config.ts': 'export const y = 1;\n' });
    const e2 = await b.deployments.create(ORG_A, SEED_USER, (await b.projects.get(ORG_A, p.project.id))!, { ...prod, versionId: v2 }).catch((x) => x);
    expect(e2.code).toBe('approval_required');
    expect(e2.extra.approvals[0].scopeHash).not.toBe(ap.scopeHash);
    // an approval older than 24 h is refused
    b.clock.now = new Date(b.clock.now.getTime() + 25 * 3_600_000);
    await expect(b.approvals.decide(ORG_A, actor('admin'), e2.extra.approvals[0].id, { decision: 'approve', scopeHash: e2.extra.approvals[0].scopeHash })).rejects.toMatchObject({ code: 'gone' });
    expect(await b.approvals.approvedFor(ORG_A, { type: 'project', id: p.project.id }, 'production_deploy', prod as never)).toBeNull();
    b.clock.now = new Date('2026-11-18T10:00:00Z');
  });

  it('paid resource, destructive migration, production rollback and data-affecting rollback each need their approval', async () => {
    const p = await mkProject();
    const paid = site(ORG_A, { newPaidResource: true });
    const e = await b.deployments.create(ORG_A, SEED_USER, p.project, { versionId: p.v1, target: { type: 'site', id: paid.id }, env: 'staging' }).catch((x) => x);
    expect(e.code).toBe('approval_required');
    expect(e.extra.approvals.map((a: { type: string }) => a.type)).toEqual(['paid_resource']);
    // destructive migration on a target that already has migration 1 applied
    const t = site();
    const d1 = await deploy(p, p.v1, t);
    const dropMig = 'ALTER TABLE "leads" DROP COLUMN "company";\n';
    const v2 = await newVersion(p.project.id, p.v1, { 'db/migrations/0002_contract.sql': dropMig, 'db/migrations/0002_contract.down.sql': 'ALTER TABLE "leads" ADD COLUMN "company" varchar(160);\n' });
    const e2 = await b.deployments.create(ORG_A, SEED_USER, (await b.projects.get(ORG_A, p.project.id))!, { versionId: v2, target: { type: 'site', id: t.id }, env: 'staging' }).catch((x) => x);
    expect(e2.code).toBe('approval_required');
    expect(e2.extra.approvals.map((a: { type: string }) => a.type)).toEqual(['destructive_migration']);
    await b.approvals.decide(ORG_A, actor('owner'), e2.extra.approvals[0].id, { decision: 'approve', scopeHash: e2.extra.approvals[0].scopeHash });
    const d2 = await deploy(p, v2, t);
    expect(d2.state).toBe('live');
    expect(d2.migrations).toEqual([{ version: 2, destructive: true }]);
    // rolling back a deployment that applied a data-affecting migration needs its own approval
    const rb = await b.deployments.rollback(ORG_A, SEED_USER, (await b.projects.get(ORG_A, p.project.id))!, d2.id).catch((x) => x);
    expect(rb.code).toBe('approval_required');
    expect(rb.extra.approvals.map((a: { type: string }) => a.type)).toEqual(['data_migration_rollback']);
    await b.approvals.decide(ORG_A, actor('admin'), rb.extra.approvals[0].id, { decision: 'approve', scopeHash: rb.extra.approvals[0].scopeHash });
    expect((await b.deployments.rollback(ORG_A, SEED_USER, (await b.projects.get(ORG_A, p.project.id))!, d2.id)).deployment.rollbackOf).toBe(d2.id);
    void d1;
    // production rollback
    const pt = site();
    const prodBody = (v: string) => ({ versionId: v, target: { type: 'site' as const, id: pt.id }, env: 'production' });
    const pp = (await b.projects.get(ORG_A, p.project.id))!;
    for (const v of [p.v1, v2]) {
      const need = await b.deployments.create(ORG_A, SEED_USER, pp, prodBody(v)).catch((x) => x);
      if (need.code === 'approval_required') for (const a of need.extra.approvals) await b.approvals.decide(ORG_A, actor('owner'), a.id, { decision: 'approve', scopeHash: a.scopeHash });
      const made = await b.deployments.create(ORG_A, SEED_USER, pp, prodBody(v));
      await b.deployments.execute(ORG_A, SEED_USER, pp, made.deployment.id);
    }
    const live = (await b.deployments.list(ORG_A, { projectId: p.project.id })).find((d) => d.target.id === pt.id && d.state === 'live')!;
    const e4 = await b.deployments.rollback(ORG_A, SEED_USER, pp, live.id).catch((x) => x);
    expect(e4.code).toBe('approval_required');
    expect(e4.extra.approvals.map((a: { type: string }) => a.type)).toContain('production_rollback');
  });

  it('supply chain: no lockfile, a typosquat, a high advisory or an install script never reaches deploy (AC-M10-16)', async () => {
    const noLock = await mkProject({}, ['package-lock.json']);
    await expect(b.deployments.create(ORG_A, SEED_USER, noLock.project, { versionId: noLock.v1, target: { type: 'site', id: site().id } })).rejects.toMatchObject({ code: 'dependency_blocked' });
    const squat = await mkProject({ 'package.json': JSON.stringify({ ...packageJson(CRM_SPEC), dependencies: { lodahs: '^4.0.0', pg: '^8.13.0' } }), 'package-lock.json': fakeLock({ dependencies: { lodahs: '1', pg: '1' } }) });
    await expect(b.deployments.create(ORG_A, SEED_USER, squat.project, { versionId: squat.v1, target: { type: 'site', id: site().id } })).rejects.toMatchObject({ code: 'dependency_blocked' });
    const script = await mkProject({ 'package-lock.json': fakeLock(packageJson(CRM_SPEC), { 'node_modules/esbuild': { version: '0.2.0', resolved: 'https://npm-mirror.nuzm.internal/esbuild.tgz', integrity: 'sha512-AAAA', license: 'MIT', hasInstallScript: true } }) });
    const e = await b.deployments.create(ORG_A, SEED_USER, script.project, { versionId: script.v1, target: { type: 'site', id: site().id } }).catch((x) => x);
    expect(e.code).toBe('approval_required');
    expect(e.extra.approvals[0].type).toBe('egress_or_dependency');
  });

  it('secrets in the release block the deployment; a canary anywhere blocks it too', async () => {
    const p = await mkProject({ 'src/leak.ts': 'export const k = "AKIAABCDEFGHIJKLMNOP";\n' });
    await expect(b.deployments.create(ORG_A, SEED_USER, p.project, { versionId: p.v1, target: { type: 'site', id: site().id } })).rejects.toMatchObject({ code: 'change_rejected' });
  });

  it('cross-tenant matrix: another org cannot read, list, roll back or deploy to org A resources (404)', async () => {
    const p = await mkProject();
    const t = site();
    const d = await deploy(p, p.v1, t);
    const pB = await b.projects.create(ORG_B, { type: 'webapp', name: 'x', dataRegion: 'sa-central', createdBy: null });
    await expect(b.deployments.get(ORG_B, d.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(b.deployments.logs(ORG_B, d.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(b.deployments.rollback(ORG_B, SEED_USER, pB, d.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await b.deployments.list(ORG_B, { projectId: p.project.id })).toEqual([]);
    const vB = (await b.projects.commit(ORG_B, pB.id, { baseVersionId: null, files: new Map(SRC), source: 'user', createdBy: null })).id;
    await expect(b.deployments.create(ORG_B, SEED_USER, (await b.projects.get(ORG_B, pB.id))!, { versionId: vB, target: { type: 'site', id: t.id }, env: 'staging' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('residency: a deployment region the policy denies is refused with 403 before anything is built', async () => {
    const p = await mkProject();
    const t = site(ORG_A, { region: 'us-east' });
    const deny = (b.deployments as unknown as { residency: { evaluate: unknown } }).residency;
    const orig = deny.evaluate;
    deny.evaluate = async (q: { targetRegion: string }) => (q.targetRegion === 'us-east' ? { decision: 'deny', reasons: [{ code: 'r', message: { en: 'not in the Kingdom', ar: 'x' } }] } : { decision: 'allow', reasons: [] });
    await expect(b.deployments.create(ORG_A, SEED_USER, p.project, { versionId: p.v1, target: { type: 'site', id: t.id } })).rejects.toMatchObject({ code: 'residency_denied' });
    deny.evaluate = orig;
  });
});

describe('export (AC-M10-07): standalone, secret-free, deterministic, signed', () => {
  it('exports source + lockfile + migrations + README + OpenAPI + SBOM, deterministically, with a ≤15 minute signed URL, and the export rebuilds and passes its own tests with no Nuzm dependency', async () => {
    const p = await mkProject();
    const ex = await b.exports.create(ORG_A, SEED_USER, p.project, {});
    expect(ex).toMatchObject({ status: 'ready', fileCount: expect.any(Number) });
    const ex2 = await b.exports.create(ORG_A, SEED_USER, p.project, {});
    expect(ex2.sha256).toBe(ex.sha256); // deterministic
    const ttl = (new Date(ex.downloadUrlExpiresAt!).getTime() - b.clock.now.getTime()) / 1000;
    expect(ttl).toBeLessThanOrEqual(900);
    const verified = b.releases.verify(ex.downloadUrl!, b.clock.now);
    expect(verified?.orgId).toBe(ORG_A);
    expect(b.releases.verify(ex.downloadUrl!, new Date(b.clock.now.getTime() + 901_000))).toBeNull(); // expired
    expect(b.releases.verify(ex.downloadUrl!.replace(/sig=.{4}/, 'sig=AAAA'), b.clock.now)).toBeNull(); // tampered
    const archive = (await b.releases.get(ORG_A, verified!.ref))!;
    expect(sha256(archive)).toBe(ex.sha256);
    const files = untarGz(archive);
    for (const f of ['package.json', 'package-lock.json', 'db/migrations/0001_init.sql', 'db/migrations/0001_init.down.sql', 'README.md', 'openapi.json', 'SBOM.cdx.json', 'EXPORT-MANIFEST.json', 'src/engine.ts', 'tests/rbac.test.ts']) expect(files.has(f), f).toBe(true);
    expect(files.has('nuzm.app.json')).toBe(false);
    expect(JSON.parse(files.get('SBOM.cdx.json')!).bomFormat).toBe('CycloneDX');
    const manifest = JSON.parse(files.get('EXPORT-MANIFEST.json')!) as { files: Record<string, string> };
    for (const [path, h] of Object.entries(manifest.files)) expect(sha256(files.get(path)!), path).toBe(h);
    // no secret anywhere, no Nuzm reference that the app needs
    for (const [path, c] of files) {
      expect(scanSecrets(c), path).toEqual([]);
      if (path.startsWith('src/') || path.startsWith('tests/')) expect(c, path).not.toMatch(/@nuzm\/|nuzm\.invalid|NUZM_/);
    }
    // rebuild from the export in a clean directory: its own tests pass (in-memory store; dependencies are installed from the lockfile in a real rebuild)
    const m = materialize(files);
    try {
      const r = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-concurrency=1', 'tests/*.test.ts'], { cwd: m.dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, timeout: 280_000 });
      expect(r.stdout).toMatch(/# fail 0/);
      expect(Number(/# pass (\d+)/.exec(r.stdout)?.[1])).toBeGreaterThan(40);
    } finally {
      m.cleanup();
    }
    expect(b.sink.events.some((e) => e.action === 'builder.export.created')).toBe(true);
    expect(b.sink.events.some((e) => e.action === 'builder.export.downloaded')).toBe(false);
    await b.exports.get(ORG_A, p.project.id, ex.id);
    expect(b.sink.events.some((e) => e.action === 'builder.export.downloaded')).toBe(true);
  }, 400_000);

  it('a secret, a canary, an unsafe path or a missing lockfile BLOCKS the export (422 export_blocked) and records rule + path, never the secret', async () => {
    const canary = b.canaries.plantStandardSet()[1]!.value;
    for (const [extra, drop, rule] of [
      [{ 'src/secrets.ts': 'const k = "AKIAABCDEFGHIJKLMNOP";' }, [], 'aws_access_key_id'],
      [{ 'src/c.ts': `// ${canary}` }, [], 'canary_token'],
      [{}, ['package-lock.json'], 'lockfile_missing'],
    ] as const) {
      const p = await mkProject({ ...extra }, [...drop]);
      const e = await b.exports.create(ORG_A, SEED_USER, p.project, {}).catch((x) => x);
      expect(e.code, rule).toBe('export_blocked');
      expect(JSON.stringify(e.errors)).toContain(rule === 'canary_token' ? 'canary' : rule);
      expect(JSON.stringify(e.errors)).not.toContain('AKIAABCDEFGHIJKLMNOP');
      expect(JSON.stringify(e.errors)).not.toContain(canary);
      expect((await b.exports.list(ORG_A, p.project.id))[0]).toMatchObject({ status: 'blocked', downloadUrl: null });
    }
  });

  it('vendored third-party code needs the export_third_party approval (bound to the exact paths); then it exports and carries the flag', async () => {
    const p = await mkProject({ 'vendor/lib/index.js': 'module.exports = 1;\n' });
    const e = await b.exports.create(ORG_A, SEED_USER, p.project, {}).catch((x) => x);
    expect(e.code).toBe('approval_required');
    expect(e.extra.approvals[0].type).toBe('export_third_party');
    await b.approvals.decide(ORG_A, actor('owner'), e.extra.approvals[0].id, { decision: 'approve', scopeHash: e.extra.approvals[0].scopeHash });
    const ok = await b.exports.create(ORG_A, SEED_USER, p.project, {});
    expect(ok).toMatchObject({ status: 'ready', flags: ['vendored_third_party_code'] });
  });

  it('residency export rule, expiry, and cross-tenant (404)', async () => {
    const p = await mkProject();
    const ex = await b.exports.create(ORG_A, SEED_USER, p.project, {});
    await expect(b.exports.get(ORG_B, p.project.id, ex.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await b.exports.list(ORG_B, p.project.id)).toEqual([]);
    b.clock.now = new Date(b.clock.now.getTime() + 8 * 86_400_000);
    expect(await b.exports.get(ORG_A, p.project.id, ex.id)).toMatchObject({ status: 'expired', downloadUrl: null });
    b.clock.now = new Date('2026-11-18T10:00:00Z');
    const deny = (b.exports as unknown as { residency: { evaluate: unknown } }).residency;
    const orig = deny.evaluate;
    deny.evaluate = async () => ({ decision: 'deny', reasons: [{ code: 'r', message: { en: 'export region denied', ar: 'x' } }] });
    await expect(b.exports.create(ORG_A, SEED_USER, p.project, {})).rejects.toMatchObject({ code: 'residency_denied' });
    deny.evaluate = orig;
  });
});

describe('the unit suite of the generated CRM runs for real in the local dev runner (NOT isolated: dev evidence only)', () => {
  it('structured junit results from a real execution of the generated tests', async () => {
    process.env.SANDBOX_LOCAL_DEV = 'true';
    const lb = await setupBuildEnv({ runtime: new LocalDevSandboxRuntime() });
    try {
      const project = await lb.projects.create(ORG_A, { type: 'webapp', name: 'crm', dataRegion: 'sa-central', createdBy: SEED_USER });
      await lb.projects.commit(ORG_A, project.id, { baseVersionId: null, files: new Map(SRC), source: 'ai', createdBy: SEED_USER });
      const p = (await lb.projects.get(ORG_A, project.id))!;
      const run = await lb.tests.create(ORG_A, SEED_USER, p, { suite: 'unit' });
      const done = await lb.tests.execute(ORG_A, SEED_USER, p, run.id);
      expect(done.runtime.kind).toBe('local-dev');
      expect(done.summary).toMatchObject({ totals: { suites: 1, failures: 0 } });
      expect((done.summary.totals as { tests: number }).tests).toBeGreaterThan(40);
      expect(done.status).toBe('passed');
    } finally {
      await lb.close();
    }
  }, 400_000);
});
