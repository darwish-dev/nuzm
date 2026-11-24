import {
  AnthropicModelAdapter,
  CLAUDE_MODEL_ID,
  CLAUDE_PROVIDER_ID,
  LIVE_REQUIRED_DECISIONS,
  assessLiveEvidence,
  liveSuiteCost,
  liveSuiteWorstCase,
  tokenCostNano,
  type WorstCase,
  reconcileLiveReport,
  runLiveVerification,
  type LiveReport,
  type LiveSuiteApproval,
  type LiveTarget,
  type ModelAdapter,
  type VendorUsage,
} from '@nuzm/adapter-model';
import { loadAiConfig } from './model';

/**
 * The real-provider SMOKE RUNNER (S-AG4, Phase 2). It is a wrapper around `runLiveVerification` that adds the gates an operator-run script needs and that are checked BEFORE the
 * key is read. By default it is a DRY RUN: it evaluates every gate, prints the plan and the worst-case cost, and sends nothing. A real run needs `execute: true` AND every gate.
 *
 * Gates (all must hold; all are listed when they do not, so the operator can fix them in one pass):
 *  1. the provider is `claude` (OpenAI and Gemini are contracts and fixtures only, D11);
 *  2. not a production process (the production vault is not decided, D-12);
 *  3. the provider is in `AI_LIVE_PROVIDERS` (D3);
 *  4. the run is approved: an entry of `AI_PROBE_APPROVALS` with the same reference exists (D9), and the approval file's caps do not exceed that entry's;
 *  5. the approval covers the WORST CASE of the whole plan in requests, tokens and money;
 *  6. the evidence rows for D2, D3, D4, D5, D6 and D9 are present and standing (`live-evidence`);
 *  7. the credential is a reference into the DEV vault (`vault://dev/ai-…`): a key is never an argument, an environment variable or a file of this script.
 * The key is read from the sealed store only after every gate passed, handed to the adapter, and never printed, returned or written: the report is checked for it before it is saved.
 */
export interface SmokeArgs {
  /** default false: a dry run */
  execute: boolean;
  provider: string;
  vaultRef: string | undefined;
  /** the parsed approval file (untrusted JSON) */
  approval: unknown;
  /** the parsed evidence file (untrusted JSON) */
  evidence: unknown;
  /** the parsed vendor-usage file, when the operator has the vendor's figure for the window */
  vendorUsage?: unknown;
  /** tokens the vendor figure may differ by (default 0) */
  usageToleranceTokens?: number;
}
export interface SmokeDeps {
  env: NodeJS.ProcessEnv;
  /** reads the sealed key; only ever called after the gates passed and `execute` is true */
  readKey: (vaultRef: string) => Promise<string>;
  /** builds the adapter; injected so tests never construct a real client */
  makeAdapter?: (getApiKey: () => Promise<string | null>) => ModelAdapter;
  /** tests only: the model to run (default the Claude model of the adapter) */
  model?: string;
  now?: () => Date;
}
export type SmokeResult =
  | { kind: 'refused'; problems: string[] }
  | { kind: 'dry_run'; plan: SmokePlan }
  | { kind: 'ran'; report: LiveReport };
export interface SmokePlan {
  provider: string;
  model: string;
  worstCase: ReturnType<typeof liveSuiteWorstCase>;
  /** nano USD, integer strings */
  maxCostNano: string;
  ceilingAllOutputNano: string;
  priceSource: string;
  decisionsStanding: string[];
  message: string;
}

const VAULT_REF = /^vault:\/\/dev\/ai-[a-z0-9-]{1,60}$/;
const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/** The gates, pure: reads nothing, sends nothing. Returns the problems (empty = all hold) and, when they hold, the parsed approval. */
export function evaluateSmokeGates(
  a: SmokeArgs,
  env: NodeJS.ProcessEnv,
  adapter: Pick<ModelAdapter, 'id' | 'pricing' | 'models'>,
  now: Date = new Date(),
  /** what the run may use at most (default: the nine-check suite; the qualification tracks pass their own) */
  worst: WorstCase = liveSuiteWorstCase(),
): { problems: string[]; approval?: LiveSuiteApproval; standing: string[] } {
  const problems: string[] = [];
  const cfg = loadAiConfig(env);
  if (a.provider !== CLAUDE_PROVIDER_ID)
    problems.push(
      `the provider must be ${CLAUDE_PROVIDER_ID}: other providers are contracts and fixtures only (D11)`,
    );
  if (env.NODE_ENV === 'production')
    problems.push('never in a production process (the production vault is not decided, D-12)');
  if (!cfg.liveProviders.includes(a.provider))
    problems.push('the provider is not in AI_LIVE_PROVIDERS (D3)');
  if (typeof a.vaultRef !== 'string' || !VAULT_REF.test(a.vaultRef))
    problems.push('the credential must be a dev-vault reference (vault://dev/ai-…); never a key');

  let approval: LiveSuiteApproval | undefined;
  const raw = a.approval;
  if (!isObj(raw)) problems.push('the approval file is missing or is not an object');
  else {
    const entry = cfg.probeApprovals.find((p) => p.ref === raw.ref);
    if (!entry)
      problems.push('no AI_PROBE_APPROVALS entry has the same reference as the approval file (D9)');
    const maxRequests = Number(raw.maxRequests);
    const maxTotalTokens = Number(raw.maxTotalTokens);
    if (
      typeof raw.ref !== 'string' ||
      typeof raw.approvedBy !== 'string' ||
      raw.environment !== 'non-production' ||
      !Number.isInteger(maxRequests) ||
      !Number.isInteger(maxTotalTokens) ||
      typeof raw.maxCostNano !== 'string'
    )
      problems.push(
        'the approval file needs ref, approvedBy, environment "non-production", maxRequests, maxTotalTokens and maxCostNano',
      );
    else {
      if (entry && (maxRequests > entry.maxRequests || maxTotalTokens > entry.maxTotalTokens))
        problems.push(
          'the approval file asks for more requests or tokens than the recorded approval (AI_PROBE_APPROVALS)',
        );
      const w = worst;
      const need = tokenCostNano(w.inputTokens, w.outputTokens, adapter.pricing);
      if (maxRequests < w.requests || maxTotalTokens < w.totalTokens)
        problems.push(
          `the approval does not cover the worst case (${w.requests} requests, ${w.totalTokens} tokens)`,
        );
      if (!/^\d{1,18}$/.test(raw.maxCostNano) || BigInt(raw.maxCostNano) < need)
        problems.push('the approval money ceiling is below the worst case at the list price');
      approval = {
        ref: raw.ref,
        approvedBy: raw.approvedBy,
        environment: 'non-production',
        maxRequests: entry ? Math.min(maxRequests, entry.maxRequests) : maxRequests,
        maxTotalTokens: entry ? Math.min(maxTotalTokens, entry.maxTotalTokens) : maxTotalTokens,
        maxCostNano: raw.maxCostNano,
      };
    }
  }
  const ev = assessLiveEvidence(a.evidence, { provider: a.provider, now, nodeEnv: env.NODE_ENV });
  // the production problem is already listed above; keep the others
  for (const p of ev.problems)
    if (!p.startsWith('a live verification never runs')) problems.push(p);
  return {
    problems,
    standing: ev.standing,
    ...(problems.length === 0 && approval ? { approval } : {}),
  };
}

function parseVendorUsage(x: unknown): VendorUsage | null {
  if (!isObj(x)) return null;
  const { inputTokens, outputTokens, source } = x;
  if (
    !Number.isInteger(inputTokens) ||
    !Number.isInteger(outputTokens) ||
    (inputTokens as number) < 0 ||
    (outputTokens as number) < 0 ||
    typeof source !== 'string' ||
    source.trim().length < 3
  )
    return null;
  return { inputTokens: inputTokens as number, outputTokens: outputTokens as number, source };
}

export async function runSmoke(a: SmokeArgs, d: SmokeDeps): Promise<SmokeResult> {
  const make =
    d.makeAdapter ??
    ((getApiKey) =>
      new AnthropicModelAdapter({
        getApiKey,
        contract: '1.1',
        // the adapter checks the live gate itself before every call, exactly as in the application (the gates above are checked first; this is the second lock)
        liveEnabled: () => loadAiConfig(d.env).liveProviders.includes(CLAUDE_PROVIDER_ID),
      }) as ModelAdapter);
  // a throw-away adapter (no key can be read through it) gives the gates the price list and model list
  const probe = make(async () => null);
  const g = evaluateSmokeGates(a, d.env, probe, d.now?.());
  if (g.problems.length > 0 || !g.approval) return { kind: 'refused', problems: g.problems };
  if (!a.execute) {
    const c = liveSuiteCost(probe.pricing);
    return {
      kind: 'dry_run',
      plan: {
        provider: a.provider,
        model: d.model ?? CLAUDE_MODEL_ID,
        worstCase: c.worst,
        maxCostNano: c.maxNano,
        ceilingAllOutputNano: c.ceilingAllOutputNano,
        priceSource: `adapter pricing ${probe.pricing.inputPerMillion}/${probe.pricing.outputPerMillion} ${probe.pricing.currency} per million tokens (list price; see S-AG4-PRICING.md)`,
        decisionsStanding: g.standing,
        message:
          'dry run: every gate holds and nothing was sent. Run again with --execute to make real requests.',
      },
    };
  }
  // ----- from here on a real request is possible
  const vendor = a.vendorUsage === undefined ? null : parseVendorUsage(a.vendorUsage);
  if (a.vendorUsage !== undefined && !vendor)
    return {
      kind: 'refused',
      problems: ['the vendor-usage file needs integer inputTokens and outputTokens and a source'],
    };
  const ref = a.vaultRef as string;
  let key: string | null = null;
  const adapter = make(async () => {
    key ??= await d.readKey(ref);
    return key;
  });
  const target: LiveTarget = {
    adapter,
    model: d.model ?? CLAUDE_MODEL_ID,
    mode: 'live',
    ...(vendor ? { vendorUsage: async () => vendor } : {}),
  };
  const report = await runLiveVerification(target, g.approval, {
    liveProviders: loadAiConfig(d.env).liveProviders,
    evidence: a.evidence,
    ...(a.usageToleranceTokens !== undefined
      ? { usageToleranceTokens: a.usageToleranceTokens }
      : {}),
    ...(d.now ? { now: d.now } : {}),
  });
  // the report is data about OUR run: it must never carry the key, and the run is discarded if it does
  const text = JSON.stringify(report);
  if (key && text.includes(key))
    return { kind: 'refused', problems: ['the report contained the credential and was discarded'] };
  return { kind: 'ran', report };
}

export { LIVE_REQUIRED_DECISIONS };

/**
 * Reconcile a SAVED report with the vendor's figure read later from the console (no request, no key, no gate needed: it only does arithmetic on two files).
 * The saved report is untrusted JSON: it must have the shape of a live report, or it is refused.
 */
export function reconcileSavedReport(
  report: unknown,
  vendor: unknown,
  tolerance = 0,
): { kind: 'reconciled'; report: LiveReport } | { kind: 'refused'; problems: string[] } {
  const v = parseVendorUsage(vendor);
  const r = report as Partial<LiveReport> | null;
  const problems: string[] = [];
  if (!v)
    problems.push('the vendor-usage file needs integer inputTokens and outputTokens and a source');
  if (
    !isObj(report) ||
    !Array.isArray(r?.checks) ||
    !isObj(r?.usage) ||
    !isObj((r?.usage as LiveReport['usage']).reported) ||
    !isObj((r?.usage as LiveReport['usage']).unreportedCeiling)
  )
    problems.push('the report file is not a live-verification report');
  if (!Number.isInteger(tolerance) || tolerance < 0)
    problems.push('the tolerance must be a non-negative integer');
  if (problems.length > 0 || !v) return { kind: 'refused', problems };
  return { kind: 'reconciled', report: reconcileLiveReport(r as LiveReport, v, tolerance) };
}
