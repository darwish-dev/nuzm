import { describe, expect, it } from 'vitest';
import { AuditSink, type AuditEvent } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import { MemoryProjects } from '../ports/m09-mock';
import type { ProjectRecord } from '../ports/m09';
import { BuilderInsightService } from './builder-insight.service';
import type { ChangeResult } from './change.service';

class Sink extends AuditSink {
  events: AuditEvent[] = [];
  record(e: AuditEvent) {
    this.events.push(e);
  }
}
const ORG = '0198aaaa-0000-7000-8000-000000000001';
const USER = '0198aaaa-0000-7000-8000-0000000000aa';
const code = async (f: Promise<unknown>) => {
  try {
    await f;
    return 'no error';
  } catch (e) {
    return e instanceof ProblemException ? e.code : String(e);
  }
};

async function setup(files: Record<string, string> = { 'src/a.ts': "import { b } from './b';\nexport function A() {}\n", 'package.json': '{"name":"x"}' }) {
  const projects = new MemoryProjects();
  let p = await projects.create(ORG, { type: 'webapp', name: 'p', dataRegion: 'sa', createdBy: USER });
  await projects.commit(ORG, p.id, { baseVersionId: null, files: new Map(Object.entries(files)), source: 'user', createdBy: USER });
  p = (await projects.get(ORG, p.id))!;
  const applied: unknown[] = [];
  const changes = {
    async apply(orgId: string, actor: string, pr: ProjectRecord, body: { patches?: unknown; source?: unknown }) {
      applied.push(body);
      const cur = new Map((await projects.readFiles(orgId, pr.id, pr.headVersionId!))!);
      for (const o of body.patches as { op: string; path: string; content?: string }[]) cur.set(o.path, o.content!);
      const v = await projects.commit(orgId, pr.id, { baseVersionId: pr.headVersionId, files: cur, source: 'user', createdBy: actor });
      return { versionId: v.id, commit: 'c'.repeat(40), branch: 'main', diff: { added: [], modified: [], deleted: [], renamed: [] }, risks: [] } as ChangeResult;
    },
  };
  const audit = new Sink();
  const svc = new BuilderInsightService(projects, changes, { rateMinorPer1kTokens: async () => 2 }, audit, () => new Date('2026-11-24T00:00:00Z'));
  return { svc, p, projects, applied, audit };
}

describe('BuilderInsightService', () => {
  it('plans from text without a project: validated plan, integer estimate, no side effects', async () => {
    const { svc } = await setup();
    const r = await svc.plan(ORG, { text: 'An online store with cart and payments', hint: 'ecommerce' });
    expect(r.plan.productType).toBe('ecommerce');
    expect(Number.isInteger(r.estimate.costMinor)).toBe(true);
    expect(r.estimateNote).toMatch(/not a quote/);
    expect(await code(svc.plan(ORG, { text: '' }))).toBe('validation_failed');
    expect(await code(svc.plan(ORG, { text: 'x'.repeat(20_001) }))).toBe('validation_failed');
    expect(await code(svc.plan(ORG, { text: 'a store', hint: 'spaceship' }))).toBe('validation_failed');
    expect(await code(svc.plan(ORG, { text: 'a store', repairRounds: 9 }))).toBe('validation_failed');
  });
  it('reviews the head, finds symbols, imports and components', async () => {
    const { svc, p } = await setup();
    const rev = await svc.review(ORG, p);
    expect(rev.summary.passed).toBe(false);
    expect(rev.findings.map((f) => f.code)).toContain('unresolved_import');
    expect((await svc.symbols(ORG, p, 'a')).symbols[0]!.name).toBe('A');
    expect(await code(svc.symbols(ORG, p, ''))).toBe('validation_failed');
    expect(await code(svc.symbols(ORG, p, 'a', 'bogus'))).toBe('validation_failed');
    expect((await svc.imports(ORG, p)).unresolved[0]).toMatchObject({ spec: './b' });
    expect((await svc.components(ORG, p)).components).toEqual([]);
  });
  it('refuses website projects', async () => {
    const { svc, projects } = await setup();
    const site = await projects.create(ORG, { type: 'website', name: 's', dataRegion: 'sa', createdBy: USER });
    expect(await code(svc.review(ORG, site))).toBe('unsupported_capability');
  });
  it('stores memory notes as a user change to .nuzm/memory.json, dedupes, and removes them', async () => {
    const { svc, p, projects, applied, audit } = await setup();
    expect((await svc.memory(ORG, p)).entries).toEqual([]);
    const a = await svc.addMemory(ORG, USER, p, { kind: 'decision', text: 'Arabic is the default language', pinned: true });
    expect(a.change).not.toBeNull();
    expect(applied[0]).toMatchObject({ source: 'user', patches: [{ op: 'add', path: '.nuzm/memory.json' }] });
    const p2 = (await projects.get(ORG, p.id))!;
    const m = await svc.memory(ORG, p2);
    expect(m.entries.map((e) => e.text)).toEqual(['Arabic is the default language']);
    expect(m.entries[0]).toMatchObject({ source: 'user', pinned: true, at: '2026-11-24T00:00:00.000Z' });
    const dup = await svc.addMemory(ORG, USER, p2, { kind: 'decision', text: ' arabic is the DEFAULT language ' });
    expect(dup.change).toBeNull(); // nothing written
    expect(await code(svc.addMemory(ORG, USER, p2, { kind: 'decision', text: 'key AKIA' + 'ABCDEFGHIJKLMNOP' }))).toBe('validation_failed');
    expect(await code(svc.addMemory(ORG, USER, p2, { kind: 'wish', text: 'x' }))).toBe('validation_failed');
    expect(await code(svc.addMemory(ORG, USER, p2, { kind: 'fact', text: 'x', baseVersion: '0198aaaa-0000-7000-8000-0000000000bb' }))).toBe('base_mismatch');
    const f = await svc.forgetMemory(ORG, USER, p2, a.entry.id);
    expect(f.change.versionId).toBeTruthy();
    expect(audit.events.map((e) => e.action)).toEqual(['builder.memory.changed', 'builder.memory.changed']);
    expect(await code(svc.forgetMemory(ORG, USER, (await projects.get(ORG, p.id))!, 'nope'))).toBe('not_found');
  });
  it('reports a damaged memory file instead of overwriting it', async () => {
    const { svc, p } = await setup({ 'src/a.ts': 'export {};\n', '.nuzm/memory.json': '{broken' });
    expect(await code(svc.memory(ORG, p))).toBe('conflict');
    expect(await code(svc.addMemory(ORG, USER, p, { kind: 'fact', text: 'x' }))).toBe('conflict');
  });
});
