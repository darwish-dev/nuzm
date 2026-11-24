import { builderTools } from '@nuzm/domain';
import { describe, expect, it } from 'vitest';
import { AuditSink, type AuditEvent } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import { MemoryProjects } from '../ports/m09-mock';
import type { ProjectRecord } from '../ports/m09';
import type { ChangeResult } from './change.service';
import { ProjectRepairService } from './repair.service';

class Sink extends AuditSink {
  events: AuditEvent[] = [];
  record(e: AuditEvent) {
    this.events.push(e);
  }
}
const ORG = '0198aaaa-0000-7000-8000-000000000001';
const USER = '0198aaaa-0000-7000-8000-0000000000aa';

async function setup(files: Record<string, string>) {
  const projects = new MemoryProjects();
  let p = await projects.create(ORG, { type: 'webapp', name: 'p', dataRegion: 'sa', createdBy: USER });
  await projects.commit(ORG, p.id, { baseVersionId: null, files: new Map(Object.entries(files)), source: 'user', createdBy: USER });
  p = (await projects.get(ORG, p.id))!;
  const applied: { source: unknown; baseVersion: unknown; message: unknown }[] = [];
  const changes = {
    async apply(orgId: string, actor: string, pr: ProjectRecord, body: { baseVersion?: unknown; patches?: unknown; source?: unknown; message?: unknown }) {
      applied.push({ source: body.source, baseVersion: body.baseVersion, message: body.message });
      const cur = new Map((await projects.readFiles(orgId, pr.id, pr.headVersionId!))!);
      for (const o of body.patches as { op: string; path: string; content?: string }[]) {
        if (o.op === 'delete') cur.delete(o.path);
        else cur.set(o.path, o.content!);
      }
      const v = await projects.commit(orgId, pr.id, { baseVersionId: pr.headVersionId, files: cur, source: 'ai', createdBy: actor });
      return { versionId: v.id, commit: 'c'.repeat(40), branch: 'work/ai', diff: { added: [], modified: [], deleted: [], renamed: [] }, risks: [] } as ChangeResult;
    },
  };
  return { projects, p, applied, changes, audit: new Sink() };
}

describe('ProjectRepairService', () => {
  it('refuses to run without a build service (execution stays blocked)', async () => {
    const { changes, p, audit, projects } = await setup({ 'a.ts': 'export {};\n' });
    const svc = new ProjectRepairService(projects, changes, audit, null);
    await expect(svc.run(ORG, USER, p, { runId: 'r1' })).rejects.toMatchObject({ code: 'unsupported_capability' });
  });
  it('repairs a static problem as AI changes chained on each new version, builds the repaired version and reports it as simulated', async () => {
    const { changes, p, audit, projects, applied } = await setup({ 'tsconfig.json': '{"a":1,}\n', 'src/a.ts': 'export {};\n' });
    const build = new builderTools.ScriptedBuildPort();
    const svc = new ProjectRepairService(projects, changes, audit, build);
    const r = await svc.run(ORG, USER, p, { runId: 'run-1' });
    expect(r).toMatchObject({ status: 'passed', origin: 'MOCK', totalOps: 1, pendingApproval: 0 });
    expect(r.note).toMatch(/simulated/);
    expect(applied).toEqual([{ source: 'ai', baseVersion: p.headVersionId, message: 'Repair 1' }]);
    expect(build.calls[0]).toMatchObject({ orgId: ORG, runId: 'run-1', projectId: p.id, versionId: r.versionId });
    expect(audit.events.at(-1)).toMatchObject({ action: 'builder.repair.completed', outcome: 'success', after: { origin: 'MOCK', runId: 'run-1' } });
  });
  it('records a failure outcome and applies nothing when the build keeps failing and no rule can help', async () => {
    const { changes, p, audit, projects, applied } = await setup({ 'a.ts': 'export {};\n' });
    const build = new builderTools.ScriptedBuildPort().script('typecheck', { status: 'failed', logs: 'a.ts(1,1): error TS1: x' });
    const r = await new ProjectRepairService(projects, changes, audit, build).run(ORG, USER, p, { runId: 'r2' });
    expect(r).toMatchObject({ status: 'failed', reason: 'strategy_gave_up', totalOps: 0 });
    expect(applied).toEqual([]);
    expect(audit.events.at(-1)).toMatchObject({ outcome: 'failure' });
  });
  it('rejects website projects and projects without a version', async () => {
    const { changes, audit, projects } = await setup({ 'a.ts': 'x' });
    const site = await projects.create(ORG, { type: 'website', name: 's', dataRegion: 'sa', createdBy: USER });
    const svc = new ProjectRepairService(projects, changes, audit, new builderTools.ScriptedBuildPort());
    await expect(svc.run(ORG, USER, site, { runId: 'r' })).rejects.toBeInstanceOf(ProblemException);
    const empty = await projects.create(ORG, { type: 'webapp', name: 'e', dataRegion: 'sa', createdBy: USER });
    await expect(svc.run(ORG, USER, empty, { runId: 'r' })).rejects.toMatchObject({ code: 'conflict' });
  });
});
