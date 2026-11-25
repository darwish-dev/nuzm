import { GOLDEN_TASKS } from '../dataset';
import { preflightBudget, type BenchmarkBudget, type PriceCard } from '../budget';
import {
  buildEvidenceRecord,
  evidenceRecordProblems,
  type EvidenceApprovals,
  type EvidenceRecord,
} from '../evidence-record';
import { reportFingerprint, runSuite } from '../report';
import {
  livePreflight,
  runLiveBenchmark,
  type CaptureSource,
  type LivePreconditions,
} from '../live-runner';
import { buildScorecard } from '../scorecard';
import { MOCK_PROFILES, mockSuite, type MockProfile } from '../simulate';
import {
  PREREQUISITES,
  REFERENCE_RATE_INPUTS,
  STAGE_IDS,
  evaluateStageEntry,
  planStage,
  selectStageTasks,
  type PrerequisiteId,
  type StageId,
  type StageState,
} from '../stages';
import { PROPOSED_THRESHOLDS, THRESHOLDS_VERSION, evaluateThresholds } from '../thresholds';
import type { Reviewer } from '../review';

/**
 * Track H: real-model benchmark qualification, as a command. TWO modes, one command line.
 *
 *   --mode simulate (default): runs the stage against a scripted MOCK model and prints a scorecard marked SIMULATED. It needs nothing and proves the pipeline; it says nothing about
 *     any provider.
 *   --mode live: REFUSES (exit 3, the capture source is never loaded or called) unless every approval exists: the flag, the live-provider gate, a named non-production environment,
 *     provider verification evidence, accepted thresholds, an approved budget that covers the stage's HARD MAXIMUM, a confirmed price card, a vendor spend cap, at least two named
 *     reviewers, a passed security review and (from stage B) the previous stage's exit. It then needs the confirmation gate (below) and a capture source module.
 *
 * Whatever the mode, the stage plan with its HARD MAXIMUM cost is printed FIRST, before anything is checked or started.
 * Confirmation gate, interactive-free: set `NUZM_BENCH_APPROVAL_REF` (the approval reference) and pass `--confirm-max <minor units>` equal to the printed maximum: typing the number
 * back is the confirmation, so a script cannot start a stage without having been given the figure.
 * The approvals are read from `NUZM_BENCH_*` environment variables holding REFERENCES to the records made in the admin console (never a secret). This is a guard against accidents,
 * not against a malicious operator: the authoritative preflight is the console's `attempt_live_run`, and the capture source (S02's adapter-backed implementation, loaded from
 * `NUZM_BENCH_CAPTURE_SOURCE_MODULE`, which must export `createCaptureSource()`) is what makes a real call, which does not exist yet.
 *
 * Exit codes: 0 done; 2 usage error; 3 refused (a precondition is missing); 4 stage not confirmed; 5 no capture source; 6 the run stopped before completing.
 * The evidence record (`EvidenceRecord`, schema nuzm.benchmark-evidence/1) is printed as JSON; it is never written to a file unless `--out` is given by the person running it.
 */
export const EXIT = {
  OK: 0,
  USAGE: 2,
  REFUSED: 3,
  NOT_CONFIRMED: 4,
  NO_SOURCE: 5,
  STOPPED: 6,
} as const;

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
}
export interface CliDeps {
  /** the injected clock (the domain never reads one) */
  now: () => string;
  /** loads the capture source module; the default (in the entry file) imports the path in `NUZM_BENCH_CAPTURE_SOURCE_MODULE` */
  loadSource?: (modulePath: string) => Promise<CaptureSource>;
  /** writes the evidence record when `--out` is given */
  writeFile?: (path: string, content: string) => void;
}
type Env = Readonly<Record<string, string | undefined>>;

interface Args {
  mode: 'simulate' | 'live';
  stage: StageId;
  profile: MockProfile;
  rate: string;
  confirmMax: string | null;
  out: string | null;
  json: boolean;
}
const USAGE = `usage: qualify [--mode simulate|live] [--stage A|B|C|D|E] [--profile ${MOCK_PROFILES.join('|')}] [--rate "<model name>"] [--confirm-max <minor units>] [--out <file>] [--json]`;

function parseArgs(argv: readonly string[]): Args | string {
  const a: Args = {
    mode: 'simulate',
    stage: 'A',
    profile: 'ideal',
    rate: 'Claude Opus 5.5',
    confirmMax: null,
    out: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = () => argv[++i];
    if (k === '--json') a.json = true;
    else if (k === '--mode') {
      const m = v();
      if (m !== 'simulate' && m !== 'live') return `--mode must be simulate or live`;
      a.mode = m;
    } else if (k === '--stage') {
      const s = v();
      if (!(STAGE_IDS as readonly string[]).includes(s ?? ''))
        return '--stage must be A, B, C, D or E';
      a.stage = s as StageId;
    } else if (k === '--profile') {
      const p = v();
      if (!(MOCK_PROFILES as readonly string[]).includes(p ?? ''))
        return `--profile must be one of ${MOCK_PROFILES.join(', ')}`;
      a.profile = p as MockProfile;
    } else if (k === '--rate') a.rate = v() ?? '';
    else if (k === '--confirm-max') {
      const c = v() ?? '';
      if (!/^[1-9]\d*$/.test(c)) return '--confirm-max must be a positive integer (minor units)';
      a.confirmMax = c;
    } else if (k === '--out') a.out = v() ?? null;
    else return `unknown argument ${k}`;
  }
  return a;
}

const money = (minor: string, cur: string) => {
  const b = BigInt(minor);
  return `${b / 100n}.${(b % 100n).toString().padStart(2, '0')} ${cur}`;
};

/** The price: the environment's confirmed card when given, otherwise the vendor LIST price as a labelled reference. */
function priceFrom(
  env: Env,
  rateName: string,
): { price: PriceCard; source: string; confirmed: boolean } | string {
  const i = env.NUZM_BENCH_PRICE_INPUT_MINOR;
  const o = env.NUZM_BENCH_PRICE_OUTPUT_MINOR;
  if (i !== undefined || o !== undefined) {
    const price: PriceCard = {
      currency: env.NUZM_BENCH_PRICE_CURRENCY ?? 'USD',
      minorPerMillionInput: i ?? '',
      minorPerMillionOutput: o ?? '',
    };
    return {
      price,
      source: (env.NUZM_BENCH_PRICE_SOURCE ?? '').trim() || 'environment (no source stated)',
      confirmed: (env.NUZM_BENCH_RATES_CONFIRMED_REF ?? '').trim() !== '',
    };
  }
  const ref = REFERENCE_RATE_INPUTS.find((r) => r.model === rateName);
  if (!ref)
    return `no reference rate named "${rateName}" (known: ${REFERENCE_RATE_INPUTS.map((r) => r.model).join('; ')})`;
  return { price: ref.price, source: `${ref.source} [${ref.status}]`, confirmed: false };
}

function parseReviewers(v: string | undefined): Reviewer[] {
  return (v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [id, ...name] = x.split(':');
      return { id: (id ?? '').trim(), name: name.join(':').trim() };
    });
}

export async function runCli(
  argv: readonly string[],
  env: Env,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  const parsed = parseArgs(argv);
  if (typeof parsed === 'string') {
    io.err(`${parsed}\n${USAGE}`);
    return EXIT.USAGE;
  }
  const a = parsed;
  const pr = priceFrom(env, a.rate);
  if (typeof pr === 'string') {
    io.err(pr);
    return EXIT.USAGE;
  }
  const tasks = selectStageTasks(a.stage, GOLDEN_TASKS);
  const plan = planStage(
    a.stage,
    GOLDEN_TASKS,
    a.stage === 'D' ? [pr.price, pr.price] : [pr.price],
  );

  // 1. the plan and the HARD MAXIMUM come first, before anything is checked or started
  io.out(
    [
      `STAGE ${a.stage} · ${plan.title} · mode ${a.mode.toUpperCase()}`,
      `tasks ${plan.tasks} (${plan.categories} categories) · runs ${plan.runs} · dataset ${GOLDEN_TASKS.length} tasks`,
      `HARD MAXIMUM COST: ${money(plan.max.costMinor, plan.currency)} (${plan.max.costMinor} minor units) · max tokens ${plan.max.tokens} · max requests ${plan.max.requests}`,
      `estimated cost: ${money(plan.estimate.costMinor, plan.currency)} (assumptions: ${plan.assumptions.basis})`,
      `rates: ${pr.source}${pr.confirmed ? '' : ' [NOT CONFIRMED: reference only]'}`,
      '',
    ].join('\n'),
  );
  if (plan.problems.length > 0) {
    io.err(`stage plan problems: ${plan.problems.join('; ')}`);
    return EXIT.USAGE;
  }

  if (a.mode === 'simulate') return simulate(a, tasks, pr, plan.max.costMinor, io, deps);
  return live(a, tasks, pr, plan, env, io, deps);
}

// ------------------------------------------------------------------------------------------------ simulate
function simulate(
  a: Args,
  tasks: ReturnType<typeof selectStageTasks>,
  pr: { price: PriceCard; source: string },
  maxCostMinor: string,
  io: CliIo,
  deps: CliDeps,
): number {
  const startedAt = deps.now();
  const recordings = mockSuite(tasks, a.profile);
  const { report } = runSuite(tasks, recordings);
  const results = evaluateThresholds(report, PROPOSED_THRESHOLDS);
  const card = buildScorecard(report, results);
  const record = buildEvidenceRecord({
    simulated: true,
    stage: a.stage,
    runId: `simulated-${a.stage}-${a.profile}`,
    status: 'COMPLETED',
    model: { adapterId: 'mock-model', model: a.profile },
    providerEvidenceRef: null,
    tasks,
    recordings,
    report,
    scorecard: card,
    thresholdResults: results,
    reportFingerprint: reportFingerprint(report),
    price: pr.price,
    priceSource: pr.source,
    maxCostMinor,
    approvals: null,
    thresholdsVersion: THRESHOLDS_VERSION,
    startedAt,
    finishedAt: deps.now(),
  });
  const problems = evidenceRecordProblems(record);
  io.out(
    [
      '*** SIMULATED *** a scripted mock model, not a model: this says nothing about any provider.',
      `evidence label: ${report.evidence.label}`,
      '',
      'scorecard (dimension · value · tasks · thresholds):',
      ...card.map(
        (r) =>
          `  ${r.dimension.padEnd(26)} ${String(r.value ?? 'not measured').padStart(10)} ${r.unit.padEnd(6)} ${String(r.tasks).padStart(3)}  ${r.thresholds.map((t) => `${t.id}=${t.status}`).join(' ')}`,
      ),
      '',
      `tokens ${record.usage.tokens} · requests ${record.usage.requests} · simulated cost ${money(record.cost.costMinor, record.cost.currency)}`,
      '',
      'evidence record:',
      JSON.stringify(record, null, 2),
    ].join('\n'),
  );
  if (problems.length > 0) {
    io.err(`the evidence record is not acceptable: ${problems.join('; ')}`);
    return EXIT.STOPPED;
  }
  return writeOut(a, record, io, deps);
}

function writeOut(a: Args, record: EvidenceRecord, io: CliIo, deps: CliDeps): number {
  if (a.out) {
    if (!deps.writeFile) {
      io.err('--out is not available here');
      return EXIT.USAGE;
    }
    deps.writeFile(a.out, `${JSON.stringify(record, null, 2)}\n`);
    io.out(`\nevidence record written to ${a.out} (generated evidence: do not commit it)`);
  }
  return EXIT.OK;
}

// ------------------------------------------------------------------------------------------------ live
async function live(
  a: Args,
  tasks: ReturnType<typeof selectStageTasks>,
  pr: { price: PriceCard; source: string; confirmed: boolean },
  plan: ReturnType<typeof planStage>,
  env: Env,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  const set = (k: string): string => (env[k] ?? '').trim();
  const num = (k: string) => Number(set(k));
  const budget: BenchmarkBudget | null = set('NUZM_BENCH_BUDGET_REF')
    ? {
        ref: set('NUZM_BENCH_BUDGET_REF'),
        approvedBy: set('NUZM_BENCH_BUDGET_APPROVED_BY'),
        currency: set('NUZM_BENCH_BUDGET_CURRENCY') || pr.price.currency,
        maxCostMinor: set('NUZM_BENCH_BUDGET_MAX_COST_MINOR'),
        maxTokens: num('NUZM_BENCH_BUDGET_MAX_TOKENS'),
        maxRequests: num('NUZM_BENCH_BUDGET_MAX_REQUESTS'),
      }
    : null;
  const reviewers = parseReviewers(env.NUZM_BENCH_REVIEWERS);
  const pre: LivePreconditions = {
    flagEnabled: set('NUZM_BENCH_LIVE') === 'true',
    liveProviderGateOpen: set('AI_LIVE_PROVIDERS') !== '',
    environment: set('NUZM_ENV')
      ? {
          name: set('NUZM_ENV'),
          production: set('NUZM_ENV') === 'production' || set('NODE_ENV') === 'production',
        }
      : null,
    providerVerified: set('NUZM_BENCH_PROVIDER_EVIDENCE_REF')
      ? {
          providerId: set('NUZM_BENCH_PROVIDER_ID'),
          model: set('NUZM_BENCH_PROVIDER_MODEL'),
          evidenceRef: set('NUZM_BENCH_PROVIDER_EVIDENCE_REF'),
        }
      : null,
    thresholdsAccepted: set('NUZM_BENCH_THRESHOLDS_ACCEPTED_BY')
      ? {
          version: set('NUZM_BENCH_THRESHOLDS_VERSION'),
          acceptedBy: set('NUZM_BENCH_THRESHOLDS_ACCEPTED_BY'),
          acceptedAt: set('NUZM_BENCH_THRESHOLDS_ACCEPTED_AT'),
        }
      : null,
    budget,
    reviewers,
    securityReview: set('NUZM_BENCH_SECURITY_REVIEW_REF')
      ? {
          ref: set('NUZM_BENCH_SECURITY_REVIEW_REF'),
          reviewedBy: set('NUZM_BENCH_SECURITY_REVIEW_BY'),
          completedAt: set('NUZM_BENCH_SECURITY_REVIEW_AT'),
          passed: set('NUZM_BENCH_SECURITY_REVIEW_PASSED') === 'true',
        }
      : null,
  };
  // the one preflight the live runner itself applies, then the stage-level prerequisites
  const pf = livePreflight(pre, tasks, pr.price);
  const satisfied: StageState['satisfied'] = {};
  const ok = (code: string) => !pf.refusals.some((r) => r.code === code);
  const give = (id: PrerequisiteId, ref: string, holds = true) => {
    if (holds && ref) satisfied[id] = ref;
  };
  give('FLAG_ON', 'NUZM_BENCH_LIVE', ok('FLAG_OFF'));
  give('LIVE_GATE_OPEN', 'AI_LIVE_PROVIDERS', ok('LIVE_GATE_CLOSED'));
  give('ENVIRONMENT_NON_PRODUCTION', set('NUZM_ENV'), ok('ENVIRONMENT_NOT_ALLOWED'));
  give('PROVIDER_VERIFIED', set('NUZM_BENCH_PROVIDER_EVIDENCE_REF'), ok('PROVIDER_NOT_VERIFIED'));
  give(
    'THRESHOLDS_ACCEPTED',
    set('NUZM_BENCH_THRESHOLDS_ACCEPTED_BY'),
    ok('THRESHOLDS_NOT_ACCEPTED'),
  );
  give(
    'BUDGET_APPROVED_FOR_STAGE',
    budget?.ref ?? '',
    ok('BUDGET_NOT_APPROVED') && ok('BUDGET_TOO_SMALL'),
  );
  give('REVIEWERS_NAMED', 'roster', ok('REVIEWERS_NOT_NAMED'));
  give(
    'SECURITY_REVIEW_PASSED',
    set('NUZM_BENCH_SECURITY_REVIEW_REF'),
    ok('SECURITY_REVIEW_MISSING'),
  );
  give(
    'RATES_CONFIRMED',
    set('NUZM_BENCH_RATES_CONFIRMED_REF'),
    pr.confirmed && ok('PRICE_CARD_INVALID'),
  );
  give('VENDOR_SPEND_CAP', set('NUZM_BENCH_VENDOR_CAP_REF'));
  give('PREVIOUS_STAGE_EXITED', set('NUZM_BENCH_PREVIOUS_STAGE_EXIT_REF'));
  give('BASELINE_RECORDED', set('NUZM_BENCH_BASELINE_REF'));
  give('CAPTURE_SOURCE_BUILT', set('NUZM_BENCH_CAPTURE_SOURCE_MODULE'));
  const entry = evaluateStageEntry(a.stage, { satisfied });

  const refusals = [
    ...pf.refusals.map((r) => `${r.code}: ${r.detail}`),
    ...entry.missing
      .filter((m) => !pf.refusals.some((r) => refusalOf(m.id) === r.code))
      .map((m) => `${m.id}: ${PREREQUISITES[m.id].text} (owner: ${PREREQUISITES[m.id].owner})`),
  ];
  if (refusals.length > 0) {
    io.out(
      `REFUSED: the live stage cannot start. Nothing was called.\n${refusals.map((r) => `  - ${r}`).join('\n')}`,
    );
    return EXIT.REFUSED;
  }

  // the budget must cover THIS stage's maximum (preflight proved it); the confirmation gate follows
  const pb = preflightBudget(tasks, budget, pr.price);
  if (!pb.ok) {
    io.out(`REFUSED: ${pb.reasons.join('; ')}`);
    return EXIT.REFUSED;
  }
  const approvalRef = set('NUZM_BENCH_APPROVAL_REF');
  if (!approvalRef || a.confirmMax !== plan.max.costMinor) {
    io.out(
      `NOT CONFIRMED: set NUZM_BENCH_APPROVAL_REF to the approval reference and pass --confirm-max ${plan.max.costMinor} (the hard maximum printed above, in minor units). Nothing was started.`,
    );
    return EXIT.NOT_CONFIRMED;
  }

  const modulePath = set('NUZM_BENCH_CAPTURE_SOURCE_MODULE');
  if (!modulePath || !deps.loadSource) {
    io.out(
      'REFUSED: NO_CAPTURE_SOURCE: no capture source module is configured; a live benchmark cannot start.',
    );
    return EXIT.NO_SOURCE;
  }
  const source = await deps.loadSource(modulePath);
  // the source must be exactly the verified provider and model (the runner enforces it again)
  const startedAt = deps.now();
  const runId = `live-${a.stage}-${startedAt}`;
  const result = await runLiveBenchmark({
    tasks,
    pre,
    source,
    price: pr.price,
    runId,
    now: deps.now,
  });
  if (result.status === 'REFUSED') {
    io.out(`REFUSED by the runner: ${result.refusals.map((r) => `${r.code}`).join(', ')}`);
    return EXIT.REFUSED;
  }
  const { report } = runSuite(tasks, result.recordings);
  const results = evaluateThresholds(report, PROPOSED_THRESHOLDS);
  const card = buildScorecard(report, results);
  const approvals: EvidenceApprovals = {
    budgetRef: budget!.ref,
    budgetApprovedBy: budget!.approvedBy,
    thresholdsVersion: pre.thresholdsAccepted!.version,
    thresholdsAcceptedBy: pre.thresholdsAccepted!.acceptedBy,
    reviewers: reviewers.map((r) => r.name),
    securityReviewRef: pre.securityReview!.ref,
    confirmRef: approvalRef,
  };
  const record = buildEvidenceRecord({
    simulated: source.mode === 'mock',
    stage: a.stage,
    runId,
    status: result.status === 'COMPLETED' ? 'COMPLETED' : result.status,
    model: { adapterId: source.adapterId, model: source.model },
    providerEvidenceRef: source.mode === 'mock' ? null : pre.providerVerified!.evidenceRef,
    tasks,
    recordings: result.recordings,
    report,
    scorecard: card,
    thresholdResults: results,
    reportFingerprint: reportFingerprint(report),
    price: pr.price,
    priceSource: pr.source,
    maxCostMinor: plan.max.costMinor,
    approvals: source.mode === 'mock' ? null : approvals,
    startedAt,
    finishedAt: deps.now(),
    thresholdsVersion: THRESHOLDS_VERSION,
  });
  const problems = evidenceRecordProblems(record);
  io.out(
    `${source.mode === 'mock' ? '*** SIMULATED *** (the source declared itself a mock)\n' : ''}evidence record:\n${JSON.stringify(record, null, 2)}`,
  );
  if (problems.length > 0) io.err(`the evidence record is not acceptable: ${problems.join('; ')}`);
  if (result.status !== 'COMPLETED') {
    io.err(`the run stopped: ${result.status}${result.detail ? ` (${result.detail})` : ''}`);
    return EXIT.STOPPED;
  }
  if (problems.length > 0) return EXIT.STOPPED;
  return writeOut(a, record, io, deps);
}

/** the live-runner refusal code that already reports a stage prerequisite (so the same fact is not printed twice) */
function refusalOf(id: PrerequisiteId): string | null {
  return (
    (
      {
        FLAG_ON: 'FLAG_OFF',
        LIVE_GATE_OPEN: 'LIVE_GATE_CLOSED',
        ENVIRONMENT_NON_PRODUCTION: 'ENVIRONMENT_NOT_ALLOWED',
        PROVIDER_VERIFIED: 'PROVIDER_NOT_VERIFIED',
        THRESHOLDS_ACCEPTED: 'THRESHOLDS_NOT_ACCEPTED',
        BUDGET_APPROVED_FOR_STAGE: 'BUDGET_NOT_APPROVED',
        REVIEWERS_NAMED: 'REVIEWERS_NOT_NAMED',
        SECURITY_REVIEW_PASSED: 'SECURITY_REVIEW_MISSING',
        RATES_CONFIRMED: 'PRICE_CARD_INVALID',
      } as Partial<Record<PrerequisiteId, string>>
    )[id] ?? null
  );
}
