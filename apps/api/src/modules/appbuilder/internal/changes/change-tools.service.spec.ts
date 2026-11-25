import { describe, expect, it } from 'vitest';
import { AuditSink, type AuditEvent } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import { MemoryProjects } from '../ports/m09-mock';
import type { ProjectRecord } from '../ports/m09';
import { CanaryRegistry, MemorySecurityAlerts } from '../sandbox/canary';
import { ChangeToolsService } from './change-tools.service';
import type { ChangeResult } from './change.service';

class Sink extends AuditSink {
  events: AuditEvent[] = [];
  record(e: AuditEvent) {
    this.events.push(e);
  }
}
const ORG = '0198aaaa-0000-7000-8000-000000000001';
const USER = '0198aaaa-0000-7000-8000-0000000000aa';

async function setup() {
  const projects = new MemoryProjects();
  let p = await projects.create(ORG, {
    type: 'webapp',
    name: 'p',
    dataRegion: 'sa',
    createdBy: USER,
  });
  const v1 = await projects.commit(ORG, p.id, {
    baseVersionId: null,
    files: new Map([
      ['src/a.ts', 'a1\n'],
      ['src/b.ts', 'b1\n'],
      ['package.json', '{"name":"x"}\n'],
    ]),
    source: 'user',
    createdBy: USER,
  });
  const v2 = await projects.commit(ORG, p.id, {
    baseVersionId: v1.id,
    files: new Map([
      ['src/a.ts', 'a2\n'],
      ['src/c.ts', 'c2\n'],
      ['package.json', '{"name":"x"}\n'],
    ]),
    source: 'ai',
    createdBy: USER,
  });
  p = (await projects.get(ORG, p.id))!;
  const applied: { source: unknown; message: unknown; patches: unknown }[] = [];
  // a stand-in for ChangeService.apply: the real one is covered by its own integration tests; here it only commits what it is given
  const changes = {
    async apply(
      orgId: string,
      actor: string,
      pr: ProjectRecord,
      body: { baseVersion?: unknown; patches?: unknown; source?: unknown; message?: unknown },
    ) {
      applied.push({ source: body.source, message: body.message, patches: body.patches });
      const cur = new Map((await projects.readFiles(orgId, pr.id, pr.headVersionId!))!);
      for (const o of body.patches as { op: string; path: string; content?: string }[]) {
        if (o.op === 'delete') cur.delete(o.path);
        else cur.set(o.path, o.content!);
      }
      const v = await projects.commit(orgId, pr.id, {
        baseVersionId: pr.headVersionId,
        files: cur,
        source: 'restore',
        createdBy: actor,
      });
      return {
        versionId: v.id,
        commit: 'c'.repeat(40),
        branch: 'main',
        diff: { added: [], modified: [], deleted: [], renamed: [] },
        risks: [],
      } as ChangeResult;
    },
  };
  const audit = new Sink();
  const canaries = new CanaryRegistry(new MemorySecurityAlerts());
  const svc = new ChangeToolsService(projects, changes, canaries, audit);
  return { projects, p, v1, v2, svc, applied, audit, canaries };
}
const code = async (f: Promise<unknown>) => {
  try {
    await f;
    return 'no error';
  } catch (e) {
    return e instanceof ProblemException ? e.code : String(e);
  }
};

describe('ChangeToolsService', () => {
  it('previews patches and diffs without storing anything', async () => {
    const { svc, p, projects, applied } = await setup();
    const r = await svc.preview(ORG, p, {
      patches: [{ op: 'modify', path: 'src/a.ts', content: 'a3\n' }],
    });
    expect(r.ok).toBe(true);
    expect(r.totals).toEqual({ files: 1, added: 1, removed: 1 });
    const viaDiff = await svc.preview(ORG, p, {
      diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a2\n+a9\n',
    });
    expect(viaDiff.ops[0]).toMatchObject({ op: 'modify', path: 'src/a.ts', content: 'a9\n' });
    expect(applied).toEqual([]);
    expect((await projects.listVersions(ORG, p.id)).length).toBe(2);
  });
  it('rejects both-or-neither input, an outdated base, a website project and a bad diff', async () => {
    const { svc, p, projects } = await setup();
    expect(await code(svc.preview(ORG, p, {}))).toBe('validation_failed');
    expect(await code(svc.preview(ORG, p, { patches: [], diff: 'x' }))).toBe('validation_failed');
    expect(
      await code(
        svc.preview(ORG, p, { baseVersion: '0198aaaa-0000-7000-8000-0000000000bb', patches: [] }),
      ),
    ).toBe('base_mismatch');
    expect(
      await code(
        svc.preview(ORG, p, { diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-zzz\n+q\n' }),
      ),
    ).toBe('change_rejected');
    const site = await projects.create(ORG, {
      type: 'website',
      name: 's',
      dataRegion: 'sa',
      createdBy: USER,
    });
    expect(await code(svc.preview(ORG, site, { patches: [] }))).toBe('unsupported_capability');
  });
  it('flags a platform canary found by the registry', async () => {
    const { svc, p, canaries } = await setup();
    const c = canaries.plant('runner_host_env', 'env:X');
    const r = await svc.preview(ORG, p, {
      patches: [{ op: 'add', path: 'src/n.ts', content: `x = "${c.value}"\n` }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('canary_detected');
  });
  it('diffs two versions', async () => {
    const { svc, p, v1, v2 } = await setup();
    const d = await svc.diff(ORG, p, v1.id, v2.id);
    expect(d.files.map((f) => `${f.op}:${f.path}`)).toEqual([
      'modify:src/a.ts',
      'delete:src/b.ts',
      'add:src/c.ts',
    ]);
    expect((await svc.diff(ORG, p, v1.id, v1.id)).files).toEqual([]);
  });
  it('rolls back to an older version as a NEW restore version and audits it', async () => {
    const { svc, p, v1, projects, applied, audit } = await setup();
    const r = await svc.rollback(ORG, USER, p, {
      targetVersion: v1.id,
      baseVersion: p.headVersionId,
    });
    expect(r.restoredFrom).toBe(v1.id);
    expect(applied[0]).toMatchObject({
      source: 'restore',
      message: `Rollback to ${v1.id.slice(0, 8)}`,
    });
    const head = (await projects.get(ORG, p.id))!.headVersionId!;
    expect(head).toBe(r.versionId);
    const files = (await projects.readFiles(ORG, p.id, head))!;
    expect([...files.entries()].sort()).toEqual(
      [...(await projects.readFiles(ORG, p.id, v1.id))!.entries()].sort(),
    );
    expect((await projects.listVersions(ORG, p.id)).length).toBe(3); // history grew, nothing rewritten
    expect(audit.events.at(-1)).toMatchObject({
      action: 'builder.change.rolled_back',
      outcome: 'success',
    });
  });
  it('refuses a rollback to the head, with a stale base, and a bad id', async () => {
    const { svc, p, v2 } = await setup();
    expect(await code(svc.rollback(ORG, USER, p, { targetVersion: v2.id }))).toBe('conflict');
    expect(await code(svc.rollback(ORG, USER, p, { targetVersion: 'nope' }))).toBe(
      'validation_failed',
    );
    expect(
      await code(
        svc.rollback(ORG, USER, p, {
          targetVersion: v2.id,
          baseVersion: '0198aaaa-0000-7000-8000-0000000000bb',
        }),
      ),
    ).toBe('base_mismatch');
  });
  it('needs a human confirmation for a risky rollback (many deletions)', async () => {
    const projects = new MemoryProjects();
    let p = await projects.create(ORG, {
      type: 'webapp',
      name: 'p',
      dataRegion: 'sa',
      createdBy: USER,
    });
    const small = new Map([['a.ts', '1\n']]);
    const big = new Map(small);
    for (let i = 0; i < 12; i++) big.set(`gen/f${i}.ts`, `${i}\n`);
    const v1 = await projects.commit(ORG, p.id, {
      baseVersionId: null,
      files: small,
      source: 'user',
      createdBy: USER,
    });
    await projects.commit(ORG, p.id, {
      baseVersionId: v1.id,
      files: big,
      source: 'user',
      createdBy: USER,
    });
    p = (await projects.get(ORG, p.id))!;
    const applied: unknown[] = [];
    const svc = new ChangeToolsService(
      projects,
      {
        apply: async (...a) => (
          applied.push(a),
          {
            versionId: 'v',
            commit: 'c',
            branch: 'main',
            diff: { added: [], modified: [], deleted: [], renamed: [] },
            risks: [],
          }
        ),
      },
      new CanaryRegistry(new MemorySecurityAlerts()),
      new Sink(),
    );
    expect(await code(svc.rollback(ORG, USER, p, { targetVersion: v1.id }))).toBe(
      'change_rejected',
    );
    expect(applied).toEqual([]);
    expect(await code(svc.rollback(ORG, USER, p, { targetVersion: v1.id, confirmed: true }))).toBe(
      'no error',
    );
    expect(applied.length).toBe(1);
  });
  it('reverts one change and reports files edited since as conflicts', async () => {
    const { svc, p, v1, v2, projects } = await setup();
    // v3 edits a.ts after v2
    const v3 = await projects.commit(ORG, p.id, {
      baseVersionId: v2.id,
      files: new Map([
        ['src/a.ts', 'a-later\n'],
        ['src/c.ts', 'c2\n'],
        ['package.json', '{"name":"x"}\n'],
      ]),
      source: 'user',
      createdBy: USER,
    });
    const head = (await projects.get(ORG, p.id))!;
    expect(head.headVersionId).toBe(v3.id);
    const r = await svc.revert(ORG, USER, head, { versionId: v2.id });
    expect(r.conflicts).toEqual(['src/a.ts']);
    const files = (await projects.readFiles(ORG, p.id, r.versionId))!;
    expect(files.get('src/a.ts')).toBe('a-later\n'); // later work kept
    expect(files.has('src/c.ts')).toBe(false); // the change's addition undone
    expect(files.get('src/b.ts')).toBe('b1\n'); // the change's deletion undone
    expect(v1.id).toBeTruthy();
  });
});
