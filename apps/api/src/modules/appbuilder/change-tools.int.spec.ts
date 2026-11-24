import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from './internal/core';
import { BuilderInsightService } from './internal/changes/builder-insight.service';
import { ChangeToolsService } from './internal/changes/change-tools.service';
import { ProjectRepairService } from './internal/changes/repair.service';
import { builderTools } from '@nuzm/domain';
import { ORG_A, ORG_B, SEED_USER, setupBuildEnv, type BuildEnv } from './internal/testing/build-harness';

let b: BuildEnv;
let tools: ChangeToolsService;
let insight: BuilderInsightService;
beforeAll(async () => {
  b = await setupBuildEnv();
  tools = new ChangeToolsService(b.projects, b.changes, b.canaries, b.sink);
  insight = new BuilderInsightService(b.projects, b.changes, b.model, b.sink);
}, 120_000);
afterAll(() => b.close());

const BASE = {
  'README.md': '# app\n',
  'src/answer.ts': 'export const answer = 1;\n',
  'package.json': JSON.stringify({ name: 'x', version: '1.0.0' }),
};
const codeOf = async (f: Promise<unknown>) => {
  try {
    await f;
    return 'no error';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};

describe('change tools on the real change pipeline (DB + Git)', () => {
  it('previews without storing anything, then rolls back to v1 as a NEW restore version on main, with the Git tree equal to v1', async () => {
    const p = await b.newProject(BASE);
    const v1 = p.versionId!;
    const proj = (await b.projects.get(ORG_A, p.project.id))!;
    const prev = await tools.preview(ORG_A, proj, { patches: [{ op: 'modify', path: 'src/answer.ts', content: 'export const answer = 2;\n', expectedHash: sha256(BASE['src/answer.ts']) }] });
    expect(prev.ok).toBe(true);
    expect((await b.projects.listVersions(ORG_A, p.project.id)).length).toBe(1);
    const c = await b.changes.apply(ORG_A, SEED_USER, proj, { baseVersion: v1, source: 'ai', patches: [{ op: 'modify', path: 'src/answer.ts', content: 'export const answer = 2;\n' }, { op: 'add', path: 'src/extra.ts', content: 'export {};\n' }] });
    const head = (await b.projects.get(ORG_A, p.project.id))!;
    expect(head.headVersionId).toBe(c.versionId);
    const d = await tools.diff(ORG_A, head, v1, c.versionId);
    expect(d.files.map((f) => `${f.op}:${f.path}`)).toEqual(['modify:src/answer.ts', 'add:src/extra.ts']);
    const r = await tools.rollback(ORG_A, SEED_USER, head, { targetVersion: v1, baseVersion: head.headVersionId });
    expect(r.branch).toBe('main');
    const versions = await b.projects.listVersions(ORG_A, p.project.id);
    expect(versions.length).toBe(3);
    expect(versions.find((v) => v.id === r.versionId)!.source).toBe('restore');
    const restored = (await b.projects.readFiles(ORG_A, p.project.id, r.versionId))!;
    expect([...restored.entries()].sort()).toEqual([...(await b.projects.readFiles(ORG_A, p.project.id, v1))!.entries()].sort());
    const repo = await b.changes.repoFor(ORG_A, proj);
    expect([...(await b.git.readTree(repo.storageRef, r.commit)).entries()].sort()).toEqual([...restored.entries()].sort());
    expect(b.sink.events.some((e) => e.action === 'builder.change.rolled_back' && e.outcome === 'success')).toBe(true);
    // a stale base is refused, history is untouched
    expect(await codeOf(tools.rollback(ORG_A, SEED_USER, head, { targetVersion: v1, baseVersion: head.headVersionId }))).toBe('base_mismatch');
  });
  it('another organization cannot read a project version through the tools', async () => {
    const p = await b.newProject(BASE);
    const proj = (await b.projects.get(ORG_A, p.project.id))!;
    expect(await codeOf(tools.diff(ORG_B, proj, p.versionId!, p.versionId!))).toBe('not_found');
    expect(await codeOf(tools.preview(ORG_B, proj, { patches: [{ op: 'add', path: 'x.ts', content: '1' }] }))).toBe('not_found');
    expect(await b.projects.get(ORG_B, p.project.id)).toBeNull();
  });
  it('a risky rollback needs a human confirmation and is applied only with it', async () => {
    const small = { ...BASE };
    const p = await b.newProject(small);
    const proj0 = (await b.projects.get(ORG_A, p.project.id))!;
    const many = Array.from({ length: 12 }, (_, i) => ({ op: 'add', path: `gen/f${i}.ts`, content: `export const f${i} = ${i};\n` }));
    await b.changes.apply(ORG_A, SEED_USER, proj0, { baseVersion: p.versionId, source: 'user', patches: many });
    const head = (await b.projects.get(ORG_A, p.project.id))!;
    expect(await codeOf(tools.rollback(ORG_A, SEED_USER, head, { targetVersion: p.versionId }))).toBe('change_rejected');
    expect((await b.projects.get(ORG_A, p.project.id))!.headVersionId).toBe(head.headVersionId);
    const r = await tools.rollback(ORG_A, SEED_USER, head, { targetVersion: p.versionId, confirmed: true });
    expect(r.risks.map((x) => x.code)).toContain('deletes_many_files');
    expect((await b.projects.readFiles(ORG_A, p.project.id, r.versionId))!.size).toBe(Object.keys(small).length);
  });
  it('reverts one change and keeps later work', async () => {
    const p = await b.newProject(BASE);
    let proj = (await b.projects.get(ORG_A, p.project.id))!;
    const c2 = await b.changes.apply(ORG_A, SEED_USER, proj, { baseVersion: p.versionId, source: 'user', patches: [{ op: 'add', path: 'src/feature.ts', content: 'export {};\n' }] });
    proj = (await b.projects.get(ORG_A, p.project.id))!;
    await b.changes.apply(ORG_A, SEED_USER, proj, { baseVersion: c2.versionId, source: 'user', patches: [{ op: 'modify', path: 'README.md', content: '# later\n' }] });
    proj = (await b.projects.get(ORG_A, p.project.id))!;
    const r = await tools.revert(ORG_A, SEED_USER, proj, { versionId: c2.versionId });
    const files = (await b.projects.readFiles(ORG_A, p.project.id, r.versionId))!;
    expect(files.has('src/feature.ts')).toBe(false);
    expect(files.get('README.md')).toBe('# later\n');
    expect(r.conflicts).toEqual([]);
  });
  it('stores project memory through the pipeline as the user (a version, a Git commit, a secret refused) and reads it back', async () => {
    const p = await b.newProject(BASE);
    const proj = (await b.projects.get(ORG_A, p.project.id))!;
    const a = await insight.addMemory(ORG_A, SEED_USER, proj, { kind: 'decision', text: 'Arabic first, English second', pinned: true });
    expect(a.change!.branch).toBe('main');
    const head = (await b.projects.get(ORG_A, p.project.id))!;
    expect((await insight.memory(ORG_A, head)).entries.map((e) => e.text)).toEqual(['Arabic first, English second']);
    expect(await codeOf(insight.addMemory(ORG_A, SEED_USER, head, { kind: 'fact', text: 'key AKIA' + 'ABCDEFGHIJKLMNOP' }))).toBe('validation_failed');
    const rev = await insight.review(ORG_A, head);
    expect(rev.summary.passed).toBe(true);
  });
  it('a simulated repair commits AI changes on the AI branch only and reports itself as simulated', async () => {
    const p = await b.newProject({ ...BASE, 'tsconfig.json': '{"compilerOptions":{},}\n' });
    const proj = (await b.projects.get(ORG_A, p.project.id))!;
    const build = new builderTools.ScriptedBuildPort();
    const r = await new ProjectRepairService(b.projects, b.changes, b.sink, build).run(ORG_A, SEED_USER, proj, { runId: 'run-int-1' });
    expect(r).toMatchObject({ status: 'passed', origin: 'MOCK', totalOps: 1 });
    const repo = await b.changes.repoFor(ORG_A, proj);
    expect((await b.git.log(repo.storageRef, 'work/ai'))[0]!.message).toBe('Repair 1');
    expect(await b.git.tipOf(repo.storageRef, 'refs/heads/main')).toBeFalsy(); // nothing landed on main
  });
});
