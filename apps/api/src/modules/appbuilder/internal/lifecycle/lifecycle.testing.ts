import { builderTools } from '@nuzm/domain';
import { SkeletonGenerator } from './file-generators';
import type {
  ExecutionBudgetPort,
  FileOp,
  LifecycleArtifacts,
  LifecycleEnv,
  LifecycleHost,
  LifecycleState,
  StepId,
  Usage,
} from './lifecycle.types';

const T = builderTools;

/** In-memory host and environment for tests of the lifecycle (no database, no Git, no model, no process). Everything the real ones persist is observable here. */
export class MemoryHost implements LifecycleHost {
  orgId = 'org-1';
  runId = '0198a3c0-1111-7000-8000-000000000001';
  projectId = 'proj-1';
  userId: string | null = 'user-1';
  permissions: ReadonlySet<string> = new Set([
    'builder:read',
    'builder:write',
    'builder:test',
    'deploy:create',
  ]);
  budget: { maxTokens?: number; maxCredits?: number } = {};
  input: { prompt: string; maxRepairRounds?: number; maxMinutes?: number } = {
    prompt: 'An online store with products, a cart and checkout, sign in, and an admin dashboard',
  };
  clock = 0;
  cancelAfterSaves: number | null = null;
  crashAfterSaves: number | null = null;
  saved: { state: LifecycleState; artifacts: LifecycleArtifacts } | null = null;
  saves: string[] = [];
  events: { type: string; data?: Record<string, unknown> }[] = [];
  audits: { action: string; outcome: string; detail: Record<string, unknown> }[] = [];
  steps: {
    id: string;
    step: StepId;
    round: number;
    attempt: number;
    status?: string;
    code?: string;
  }[] = [];
  artifactsStore = new Map<string, unknown>();
  runState: string[] = [];
  cancel = false;
  now() {
    return new Date(Date.parse('2026-11-24T00:00:00Z') + this.clock++ * 1000).toISOString();
  }
  async load() {
    return this.saved ? JSON.parse(JSON.stringify(this.saved)) : null;
  }
  async save(state: LifecycleState, artifacts: LifecycleArtifacts, step: string) {
    this.saved = JSON.parse(JSON.stringify({ state, artifacts }));
    this.saves.push(step);
    if (this.cancelAfterSaves !== null && this.saves.length >= this.cancelAfterSaves)
      this.cancel = true;
    if (this.crashAfterSaves !== null && this.saves.length === this.crashAfterSaves)
      throw new Error('simulated crash');
  }
  async emit(type: string, data?: Record<string, unknown>) {
    this.events.push({ type, ...(data ? { data } : {}) });
  }
  async audit(action: string, outcome: 'success' | 'failure', detail: Record<string, unknown>) {
    this.audits.push({ action, outcome, detail });
  }
  async cancelled() {
    return this.cancel;
  }
  async stepBegin(step: StepId, round: number, attempt: number) {
    const id = `s${this.steps.length + 1}`;
    this.steps.push({ id, step, round, attempt });
    return id;
  }
  async stepEnd(id: string, status: 'succeeded' | 'failed', o: { usage?: Usage; code?: string }) {
    const s = this.steps.find((x) => x.id === id)!;
    s.status = status;
    if (o.code) s.code = o.code;
  }
  async storeArtifact(_t: 'change_set' | 'evaluation_report', payload: unknown) {
    const id = `art-${this.artifactsStore.size + 1}`;
    this.artifactsStore.set(id, JSON.parse(JSON.stringify(payload)));
    return id;
  }
  async loadArtifact(id: string) {
    return this.artifactsStore.get(id) ?? null;
  }
  async setRunState(state: 'running' | 'waiting_approval') {
    this.runState.push(state);
  }
  stepNames() {
    return this.steps.map((s) => s.step);
  }
}

export class MemoryBudget implements ExecutionBudgetPort {
  starts: string[] = [];
  metered: { eventKey: string; profile: string; origin: string }[] = [];
  deny: { code: string } | null = null;
  async assertStart(_org: string, purpose: string) {
    if (this.deny) {
      const { ProblemException } = await import('../../../../common/errors');
      throw new ProblemException(this.deny.code as never, 'denied');
    }
    this.starts.push(purpose);
    return { gates: ['residency', 'platform_ceiling', 'build_allowance'] };
  }
  async meter(
    _o: string,
    _p: string,
    e: { eventKey: string; profile: string; durationMs: number; origin: 'MOCK' | 'REAL' },
  ) {
    // idempotent by key, like the metering pipeline
    if (!this.metered.some((m) => m.eventKey === e.eventKey)) this.metered.push(e);
  }
}

export class MemoryEnv implements LifecycleEnv {
  files = new Map<string, string>();
  versions = 0;
  versionId: string | null = null;
  applied: { ops: FileOp[]; label: string }[] = [];
  generator: LifecycleEnv['generator'] = new SkeletonGenerator();
  repair: builderTools.RepairStrategy = new T.RuleBasedRepair();
  modelBacked = { file_generation: false, repair: false };
  build: builderTools.BuildPort | null = new T.ScriptedBuildPort();
  budget = new MemoryBudget();
  approvalStatus: 'pending' | 'approved' | 'rejected' | 'expired' = 'pending';
  approvalsRequested: Record<string, unknown>[] = [];
  usage: Usage = {};
  async head() {
    return { versionId: this.versionId, files: new Map(this.files) };
  }
  async apply(ops: FileOp[], label: string) {
    const prev = T.previewChangeSet(this.files, ops, { hasHead: this.versionId !== null });
    if (!prev.ok || !prev.next) throw new Error('memory env: the change was rejected');
    this.files = new Map(prev.next);
    this.versions += 1;
    this.versionId = `0198a3c0-aaaa-7000-8000-${String(this.versions).padStart(12, '0')}`;
    this.applied.push({ ops, label });
    return { versionId: this.versionId };
  }
  async requestDeployApproval(summary: Record<string, unknown>) {
    this.approvalsRequested.push(summary);
    return { id: 'approval-1', scopeHash: 'h' };
  }
  async deployApprovalStatus() {
    return this.approvalStatus;
  }
  takeUsage(): Usage {
    const u = this.usage;
    this.usage = {};
    return u;
  }
}
