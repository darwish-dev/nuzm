import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import {
  reconcileInvoice,
  type InvoiceReconciliation,
  AnthropicModelAdapter,
  CLAUDE_MODEL_ID,
  CLAUDE_PROVIDER_ID,
  LiveSuiteRefused,
  ModelAdapterError,
  QUALIFICATION_TRACKS,
  formatNano,
  liveSuiteWorstCase,
  runLiveVerification,
  runQualification,
  tokenCostNano,
  trackWorstCase,
  twinTarget,
  validateEvidence,
  type LiveReport,
  type LiveSuiteApproval,
  type LiveTarget,
  type ModelAdapter,
  type QualificationEvidence,
  type QualificationTrack,
  type WorstCase,
} from '@nuzm/adapter-model';
import { loadAiConfig } from './model';
import { evaluateSmokeGates, type SmokeDeps } from './live-smoke';

/**
 * THE PHASE 3 LIVE EXECUTOR (P3-S01). One command that runs qualification tracks A (connection), B (tool calling), C (code generation) and, optionally, D (a controlled real
 * error), E (a synthetic agent tool loop) and the nine-check suite, in order, against the REAL adapter once the owner has recorded D2, D3, D4, D5, D6 and D9, and writes ONE evidence
 * envelope (`nuzm.p3-provider-evidence`) with the component versions, the approval references, hashes of what went in and out, the cost against a HARD cap, and one claim per check
 * labelled LIVE-VERIFIED / SIMULATED / FAIL / NOT VERIFIED.
 *
 * What it does NOT do: create or hold a credential (the key is read from the sealed dev vault only after every gate passed and is never printed, returned or written), accept an agreement,
 * open `AI_LIVE_PROVIDERS`, retry anything, or run in a production process. Without every gate it refuses and sends nothing. Without `--execute` it prints the plan and the cap and sends nothing.
 *
 * The cap is cumulative and enforced twice: before each track (the remaining budget must cover that track's worst case, else the track is not run and says so) and after it (the actual
 * cost is added; a total above the cap is reported as an overrun and fails the run).
 */
export type ExecutorTrack = QualificationTrack | 'S';
export const DEFAULT_TRACKS: ExecutorTrack[] = ['A', 'B', 'C'];
const ORDER: ExecutorTrack[] = ['A', 'D', 'B', 'E', 'C', 'S'];

export interface ExecutorArgs {
  tracks: ExecutorTrack[];
  /** a decimal USD figure (up to 9 decimals); default = the plan's worst case */
  capUsd?: string;
  execute: boolean;
  twin: boolean;
  provider: string;
  vaultRef: string | undefined;
  approval: unknown;
  evidence: unknown;
}

export type ClaimLabel = 'LIVE-VERIFIED' | 'SIMULATED' | 'FAIL' | 'NOT VERIFIED';
export interface Claim {
  claim: string;
  label: ClaimLabel;
  basis: string;
}
export interface ExecutorPlan {
  provider: string;
  model: string;
  tracks: {
    track: ExecutorTrack;
    name: string;
    requests: number;
    totalTokens: number;
    maxCostNano: string;
  }[];
  worstCase: WorstCase;
  /** the HARD maximum of the whole run, printed before anything is sent */
  hardCapNano: string;
  hardCapUsd: string;
  currency: string;
  /** what the approval file must cover: the sum, not the largest single track */
  approvalMustCover: { maxRequests: number; maxTotalTokens: number; maxCostNano: string };
  decisionsStanding: string[];
  message: string;
}
export interface Envelope {
  schema: 'nuzm.p3-provider-evidence';
  schemaVersion: 1;
  id: string;
  createdAt: string;
  mode: 'live' | 'mock';
  provider: string;
  model: string;
  contractVersion: string;
  components: { adapterPackage: string; harness: string; node: string };
  approvals: { ref: string; approvedBy: string; decisions: { decision: string; ref: string }[] };
  cap: { currency: string; hardMaxNano: string; spentNano: string; overran: boolean };
  /** the adapter's list price the cost was computed at (for the invoice reconciliation) */
  listPrice: { inputPerMillion: string; outputPerMillion: string; currency: string };
  inputsSha256: string;
  outputsSha256: string;
  tracks: {
    track: ExecutorTrack;
    status: 'ran' | 'not_run';
    reason?: string;
    verdict?: string;
    requests?: number;
    costNano?: string;
    recordSha256?: string;
  }[];
  claims: Claim[];
  records: QualificationEvidence[];
  suite?: LiveReport;
  leakCheck: { performed: true; findings: number };
  verdict: ClaimLabel;
  contentPolicy: 'no key, prompt, completion, tool argument or vendor message is recorded';
}
export type ExecutorResult =
  | { kind: 'refused'; problems: string[] }
  | { kind: 'dry_run'; plan: ExecutorPlan }
  | { kind: 'ran'; envelope: Envelope; fileName: string };

export interface ExecutorDeps extends SmokeDeps {
  /** tests only: the clock for ids and file names */
  now?: () => Date;
}

const USD = /^\d{1,6}(\.\d{1,9})?$/;
/** A decimal USD figure to nano-USD (integer), or null when it is not a plain decimal. */
export function usdToNano(s: string): bigint | null {
  if (!USD.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole!) * 1_000_000_000n + BigInt(frac.padEnd(9, '0'));
}
/** The digest the envelope stores for each record: sha-256 of the record's JSON text. */
export const recordSha256 = (v: unknown): string =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
const sha = recordSha256;

const sumWorst = (ws: WorstCase[]): WorstCase =>
  ws.reduce(
    (a, w) => ({
      requests: a.requests + w.requests,
      inputTokens: a.inputTokens + w.inputTokens,
      outputTokens: a.outputTokens + w.outputTokens,
      totalTokens: a.totalTokens + w.totalTokens,
    }),
    { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
const worstOf = (t: ExecutorTrack): WorstCase =>
  t === 'S' ? liveSuiteWorstCase() : trackWorstCase(t);
const nameOf = (t: ExecutorTrack): string =>
  t === 'S' ? 'nine-check suite' : QUALIFICATION_TRACKS[t].name;

/** Normalises the track list: known ids only, no duplicates, the fixed order; the suite already contains the whole tool-calling probe, so `B` with `S` is refused. */
export function parseTracks(raw: string | undefined): ExecutorTrack[] | { error: string } {
  const list = (raw ?? DEFAULT_TRACKS.join(','))
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
  const bad = list.filter((x) => !(ORDER as string[]).includes(x));
  if (bad.length) return { error: `unknown track(s): ${bad.join(', ')} (use A,B,C,D,E,S)` };
  const set = new Set(list as ExecutorTrack[]);
  if (set.size === 0) return { error: 'no track selected' };
  if (set.has('S') && set.has('B'))
    return {
      error:
        'track S (the suite) already runs the whole tool-calling probe: do not select B with it',
    };
  return ORDER.filter((t) => set.has(t));
}

// ───────────────────────────── the leak check (acceptance A4) ─────────────────────────────

const LEAK_SHAPES: [string, RegExp][] = [
  ['an Anthropic-style key', /sk-ant-[A-Za-z0-9_-]{8,}/],
  ['an OpenAI-style key', /\bsk-[A-Za-z0-9]{20,}/],
  ['a Google-style key', /\bAIza[0-9A-Za-z_-]{20,}/],
  ['a bearer token', /\bBearer\s+[A-Za-z0-9._-]{16,}/i],
  ['a private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['an authorization header', /authorization['"]?\s*[:=]/i],
];
/** What a run artifact must not contain: the credential itself (when known) and anything shaped like a key. Only the NAMES of the findings are returned, never the match. */
export function scanForLeaks(text: string, secrets: readonly (string | null)[] = []): string[] {
  const out: string[] = [];
  for (const s of secrets)
    if (s && s.length >= 8 && text.includes(s)) out.push('the credential itself');
  for (const [name, re] of LEAK_SHAPES) if (re.test(text)) out.push(name);
  return out;
}

// ───────────────────────────── claims ─────────────────────────────

const CLAIM_NAMES: Record<string, string> = {
  listing: 'the key and host are valid and the declared model is listed by the provider',
  complete: 'a minimal request is answered with text and reported usage',
  stream: 'streaming delivers text, a stop and usage',
  tool_calling:
    'tool calling works (single, forced, parallel, streamed, round trip, none, truncated, cancel)',
  codegen_slugify: 'code generation: slugify (static checks only, never executed)',
  codegen_sum: 'code generation: sum (static checks only, never executed)',
  error_mapping:
    'a real provider refusal is mapped onto the contract (invalid_request, not retryable)',
  agent_loop: 'an agent tool loop completes: read tool call, tool result, answer that uses it',
};
const labelOf = (mode: 'live' | 'mock', ok: boolean, ran: boolean): ClaimLabel =>
  !ran ? 'NOT VERIFIED' : !ok ? 'FAIL' : mode === 'live' ? 'LIVE-VERIFIED' : 'SIMULATED';

/** One claim per check, plus the claims that stay what they are even in a live run. Pure. */
export function buildClaims(
  mode: 'live' | 'mock',
  records: readonly QualificationEvidence[],
  suite: LiveReport | undefined,
  selected: readonly ExecutorTrack[],
): Claim[] {
  const out: Claim[] = [];
  for (const r of records)
    for (const c of r.checks)
      out.push({
        claim: CLAIM_NAMES[c.id] ?? c.id,
        label: labelOf(mode, c.ok, c.ran),
        basis: `track ${r.track}: ${c.detail}`,
      });
  if (suite)
    for (const c of suite.checks) {
      // the suite labels each check itself: a check that is simulated by design stays simulated even in a live run
      const label: ClaimLabel = !c.ran
        ? 'NOT VERIFIED'
        : !c.ok
          ? 'FAIL'
          : c.evidence === 'live'
            ? 'LIVE-VERIFIED'
            : c.evidence === 'simulated'
              ? 'SIMULATED'
              : 'NOT VERIFIED';
      out.push({ claim: `suite: ${c.id}`, label, basis: c.detail });
    }
  const hasSuite = selected.includes('S');
  if (!hasSuite)
    for (const id of [
      'structured output',
      'cancel mid-stream',
      'usage reconciliation against the vendor figure',
    ])
      out.push({
        claim: id,
        label: 'NOT VERIFIED',
        basis:
          'not selected in this run: they are checks of the nine-check suite (track S); usage reconciliation also needs the vendor console figure',
      });
  out.push(
    {
      claim: 'retry and circuit breaker against the real vendor',
      label: 'SIMULATED',
      basis:
        'faults can only be injected on our side; a real provider cannot be made to fail on demand',
    },
    {
      claim: 'approved fallback routing proven with real error codes',
      label: 'SIMULATED',
      basis: 'needs a second approved provider and an injected failure',
    },
    {
      claim: '401, 429 and 5xx handling against the real vendor',
      label: 'NOT VERIFIED',
      basis:
        'cannot be provoked safely (no bad key is ever entered, no limit is exceeded on purpose)',
    },
    {
      claim: 'model quality',
      label: 'NOT VERIFIED',
      basis: 'measured by the benchmark session (P3-S08), not here',
    },
  );
  return out;
}

// ───────────────────────────── the command ─────────────────────────────

export async function runExecutor(a: ExecutorArgs, d: ExecutorDeps): Promise<ExecutorResult> {
  const tracks = ORDER.filter((t) => a.tracks.includes(t));
  if (tracks.length === 0) return { kind: 'refused', problems: ['no track selected'] };
  if (tracks.includes('S') && tracks.includes('B'))
    return {
      kind: 'refused',
      problems: ['track S already runs the whole tool-calling probe: do not select B with it'],
    };
  const make =
    d.makeAdapter ??
    ((getApiKey) =>
      new AnthropicModelAdapter({
        getApiKey,
        contract: '1.1',
        liveEnabled: () => loadAiConfig(d.env).liveProviders.includes(CLAUDE_PROVIDER_ID),
      }) as ModelAdapter);
  const now = d.now ?? (() => new Date());

  // ---- the mock twin: rehearsal, no key, no network, labelled SIMULATED
  if (a.twin)
    return finish(
      await runTracks(tracks, twinContext(), a.capUsd, null, now),
      'mock',
      now,
      d,
      null,
    );

  // ---- live: every gate, evaluated before the key is read
  const probe = make(async () => null);
  const worst = sumWorst(tracks.map(worstOf));
  const planCost = tokenCostNano(worst.inputTokens, worst.outputTokens, probe.pricing);
  let cap = planCost;
  if (a.capUsd !== undefined) {
    const c = usdToNano(a.capUsd);
    if (c === null)
      return {
        kind: 'refused',
        problems: ['the cap must be a plain decimal USD figure such as 0.12'],
      };
    cap = c;
  }
  const g = evaluateSmokeGates(a, d.env, probe, now(), worst);
  const problems = [...g.problems];
  // the approval must cover the whole plan and the cap the operator printed
  const approved = g.approval;
  if (approved && BigInt(approved.maxCostNano) < cap)
    problems.push('the approval money ceiling is below the hard cap of this run');
  if (problems.length > 0 || !approved) return { kind: 'refused', problems };
  const plan: ExecutorPlan = {
    provider: a.provider,
    model: CLAUDE_MODEL_ID,
    tracks: tracks.map((t) => {
      const w = worstOf(t);
      return {
        track: t,
        name: nameOf(t),
        requests: w.requests,
        totalTokens: w.totalTokens,
        maxCostNano: tokenCostNano(w.inputTokens, w.outputTokens, probe.pricing).toString(),
      };
    }),
    worstCase: worst,
    hardCapNano: cap.toString(),
    hardCapUsd: `${probe.pricing.currency} ${formatNano(cap)}`,
    currency: probe.pricing.currency,
    approvalMustCover: {
      maxRequests: worst.requests,
      maxTotalTokens: worst.totalTokens,
      maxCostNano: cap.toString(),
    },
    decisionsStanding: g.standing,
    message: a.execute
      ? 'every gate holds: running'
      : 'dry run: every gate holds and nothing was sent. Run again with --execute to make real requests.',
  };
  if (!a.execute) return { kind: 'dry_run', plan };

  let key: string | null = null;
  const adapter = make(async () => {
    key ??= await d.readKey(a.vaultRef as string);
    return key;
  });
  const target: LiveTarget = { adapter, model: d.model ?? CLAUDE_MODEL_ID, mode: 'live' };
  const ctx: RunContext = {
    target,
    approval: approved,
    liveProviders: loadAiConfig(d.env).liveProviders,
    evidence: a.evidence,
    standing: g.standing,
    prep: () => undefined,
  };
  const out = await runTracks(tracks, ctx, cap.toString(), cap, now);
  return finish(out, 'live', now, d, key, g.standing, approved);
}

interface RunContext {
  target: LiveTarget;
  approval: LiveSuiteApproval;
  liveProviders?: string[];
  evidence?: unknown;
  standing: string[];
  /** before a track: lets the twin arm its refusal for track D */
  prep: (t: ExecutorTrack) => void;
}
function twinContext(): RunContext {
  const { target, primary } = twinTarget();
  return {
    target,
    approval: {
      ref: 'twin-synthetic',
      approvedBy: 'twin',
      environment: 'non-production',
      maxRequests: 1000,
      maxTotalTokens: 10_000_000,
      maxCostNano: '1000000000000',
    },
    standing: [],
    prep: (t) => {
      if (t === 'D')
        primary.failNext(
          new ModelAdapterError('invalid_request', 'the twin refused the oversized ceiling', false),
          1,
        );
    },
  };
}
interface Ran {
  ctx: RunContext;
  records: QualificationEvidence[];
  suite?: LiveReport;
  tracks: Envelope['tracks'];
  spent: bigint;
  hardCap: bigint;
  overran: boolean;
  tracksSelected: ExecutorTrack[];
}

/** Runs the tracks in order against the cumulative budget. The remaining budget is what each track is APPROVED to use, so the run cannot pass the cap. */
async function runTracks(
  tracks: ExecutorTrack[],
  ctx: RunContext,
  capUsd: string | undefined,
  capNano: bigint | null,
  now: () => Date,
): Promise<Ran> {
  const price = ctx.target.adapter.pricing;
  const plan = sumWorst(tracks.map(worstOf));
  const planCost = tokenCostNano(plan.inputTokens, plan.outputTokens, price);
  const hardCap = capNano ?? (capUsd ? (usdToNano(capUsd) ?? planCost) : planCost);
  const out: Ran = {
    ctx,
    records: [],
    tracks: [],
    spent: 0n,
    hardCap,
    overran: false,
    tracksSelected: tracks,
  };
  let reqUsed = 0;
  let tokUsed = 0;
  let halted: string | null = null;
  for (const t of tracks) {
    if (halted) {
      out.tracks.push({ track: t, status: 'not_run', reason: halted });
      continue;
    }
    const remaining: LiveSuiteApproval = {
      ...ctx.approval,
      maxRequests: ctx.approval.maxRequests - reqUsed,
      maxTotalTokens: ctx.approval.maxTotalTokens - tokUsed,
      maxCostNano: (hardCap - out.spent < BigInt(ctx.approval.maxCostNano) - out.spent
        ? hardCap - out.spent
        : BigInt(ctx.approval.maxCostNano) - out.spent
      ).toString(),
    };
    if (BigInt(remaining.maxCostNano) < 0n) remaining.maxCostNano = '0';
    ctx.prep(t);
    try {
      if (t === 'S') {
        const rep = await runLiveVerification(ctx.target, remaining, {
          ...(ctx.liveProviders ? { liveProviders: ctx.liveProviders } : {}),
          ...(ctx.evidence !== undefined ? { evidence: ctx.evidence } : {}),
          now,
        });
        out.suite = rep;
        out.spent += BigInt(rep.costNano);
        reqUsed += rep.requests;
        tokUsed += rep.totalTokens;
        out.tracks.push({
          track: t,
          status: 'ran',
          verdict: rep.allPassed
            ? rep.mode === 'live'
              ? 'LIVE-VERIFIED'
              : 'SIMULATED'
            : 'NOT VERIFIED',
          requests: rep.requests,
          costNano: rep.costNano,
          recordSha256: sha(rep),
        });
        if (rep.overran) out.overran = true;
        if (
          rep.stoppedEarly === 'credential_or_availability' ||
          rep.stoppedEarly === 'rate_limited'
        )
          halted = `stopped: ${rep.stoppedEarly} in the suite`;
      } else {
        const rec = await runQualification(t, ctx.target, remaining, {
          ...(ctx.liveProviders ? { liveProviders: ctx.liveProviders } : {}),
          ...(ctx.evidence !== undefined ? { evidence: ctx.evidence } : {}),
          now,
        });
        const problems = validateEvidence(rec);
        if (problems.length) throw new Error('invalid evidence record');
        out.records.push(rec);
        out.spent += BigInt(rec.totals.costNano);
        reqUsed += rec.totals.requests;
        tokUsed += rec.totals.tokensIn + rec.totals.tokensOut;
        out.tracks.push({
          track: t,
          status: 'ran',
          verdict: rec.verdict,
          requests: rec.totals.requests,
          costNano: rec.totals.costNano,
          recordSha256: sha(rec),
        });
        // a credential, availability or rate-limit failure ends the whole run: nothing is retried and nothing further is sent
        if (
          rec.stoppedEarly === 'credential_or_availability' ||
          rec.stoppedEarly === 'rate_limited'
        )
          halted = `stopped: ${rec.stoppedEarly} in track ${t}`;
      }
    } catch (e) {
      const reason =
        e instanceof LiveSuiteRefused
          ? `not run: the remaining budget does not cover this track (${e.message.slice(0, 120)})`
          : 'not run: the track failed unexpectedly (no detail is recorded: it could carry request data)';
      out.tracks.push({ track: t, status: 'not_run', reason });
      if (!(e instanceof LiveSuiteRefused)) halted = 'stopped after an unexpected failure';
    }
    if (out.spent > hardCap) {
      out.overran = true;
      halted = 'stopped: the hard cap was reached';
    }
  }
  return out;
}

function finish(
  r: Ran,
  mode: 'live' | 'mock',
  now: () => Date,
  d: ExecutorDeps,
  key: string | null,
  standing: string[] = [],
  approval?: LiveSuiteApproval,
): ExecutorResult {
  const adapter = r.ctx.target.adapter;
  const claims = buildClaims(mode, r.records, r.suite, r.tracksSelected);
  const anyFail = claims.some((c) => c.label === 'FAIL') || r.overran;
  const core = claims.filter(
    (c) =>
      !/^(retry|approved fallback|401|model quality)/.test(c.claim) &&
      !c.basis.startsWith('not selected'),
  );
  const allGood =
    r.tracks.every((t) => t.status === 'ran') && // a track that was not run can never be part of a pass
    core.length > 0 &&
    core.every((c) => c.label === (mode === 'live' ? 'LIVE-VERIFIED' : 'SIMULATED'));
  const verdict: ClaimLabel = anyFail
    ? 'FAIL'
    : allGood
      ? mode === 'live'
        ? 'LIVE-VERIFIED'
        : 'SIMULATED'
      : 'NOT VERIFIED';
  const env: Omit<Envelope, 'leakCheck'> = {
    schema: 'nuzm.p3-provider-evidence',
    schemaVersion: 1,
    id: uuidv7(),
    createdAt: now().toISOString(),
    mode,
    provider: adapter.id,
    model: r.ctx.target.model,
    contractVersion: adapter.contractVersion,
    components: {
      adapterPackage: '@nuzm/adapter-model',
      harness: 'p3-s01-live-executor/1',
      node: process.version,
    },
    approvals: {
      ref: approval?.ref ?? 'twin-synthetic',
      approvedBy: approval?.approvedBy ?? 'twin',
      // references only (never a secret): the rows of the evidence file that stood when the run started
      decisions: standing.map((decision) => ({ decision, ref: refOf(r.ctx.evidence, decision) })),
    },
    cap: {
      currency: adapter.pricing.currency,
      hardMaxNano: r.hardCap.toString(),
      spentNano: r.spent.toString(),
      overran: r.overran,
    },
    listPrice: { ...adapter.pricing },
    inputsSha256: sha({
      tracks: r.tracksSelected,
      model: r.ctx.target.model,
      hardCap: r.hardCap.toString(),
    }),
    outputsSha256: sha({ records: r.records, suite: r.suite ?? null }),
    tracks: r.tracks,
    claims,
    records: r.records,
    ...(r.suite ? { suite: r.suite } : {}),
    verdict,
    contentPolicy: 'no key, prompt, completion, tool argument or vendor message is recorded',
  };
  // the live-run leak check (A4): the artifact is scanned for the credential and for anything key-shaped BEFORE it is returned
  const findings = scanForLeaks(JSON.stringify(env), [key]);
  if (findings.length > 0)
    return {
      kind: 'refused',
      problems: [`the evidence envelope was discarded: it contained ${findings.join(', ')}`],
    };
  const envelope: Envelope = { ...env, leakCheck: { performed: true, findings: 0 } };
  void d;
  return { kind: 'ran', envelope, fileName: envelopeFileName(envelope) };
}
function refOf(rows: unknown, decision: string): string {
  if (!Array.isArray(rows)) return 'n/a';
  const latest = [...rows]
    .reverse()
    .find((x) => (x as { decision?: unknown })?.decision === decision) as
    { ref?: unknown } | undefined;
  return typeof latest?.ref === 'string' ? latest.ref.slice(0, 120) : 'n/a';
}
/** `<date>-<id>.json`: the name under `docs/phase3/EVIDENCE/provider/` (the operator chooses the directory). */
export function envelopeFileName(e: Pick<Envelope, 'createdAt' | 'id' | 'mode'>): string {
  return `${e.createdAt.slice(0, 10)}-${e.mode === 'live' ? '' : 'sim-'}${e.id}.json`;
}

/**
 * Reconciles the cost of a SAVED live envelope with the vendor's invoice (plan item 7): arithmetic on two files, no request, no key, no gate. A mock envelope is refused (there is no
 * invoice for a mock run). Returns the reconciliation and the claims it adds.
 */
export function reconcileEnvelopeInvoice(
  envelope: unknown,
  invoice: unknown,
  toleranceUsd = '0',
):
  | { kind: 'reconciled'; result: InvoiceReconciliation; claims: Claim[] }
  | { kind: 'refused'; problems: string[] } {
  const e = envelope as Partial<Envelope> | null;
  const i = invoice as {
    amountUsd?: unknown;
    currency?: unknown;
    source?: unknown;
    vendorInputTokens?: unknown;
    vendorOutputTokens?: unknown;
  } | null;
  const problems: string[] = [];
  if (!e || e.schema !== 'nuzm.p3-provider-evidence' || !e.cap || !e.listPrice)
    problems.push('the envelope file is not a nuzm.p3-provider-evidence file');
  else if (e.mode !== 'live')
    problems.push('only a LIVE envelope can be reconciled with an invoice');
  if (!i || typeof i !== 'object') problems.push('the invoice file is missing');
  const amount = typeof i?.amountUsd === 'string' ? usdToNano(i.amountUsd) : null;
  if (i && amount === null)
    problems.push('amountUsd must be a plain decimal string such as "0.12"');
  const tol = usdToNano(toleranceUsd);
  if (tol === null) problems.push('the tolerance must be a plain decimal USD figure');
  const hasUsage = i && i.vendorInputTokens !== undefined && i.vendorOutputTokens !== undefined;
  if (
    hasUsage &&
    (!Number.isInteger(i.vendorInputTokens) || !Number.isInteger(i.vendorOutputTokens))
  )
    problems.push('vendorInputTokens and vendorOutputTokens must be integers');
  if (problems.length > 0 || !e || !i || amount === null || tol === null)
    return { kind: 'refused', problems };
  const result = reconcileInvoice(
    e.cap!.spentNano!,
    e.listPrice!,
    {
      amountNano: amount.toString(),
      currency: typeof i.currency === 'string' ? i.currency : 'USD',
      source: typeof i.source === 'string' ? i.source : '',
      ...(hasUsage
        ? {
            vendorUsage: {
              inputTokens: i.vendorInputTokens as number,
              outputTokens: i.vendorOutputTokens as number,
            },
          }
        : {}),
    },
    tol,
  );
  const label = (c: { ran: boolean; ok: boolean }): ClaimLabel =>
    !c.ran ? 'NOT VERIFIED' : c.ok ? 'LIVE-VERIFIED' : 'FAIL';
  const claims: Claim[] = result.checks.map((c) => ({
    claim:
      c.id === 'our_cost_vs_invoice'
        ? 'our computed cost matches the vendor invoice'
        : 'the list price (rate card input) matches the vendor invoice',
    label: label(c),
    basis: c.detail,
  }));
  return { kind: 'reconciled', result, claims };
}
