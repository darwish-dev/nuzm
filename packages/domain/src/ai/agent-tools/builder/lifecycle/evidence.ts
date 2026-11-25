import type { RepairMetrics, RepairRoundRecord } from '../autorepair/metrics';
import { summarizeRepairs } from '../autorepair/metrics';
import type { LifecycleState } from './machine';

/**
 * The evidence record of one builder-lifecycle run (P3-S03, acceptance L1): model id, tokens, cost, tool invocations, files, build/test results, repair rounds and durations, with an
 * honest CLAIM. The claim is computed from the ORIGINS of what actually ran, never asserted:
 *  - `SIMULATED`   no real component took part (placeholders or scripted model, mock/twin build);
 *  - `MIXED`       one of model/build was real and the other simulated;
 *  - `REAL_COMPONENTS`  the model ran through the metered gateway on a provider row AND the build ran on a REAL port. Even then this record is not `LIVE-VERIFIED`: that word is
 *                  given only by the qualification session after it checks the approvals and the evidence file against its schema.
 * Pure: the caller supplies usage totals and model refs read from the database (`ai.model_usage`), so tokens and cost are the gateway's numbers, not the lifecycle's own.
 */
export interface BuildLogEntry {
  phase: 'build' | 'rebuild' | 'tests';
  round: number;
  profile: string;
  status: string;
  durationMs: number;
  origin: 'MOCK' | 'REAL';
}
export interface EvidenceUsage {
  /** distinct `provider/model` refs the run's calls used (from `ai.model_usage`) */
  modelRefs: readonly string[];
  tokensIn: number;
  tokensOut: number;
  credits: string;
  /** provider cost in minor units, null when no rate card priced the calls (never guessed) */
  costMinor: string | null;
  /** number of settled calls */
  calls: number;
  /** true when the model calls went through a configured, non-dev-reference provider row */
  realProvider: boolean;
}
export interface RunEvidence {
  schema: 'nuzm.builder-run-evidence/1';
  runId: string;
  projectId: string;
  status: LifecycleState['status'];
  failureCode: string | null;
  claim: 'SIMULATED' | 'MIXED' | 'REAL_COMPONENTS';
  label: string;
  model: { refs: readonly string[]; generator: 'skeleton' | 'model' | null; calls: number };
  tokens: { in: number; out: number };
  credits: string;
  costMinor: string | null;
  filesGenerated: number;
  toolInvocations: { tool: string; step: string; status: string }[];
  toolInvocationSummary: Record<string, { ok: number; failed: number; denied: number }>;
  builds: BuildLogEntry[];
  executionOrigin: 'MOCK' | 'REAL' | null;
  repair: { rounds: number; metrics: RepairMetrics; records: RepairRoundRecord[] };
  durations: { totalMs: number | null; byStep: Record<string, number> };
  /** tokens and credits of the lifecycle's own accounting versus the gateway's, so a reader sees at once whether they agree */
  reconciliation: {
    stateTokens: number;
    usageTokens: number;
    stateCredits: string;
    usageCredits: string;
    equal: boolean;
  };
}

export interface EvidenceInput {
  runId: string;
  projectId: string;
  state: LifecycleState;
  generator: 'skeleton' | 'model' | null;
  generatedFiles: number;
  builds: readonly BuildLogEntry[];
  executionOrigin: 'MOCK' | 'REAL' | null;
  repairRecords: readonly RepairRoundRecord[];
  usage: EvidenceUsage;
  finishedAt?: string;
}

export function claimOf(
  modelReal: boolean,
  executionOrigin: 'MOCK' | 'REAL' | null,
): RunEvidence['claim'] {
  const execReal = executionOrigin === 'REAL';
  if (modelReal && execReal) return 'REAL_COMPONENTS';
  if (modelReal || execReal) return 'MIXED';
  return 'SIMULATED';
}

const LABEL: Record<RunEvidence['claim'], string> = {
  SIMULATED:
    'SIMULATED: no real component took part (placeholder or scripted model, mock or twin build); this proves plumbing, accounting and limits, not model quality and not that the code builds',
  MIXED:
    'MIXED: one of the model and the build was real and the other simulated; nothing here is LIVE-VERIFIED until the qualification session checks it',
  REAL_COMPONENTS:
    'REAL COMPONENTS: the model and the build ran through real adapters; this is evidence for review, not LIVE-VERIFIED until the qualification session checks the approvals and the file',
};

export function buildRunEvidence(i: EvidenceInput): RunEvidence {
  const s = i.state;
  const byStep: Record<string, number> = {};
  for (const r of Object.values(s.steps))
    if (r.startedAt && r.finishedAt)
      byStep[`${r.id}#r${r.round}`] = Math.max(
        0,
        Date.parse(r.finishedAt) - Date.parse(r.startedAt),
      );
  const total = i.finishedAt
    ? Math.max(0, Date.parse(i.finishedAt) - Date.parse(s.startedAt))
    : null;
  const summary: RunEvidence['toolInvocationSummary'] = {};
  for (const v of s.invocations) {
    const e = (summary[v.tool] ??= { ok: 0, failed: 0, denied: 0 });
    if (v.status === 'succeeded') e.ok++;
    else if (v.status === 'denied') e.denied++;
    else if (v.status === 'failed') e.failed++;
  }
  const claim = claimOf(i.usage.realProvider && i.usage.calls > 0, i.executionOrigin);
  const stateTokens = s.tokensIn + s.tokensOut;
  const usageTokens = i.usage.tokensIn + i.usage.tokensOut;
  return {
    schema: 'nuzm.builder-run-evidence/1',
    runId: i.runId,
    projectId: i.projectId,
    status: s.status,
    failureCode: s.failure?.code ?? null,
    claim,
    label: LABEL[claim],
    model: { refs: i.usage.modelRefs, generator: i.generator, calls: i.usage.calls },
    tokens: { in: i.usage.tokensIn, out: i.usage.tokensOut },
    credits: i.usage.credits,
    costMinor: i.usage.costMinor,
    filesGenerated: i.generatedFiles,
    toolInvocations: s.invocations.map((v) => ({ tool: v.tool, step: v.step, status: v.status })),
    toolInvocationSummary: summary,
    builds: [...i.builds],
    executionOrigin: i.executionOrigin,
    repair: {
      rounds: s.repairRound,
      metrics: summarizeRepairs(i.repairRecords, i.executionOrigin === 'REAL' ? 'REAL' : 'MOCK'),
      records: [...i.repairRecords],
    },
    durations: { totalMs: total, byStep },
    reconciliation: {
      stateTokens,
      usageTokens,
      stateCredits: s.credits,
      usageCredits: i.usage.credits,
      equal: stateTokens === usageTokens && s.credits === i.usage.credits,
    },
  };
}
