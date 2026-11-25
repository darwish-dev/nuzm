import { describe, expect, it } from 'vitest';
import {
  ApprovalWorkflow,
  CLOSED_GATE,
  DEFAULT_QUEUE_CONFIG,
  ExecutionOrchestrator,
  ExecutionQueue,
  JournaledKillSwitch,
  QuotaLedger,
  createMockExecutionPort,
  type ExecContext,
  type ExecutionJournal,
  type JournalCreated,
  type JournalJob,
  type JournalMove,
  type OrgCeilings,
} from './index';

const ctx: ExecContext = {
  orgId: 'org-1',
  runId: 'run-1',
  enabledProfiles: ['typecheck', 'unit-tests', 'build', 'run-script', 'install-deps'],
  projectScripts: ['lint'],
};
const CEIL: OrgCeilings = {
  maxConcurrent: 2,
  maxRunsPerWindow: 50,
  windowMs: 3_600_000,
  maxCpuSecondsPerWindow: 100_000,
  budgetCapMinor: 1_000_000,
  rates: { currency: 'SAR', minorPerKiloCpuSecond: 100 },
};
const human = { userId: 'u1', orgId: 'org-1', kind: 'user' as const, canApproveExecution: true };

class RecordingJournal implements ExecutionJournal {
  created_: JournalJob[] = [];
  moves: JournalMove[] = [];
  result: JournalCreated = { ok: true };
  throws = false;
  async created(j: JournalJob): Promise<JournalCreated> {
    if (this.throws) throw new Error('db down');
    if (this.result.ok) this.created_.push(j);
    return this.result;
  }
  moved(m: JournalMove): void {
    this.moves.push(m);
  }
}
function rig(journal?: RecordingJournal) {
  const t = 1_000_000;
  const port = createMockExecutionPort(ctx);
  const o = new ExecutionOrchestrator({
    port,
    ledger: new QuotaLedger(() => t),
    queue: new ExecutionQueue<string>(DEFAULT_QUEUE_CONFIG, () => t),
    approvals: new ApprovalWorkflow(() => t, 60_000),
    killSwitch: new JournaledKillSwitch(() => undefined),
    audit: () => undefined,
    gate: () => CLOSED_GATE,
    flags: () => ({ execTools: true, aiKillSwitch: false }),
    ceilings: () => CEIL,
    canaries: () => [],
    now: () => t,
    ...(journal ? { journal: { sink: journal, dataRegion: () => 'sa-riyadh' } } : {}),
  });
  return { o, port };
}
const submit = (o: ExecutionOrchestrator, profile = 'typecheck', key = 'idem-0001') =>
  o.submit({
    orgId: 'org-1',
    runId: 'run-1',
    idempotencyKey: key,
    request: { orgId: 'org-1', runId: 'run-1', profile },
  });

describe('orchestrator durable journal (P3-S02)', () => {
  it('records the job before it exists and every state change in order, with the outcome on the terminal move', async () => {
    const j = new RecordingJournal();
    const { o } = rig(j);
    const s = await submit(o);
    expect(s).toMatchObject({ status: 'queued' });
    expect(j.created_).toHaveLength(1);
    expect(j.created_[0]).toMatchObject({
      orgId: 'org-1',
      runId: 'run-1',
      profile: 'typecheck',
      origin: 'MOCK',
      dataRegion: 'sa-riyadh',
      requiresApproval: false,
    });
    expect(j.created_[0]!.decisionDigest).toMatch(/^[0-9a-f]{64}$/);
    const v = await o.runNext('w');
    expect(v).not.toBeNull();
    expect(j.moves.map((m) => `${m.from}>${m.to}`)).toEqual([
      'requested>queued',
      'queued>running',
      'running>succeeded',
    ]);
    const last = j.moves.at(-1)!;
    expect(last.patch).toMatchObject({ outcomeStatus: 'completed', exitCode: 0 });
    expect(last.patch?.durationMs).toBeGreaterThanOrEqual(0);
    // nothing but identifiers, states, causes and numbers goes to the journal: no request payload, output or environment
    expect(JSON.stringify([j.created_, j.moves])).not.toMatch(/stdout|stderr|env|argv/i);
  });

  it('records the approval path (awaiting_approval, rejected) and a cancelled queued job', async () => {
    const j = new RecordingJournal();
    const { o } = rig(j);
    const s = await submit(o, 'install-deps', 'idem-appr-1');
    expect(s).toMatchObject({ status: 'awaiting_approval' });
    const jobId = (s as { jobId: string }).jobId;
    await o.decide(jobId, human, 'reject', 'no');
    expect(j.moves.map((m) => `${m.from}>${m.to}`)).toEqual([
      'requested>awaiting_approval',
      'awaiting_approval>rejected',
    ]);
    const q = await submit(o, 'typecheck', 'idem-canc-1');
    await o.cancel((q as { jobId: string }).jobId, 'org-1');
    expect(j.moves.at(-1)).toMatchObject({
      from: 'queued',
      to: 'cancelled',
      cause: 'caller_cancelled',
    });
  });

  it('FAIL CLOSED: a journal that cannot write refuses the submit and nothing runs', async () => {
    const j = new RecordingJournal();
    j.throws = true;
    const { o, port } = rig(j);
    expect(await submit(o)).toEqual({ status: 'refused', reasons: ['journal_unavailable'] });
    expect(await o.runNext('w')).toBeNull();
    expect(port.calls).toHaveLength(0);
    expect(j.moves).toHaveLength(0);
  });

  it('a journal that refuses the key (already recorded) refuses the submit with its reason', async () => {
    const j = new RecordingJournal();
    j.result = { ok: false, reason: 'idempotency_key_already_recorded' };
    const { o } = rig(j);
    expect(await submit(o)).toEqual({
      status: 'refused',
      reasons: ['idempotency_key_already_recorded'],
    });
    expect(await o.runNext('w')).toBeNull();
  });

  it('a duplicate submit does not create a second durable record', async () => {
    const j = new RecordingJournal();
    const { o } = rig(j);
    await submit(o);
    expect(await submit(o)).toMatchObject({ status: 'queued', duplicate: true });
    expect(j.created_).toHaveLength(1);
  });

  it('a journal that throws in `moved` can never change what the state machine does', async () => {
    const j = new RecordingJournal();
    j.moved = () => {
      throw new Error('boom');
    };
    const { o } = rig(j);
    await submit(o);
    expect(await o.runNext('w')).toMatchObject({ state: 'succeeded' });
  });

  it('without a journal nothing changes (the default)', async () => {
    const { o } = rig();
    await submit(o);
    expect(await o.runNext('w')).toMatchObject({ state: 'succeeded' });
  });
});

describe('JournaledKillSwitch', () => {
  it('reports every change and restores state without writing it back', () => {
    const changes: unknown[] = [];
    const ks = new JournaledKillSwitch((c) => changes.push(c));
    ks.engageOrg('org-1', 'canary_in_output');
    ks.engageGlobal('incident');
    ks.releaseOrg('org-1');
    ks.releaseGlobal();
    expect(changes).toEqual([
      { scope: 'org', orgId: 'org-1', engaged: true, reason: 'canary_in_output' },
      { scope: 'global', engaged: true, reason: 'incident' },
      { scope: 'org', orgId: 'org-1', engaged: false, reason: 'released' },
      { scope: 'global', engaged: false, reason: 'released' },
    ]);
    const restored = new JournaledKillSwitch((c) => changes.push(c));
    const before = changes.length;
    restored.hydrate({ global: false, orgs: ['org-9'] });
    expect(restored.isEngaged('org-9')).toBe(true);
    expect(restored.isEngaged('org-1')).toBe(false);
    restored.hydrate({ global: true, orgs: [] });
    expect(restored.isEngaged('anything')).toBe(true);
    expect(changes.length).toBe(before);
  });
});
