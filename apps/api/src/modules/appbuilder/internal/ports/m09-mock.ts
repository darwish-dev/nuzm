import { v7 as uuidv7 } from 'uuid';
import { sha256 } from '../core';
import {
  ArtifactStorePort,
  ModelGatewayPort,
  ModelNoCapacityError,
  ModelTimeoutError,
  OrgBudgetPort,
  ProjectsPort,
  RUN_TRANSITIONS,
  RunStorePort,
  StaleBaseError,
  TERMINAL_RUN_STATES,
  type ModelRequest,
  type ModelResponse,
  type ProjectRecord,
  type ProjectType,
  type ProjectVersion,
  type RunRecord,
  type RunState,
  type RunUsage,
} from './m09';

/**
 * IN-MEMORY STAND-INS FOR M09 (NOT VERIFIED). They exist so M10A can be built and tested before M09 lands; they are never counted as evidence of
 * model quality, of M09 behaviour or of persistence. Production wiring uses `M09_PORT_PROVIDERS` once M09 is on main.
 */

export type Fixture = (req: ModelRequest) => unknown;
export type ScriptedFault = 'timeout' | 'no_capacity' | 'malformed';

/** Scripted model adapter: returns recorded/hand-written fixtures per `purpose`; deterministic usage (chars/4, +1 minimum). */
export class ScriptedModelGateway extends ModelGatewayPort {
  readonly calls: ModelRequest[] = [];
  private readonly faults: ScriptedFault[] = [];
  /** Minor units per 1,000 tokens (both directions) used for the reservation and for the reported cost. */
  rate = 2;
  constructor(private readonly fixtures: Record<string, Fixture>) {
    super();
  }
  register(purpose: string, f: Fixture) {
    this.fixtures[purpose] = f;
  }
  /** The next call fails (consumed once per queued fault). */
  failNext(fault: ScriptedFault) {
    this.faults.push(fault);
  }
  async rateMinorPer1kTokens(): Promise<number> {
    return this.rate;
  }
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.calls.push(req);
    const fault = this.faults.shift();
    if (fault === 'timeout') throw new ModelTimeoutError();
    if (fault === 'no_capacity') throw new ModelNoCapacityError();
    const fx = this.fixtures[req.purpose];
    if (!fx) throw new Error(`scripted model: no fixture for purpose "${req.purpose}"`);
    const output = fault === 'malformed' ? { malformed: true } : fx(req);
    const tokensIn = Math.max(1, Math.ceil(JSON.stringify(req.input ?? '').length / 4));
    const tokensOut = Math.min(
      req.maxTokens,
      Math.max(1, Math.ceil(JSON.stringify(output).length / 4)),
    );
    return {
      output,
      tokensIn,
      tokensOut,
      costMinor: Math.max(1, Math.ceil(((tokensIn + tokensOut) * this.rate) / 1000)),
      modelRef: 'scripted-fixture-v1',
      estimated: true,
    };
  }
}

export class MemoryRunStore extends RunStorePort {
  readonly runs = new Map<string, RunRecord>();
  async create(orgId: string, i: Parameters<RunStorePort['create']>[1]): Promise<RunRecord> {
    const now = new Date().toISOString();
    const r: RunRecord = {
      id: uuidv7(),
      orgId,
      kind: i.kind,
      projectId: i.projectId,
      sessionId: i.sessionId ?? null,
      state: 'queued',
      budget: i.budget,
      usage: { tokensIn: 0, tokensOut: 0, costMinor: 0, steps: 0 },
      dataRegion: i.dataRegion,
      createdBy: i.createdBy,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      reason: null,
      specRef: i.specRef ?? null,
      operationId: null,
    };
    this.runs.set(r.id, r);
    return { ...r };
  }
  async get(orgId: string, id: string) {
    const r = this.runs.get(id);
    return r && r.orgId === orgId ? { ...r, usage: { ...r.usage } } : null;
  }
  async list(orgId: string, f: { projectId?: string; state?: RunState; limit?: number } = {}) {
    return [...this.runs.values()]
      .filter(
        (r) =>
          r.orgId === orgId &&
          (!f.projectId || r.projectId === f.projectId) &&
          (!f.state || r.state === f.state),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, f.limit ?? 50)
      .map((r) => ({ ...r }));
  }
  async transition(orgId: string, id: string, to: RunState, reason: string | null = null) {
    const r = this.runs.get(id);
    if (!r || r.orgId !== orgId) throw new Error('run not found');
    if (r.state === to) return { ...r };
    if (!RUN_TRANSITIONS[r.state].includes(to))
      throw new Error(`illegal run transition ${r.state} -> ${to}`);
    r.state = to;
    r.reason = reason ?? r.reason;
    r.updatedAt = new Date().toISOString();
    if (to === 'running' && !r.startedAt) r.startedAt = r.updatedAt;
    if (TERMINAL_RUN_STATES.includes(to)) r.finishedAt = r.updatedAt;
    return { ...r };
  }
  async addUsage(orgId: string, id: string, d: Partial<RunUsage>) {
    const r = this.runs.get(id);
    if (!r || r.orgId !== orgId) throw new Error('run not found');
    r.usage = {
      tokensIn: r.usage.tokensIn + (d.tokensIn ?? 0),
      tokensOut: r.usage.tokensOut + (d.tokensOut ?? 0),
      costMinor: r.usage.costMinor + (d.costMinor ?? 0),
      steps: r.usage.steps + (d.steps ?? 0),
    };
    return { ...r, usage: { ...r.usage } };
  }
  async listAll(f: { state?: RunState; limit?: number } = {}) {
    return [...this.runs.values()]
      .filter((r) => !f.state || r.state === f.state)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, f.limit ?? 100)
      .map((r) => ({ ...r }));
  }
}

export class MemoryArtifactStore extends ArtifactStorePort {
  private readonly items = new Map<string, { orgId: string; payload: string }>();
  async put(orgId: string, runId: string | null, kind: string, payload: unknown) {
    const ref = `art_${kind}_${uuidv7()}`;
    this.items.set(ref, { orgId, payload: JSON.stringify(payload) });
    void runId;
    return ref;
  }
  async get(orgId: string, ref: string) {
    const x = this.items.get(ref);
    return x && x.orgId === orgId ? (JSON.parse(x.payload) as unknown) : null;
  }
}

export class MemoryProjects extends ProjectsPort {
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly versions = new Map<string, { v: ProjectVersion; files: Map<string, string> }>();
  async get(orgId: string, id: string) {
    const p = this.projects.get(id);
    return p && p.orgId === orgId ? { ...p } : null;
  }
  async list(orgId: string, f: { type?: ProjectType; limit?: number } = {}) {
    return [...this.projects.values()]
      .filter((p) => p.orgId === orgId && (!f.type || p.type === f.type))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, f.limit ?? 50)
      .map((p) => ({ ...p }));
  }
  async create(orgId: string, i: Parameters<ProjectsPort['create']>[1]) {
    const p: ProjectRecord = {
      id: uuidv7(),
      orgId,
      type: i.type,
      name: i.name,
      dataRegion: i.dataRegion,
      headVersionId: null,
      version: 1,
      referenceTemplate: i.referenceTemplate ?? null,
      createdBy: i.createdBy,
      createdAt: new Date().toISOString(),
    };
    this.projects.set(p.id, p);
    return { ...p };
  }
  async getVersion(orgId: string, projectId: string, versionId: string) {
    const p = await this.get(orgId, projectId);
    const x = this.versions.get(versionId);
    return p && x && x.v.projectId === projectId ? { ...x.v } : null;
  }
  async listVersions(orgId: string, projectId: string) {
    if (!(await this.get(orgId, projectId))) return [];
    return [...this.versions.values()]
      .filter((x) => x.v.projectId === projectId)
      .map((x) => ({ ...x.v }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async commit(orgId: string, projectId: string, i: Parameters<ProjectsPort['commit']>[2]) {
    const p = this.projects.get(projectId);
    if (!p || p.orgId !== orgId) throw new Error('project not found');
    if (p.headVersionId !== i.baseVersionId) throw new StaleBaseError(p.headVersionId);
    const manifest: Record<string, string> = {};
    for (const [path, content] of i.files) manifest[path] = sha256(content);
    const v: ProjectVersion = {
      id: uuidv7(),
      projectId,
      parentId: p.headVersionId,
      label: i.label ?? null,
      source: i.source,
      createdAt: new Date().toISOString(),
      createdBy: i.createdBy,
      manifest,
    };
    this.versions.set(v.id, { v, files: new Map(i.files) });
    p.headVersionId = v.id;
    p.version += 1;
    return { ...v };
  }
  async readFiles(orgId: string, projectId: string, versionId: string) {
    if (!(await this.get(orgId, projectId))) return null;
    const x = this.versions.get(versionId);
    return x && x.v.projectId === projectId ? new Map(x.files) : null;
  }
}

export class StaticOrgBudget extends OrgBudgetPort {
  constructor(public remaining = 1_000_000_00) {
    super();
  }
  async remainingMinor() {
    return this.remaining;
  }
}
