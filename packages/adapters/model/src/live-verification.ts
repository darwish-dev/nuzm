import { KIT_TOOLS } from './conformance';
import { assertLiveEvidence, LiveRunRefused } from './live-evidence';
import { applyFallbackPolicy, candidateKey, type FallbackPolicy } from './fallback';
import { PROBE_INPUT_ALLOWANCE, PROBE_PLAN, probeWorstCase, runCapabilityProbe } from './probe';
import { probeCost, tokenCostNano } from './probe-cost';
import { reconcileDiscovery } from './registry';
import {
  countsAgainstHealth,
  createResilience,
  retryDelayMs,
  type Clock,
  type Resilience,
  type RetryPolicy,
} from './resilience';
import {
  MODEL_CONTRACT_VERSION_1_1,
  ModelAdapterError,
  contractAtLeast,
  type CompleteRequest,
  type CompleteResponse,
  type ModelAdapter,
  type ModelErrorCode,
} from './types';

/**
 * The LIVE-VERIFICATION SUITE (S-AG4, Phase 2): ONE list of checks that runs against the MOCK TWIN now (every assertion, offline) and against the real adapter later, unchanged.
 * Nothing here is wired to a route or a job. The real-provider runner (`apps/api/src/modules/ai/live-verification/live-smoke.ts`) is sealed behind the gates below.
 *
 * What a result means (never blurred):
 *  - `evidence: 'live'`      the check was answered by a real provider in a run that passed every gate. Only such results can ever support a `LIVE-VERIFIED` claim.
 *  - `evidence: 'simulated'` the answer came from the mock twin, OR the behaviour is exercised by injecting faults on our side of the wire (retry, circuit breaker, fallback): a
 *                            real provider cannot be made to fail on demand, so those checks are SIMULATED even in a live run, and the report says so.
 *  - `ok: false, ran: false` the check did not run (a gate, a cap, a missing capability): NOT VERIFIED. The suite never converts a skipped check into a pass.
 *
 * Hard limits enforced here (not by the caller): refusal before anything is sent unless the approval covers the WORST CASE of the whole plan (requests, tokens AND money);
 * a running total stops the run before a request that could pass the cap; a credential/availability/rate-limit failure stops it at once; no check retries a real request;
 * a production process is always refused; a LIVE run additionally needs the provider in the live gate and the D2/D3/D4/D5/D6/D9 evidence rows.
 */
export type LiveCheckId =
  | 'capability_discovery'
  | 'streaming'
  | 'structured_output'
  | 'tool_calling'
  | 'cancel_mid_stream'
  | 'usage_reconciliation'
  | 'retry_and_breaker'
  | 'health'
  | 'fallback_routing';
export const LIVE_CHECK_IDS: readonly LiveCheckId[] = [
  'capability_discovery',
  'streaming',
  'structured_output',
  'tool_calling',
  'cancel_mid_stream',
  'usage_reconciliation',
  'retry_and_breaker',
  'health',
  'fallback_routing',
];

/** The request budget of the plan, besides the capability probe (which has its own, see `probe.ts`). `inputAllowance` covers a short prompt plus the system sentence. */
export const SUITE_EXTRA_INPUT_ALLOWANCE = 300;
export const SUITE_EXTRA_PLAN = [
  { id: 'streaming', maxTokens: 500 },
  { id: 'structured_output', maxTokens: 500 },
  { id: 'cancel_mid_stream', maxTokens: 300 },
  { id: 'recovery_after_retry', maxTokens: 100 },
  { id: 'half_open_trial', maxTokens: 100 },
] as const;

export function liveSuiteWorstCase(): {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  const p = probeWorstCase();
  const probeIn = PROBE_INPUT_ALLOWANCE * PROBE_PLAN.length;
  const extraOut = SUITE_EXTRA_PLAN.reduce((n, s) => n + s.maxTokens, 0);
  const extraIn = SUITE_EXTRA_INPUT_ALLOWANCE * SUITE_EXTRA_PLAN.length;
  return {
    requests: p.requests + SUITE_EXTRA_PLAN.length,
    inputTokens: probeIn + extraIn,
    outputTokens: p.totalTokens - probeIn + extraOut,
    totalTokens: p.totalTokens + extraOut + extraIn,
  };
}

/** What the owner approves for the run (D9): who, which reference, where, and the ceilings in requests, tokens and money. */
export interface LiveSuiteApproval {
  ref: string;
  approvedBy: string;
  environment: 'non-production';
  maxRequests: number;
  maxTotalTokens: number;
  /** nano units of the price currency, integer string: must cover the plan's worst case at the adapter's cost price */
  maxCostNano: string;
}

/** The vendor's own figure for the run (read by a human from the vendor console / usage report for the dedicated key and the run window). */
export interface VendorUsage {
  inputTokens: number;
  outputTokens: number;
  /** where the figure comes from, e.g. `console usage report, workspace nuzm-probe, 2026-12-01` (a label, never a key) */
  source: string;
}

export interface LiveTarget {
  adapter: ModelAdapter;
  model: string;
  /** `live`: a real provider; `mock`: the offline twin. The mode only decides the evidence label and which gates apply. */
  mode: 'live' | 'mock';
  /** an approved second provider/model for the fallback check (mock twin now; absent while only one provider is approved) */
  fallback?: { adapter: ModelAdapter; model: string };
  /** the vendor's figure for this run; without it usage reconciliation is NOT VERIFIED */
  vendorUsage?: () => Promise<VendorUsage | null>;
}
export interface LiveRunOptions {
  signal?: AbortSignal;
  now?: () => Date;
  /** how many tokens the vendor figure may differ from ours (default 0) */
  usageToleranceTokens?: number;
  /** live runs: the providers the environment lists as approved for live calls (`AI_LIVE_PROVIDERS`) */
  liveProviders?: readonly string[];
  /** live runs: the evidence rows (D2, D3, D4, D5, D6, D9) */
  evidence?: unknown;
  /** a policy to prove `approved_only` fallback with (default: only the listed fallback target is approved) */
  fallbackPolicy?: FallbackPolicy;
}

export interface LiveCheckResult {
  id: LiveCheckId;
  ok: boolean;
  ran: boolean;
  evidence: 'live' | 'simulated' | 'none';
  /** a fixed sentence: never a provider message, never content, never a key */
  detail: string;
  requests: number;
  tokensIn: number;
  tokensOut: number;
}
export interface LiveReport {
  adapterId: string;
  contractVersion: string;
  model: string;
  mode: 'live' | 'mock';
  approvalRef: string;
  startedAt: string;
  finishedAt: string;
  requests: number;
  totalTokens: number;
  /** cost of the REPORTED usage at the adapter's cost price, nano units, integer string */
  costNano: string;
  currency: string;
  stoppedEarly?:
    | 'token_cap'
    | 'request_cap'
    | 'cost_cap'
    | 'credential_or_availability'
    | 'rate_limited'
    | 'aborted';
  checks: LiveCheckResult[];
  /** what the reconciliation check needs, kept so a vendor figure that arrives LATER can still be checked (`reconcileLiveReport`) */
  usage: UsageLedger;
  /** true when the reported usage exceeded the approved token or money ceiling (a provider can report more than the allowance) */
  overran: boolean;
  /** true only when EVERY check ran and passed and every non-simulated-by-design check had live evidence */
  allPassed: boolean;
  scope: 'this model, this adapter build, these requests, this moment';
}

/** Token totals of a run: those the provider REPORTED, and the ceiling of the requests it may have billed although we hold no report for them (a cancelled stream, a failed call). */
export interface UsageLedger {
  reported: { in: number; out: number };
  unreportedCeiling: { in: number; out: number };
  reportedRequests: number;
}
const sumTokens = (rs: { in: number; out: number }[]) =>
  rs.reduce((a, r) => ({ in: a.in + r.in, out: a.out + r.out }), { in: 0, out: 0 });

/**
 * The reconciliation rule, pure. The vendor bills every request: the ones we hold a report for, plus (up to their ceilings) the ones we hold none for. A vendor figure BELOW our reported
 * total means we would charge for tokens that were not used; ABOVE the ceiling of everything we could not see means we under-report. Within the window: reconciled.
 */
export function decideUsageReconciliation(
  l: UsageLedger,
  v: VendorUsage | null,
  tol: number,
  label: 'live' | 'simulated',
): Pick<LiveCheckResult, 'id' | 'ok' | 'ran' | 'evidence' | 'detail'> {
  const id = 'usage_reconciliation' as const;
  if (
    l.reportedRequests === 0 ||
    !Number.isInteger(l.reported.in) ||
    !Number.isInteger(l.reported.out)
  )
    return {
      id,
      ok: false,
      ran: true,
      evidence: 'none',
      detail: 'no usable usage figures were reported by the provider',
    };
  if (!v)
    return {
      id,
      ok: false,
      ran: false,
      evidence: 'none',
      detail: `not verified: no vendor figure was supplied (our reported total: ${l.reported.in} in / ${l.reported.out} out)`,
    };
  const ok =
    v.inputTokens >= l.reported.in - tol &&
    v.inputTokens <= l.reported.in + l.unreportedCeiling.in + tol &&
    v.outputTokens >= l.reported.out - tol &&
    v.outputTokens <= l.reported.out + l.unreportedCeiling.out + tol;
  return {
    id,
    ok,
    ran: true,
    evidence: label,
    detail: ok
      ? `the vendor figure lies within our reported usage and the ceiling of the requests we hold no report for (tolerance ${tol} tokens; reported ${l.reported.in} in / ${l.reported.out} out; source: ${v.source})`
      : `the vendor figure is outside what our reports can explain (reported ${l.reported.in} in / ${l.reported.out} out; unreported ceiling ${l.unreportedCeiling.in} in / ${l.unreportedCeiling.out} out; vendor ${v.inputTokens} in / ${v.outputTokens} out; source: ${v.source})`,
  };
}

/**
 * A live run cannot know the vendor's figure at the end (the console's usage report lags). The operator reads it later for the run's window and calls this with the saved report: no
 * request is made, no key is read. Returns a NEW report whose reconciliation check and overall verdict are recomputed; the rest is untouched.
 */
export function reconcileLiveReport(r: LiveReport, v: VendorUsage, tol = 0): LiveReport {
  const label = r.mode === 'live' ? 'live' : 'simulated';
  const prev = r.checks.find((c) => c.id === 'usage_reconciliation');
  const next: LiveCheckResult = {
    requests: 0,
    tokensIn: 0,
    tokensOut: 0,
    ...decideUsageReconciliation(r.usage, v, tol, label),
  };
  const checks = r.checks.map((c) => (c.id === 'usage_reconciliation' ? next : c));
  void prev;
  return {
    ...r,
    checks,
    allPassed: checks.every((c) => c.ok && c.ran) && !r.stoppedEarly && !r.overran,
  };
}

export class LiveSuiteRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveSuiteRefused';
  }
}
const refuse = (m: string): never => {
  throw new LiveSuiteRefused(m);
};

/** The cost of the whole plan at a price: the number shown to the approver BEFORE approving. */
export function liveSuiteCost(p: {
  currency: string;
  inputPerMillion: string;
  outputPerMillion: string;
}) {
  const w = liveSuiteWorstCase();
  return {
    worst: w,
    maxNano: tokenCostNano(w.inputTokens, w.outputTokens, p).toString(),
    ceilingAllOutputNano: tokenCostNano(0, w.totalTokens, p).toString(),
    probeOnly: probeCost(p),
  };
}

/** What a run may use at most: requests and tokens (input and output apart, so the money bound can be computed at the adapter's price). */
export interface WorstCase {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * The gates every live run shares (the suite and the three qualification tracks): refuses unless the target and approval are in order and cover `w` in requests, tokens AND money, and
 * (for a live target) the live gate and the D2/D3/D4/D5/D6/D9 evidence stand. Pure: reads nothing, sends nothing.
 */
export function assertRunAllowed(
  t: Pick<LiveTarget, 'adapter' | 'model' | 'mode'>,
  approval: LiveSuiteApproval | undefined,
  w: WorstCase,
  o: LiveRunOptions = {},
): void {
  if (process.env.NODE_ENV === 'production')
    refuse('a live verification never runs in a production process');
  if (!approval) refuse('a recorded approval is required (D9)');
  const a = approval as LiveSuiteApproval;
  if (typeof a.ref !== 'string' || a.ref.length < 3 || a.ref.length > 200)
    refuse('the approval needs a reference (3-200 characters)');
  if (typeof a.approvedBy !== 'string' || a.approvedBy.trim().length === 0)
    refuse('the approval needs the name of the approver');
  if (a.environment !== 'non-production')
    refuse('a live verification runs in a non-production environment only');
  if (!Number.isInteger(a.maxRequests) || a.maxRequests < w.requests)
    refuse(`the approval must allow at least ${w.requests} requests`);
  if (!Number.isInteger(a.maxTotalTokens) || a.maxTotalTokens < w.totalTokens)
    refuse(`the approved token cap must cover the worst case (${w.totalTokens} tokens)`);
  if (typeof a.maxCostNano !== 'string' || !/^\d{1,18}$/.test(a.maxCostNano))
    refuse('the approval needs a money ceiling (maxCostNano)');
  const need = tokenCostNano(w.inputTokens, w.outputTokens, t.adapter.pricing);
  if (BigInt(a.maxCostNano) < need)
    refuse(`the approved money ceiling is below the worst case of the plan`);
  if (!t.adapter.models().some((m) => m.modelId === t.model)) refuse('unknown model');
  if (t.mode === 'live') {
    if (!o.liveProviders?.includes(t.adapter.id))
      refuse(
        'this provider is not approved for live calls in this environment (AI_LIVE_PROVIDERS, D3)',
      );
    try {
      assertLiveEvidence(o.evidence, { provider: t.adapter.id });
    } catch (e) {
      if (e instanceof LiveRunRefused) refuse(e.message);
      throw e;
    }
  }
}

/** Refuses unless the target and approval are in order for the nine-check suite. Pure: reads nothing, sends nothing. */
export function assertLiveSuiteAllowed(
  t: LiveTarget,
  approval: LiveSuiteApproval | undefined,
  o: LiveRunOptions = {},
): void {
  assertRunAllowed(t, approval, liveSuiteWorstCase(), o);
}

// ───────────────────────────── fault injection (OUR side of the wire) ─────────────────────────────

/** Wraps an adapter so that a scripted fault is thrown BEFORE the call is delegated: nothing is sent to the provider for a faulted attempt. */
export class FaultInjectingAdapter implements ModelAdapter {
  readonly kind = 'model' as const;
  readonly contractVersion: string;
  readonly id: string;
  readonly region: string;
  readonly dataTerms: ModelAdapter['dataTerms'];
  readonly pricing: ModelAdapter['pricing'];
  /** attempts made through this wrapper, and how many were delegated (reached the inner adapter) */
  attempts = 0;
  delegated = 0;
  private plan: (ModelAdapterError | null)[] = [];
  private always: ModelAdapterError | null = null;
  constructor(private readonly inner: ModelAdapter) {
    this.contractVersion = inner.contractVersion;
    this.id = inner.id;
    this.region = inner.region;
    this.dataTerms = inner.dataTerms;
    this.pricing = inner.pricing;
  }
  /** the next attempts fail with these errors in order (`null` = let that attempt through) */
  script(...faults: (ModelAdapterError | null)[]): void {
    this.plan = faults;
  }
  /** every attempt fails with this error until cleared with `null` */
  failAlways(e: ModelAdapterError | null): void {
    this.always = e;
  }
  models() {
    return this.inner.models();
  }
  tokenCount(model: string, messages: Parameters<ModelAdapter['tokenCount']>[1]) {
    return this.inner.tokenCount(model, messages);
  }
  private gate(): void {
    this.attempts += 1;
    const next = this.plan.length ? this.plan.shift()! : this.always;
    if (next) throw next;
    this.delegated += 1;
  }
  async complete(ctx: Parameters<ModelAdapter['complete']>[0], req: CompleteRequest) {
    this.gate();
    return this.inner.complete(ctx, req);
  }
  stream(ctx: Parameters<ModelAdapter['stream']>[0], req: CompleteRequest) {
    this.gate();
    return this.inner.stream(ctx, req);
  }
}

export interface Candidate {
  /** `provider/model` */
  key: string;
  providerCode: string;
  modelId: string;
  adapter: ModelAdapter;
}
export interface InvokeOutcome {
  ok: boolean;
  response?: CompleteResponse;
  /** the candidate that answered */
  via?: string;
  /** attempts per candidate key, in the order they were tried */
  attempts: { key: string; n: number; skipped?: 'circuit_open' }[];
  error?: ModelAdapterError;
  /** attempts that spoke about the provider's health (an independent count to check the monitor against) */
  healthOk: number;
  healthFail: number;
}

/**
 * The gateway's per-candidate loop in miniature, built from the same primitives (retry policy, per-provider circuit, health monitor), so the suite can show the behaviour against
 * ANY adapter without a database. The real gateway is exercised by `resilience.int.spec.ts`; this keeps the two honest by asserting the same properties.
 */
export async function resilientInvoke(
  res: Resilience,
  candidates: readonly Candidate[],
  req: Omit<CompleteRequest, 'model'>,
  ctxId: string,
  clock: { now(): number } = { now: Date.now },
): Promise<InvokeOutcome> {
  const attempts: InvokeOutcome['attempts'] = [];
  let last: ModelAdapterError | undefined;
  let healthOk = 0;
  let healthFail = 0;
  for (const c of candidates) {
    if (!res.breaker.acquire(c.providerCode)) {
      attempts.push({ key: c.key, n: 0, skipped: 'circuit_open' });
      last = new ModelAdapterError('unavailable', 'the provider is paused (circuit open)', false);
      continue;
    }
    let n = 0;
    for (;;) {
      n += 1;
      const t0 = clock.now();
      try {
        const response = await c.adapter.complete(
          { callId: `${ctxId}:${c.key}:${n}` },
          { ...req, model: c.modelId },
        );
        res.breaker.success(c.providerCode);
        res.health.recordSuccess(c.providerCode, clock.now() - t0);
        healthOk += 1;
        attempts.push({ key: c.key, n });
        return { ok: true, response, via: c.key, attempts, healthOk, healthFail };
      } catch (e) {
        const err =
          e instanceof ModelAdapterError ? e : new ModelAdapterError('unavailable', 'unexpected');
        last = err;
        res.breaker.failure(c.providerCode, err.code);
        res.health.recordFailure(c.providerCode, err.code, clock.now() - t0);
        if (countsAgainstHealth(err.code)) healthFail += 1;
        const wait =
          res.breaker.state(c.providerCode) === 'open'
            ? null
            : retryDelayMs(res.retry, n, err, () => 0);
        if (wait === null) break;
      }
    }
    attempts.push({ key: c.key, n });
  }
  return { ok: false, attempts, healthOk, healthFail, ...(last ? { error: last } : {}) };
}

// ───────────────────────────── the runner ─────────────────────────────

const msg = (text: string) => [{ role: 'user' as const, content: text }];

export async function runLiveVerification(
  target: LiveTarget,
  approval: LiveSuiteApproval,
  opts: LiveRunOptions = {},
): Promise<LiveReport> {
  assertLiveSuiteAllowed(target, approval, opts);
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const { adapter, model } = target;
  const live = target.mode === 'live';
  const realEvidence: 'live' | 'simulated' = live ? 'live' : 'simulated';
  const price = adapter.pricing;
  const results = new Map<LiveCheckId, LiveCheckResult>();
  let requests = 0;
  let inTotal = 0;
  let outTotal = 0;
  let stopped: LiveReport['stoppedEarly'];
  const maxCost = BigInt(approval.maxCostNano);
  const reported: { in: number; out: number }[] = [];
  /** requests the vendor may have billed although we hold no reported usage for them (a cancelled stream, a failed call): at their ceilings */
  const unreported = { in: 0, out: 0 };
  const clockState = { t: 1_000_000 };
  const fake: Clock = { now: () => clockState.t };
  const res = createResilience({
    retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitter: 'none' },
    breaker: { failureThreshold: 3, openMs: 1_000, halfOpenMaxProbes: 1 },
    health: { windowMs: 3_600_000, minSamples: 5, maxSamples: 200 },
    clock: fake,
  });
  const key = adapter.id;
  const set = (
    r: Omit<LiveCheckResult, 'requests' | 'tokensIn' | 'tokensOut'> &
      Partial<Pick<LiveCheckResult, 'requests' | 'tokensIn' | 'tokensOut'>>,
  ) => void results.set(r.id, { requests: 0, tokensIn: 0, tokensOut: 0, ...r });
  const notRun = (id: LiveCheckId, detail: string) =>
    set({ id, ok: false, ran: false, evidence: 'none', detail });

  // ---- budget: every real request is reserved at its ceiling BEFORE it is sent
  const costNow = () => tokenCostNano(inTotal, outTotal, price);
  const reserve = (maxOut: number, allowIn: number): boolean => {
    if (stopped) return false;
    if (requests + 1 > approval.maxRequests) {
      stopped = 'request_cap';
      return false;
    }
    if (inTotal + outTotal + maxOut + allowIn > approval.maxTotalTokens) {
      stopped = 'token_cap';
      return false;
    }
    if (costNow() + tokenCostNano(allowIn, maxOut, price) > maxCost) {
      stopped = 'cost_cap';
      return false;
    }
    if (opts.signal?.aborted) {
      stopped = 'aborted';
      return false;
    }
    return true;
  };
  const account = (
    u: { inputTokens: number; outputTokens: number } | null,
    maxOut: number,
    allowIn: number,
  ) => {
    // an unreported count is charged at the ceiling: the cap stays honest
    const i = u?.inputTokens ?? allowIn;
    const o = u?.outputTokens ?? maxOut;
    inTotal += i;
    outTotal += o;
    requests += 1;
    if (u) reported.push({ in: u.inputTokens, out: u.outputTokens });
    else {
      unreported.in += allowIn;
      unreported.out += maxOut;
    }
    return { i, o };
  };
  const failStop = (code: ModelErrorCode) => {
    if (code === 'rate_limited') stopped = 'rate_limited';
    else if (code === 'aborted' && opts.signal?.aborted) stopped = 'aborted';
    else if (code !== 'invalid_response' && code !== 'unsupported_capability')
      stopped = 'credential_or_availability';
  };
  const codeOf = (e: unknown): ModelErrorCode =>
    e instanceof ModelAdapterError ? e.code : 'unavailable';
  const tally = { ok: 0, fail: 0 };
  const noteFailure = (code: ModelErrorCode, t0: number) => {
    res.health.recordFailure(key, code, Date.now() - t0);
    if (countsAgainstHealth(code)) tally.fail += 1;
  };
  const timed = async <T>(fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      const v = await fn();
      res.health.recordSuccess(key, Date.now() - t0);
      tally.ok += 1;
      return v;
    } catch (e) {
      noteFailure(codeOf(e), t0);
      throw e;
    }
  };
  const base = (
    task: string,
    text: string,
    maxTokens: number,
    extra: Partial<CompleteRequest> = {},
  ): CompleteRequest => ({
    model,
    messages: msg(text),
    maxTokens,
    task,
    ...extra,
  });
  const ctx = (id: string, signal?: AbortSignal) => ({
    callId: `live-${id}`,
    ...(signal ? { signal } : {}),
  });
  const A = SUITE_EXTRA_INPUT_ALLOWANCE;

  // 1 ───── capability discovery: what the adapter declares, and (when it can) what the vendor's listing confirms
  {
    const declared = adapter.models();
    const hasModel = declared.some((m) => m.modelId === model);
    let detail = hasModel ? 'the model is declared by the adapter' : 'the model is not declared';
    let ok = hasModel && declared.every((m) => m.contextTokens > 0 && m.maxOutputTokens > 0);
    if (ok && adapter.discoverModels) {
      try {
        const rec = reconcileDiscovery(
          declared,
          await adapter.discoverModels(ctx('discover', opts.signal)),
        );
        const confirmed = rec.confirmed.includes(model);
        ok = confirmed;
        detail = confirmed
          ? 'the declared model is confirmed by the provider listing (a listing is not capability evidence)'
          : 'the provider listing does not confirm the declared model';
      } catch (e) {
        ok = false;
        detail = `the provider listing failed (${codeOf(e)})`;
        failStop(codeOf(e));
      }
    } else if (ok)
      detail = `${detail}; the adapter has no listing endpoint, so nothing was confirmed by the provider`;
    set({
      id: 'capability_discovery',
      ok,
      ran: true,
      evidence: adapter.discoverModels ? realEvidence : 'none',
      detail,
    });
  }

  // 2 ───── streaming: chunks arrive, assemble to text, end with a done chunk that reports usage
  if (reserve(500, A)) {
    const o = SUITE_EXTRA_PLAN[0].maxTokens;
    const t0 = Date.now();
    try {
      const chunks: string[] = [];
      let usage: CompleteResponse['usage'] = null;
      let finish = '';
      for await (const c of adapter.stream(
        ctx('stream', opts.signal),
        base('live:streaming', 'Reply with exactly the word: ok', o),
      )) {
        if ('delta' in c) chunks.push(c.delta);
        if ('done' in c) {
          usage = c.usage;
          finish = c.finishReason;
        }
      }
      res.health.recordSuccess(key, Date.now() - t0);
      tally.ok += 1;
      const a = account(usage, o, A);
      const text = chunks.join('');
      const ok =
        chunks.length >= 1 && text.trim().length > 0 && finish === 'stop' && usage !== null;
      set({
        id: 'streaming',
        ok,
        ran: true,
        evidence: realEvidence,
        detail: ok
          ? 'the stream delivered text, ended with a stop and reported usage'
          : finish === 'length'
            ? 'the stream ended at the output ceiling before any answer (inconclusive: raise the ceiling)'
            : 'the stream did not deliver text, a stop, and usage',
        requests: 1,
        tokensIn: a.i,
        tokensOut: a.o,
      });
    } catch (e) {
      noteFailure(codeOf(e), t0);
      const a = account(null, o, A);
      set({
        id: 'streaming',
        ok: false,
        ran: true,
        evidence: realEvidence,
        detail: `the stream failed (${codeOf(e)})`,
        requests: 1,
        tokensIn: a.i,
        tokensOut: a.o,
      });
      failStop(codeOf(e));
    }
  } else notRun('streaming', 'not run: a cap or a stop was reached first');

  // 3 ───── structured output: a JSON object that parses, with finish `stop`
  if (reserve(500, A)) {
    const o = SUITE_EXTRA_PLAN[1].maxTokens;
    try {
      const r = await timed(() =>
        adapter.complete(
          ctx('structured', opts.signal),
          base(
            'live:structured',
            'Return a JSON object with one key "ok" whose value is true.',
            o,
            { responseFormat: 'json' },
          ),
        ),
      );
      const a = account(r.usage, o, A);
      let ok = false;
      try {
        const v = JSON.parse(r.text.trim()) as unknown;
        ok =
          typeof v === 'object' &&
          v !== null &&
          !Array.isArray(v) &&
          (v as { ok?: unknown }).ok === true &&
          r.finishReason === 'stop';
      } catch {
        ok = false;
      }
      set({
        id: 'structured_output',
        ok,
        ran: true,
        evidence: realEvidence,
        detail: ok
          ? 'the answer was a JSON object that parses'
          : r.finishReason === 'length'
            ? 'the answer was cut at the ceiling (inconclusive)'
            : 'the answer did not parse as the requested JSON object',
        requests: 1,
        tokensIn: a.i,
        tokensOut: a.o,
      });
    } catch (e) {
      const a = account(null, o, A);
      set({
        id: 'structured_output',
        ok: false,
        ran: true,
        evidence: realEvidence,
        detail: `the request failed (${codeOf(e)})`,
        requests: 1,
        tokensIn: a.i,
        tokensOut: a.o,
      });
      failStop(codeOf(e));
    }
  } else notRun('structured_output', 'not run: a cap or a stop was reached first');

  // 4 ───── tool calling (+ the probe's cancelled stream): the capability probe, only for a contract-1.1 adapter that declares tool-use
  const declared = adapter.models().find((m) => m.modelId === model);
  const canProbe =
    !!declared &&
    contractAtLeast(adapter.contractVersion, MODEL_CONTRACT_VERSION_1_1) &&
    declared.capabilities.includes('tool-use');
  const probeW = probeWorstCase();
  let probeCancel: LiveCheckResult | undefined;
  if (!canProbe) {
    notRun(
      'tool_calling',
      'not run: the adapter build is on contract 1.0 or the model declares no tool-use (unknown = unsupported)',
    );
  } else if (
    !stopped &&
    requests + probeW.requests <= approval.maxRequests &&
    inTotal + outTotal + probeW.totalTokens <= approval.maxTotalTokens &&
    costNow() +
      tokenCostNano(
        PROBE_INPUT_ALLOWANCE * PROBE_PLAN.length,
        probeW.totalTokens - PROBE_INPUT_ALLOWANCE * PROBE_PLAN.length,
        price,
      ) <=
      maxCost
  ) {
    const rep = await runCapabilityProbe(
      adapter,
      model,
      {
        ref: approval.ref,
        approvedBy: approval.approvedBy,
        environment: 'non-production',
        maxRequests: approval.maxRequests - requests,
        maxTotalTokens: approval.maxTotalTokens - inTotal - outTotal,
      },
      { ...(opts.signal ? { signal: opts.signal } : {}), now },
    );
    // the probe accounts its own tokens (an unreported count at the allowance); fold them in
    const pin = rep.observations.reduce((n, x) => n + x.tokensIn, 0);
    const pout = rep.observations.reduce((n, x) => n + x.tokensOut, 0);
    inTotal += pin;
    outTotal += pout;
    requests += rep.requests;
    for (const x of rep.observations) {
      if (!x.ran) continue;
      // a cancelled stream and a failed request carry no usage report: the vendor may still have billed them, up to their ceilings
      if (x.id === 'cancelled_stream' || x.errorCode) {
        unreported.in += x.tokensIn;
        unreported.out += x.tokensOut;
      } else reported.push({ in: x.tokensIn, out: x.tokensOut });
    }
    const ok = rep.capabilities['tool-use'] === 'VERIFIED' && !rep.stoppedEarly;
    set({
      id: 'tool_calling',
      ok,
      ran: true,
      evidence: realEvidence,
      detail: ok
        ? `the probe verified tool-use (${rep.capabilities['parallel-tool-calls'] === 'VERIFIED' ? 'parallel calls verified' : 'parallel calls NOT verified'}; ${rep.capabilities['streaming-tool-calls'] === 'VERIFIED' ? 'streamed calls verified' : 'streamed calls NOT verified'})`
        : `the probe did not verify tool-use${rep.stoppedEarly ? ` (stopped: ${rep.stoppedEarly})` : ''}`,
      requests: rep.requests,
      tokensIn: pin,
      tokensOut: pout,
    });
    const c = rep.observations.find((x) => x.id === 'cancelled_stream');
    if (c?.ran)
      probeCancel = {
        id: 'cancel_mid_stream',
        ok: c.ok,
        ran: true,
        evidence: realEvidence,
        detail: c.detail,
        requests: 0,
        tokensIn: 0,
        tokensOut: 0,
      };
    if (rep.stoppedEarly === 'rate_limited') stopped = 'rate_limited';
    else if (rep.stoppedEarly === 'credential_or_availability')
      stopped = 'credential_or_availability';
    else if (rep.stoppedEarly === 'aborted') stopped = 'aborted';
  } else {
    if (!stopped) {
      const probeIn = PROBE_INPUT_ALLOWANCE * PROBE_PLAN.length;
      if (requests + probeW.requests > approval.maxRequests) stopped = 'request_cap';
      else if (inTotal + outTotal + probeW.totalTokens > approval.maxTotalTokens)
        stopped = 'token_cap';
      else if (costNow() + tokenCostNano(probeIn, probeW.totalTokens - probeIn, price) > maxCost)
        stopped = 'cost_cap';
    }
    notRun('tool_calling', 'not run: a cap or a stop was reached first');
  }

  // 5 ───── cancellation in the middle of a stream (taken from the probe when it ran, else its own request)
  if (probeCancel) set(probeCancel);
  else if (reserve(300, A)) {
    const o = SUITE_EXTRA_PLAN[2].maxTokens;
    const ac = new AbortController();
    opts.signal?.addEventListener('abort', () => ac.abort(), { once: true });
    let chunks = 0;
    let code: string | undefined;
    try {
      for await (const _c of adapter.stream(
        ctx('cancel', ac.signal),
        base('live:cancel', 'Write the numbers one to fifty in words, one per line.', o),
      )) {
        void _c;
        chunks += 1;
        if (chunks === 2) ac.abort();
        if (chunks > 200) break; // a stream that ignores cancellation is the failure being looked for
      }
    } catch (e) {
      code = codeOf(e);
    }
    const a = account(null, o, A);
    const ok = code === 'aborted' && chunks < 200;
    set({
      id: 'cancel_mid_stream',
      ok,
      ran: true,
      evidence: realEvidence,
      detail: ok
        ? 'the stream stopped when cancelled'
        : 'the stream did not stop with the cancellation',
      requests: 1,
      tokensIn: a.i,
      tokensOut: a.o,
    });
  } else notRun('cancel_mid_stream', 'not run: a cap or a stop was reached first');

  // 6 ───── retry and circuit breaker: faults are injected on OUR side; the recovery requests are real
  {
    const fi = new FaultInjectingAdapter(adapter);
    const cand: Candidate[] = [
      { key: `${key}/${model}`, providerCode: key, modelId: model, adapter: fi },
    ];
    const pass: string[] = [];
    const fail: string[] = [];
    const check = (name: string, c: boolean) => (c ? pass : fail).push(name);
    const tx = (code: ModelErrorCode, retryable?: boolean) =>
      new ModelAdapterError(code, 'injected fault', retryable);
    const pingReq = (maxOut: number): Omit<CompleteRequest, 'model'> => ({
      messages: msg('Reply with exactly the word: ok'),
      maxTokens: maxOut,
      task: 'live:ping',
    });
    const count = (r: InvokeOutcome) => {
      tally.ok += r.healthOk;
      tally.fail += r.healthFail;
      return r;
    };
    const settle = (before: number, r: InvokeOutcome, maxOut: number) => {
      const n = fi.delegated - before;
      for (let k = 0; k < n; k++)
        account(k === n - 1 && r.response ? r.response.usage : null, maxOut, A);
      if (!r.ok && n > 0 && r.error) failStop(r.error.code);
    };
    const o = SUITE_EXTRA_PLAN[3].maxTokens;
    // (a) a transient fault, then a REAL request: one retry, answered
    if (reserve(o, A)) {
      const before = fi.delegated;
      fi.script(tx('unavailable'), null);
      const r1 = count(await resilientInvoke(res, cand, pingReq(o), 'retry-a', fake));
      settle(before, r1, o);
      check(
        'a transient fault is retried once and then answered',
        r1.ok && r1.attempts[0]?.n === 2 && fi.delegated - before === 1,
      );
    } else fail.push('the recovery request was not run (cap)');
    // (b) non-retryable faults are not retried (no hidden retry): a bad request and a spending limit
    fi.script(tx('invalid_request', false));
    const r2 = count(await resilientInvoke(res, cand, pingReq(o), 'retry-b', fake));
    check('a non-retryable fault is not retried', !r2.ok && r2.attempts[0]?.n === 1);
    fi.script(tx('rate_limited', false));
    const r3 = count(await resilientInvoke(res, cand, pingReq(o), 'retry-c', fake));
    check(
      'a spending-limit style rate_limited that is not retryable is not retried',
      !r3.ok && r3.attempts[0]?.n === 1,
    );
    // (c) consecutive health failures open the circuit; an open circuit refuses WITHOUT calling the provider
    res.breaker.reset(key);
    fi.failAlways(tx('unavailable'));
    const before = fi.attempts;
    let guard = 0;
    while (res.breaker.state(key) !== 'open' && guard++ < 10)
      count(await resilientInvoke(res, cand, pingReq(o), `open-${guard}`, fake));
    check('repeated failures open the circuit', res.breaker.state(key) === 'open');
    const attemptsAtOpen = fi.attempts;
    const r4 = count(await resilientInvoke(res, cand, pingReq(o), 'refused', fake));
    check(
      'an open circuit refuses without calling the provider',
      !r4.ok &&
        r4.attempts[0]?.skipped === 'circuit_open' &&
        fi.attempts === attemptsAtOpen &&
        attemptsAtOpen > before,
    );
    // (d) after the open period ONE trial goes out (a REAL request); success closes the circuit
    fi.failAlways(null);
    clockState.t += 1_001;
    check(
      'after the open period the circuit offers a single trial',
      res.breaker.state(key) === 'half_open',
    );
    if (reserve(SUITE_EXTRA_PLAN[4].maxTokens, A)) {
      const before = fi.delegated;
      const r5 = count(
        await resilientInvoke(res, cand, pingReq(SUITE_EXTRA_PLAN[4].maxTokens), 'trial', fake),
      );
      settle(before, r5, SUITE_EXTRA_PLAN[4].maxTokens);
      check('a successful trial closes the circuit', r5.ok && res.breaker.state(key) === 'closed');
    } else fail.push('the half-open trial was not run (cap)');
    set({
      id: 'retry_and_breaker',
      ok: fail.length === 0,
      ran: true,
      // fault injection is ours: even against a real provider this cannot be live evidence of the PROVIDER's behaviour under failure
      evidence: 'simulated',
      detail:
        fail.length === 0
          ? `all ${pass.length} retry and circuit properties held (faults injected on our side; recovery requests were ${live ? 'real' : 'mock'})`
          : `not held: ${fail.join('; ')}`,
    });
  }

  // 7 ───── health: the monitor's arithmetic must match an independent count of the same outcomes
  {
    const snap = res.health.snapshot(key);
    const total = tally.ok + tally.fail;
    const ok =
      snap.samples === total &&
      snap.samples >= 5 &&
      snap.successPerMille === Math.floor((tally.ok * 1000) / total) &&
      snap.p50LatencyMs !== null &&
      snap.p95LatencyMs !== null &&
      snap.p50LatencyMs <= snap.p95LatencyMs &&
      snap.status !== 'unknown' &&
      snap.lastErrorCode !== null &&
      snap.lastSuccessAt !== null;
    set({
      id: 'health',
      ok,
      ran: true,
      evidence: realEvidence,
      detail: ok
        ? `the monitor reports ${snap.samples} samples, ${snap.successPerMille} per mille ok, status ${snap.status}, breaker ${snap.breaker}, matching an independent count`
        : 'the health snapshot is incomplete or does not match an independent count',
    });
  }

  // 8 ───── approved fallback routing: the primary fails, ONLY an approved candidate stands in, an unapproved one is never called
  {
    const primaryInner = adapter;
    const primary = new FaultInjectingAdapter(primaryInner);
    const fb = target.fallback ? new FaultInjectingAdapter(target.fallback.adapter) : undefined;
    const rogue = new FaultInjectingAdapter(adapter); // stands for a candidate nobody approved: it must never be reached
    const fbKey = target.fallback
      ? `${target.fallback.adapter.id}/${target.fallback.model}`
      : undefined;
    const priKey = `${adapter.id}/${model}`;
    const ranked = [
      { providerCode: adapter.id, modelId: model, adapter: primary },
      { providerCode: 'unapproved', modelId: 'rogue-1', adapter: rogue },
      ...(target.fallback && fbKey
        ? [
            {
              providerCode: target.fallback.adapter.id,
              modelId: target.fallback.model,
              adapter: fb!,
            },
          ]
        : []),
    ];
    const policy: FallbackPolicy = opts.fallbackPolicy ?? {
      mode: 'approved_only',
      approved: fbKey ? { [priKey]: [fbKey] } : {},
    };
    const allowed = applyFallbackPolicy(ranked, policy);
    const cands: Candidate[] = allowed.map((c) => ({
      key: candidateKey(c),
      providerCode: c.providerCode,
      modelId: c.modelId,
      adapter: c.adapter,
    }));
    const pass: string[] = [];
    const fail: string[] = [];
    const check = (name: string, c: boolean) => (c ? pass : fail).push(name);
    check(
      'an unapproved candidate is removed from the route',
      !cands.some((c) => c.providerCode === 'unapproved'),
    );
    primary.failAlways(new ModelAdapterError('unavailable', 'injected fault'));
    const res2 = createResilience({
      retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: 'none' },
      breaker: { failureThreshold: 5 },
      clock: fake,
    });
    const out = await resilientInvoke(
      res2,
      cands,
      { messages: msg('Reply with exactly the word: ok'), maxTokens: 50, task: 'live:fallback' },
      'fallback',
      fake,
    );
    if (target.fallback && fbKey) {
      if (out.response) {
        // the stand-in is the approved second target: when it is a MOCK it costs nothing; a real one is counted
        if (target.fallback.adapter !== adapter && live) account(out.response.usage, 50, A);
      }
      check('the approved fallback answered when the primary failed', out.ok && out.via === fbKey);
    } else {
      check(
        'with no approved fallback the call fails cleanly instead of going elsewhere',
        !out.ok && out.attempts.length === 1,
      );
    }
    check('the unapproved candidate was never called', rogue.attempts === 0);
    set({
      id: 'fallback_routing',
      ok: fail.length === 0,
      ran: true,
      evidence: 'simulated',
      detail:
        fail.length === 0
          ? `all ${pass.length} fallback properties held (primary failure injected on our side${target.fallback ? '' : '; no second provider is approved, so only the refusal path was exercised'})`
          : `not held: ${fail.join('; ')}`,
    });
  }

  // 9 ───── usage and token accounting reconciliation against the vendor's own figure (a live run usually has none yet: the vendor's report lags; see `reconcileLiveReport`)
  {
    const v = target.vendorUsage ? await target.vendorUsage() : null;
    set({
      requests: 0,
      tokensIn: 0,
      tokensOut: 0,
      ...decideUsageReconciliation(
        {
          reported: sumTokens(reported),
          unreportedCeiling: { ...unreported },
          reportedRequests: reported.length,
        },
        v,
        opts.usageToleranceTokens ?? 0,
        realEvidence,
      ),
    });
  }

  // a provider may report more than the allowance (tool schemas, system overhead): that is reported, never hidden, and a run that overran is not a clean pass
  const overran = inTotal + outTotal > approval.maxTotalTokens || costNow() > maxCost;
  const ordered = LIVE_CHECK_IDS.map(
    (id) =>
      results.get(id) ?? {
        id,
        ok: false,
        ran: false,
        evidence: 'none' as const,
        detail: 'not run',
        requests: 0,
        tokensIn: 0,
        tokensOut: 0,
      },
  );
  return {
    adapterId: adapter.id,
    contractVersion: adapter.contractVersion,
    model,
    mode: target.mode,
    approvalRef: approval.ref,
    startedAt,
    finishedAt: now().toISOString(),
    requests,
    totalTokens: inTotal + outTotal,
    costNano: costNow().toString(),
    currency: price.currency,
    ...(stopped ? { stoppedEarly: stopped } : {}),
    checks: ordered,
    usage: {
      reported: sumTokens(reported),
      unreportedCeiling: { ...unreported },
      reportedRequests: reported.length,
    },
    overran,
    allPassed: ordered.every((c) => c.ok && c.ran) && !stopped && !overran,
    scope: 'this model, this adapter build, these requests, this moment',
  };
}

export { KIT_TOOLS as LIVE_TOOLS };
export type { RetryPolicy };
