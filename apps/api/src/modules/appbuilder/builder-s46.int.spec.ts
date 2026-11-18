import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from './internal/core';
import { ORG_A, ORG_B, SEED_USER, setupBuildEnv, type BuildEnv } from './internal/testing/build-harness';

let b: BuildEnv;
beforeAll(async () => {
  b = await setupBuildEnv();
}, 120_000);
afterAll(() => b.close());

const BASE = {
  'README.md': '# app\n',
  'src/answer.ts': 'export const answer = 1;\n',
  'db/migrations/0001_init.sql': 'CREATE TABLE t (id int);\n',
  'tests/answer.test.ts': 'test\n',
  'package.json': JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { pg: '^8.0.0' } }),
  'nuzm.app.json': JSON.stringify({ commands: { unit: ['node', '--test'], typecheck: ['npx', 'tsc', '--noEmit'], build: ['npx', 'tsc', '-p', 'tsconfig.build.json'] } }),
};
const apply = async (p: Awaited<ReturnType<BuildEnv['newProject']>>, body: Record<string, unknown>, org = ORG_A) => b.changes.apply(org, SEED_USER, (await b.projects.get(org, p.project.id))!, { baseVersion: p.versionId, ...body });

describe('changes (safe diff apply)', () => {
  it('applies add/modify/delete/rename atomically: a new project version, one commit on the right branch, the diff and the risks', async () => {
    const p = await b.newProject(BASE);
    const r = await apply(p, {
      source: 'ai',
      message: 'ai tweak',
      patches: [
        { op: 'modify', path: 'src/answer.ts', content: 'export const answer = 2;\n', expectedHash: sha256(BASE['src/answer.ts']) },
        { op: 'add', path: 'src/new.ts', content: 'export {};\n' },
        { op: 'rename', from: 'README.md', path: 'docs/README.md' },
        { op: 'delete', path: 'tests/answer.test.ts' },
      ],
    });
    expect(r.diff).toEqual({ added: ['src/new.ts'], modified: ['src/answer.ts'], deleted: ['tests/answer.test.ts'], renamed: [{ from: 'README.md', to: 'docs/README.md' }] });
    expect(r.branch).toBe('work/ai');
    expect(r.risks.map((x) => x.code)).toEqual(['removes_tests']);
    const files = (await b.projects.readFiles(ORG_A, p.project.id, r.versionId))!;
    expect([...files.keys()].sort()).toEqual(['db/migrations/0001_init.sql', 'docs/README.md', 'nuzm.app.json', 'package.json', 'src/answer.ts', 'src/new.ts']);
    expect(files.get('src/answer.ts')).toBe('export const answer = 2;\n');
    // the commit holds exactly the same files
    const repo = await b.changes.repoFor(ORG_A, p.project);
    expect([...(await b.git.readTree(repo.storageRef, r.commit)).entries()].sort()).toEqual([...files.entries()].sort());
    expect((await b.git.log(repo.storageRef, 'work/ai'))[0]!.message).toBe('ai tweak');
    expect((await b.env.sql(`SELECT last_commit FROM builder.git_repos WHERE project_id = $1`, [p.project.id]))[0]!.last_commit).toBe(r.commit);
    expect(b.sink.events.some((e) => e.action === 'builder.change.applied')).toBe(true);
    // a user change goes to main
    const u = await b.changes.apply(ORG_A, SEED_USER, (await b.projects.get(ORG_A, p.project.id))!, { baseVersion: r.versionId, patches: [{ op: 'add', path: 'src/user.ts', content: 'x' }] });
    expect(u.branch).toBe('main');
  });
  it('editing an applied migration and changing dependencies are flagged as risks', async () => {
    const p = await b.newProject(BASE);
    const r = await apply(p, { patches: [{ op: 'modify', path: 'db/migrations/0001_init.sql', content: 'CREATE TABLE t (id bigint);\n' }, { op: 'modify', path: 'package.json', content: JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { pg: '^8.0.0', ws: '^8.0.0' } }) }] });
    expect(r.risks.map((x) => x.code).sort()).toEqual(['changes_dependencies', 'edits_applied_migration']);
  });
  it('409 base_mismatch for an outdated baseVersion and for a file whose hash changed; nothing is written', async () => {
    const p = await b.newProject(BASE);
    await apply(p, { patches: [{ op: 'add', path: 'a.txt', content: '1' }] });
    await expect(apply(p, { patches: [{ op: 'add', path: 'b.txt', content: '2' }] })).rejects.toMatchObject({ code: 'base_mismatch' });
    const head = (await b.projects.get(ORG_A, p.project.id))!;
    await expect(b.changes.apply(ORG_A, SEED_USER, head, { baseVersion: head.headVersionId, patches: [{ op: 'modify', path: 'src/answer.ts', content: 'x', expectedHash: sha256('something else') }] })).rejects.toMatchObject({ code: 'base_mismatch' });
    expect((await b.projects.get(ORG_A, p.project.id))!.headVersionId).toBe(head.headVersionId);
  });
  it('atomic: when one patch of a set is refused, no version and no commit exist', async () => {
    const p = await b.newProject(BASE);
    const before = (await b.projects.listVersions(ORG_A, p.project.id)).length;
    await expect(apply(p, { patches: [{ op: 'add', path: 'ok.txt', content: 'fine' }, { op: 'modify', path: 'nope.ts', content: 'x' }] })).rejects.toMatchObject({ code: 'change_rejected' });
    expect((await b.projects.listVersions(ORG_A, p.project.id)).length).toBe(before);
    expect((await b.env.sql(`SELECT count(*)::int n FROM builder.git_repos WHERE project_id = $1`, [p.project.id]))[0]!.n).toBe(0);
  });
  it('refuses traversal, secrets (never echoing them), canaries, duplicate paths and oversize with field-level reasons', async () => {
    const p = await b.newProject(BASE);
    const canary = b.canaries.plantStandardSet()[0]!.value;
    for (const patch of [
      { op: 'add', path: '../../etc/passwd', content: 'x' }, { op: 'add', path: '/abs', content: 'x' }, { op: 'add', path: '.git/hooks/pre-commit', content: 'x' }, { op: 'add', path: 'a\\b', content: 'x' },
      { op: 'add', path: 'src/k.ts', content: 'const k = "AKIAABCDEFGHIJKLMNOP";' }, { op: 'add', path: 'src/c.ts', content: `x ${canary}` }, { op: 'add', path: 'big.txt', content: 'x'.repeat(1_000_001) }, { op: 'explode', path: 'x' }, { op: 'add', path: 'n.txt' },
    ]) {
      const e = await apply(p, { patches: [patch] }).catch((x) => x);
      expect(e.code, JSON.stringify(patch).slice(0, 60)).toBe('change_rejected');
      expect(JSON.stringify(e.errors ?? [])).not.toContain('AKIAABCDEFGHIJKLMNOP');
      expect(JSON.stringify(e.errors ?? [])).not.toContain(canary);
    }
    await expect(apply(p, { patches: [{ op: 'add', path: 'd.txt', content: '1' }, { op: 'modify', path: 'd.txt', content: '2' }] })).rejects.toMatchObject({ code: 'change_rejected' });
    await expect(apply(p, { patches: [] })).rejects.toMatchObject({ code: 'change_rejected' });
    await expect(apply(p, { patches: Array.from({ length: 201 }, (_, i) => ({ op: 'add', path: `f${i}.txt`, content: 'x' })) })).rejects.toMatchObject({ code: 'change_rejected' });
  });
  it('a typosquatted dependency in package.json is blocked (dependency_blocked)', async () => {
    const p = await b.newProject(BASE);
    await expect(apply(p, { patches: [{ op: 'modify', path: 'package.json', content: JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { lodahs: '^4.0.0' } }) }] })).rejects.toMatchObject({ code: 'dependency_blocked' });
  });
  it('website projects are not handled here; checkpoints are tags on the latest commit and cannot be reused', async () => {
    const w = await b.projects.create(ORG_A, { type: 'website', name: 'w', dataRegion: 'sa-central', createdBy: null });
    await expect(b.changes.apply(ORG_A, SEED_USER, w, { baseVersion: null, patches: [{ op: 'add', path: 'a', content: 'x' }] })).rejects.toMatchObject({ code: 'unsupported_capability' });
    const p = await b.newProject(BASE);
    const r = await apply(p, { patches: [{ op: 'add', path: 'a.txt', content: 'x' }] });
    const cp = await b.changes.checkpoint(ORG_A, (await b.projects.get(ORG_A, p.project.id))!, 'cp-before-deploy');
    expect(cp.sha).toBe(r.commit);
    await expect(b.changes.checkpoint(ORG_A, p.project, 'cp-before-deploy')).rejects.toMatchObject({ code: 'conflict' });
    await expect(b.changes.checkpoint(ORG_A, p.project, 'Bad Name')).rejects.toMatchObject({ code: 'validation_failed' });
  });
  it('cross-tenant: org B cannot see org A repository rows', async () => {
    const p = await b.newProject(BASE);
    await apply(p, { patches: [{ op: 'add', path: 'a.txt', content: 'x' }] });
    const seen = await b.env.app.withOrg(ORG_B, async (c) => (await c.query(`SELECT count(*)::int n FROM builder.git_repos WHERE project_id = $1`, [p.project.id])).rows[0]!.n as number);
    expect(seen).toBe(0);
  });
});

const junit = (cases: { name: string; fail?: string }[]) => `<testsuites><testsuite name="s">${cases.map((c) => `<testcase name="${c.name}" classname="tests/x.test.ts" time="0.01">${c.fail ? `<failure message="${c.fail}"/>` : ''}</testcase>`).join('')}</testsuite></testsuites>`;
/** A mock `node --test`: passes when src/answer.ts says FIXED. */
const registerNode = () =>
  b.mock.register('node', ({ files }) => {
    const ok = (files.get('src/answer.ts') ?? '').includes('FIXED');
    return { stdout: junit([{ name: 'src/answer.ts check', ...(ok ? {} : { fail: 'expected FIXED' }) }, { name: 'other ok' }]), exitCode: ok ? 0 : 1, cpuSeconds: 2 };
  });
const registerNpx = () => b.mock.register('npx', () => ({ stdout: '', exitCode: 0 }));

describe('test runner (S46.3)', () => {
  it('runs the unit suite in a sandbox, returns structured results, redacts the log, meters build minutes, ends the sandbox, records the runtime', async () => {
    registerNode();
    b.mock.register('node', ({ files }) => ({ stdout: junit([{ name: 'src/answer.ts check', fail: 'expected FIXED' }, { name: 'other ok' }]) + '\nleak AKIAABCDEFGHIJKLMNOP ' + (files.size ? '' : ''), exitCode: 1, cpuSeconds: 3 }));
    const p = await b.newProject(BASE);
    const run = await b.tests.create(ORG_A, SEED_USER, p.project, { suite: 'unit' });
    expect(run.status).toBe('queued');
    const done = await b.tests.execute(ORG_A, SEED_USER, p.project, run.id);
    expect(done).toMatchObject({ status: 'failed', runtime: { kind: 'mock' } });
    expect(done.summary).toMatchObject({ totals: { suites: 1, tests: 2, failures: 1 } });
    const failing = (done.summary.suites as { cases: { status: string; failure?: string }[] }[])[0]!.cases.find((c) => c.status === 'failed')!;
    expect(failing.failure).toBe('expected FIXED');
    const log = JSON.stringify(await b.artifacts.get(ORG_A, done.logsRef!));
    expect(log).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(log).toContain('redacted');
    const ev = await b.env.sql(`SELECT payload FROM platform.outbox WHERE topic = 'usage.recorded' AND payload->>'meterId' = 'builder.build_minutes' AND payload->>'resourceId' = $1`, [run.id]);
    expect(ev).toHaveLength(1);
    expect((await b.env.sql(`SELECT state FROM builder.sandboxes WHERE id = (SELECT sandbox_id FROM builder.test_runs WHERE id = $1)`, [run.id]))[0]!.state).toBe('terminated');
    expect(await b.tests.execute(ORG_A, SEED_USER, p.project, run.id)).toMatchObject({ status: 'failed' }); // not re-run
  });
  it('an unavailable suite is 422; typecheck without a lockfile is errored with a clear note; with a lockfile that violates the policy the install is blocked', async () => {
    const p = await b.newProject({ ...BASE, 'nuzm.app.json': JSON.stringify({ commands: { unit: ['node', '--test'] } }) });
    await expect(b.tests.create(ORG_A, SEED_USER, p.project, { suite: 'e2e' })).rejects.toMatchObject({ code: 'test_suite_unavailable' });
    await expect(b.tests.create(ORG_A, SEED_USER, p.project, { suite: 'nope' })).rejects.toMatchObject({ code: 'validation_failed' });
    const q = await b.newProject(BASE);
    registerNpx();
    const r = await b.tests.execute(ORG_A, SEED_USER, q.project, (await b.tests.create(ORG_A, SEED_USER, q.project, { suite: 'typecheck' })).id);
    expect(r.status).toBe('errored');
    expect(JSON.stringify(r.summary)).toContain('no lockfile');
    const lock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/lodahs': { version: '1.0.0', resolved: 'https://npm-mirror.nuzm.internal/x.tgz', integrity: 'sha512-AAAA', license: 'MIT' } } };
    const s = await b.newProject({ ...BASE, 'package-lock.json': JSON.stringify(lock) });
    const r2 = await b.tests.execute(ORG_A, SEED_USER, s.project, (await b.tests.create(ORG_A, SEED_USER, s.project, { suite: 'build' })).id);
    expect(r2.status).toBe('errored');
    expect(JSON.stringify(r2.summary)).toContain('dependency policy blocked');
  });
  it('cross-tenant: a test run of org A is 404 for org B', async () => {
    const p = await b.newProject(BASE);
    const run = await b.tests.create(ORG_A, SEED_USER, p.project, { suite: 'unit' });
    await expect(b.tests.get(ORG_B, p.project.id, run.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await b.tests.list(ORG_B, p.project.id)).toEqual([]);
  });
});

const FIXBASE = { ...BASE, 'nuzm.app.json': JSON.stringify({ commands: { unit: ['node', '--test'] } }) };

describe('test-fix run: bounded debugging loop (AC-M10-04)', () => {
  const newFixRun = async (p: Awaited<ReturnType<BuildEnv['newProject']>>, budget = { maxTokens: 900_000, maxCostMinor: 1_000_000, maxMinutes: 30 }) =>
    (await b.runs.create(ORG_A, { kind: 'test-fix', projectId: p.project.id, budget, dataRegion: 'sa-central', createdBy: SEED_USER })).id;
  const fixture = (content: (n: number) => string) => {
    let n = 0;
    b.model.register('test_fix', () => ({ explanation: 'patch', patches: [{ op: 'modify', path: 'src/answer.ts', content: content(++n) }] }));
  };

  it('fixes a failing test in one iteration through the checked changes pipeline (an ai commit on the work branch) and ends the run succeeded', async () => {
    registerNode();
    fixture(() => 'export const answer = "FIXED";\n');
    const p = await b.newProject(FIXBASE);
    const runId = await newFixRun(p);
    const out = await b.testFix.run(ORG_A, SEED_USER, p.project.id, runId);
    expect(out).toEqual({ status: 'fixed', iterations: 1 });
    expect((await b.runs.get(ORG_A, runId))!.state).toBe('succeeded');
    const repo = await b.changes.repoFor(ORG_A, p.project);
    expect((await b.git.log(repo.storageRef, 'work/ai'))[0]!.message).toBe('test-fix: src/answer.ts');
  });
  it('stops after 3 identical failure signatures and escalates to a human', async () => {
    registerNode();
    fixture(() => 'export const answer = "still broken";\n');
    const p = await b.newProject(FIXBASE);
    const runId = await newFixRun(p);
    const out = await b.testFix.run(ORG_A, SEED_USER, p.project.id, runId);
    expect(out).toMatchObject({ status: 'escalated', reason: 'repeated_failure', group: 'src/answer.ts', iterations: 2 });
    expect(await b.runs.get(ORG_A, runId)).toMatchObject({ state: 'failed', reason: 'escalated_to_human' });
  });
  it('stops at 5 consecutive attempts for one group when each attempt fails differently', async () => {
    let n = 0;
    b.mock.register('node', () => ({ stdout: junit([{ name: 'src/answer.ts check', fail: `different failure ${'x'.repeat(++n)}` }]), exitCode: 1 }));
    fixture((i) => `export const answer = ${i};\n`);
    const p = await b.newProject(FIXBASE);
    const out = await b.testFix.run(ORG_A, SEED_USER, p.project.id, await newFixRun(p));
    expect(out).toMatchObject({ status: 'escalated', reason: 'group_limit', iterations: 5 });
  });
  it('stops at 15 attempts per run across failing groups', async () => {
    let n = 0;
    b.mock.register('node', () => ({ stdout: junit(Array.from({ length: 6 }, (_, g) => ({ name: `src/g${g}.ts check`, fail: `fail ${g} round ${Math.floor(n / 1)} ${'y'.repeat(++n)}` }))), exitCode: 1 }));
    b.model.register('test_fix', () => ({ patches: [{ op: 'add', path: `src/fix-${Math.random().toString(36).slice(2)}.ts`, content: 'x' }] }));
    const p = await b.newProject(FIXBASE);
    const out = await b.testFix.run(ORG_A, SEED_USER, p.project.id, await newFixRun(p));
    expect(out).toMatchObject({ status: 'escalated', reason: 'run_limit', iterations: 15 });
  });
  it('the run budget stops the loop before the call that does not fit (budget_exceeded), not an endless loop', async () => {
    registerNode();
    fixture((n) => `export const answer = ${n};\n`);
    const p = await b.newProject(FIXBASE);
    const runId = await newFixRun(p, { maxTokens: 12_100, maxCostMinor: 1_000_000, maxMinutes: 30 });
    const out = await b.testFix.run(ORG_A, SEED_USER, p.project.id, runId);
    expect(out).toMatchObject({ status: 'budget_exceeded', dimension: 'tokens' });
    expect((await b.runs.get(ORG_A, runId))!.state).toBe('budget_exceeded');
  });
  it('a patch the safety checks refuse counts as a failed attempt (the loop does not apply it and stops by the limits)', async () => {
    registerNode();
    b.model.register('test_fix', () => ({ patches: [{ op: 'modify', path: 'src/answer.ts', content: 'const k = "AKIAABCDEFGHIJKLMNOP"; FIXED' }] }));
    const p = await b.newProject(FIXBASE);
    const out = await b.testFix.run(ORG_A, SEED_USER, p.project.id, await newFixRun(p));
    expect(out).toMatchObject({ status: 'escalated', reason: 'repeated_failure' });
    expect((await b.projects.readFiles(ORG_A, p.project.id, (await b.projects.get(ORG_A, p.project.id))!.headVersionId!))!.get('src/answer.ts')).toBe(BASE['src/answer.ts']);
  });
});
