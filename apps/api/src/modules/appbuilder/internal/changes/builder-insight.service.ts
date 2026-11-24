import { builderTools } from '@nuzm/domain';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import { newId } from '../core';
import type { ModelGatewayPort, ProjectRecord, ProjectsPort } from '../ports/m09';
import type { ChangeResult, ChangeService } from './change.service';

const T = builderTools;

/**
 * Read-only insight over a project plus the customer-facing project memory (S-05). Everything here is computed by the pure builder-tools code from the project's own files or from the
 * text the customer typed; NOTHING is sent to a model or a vendor, so there is no residency decision, no credit spend and no data transfer to make. The only write is the project
 * memory file (`.nuzm/memory.json`), which goes through the ordinary safe-change pipeline like any edit, as the signed-in person (never as an agent).
 */
export class BuilderInsightService {
  constructor(
    private readonly projects: ProjectsPort,
    private readonly changes: Pick<ChangeService, 'apply'>,
    private readonly gateway: Pick<ModelGatewayPort, 'rateMinorPer1kTokens'>,
    private readonly audit: AuditSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async head(orgId: string, p: ProjectRecord): Promise<Map<string, string>> {
    if (!p.headVersionId) return new Map();
    return (await this.projects.readFiles(orgId, p.id, p.headVersionId)) ?? new Map();
  }
  private assertTree(p: ProjectRecord) {
    if (p.type !== 'webapp' && p.type !== 'mobile')
      throw new ProblemException('unsupported_capability', 'this applies to web-app and mobile projects; a website project is a site model without a file tree');
  }

  /** Requirement text in, plan and estimate out. Pure: no project, no model, nothing stored. */
  async plan(orgId: string, body: { text?: unknown; hint?: unknown; repairRounds?: unknown }) {
    if (typeof body.text !== 'string' || body.text.trim().length === 0) throw new ProblemException('validation_failed', 'text is required');
    if (body.text.length > T.planning.PLAN_LIMITS.maxRequirementChars)
      throw new ProblemException('validation_failed', `text is at most ${T.planning.PLAN_LIMITS.maxRequirementChars} characters`);
    if (body.hint !== undefined && !(T.planning.PRODUCT_TYPES as readonly string[]).includes(body.hint as string))
      throw new ProblemException('validation_failed', 'hint is not a known product type');
    const rounds = body.repairRounds === undefined ? 1 : Number(body.repairRounds);
    if (!Number.isInteger(rounds) || rounds < 0 || rounds > 3) throw new ProblemException('validation_failed', 'repairRounds is 0 to 3');
    const analysis = T.planning.analyzeRequirements(body.text, body.hint ? { hint: body.hint as builderTools.planning.ProductType } : {});
    const plan = T.planning.buildPlan(analysis, body.text);
    const v = T.planning.validatePlan(plan);
    if (!v.ok) throw new ProblemException('internal_error', 'the generated plan failed its own checks');
    const rate = await this.gateway.rateMinorPer1kTokens(orgId);
    return { plan, estimate: T.estimatePlan(plan, { inputPer1k: rate, outputPer1k: rate }, { repairRounds: rounds }), estimateNote: 'planning figures, not a quote: the provider usage and the organization rate card are authoritative' };
  }

  async review(orgId: string, p: ProjectRecord) {
    this.assertTree(p);
    const files = await this.head(orgId, p);
    const r = T.reviewProject(files);
    return { versionId: p.headVersionId, ...r };
  }

  async symbols(orgId: string, p: ProjectRecord, q: string, kind?: string) {
    this.assertTree(p);
    if (typeof q !== 'string' || q.trim().length < 1 || q.length > 100) throw new ProblemException('validation_failed', 'q is 1 to 100 characters');
    const kinds = ['function', 'class', 'const', 'type', 'interface', 'enum'];
    if (kind !== undefined && !kinds.includes(kind)) throw new ProblemException('validation_failed', 'kind is not a known symbol kind');
    const files = await this.head(orgId, p);
    return { query: q.trim(), symbols: T.searchSymbols(files, q, kind ? { kind: kind as builderTools.SymbolKind } : {}) };
  }

  async imports(orgId: string, p: ProjectRecord) {
    this.assertTree(p);
    const a = T.analyzeImports(await this.head(orgId, p));
    return { unresolved: a.unresolved.slice(0, 200), missingPackages: a.missingPackages.slice(0, 200), unusedDependencies: a.unusedDependencies.slice(0, 200), cycles: a.cycles, files: a.graph.size, truncated: a.truncated };
  }

  async components(orgId: string, p: ProjectRecord) {
    this.assertTree(p);
    return { components: T.discoverComponents(await this.head(orgId, p)) };
  }

  // ───────────── project memory (a file in the project) ─────────────
  async memory(orgId: string, p: ProjectRecord) {
    this.assertTree(p);
    const m = T.memoryFromFiles(await this.head(orgId, p));
    if (!m.ok) throw new ProblemException('conflict', 'the stored project memory is damaged; fix or remove .nuzm/memory.json');
    return { path: T.MEMORY_PATH, entries: T.activeEntries(m.value), total: m.value.entries.length, limits: T.MEMORY_LIMITS };
  }

  async addMemory(orgId: string, actor: string, p: ProjectRecord, body: { kind?: unknown; text?: unknown; pinned?: unknown; baseVersion?: unknown }): Promise<{ entry: builderTools.MemoryEntry; change: ChangeResult | null }> {
    this.assertTree(p);
    if (body.baseVersion !== undefined && body.baseVersion !== p.headVersionId)
      throw new ProblemException('base_mismatch', 'the project changed since you loaded it', undefined, { currentVersion: p.headVersionId });
    const files = await this.head(orgId, p);
    const cur = T.memoryFromFiles(files);
    if (!cur.ok) throw new ProblemException('conflict', 'the stored project memory is damaged; fix or remove .nuzm/memory.json');
    const r = T.addEntry(cur.value, { kind: body.kind as builderTools.MemoryKind, text: String(body.text ?? ''), source: 'user', at: this.now().toISOString(), pinned: body.pinned === true }, newId);
    if (!r.ok) throw new ProblemException('validation_failed', `the note was refused: ${r.code}`, [{ field: 'text', message: r.code }]);
    if (!r.value.added) return { entry: r.value.entry, change: null };
    const change = await this.write(orgId, actor, p, files, r.value.memory, 'Add project memory note');
    return { entry: r.value.entry, change };
  }

  async forgetMemory(orgId: string, actor: string, p: ProjectRecord, entryId: string): Promise<{ change: ChangeResult }> {
    this.assertTree(p);
    const files = await this.head(orgId, p);
    const cur = T.memoryFromFiles(files);
    if (!cur.ok) throw new ProblemException('conflict', 'the stored project memory is damaged; fix or remove .nuzm/memory.json');
    const r = T.forget(cur.value, entryId);
    if (!r.ok) throw new ProblemException('not_found', 'memory note not found');
    return { change: await this.write(orgId, actor, p, files, r.value, 'Remove project memory note') };
  }

  private async write(orgId: string, actor: string, p: ProjectRecord, files: ReadonlyMap<string, string>, m: builderTools.ProjectMemory, message: string): Promise<ChangeResult> {
    const ops = T.memoryOps(files, m);
    const result = await this.changes.apply(orgId, actor, p, { baseVersion: p.headVersionId, patches: ops, source: 'user', message });
    await this.audit.record({ action: 'builder.memory.changed', orgId, actorUserId: actor, resource: { type: 'project', id: p.id }, outcome: 'success', after: { versionId: result.versionId, entries: m.entries.length } });
    return result;
  }
}
