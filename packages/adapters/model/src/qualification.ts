import {
  assertRunAllowed,
  type LiveRunOptions,
  type LiveSuiteApproval,
  type LiveTarget,
  type WorstCase,
} from './live-verification';
import { runCapabilityProbe, probeWorstCase, PROBE_INPUT_ALLOWANCE, PROBE_PLAN } from './probe';
import { tokenCostNano } from './probe-cost';
import { reconcileDiscovery } from './registry';
import {
  ModelAdapterError,
  type CompleteRequest,
  type ModelErrorCode,
  type ModelMessage,
} from './types';

/**
 * QUALIFICATION TRACKS A, B, C (S-AG4, Phase 2): three small, bounded, runnable checks of a provider, each with the SAME gates as the live-verification suite and each writing ONE
 * evidence record. They run today against the mock twin (verdict `SIMULATED`) and later against the real adapter (verdict `LIVE-VERIFIED` only when every check ran and passed).
 *
 *  A  provider connection   the declared model is confirmed by the provider's own listing (when the adapter has one), a minimal request is answered, a minimal stream is answered.
 *  B  tool calling          the capability probe (`probe.ts`): single, forced, parallel, streamed calls, the round trip, choice none, a truncated call, a cancelled stream.
 *  C  code generation       the model is asked for two small TypeScript functions; the answers are checked STATICALLY (a code block, the exported signature, balanced brackets, no
 *                           forbidden capability). The generated code is NEVER executed, imported or evaluated: that needs the isolated runtime, which does not exist yet (D-21).
 *
 * What the evidence record holds (and never holds): per request the step, the provider's request id (when it sent one), tokens, whether the tokens were estimated, cost, latency and
 * outcome; per check a fixed sentence. No prompt, no completion, no tool argument, no key. `validateEvidence` enforces the shape before a record is ever written.
 */
export type QualificationTrack = 'A' | 'B' | 'C' | 'D' | 'E';
export const QUALIFICATION_TRACKS: Record<QualificationTrack, { name: string; checks: string[] }> =
  {
    A: { name: 'provider connection', checks: ['listing', 'complete', 'stream'] },
    B: { name: 'tool calling', checks: ['tool_calling'] },
    C: { name: 'code generation', checks: ['codegen_slugify', 'codegen_sum'] },
    D: { name: 'controlled error mapping', checks: ['error_mapping'] },
    E: { name: 'agent tool loop', checks: ['agent_loop'] },
  };

const A_ALLOWANCE = 300;
const A_STEPS = [
  { id: 'complete', maxTokens: 100 },
  { id: 'stream', maxTokens: 100 },
] as const;
const C_ALLOWANCE = 300;
const C_STEPS = [
  {
    id: 'codegen_slugify',
    fn: 'slugify',
    signature: /slugify\s*\(\s*\w+\s*:\s*string\s*\)\s*:\s*string/,
    maxTokens: 700,
    prompt:
      'Write a TypeScript function `slugify(input: string): string` that lowercases the input, replaces each run of non-alphanumeric characters with a single hyphen and trims hyphens from both ends. Reply with one TypeScript code block and nothing else.',
  },
  {
    id: 'codegen_sum',
    fn: 'sum',
    signature: /sum\s*\(\s*\w+\s*:\s*number\s*\[\s*\]\s*\)\s*:\s*number/,
    maxTokens: 700,
    prompt:
      'Write a TypeScript function `sum(values: number[]): number` that returns the sum of the numbers. Reply with one TypeScript code block and nothing else.',
  },
] as const;

/**
 * Track D (CONTROLLED ERROR MAPPING): ONE request that a real vendor refuses before generating anything (an output ceiling above the model's limit), to see a REAL error status mapped onto
 * the contract (`invalid_request`, not retryable) and to confirm nothing was billed. It cannot show 401/429/5xx handling (those cannot be provoked safely) and says so. If the vendor
 * unexpectedly ACCEPTS the request, the prompt asks for one word, the actual usage is recorded and the check fails.
 */
const D_ALLOWANCE = 100;
const D_MAX_OUT = 100;
/**
 * Track E (AGENT TOOL LOOP, acceptance A2): a synthetic read-tool loop. The model is offered one read tool over a constant in-memory note, must call it, receives the result and must
 * answer with the code word that was IN the result (so it provably used it). Two requests; the tool is a pure function of a constant: nothing is executed, read or written outside.
 */
const E_STEPS = 2;
const E_ALLOWANCE = 400;
const E_MAX_OUT = 300;
const E_NOTE_ID = 'alpha';
const E_CODE_WORD = 'PELICAN-4821';
const E_TOOL = {
  name: 'read_note',
  description: 'Read a note by its id and return its text.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
/** The synthetic read tool: a pure function over constants (never a file, a process or the network). */
export function syntheticReadNote(args: unknown): string {
  const id = (args as { id?: unknown } | null)?.id;
  return id === E_NOTE_ID
    ? `Note ${E_NOTE_ID}: the code word is ${E_CODE_WORD}.`
    : `No note with that id exists.`;
}

/** What a track may use at most (shown to the approver before approving). */
export function trackWorstCase(track: QualificationTrack): WorstCase {
  if (track === 'A') {
    const out = A_STEPS.reduce((n, s) => n + s.maxTokens, 0);
    const inn = A_ALLOWANCE * A_STEPS.length;
    return {
      requests: A_STEPS.length,
      inputTokens: inn,
      outputTokens: out,
      totalTokens: inn + out,
    };
  }
  if (track === 'B') {
    const w = probeWorstCase();
    const inn = PROBE_INPUT_ALLOWANCE * PROBE_PLAN.length;
    return {
      requests: w.requests,
      inputTokens: inn,
      outputTokens: w.totalTokens - inn,
      totalTokens: w.totalTokens,
    };
  }
  if (track === 'D')
    return {
      requests: 1,
      inputTokens: D_ALLOWANCE,
      outputTokens: D_MAX_OUT,
      totalTokens: D_ALLOWANCE + D_MAX_OUT,
    };
  if (track === 'E') {
    const inn = E_ALLOWANCE * E_STEPS;
    const out = E_MAX_OUT * E_STEPS;
    return { requests: E_STEPS, inputTokens: inn, outputTokens: out, totalTokens: inn + out };
  }
  const out = C_STEPS.reduce((n, s) => n + s.maxTokens, 0);
  const inn = C_ALLOWANCE * C_STEPS.length;
  return { requests: C_STEPS.length, inputTokens: inn, outputTokens: out, totalTokens: inn + out };
}

// ───────────────────────────── static checks of generated code (never executed) ─────────────────────────────

const FORBIDDEN: [string, RegExp][] = [
  ['an import or require', /(^|[^\w.])(import\s*[\w{*(]|require\s*\()/m],
  ['eval or a Function constructor', /(^|[^\w.])(eval\s*\(|new\s+Function\s*\(|Function\s*\()/],
  ['process or child_process access', /\b(process\.|child_process|spawn\s*\(|exec\s*\()/],
  [
    'file system or network access',
    /\b(fs\.|readFile|writeFile|fetch\s*\(|XMLHttpRequest|WebSocket|http\.|https\.)/,
  ],
];

/** True when (), [] and {} are balanced outside string literals, template literals and comments. */
export function bracketsBalanced(code: string): boolean {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  let i = 0;
  while (i < code.length) {
    const c = code[i]!;
    const n = code[i + 1];
    if (c === '/' && n === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = code.indexOf('*/', i + 2);
      if (end < 0) return false;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < code.length && code[i] !== c) {
        if (code[i] === '\\') i++;
        i++;
      }
      if (i >= code.length) return false;
      i++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') stack.push(c);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== pairs[c]) return false;
    }
    i++;
  }
  return stack.length === 0;
}

/** The first fenced code block of an answer, or the whole answer when it has no fence but starts like code. */
export function extractCode(answer: string): string | null {
  const fenced = /```(?:ts|typescript|tsx|js|javascript)?[^\S\n]*\n([\s\S]*?)```/i.exec(answer);
  if (fenced) return fenced[1]!;
  const t = answer.trim();
  return /^(export\s|function\s|const\s)/.test(t) ? t : null;
}

/** Static checks only: one fixed sentence per problem, never a quote of the code. The code is not run, imported or evaluated. */
export function checkGeneratedCode(
  answer: string,
  step: { fn: string; signature: RegExp },
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const code = extractCode(answer);
  if (!code) return { ok: false, problems: ['the answer has no code block'] };
  if (code.length > 4_000) problems.push('the code is longer than 4,000 characters');
  if (!new RegExp(`export\\s+(?:function\\s+${step.fn}\\b|const\\s+${step.fn}\\s*=)`).test(code))
    problems.push(`the code does not export ${step.fn}`);
  if (!step.signature.test(code)) problems.push('the typed signature is not the one asked for');
  if (!/\breturn\b|=>/.test(code)) problems.push('the code returns nothing');
  if (!bracketsBalanced(code)) problems.push('the brackets are not balanced');
  for (const [name, re] of FORBIDDEN) if (re.test(code)) problems.push(`the code uses ${name}`);
  return { ok: problems.length === 0, problems };
}

// ───────────────────────────── the evidence record ─────────────────────────────

export interface EvidenceRequest {
  step: string;
  /** the provider's own request id (`req_…`) when it sent one, else null */
  requestId: string | null;
  tokensIn: number;
  tokensOut: number;
  /** true when the provider reported no usage and the ceiling was charged instead */
  estimated: boolean;
  /** nano units of the price currency, integer string */
  costNano: string;
  latencyMs: number;
  outcome: 'ok' | 'error';
  errorCode: string | null;
}
export interface EvidenceCheck {
  id: string;
  ok: boolean;
  ran: boolean;
  /** a fixed sentence: never provider text, never content */
  detail: string;
}
export type QualificationVerdict = 'LIVE-VERIFIED' | 'SIMULATED' | 'FAIL' | 'NOT VERIFIED';
export interface QualificationEvidence {
  schemaVersion: 1;
  track: QualificationTrack;
  trackName: string;
  provider: string;
  model: string;
  contractVersion: string;
  mode: 'live' | 'mock';
  verdict: QualificationVerdict;
  approvalRef: string;
  startedAt: string;
  finishedAt: string;
  currency: string;
  requests: EvidenceRequest[];
  totals: { requests: number; tokensIn: number; tokensOut: number; costNano: string };
  checks: EvidenceCheck[];
  stoppedEarly?: string;
  contentPolicy: typeof CONTENT_POLICY;
}
export const CONTENT_POLICY =
  'no prompt, completion or tool argument is recorded; code checks are static and the generated code is never executed' as const;

/** The file name an evidence record is written under (the operator chooses the directory, outside the repository). */
export function evidenceFileName(
  e: Pick<QualificationEvidence, 'track' | 'provider' | 'startedAt' | 'mode'>,
): string {
  const t = e.startedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `qualification-${e.track}-${e.provider}-${e.mode}-${t}.json`;
}

const REQUEST_ID = /^req_[A-Za-z0-9_-]{4,100}$/;
/** Problems with an evidence record (empty = fit to be written): shape, short fixed strings only, well-formed ids, consistent totals, verdict that matches the checks. */
export function validateEvidence(e: QualificationEvidence): string[] {
  const p: string[] = [];
  if (e.schemaVersion !== 1) p.push('schemaVersion must be 1');
  if (e.contentPolicy !== CONTENT_POLICY) p.push('the content policy sentence is missing');
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'string' && v.length > 300)
      p.push(`${path}: a string is longer than 300 characters (content must not be recorded)`);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(e, 'evidence');
  let tin = 0;
  let tout = 0;
  let cost = 0n;
  for (const r of e.requests) {
    if (r.requestId !== null && !REQUEST_ID.test(r.requestId))
      p.push(`request ${r.step}: malformed request id`);
    if (![r.tokensIn, r.tokensOut, r.latencyMs].every((n) => Number.isInteger(n) && n >= 0))
      p.push(`request ${r.step}: tokens and latency must be non-negative integers`);
    if (!/^\d{1,18}$/.test(r.costNano)) p.push(`request ${r.step}: cost must be an integer string`);
    tin += r.tokensIn;
    tout += r.tokensOut;
    cost += /^\d{1,18}$/.test(r.costNano) ? BigInt(r.costNano) : 0n;
  }
  if (
    e.totals.requests !== e.requests.length ||
    e.totals.tokensIn !== tin ||
    e.totals.tokensOut !== tout ||
    e.totals.costNano !== cost.toString()
  )
    p.push('the totals do not add up');
  const allOk = e.checks.length > 0 && e.checks.every((c) => c.ok && c.ran);
  const anyFail = e.checks.some((c) => c.ran && !c.ok);
  const expected: QualificationVerdict = anyFail
    ? 'FAIL'
    : allOk && !e.stoppedEarly
      ? e.mode === 'live'
        ? 'LIVE-VERIFIED'
        : 'SIMULATED'
      : 'NOT VERIFIED';
  if (e.verdict !== expected)
    p.push(`the verdict ${e.verdict} does not match the checks (${expected})`);
  if (e.mode === 'mock' && e.verdict === 'LIVE-VERIFIED')
    p.push('a mock run can never be LIVE-VERIFIED');
  return p;
}

// ───────────────────────────── the runner ─────────────────────────────

const codeOf = (e: unknown): ModelErrorCode =>
  e instanceof ModelAdapterError ? e.code : 'unavailable';

/**
 * Runs one track. Refuses (throws `LiveSuiteRefused`) before anything is sent unless the approval covers the track's worst case in requests, tokens and money and, for a live target,
 * the live gate and the D2/D3/D4/D5/D6/D9 evidence stand. A running total stops the run before a request that could pass a cap; a credential, availability or rate-limit failure stops it
 * at once; nothing is retried.
 */
export async function runQualification(
  track: QualificationTrack,
  target: LiveTarget,
  approval: LiveSuiteApproval,
  opts: LiveRunOptions = {},
): Promise<QualificationEvidence> {
  const w = trackWorstCase(track);
  assertRunAllowed(target, approval, w, opts);
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const { adapter, model } = target;
  const price = adapter.pricing;
  const requests: EvidenceRequest[] = [];
  const checks: EvidenceCheck[] = [];
  let stopped: string | undefined;
  let inT = 0;
  let outT = 0;
  const maxCost = BigInt(approval.maxCostNano);
  const costNow = () => tokenCostNano(inT, outT, price);
  const room = (maxOut: number, allowIn: number): boolean => {
    if (stopped) return false;
    if (requests.length + 1 > approval.maxRequests) stopped = 'request_cap';
    else if (inT + outT + maxOut + allowIn > approval.maxTotalTokens) stopped = 'token_cap';
    else if (costNow() + tokenCostNano(allowIn, maxOut, price) > maxCost) stopped = 'cost_cap';
    else if (opts.signal?.aborted) stopped = 'aborted';
    return !stopped;
  };
  const record = (
    step: string,
    t0: number,
    u: { inputTokens: number; outputTokens: number } | null,
    maxOut: number,
    allowIn: number,
    outcome: 'ok' | 'error',
    errorCode: string | null,
    requestId?: string,
  ) => {
    const tin = u?.inputTokens ?? allowIn;
    const tout = u?.outputTokens ?? maxOut;
    inT += tin;
    outT += tout;
    requests.push({
      step,
      requestId: requestId ?? null,
      tokensIn: tin,
      tokensOut: tout,
      estimated: u === null,
      costNano: tokenCostNano(tin, tout, price).toString(),
      latencyMs: Math.max(0, Date.now() - t0),
      outcome,
      errorCode,
    });
  };
  const fail = (code: ModelErrorCode) => {
    if (code === 'rate_limited') stopped = 'rate_limited';
    else if (code === 'aborted' && opts.signal?.aborted) stopped = 'aborted';
    else if (code !== 'invalid_response') stopped = 'credential_or_availability';
  };
  const check = (id: string, ok: boolean, ran: boolean, detail: string) =>
    void checks.push({ id, ok, ran, detail });
  const base = (task: string, text: string, maxTokens: number): CompleteRequest => ({
    model,
    messages: [{ role: 'user', content: text }],
    maxTokens,
    task,
  });
  const ctx = (id: string) => ({
    callId: `qual-${track}-${id}`,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  if (track === 'A') {
    // listing: not billed
    const declared = adapter.models();
    if (adapter.discoverModels) {
      try {
        const rec = reconcileDiscovery(declared, await adapter.discoverModels(ctx('listing')));
        const ok = rec.confirmed.includes(model);
        check(
          'listing',
          ok,
          true,
          ok
            ? 'the declared model is confirmed by the provider listing'
            : 'the provider listing does not confirm the declared model',
        );
      } catch (e) {
        check('listing', false, true, `the provider listing failed (${codeOf(e)})`);
        fail(codeOf(e));
      }
    } else
      check(
        'listing',
        declared.some((m) => m.modelId === model),
        true,
        'the adapter has no listing endpoint: the declared model was not confirmed by the provider',
      );
    // complete
    const s0 = A_STEPS[0];
    if (room(s0.maxTokens, A_ALLOWANCE)) {
      const t0 = Date.now();
      try {
        const r = await adapter.complete(
          ctx(s0.id),
          base('qual:ping', 'Reply with exactly the word: ok', s0.maxTokens),
        );
        record(s0.id, t0, r.usage, s0.maxTokens, A_ALLOWANCE, 'ok', null, r.requestId);
        const ok = r.text.trim().length > 0 && r.finishReason === 'stop' && r.usage !== null;
        check(
          s0.id,
          ok,
          true,
          ok
            ? 'the request was answered with text and reported usage'
            : r.finishReason === 'length'
              ? 'the answer was cut at the output ceiling (inconclusive)'
              : 'the answer had no text, no stop or no usage',
        );
      } catch (e) {
        record(s0.id, t0, null, s0.maxTokens, A_ALLOWANCE, 'error', codeOf(e));
        check(s0.id, false, true, `the request failed (${codeOf(e)})`);
        fail(codeOf(e));
      }
    } else check(s0.id, false, false, 'not run: a cap or a stop was reached first');
    // stream
    const s1 = A_STEPS[1];
    if (room(s1.maxTokens, A_ALLOWANCE)) {
      const t0 = Date.now();
      try {
        let text = '';
        let usage: { inputTokens: number; outputTokens: number } | null = null;
        let finish = '';
        let rid: string | undefined;
        for await (const c of adapter.stream(
          ctx(s1.id),
          base('qual:ping', 'Reply with exactly the word: ok', s1.maxTokens),
        )) {
          if ('delta' in c) text += c.delta;
          if ('done' in c) {
            usage = c.usage;
            finish = c.finishReason;
            rid = c.requestId;
          }
        }
        record(s1.id, t0, usage, s1.maxTokens, A_ALLOWANCE, 'ok', null, rid);
        const ok = text.trim().length > 0 && finish === 'stop' && usage !== null;
        check(
          s1.id,
          ok,
          true,
          ok
            ? 'the stream delivered text, a stop and usage'
            : 'the stream did not deliver text, a stop and usage',
        );
      } catch (e) {
        record(s1.id, t0, null, s1.maxTokens, A_ALLOWANCE, 'error', codeOf(e));
        check(s1.id, false, true, `the stream failed (${codeOf(e)})`);
        fail(codeOf(e));
      }
    } else check(s1.id, false, false, 'not run: a cap or a stop was reached first');
  } else if (track === 'B') {
    try {
      const rep = await runCapabilityProbe(
        adapter,
        model,
        {
          ref: approval.ref,
          approvedBy: approval.approvedBy,
          environment: 'non-production',
          maxRequests: approval.maxRequests,
          maxTotalTokens: approval.maxTotalTokens,
        },
        { ...(opts.signal ? { signal: opts.signal } : {}), now },
      );
      for (const o of rep.observations) {
        if (!o.ran) continue;
        const u = { inputTokens: o.tokensIn, outputTokens: o.tokensOut };
        requests.push({
          step: o.id,
          requestId: o.requestId ?? null,
          tokensIn: u.inputTokens,
          tokensOut: u.outputTokens,
          // the probe charges the allowance when no usage was reported; a step without a request id may be a stream, which the contract does not report an id for
          estimated: false,
          costNano: tokenCostNano(u.inputTokens, u.outputTokens, price).toString(),
          latencyMs: o.latencyMs ?? 0,
          outcome: o.errorCode && o.id !== 'truncated_call' ? 'error' : 'ok',
          errorCode: o.errorCode ?? null,
        });
        inT += u.inputTokens;
        outT += u.outputTokens;
      }
      const ok = rep.capabilities['tool-use'] === 'VERIFIED' && !rep.stoppedEarly;
      check(
        'tool_calling',
        ok,
        true,
        ok
          ? `the probe verified tool-use (${rep.capabilities['parallel-tool-calls'] === 'VERIFIED' ? 'parallel calls verified' : 'parallel calls NOT verified'}; ${rep.capabilities['streaming-tool-calls'] === 'VERIFIED' ? 'streamed calls verified' : 'streamed calls NOT verified'})`
          : `the probe did not verify tool-use${rep.stoppedEarly ? ` (stopped: ${rep.stoppedEarly})` : ''}`,
      );
      if (rep.stoppedEarly) stopped = rep.stoppedEarly;
    } catch (e) {
      check(
        'tool_calling',
        false,
        false,
        `not run: ${e instanceof Error ? e.name : 'refused'} (the adapter build must be on contract 1.1 and declare tool-use)`,
      );
    }
  } else if (track === 'D') {
    if (room(D_MAX_OUT, D_ALLOWANCE)) {
      const t0 = Date.now();
      const over = (adapter.models().find((m) => m.modelId === model)?.maxOutputTokens ?? 0) + 1;
      try {
        const r = await adapter.complete(ctx('error_mapping'), {
          ...base('qual:error', 'Reply with exactly the word: ok', over),
        });
        record('error_mapping', t0, r.usage, D_MAX_OUT, D_ALLOWANCE, 'ok', null, r.requestId);
        check(
          'error_mapping',
          false,
          true,
          'the provider ACCEPTED an output ceiling above the model limit: no error was produced to map',
        );
      } catch (e) {
        const code = codeOf(e);
        const retryable = e instanceof ModelAdapterError && e.retryable;
        // nothing was generated: the request failed before any output, so no usage is charged
        record(
          'error_mapping',
          t0,
          { inputTokens: 0, outputTokens: 0 },
          D_MAX_OUT,
          D_ALLOWANCE,
          'error',
          code,
        );
        const ok = code === 'invalid_request' && !retryable;
        check(
          'error_mapping',
          ok,
          true,
          ok
            ? 'a real provider refusal was mapped to invalid_request, not retryable (401/429/5xx handling is NOT exercised)'
            : `the refusal was mapped to ${code}${retryable ? ' (retryable)' : ''}, not to a non-retryable invalid_request`,
        );
        if (!ok) fail(code);
      }
    } else check('error_mapping', false, false, 'not run: a cap or a stop was reached first');
  } else if (track === 'E') {
    const history: ModelMessage[] = [
      {
        role: 'user',
        content: `Use the read_note tool to read the note with id "${E_NOTE_ID}", then reply with only the code word that the note contains.`,
      },
    ];
    const req = (): CompleteRequest => ({
      model,
      messages: history,
      maxTokens: E_MAX_OUT,
      task: 'qual:agent-loop',
      tools: [E_TOOL],
      toolChoice: 'auto',
      maxToolCalls: 1,
    });
    let loopOk = false;
    let detail = 'not run: a cap or a stop was reached first';
    let ran = false;
    if (room(E_MAX_OUT, E_ALLOWANCE)) {
      ran = true;
      const t0 = Date.now();
      try {
        const r1 = await adapter.complete(ctx('agent_call'), req());
        record('agent_call', t0, r1.usage, E_MAX_OUT, E_ALLOWANCE, 'ok', null, r1.requestId);
        const call = r1.toolCalls?.[0];
        if (r1.finishReason !== 'tool_calls' || !call || call.name !== E_TOOL.name) {
          detail = 'the model did not call the read tool';
        } else if (!room(E_MAX_OUT, E_ALLOWANCE)) {
          detail = 'not completed: a cap or a stop was reached before the second request';
          ran = false;
        } else {
          // the harness executes the synthetic tool and returns its result as a tool_result block
          history.push(
            {
              role: 'assistant',
              content: r1.text,
              blocks: [{ type: 'tool_call', id: call.id, name: call.name, args: call.args }],
            },
            {
              role: 'user',
              content: '',
              blocks: [
                { type: 'tool_result', callId: call.id, content: syntheticReadNote(call.args) },
              ],
            },
          );
          const t1 = Date.now();
          const r2 = await adapter.complete(ctx('agent_answer'), req());
          record('agent_answer', t1, r2.usage, E_MAX_OUT, E_ALLOWANCE, 'ok', null, r2.requestId);
          const usedResult = r2.finishReason === 'stop' && r2.text.includes(E_CODE_WORD);
          loopOk = usedResult && (call.args as { id?: unknown })?.id === E_NOTE_ID;
          detail = loopOk
            ? 'the model called the read tool, received its result and answered with the code word it contained'
            : (call.args as { id?: unknown })?.id !== E_NOTE_ID
              ? 'the model called the read tool with the wrong note id'
              : 'the final answer did not contain the code word from the tool result';
        }
      } catch (e) {
        record('agent_loop', t0, null, E_MAX_OUT, E_ALLOWANCE, 'error', codeOf(e));
        detail = `the loop failed (${codeOf(e)})`;
        fail(codeOf(e));
      }
    }
    check('agent_loop', loopOk, ran, detail);
  } else {
    for (const s of C_STEPS) {
      if (!room(s.maxTokens, C_ALLOWANCE)) {
        check(s.id, false, false, 'not run: a cap or a stop was reached first');
        continue;
      }
      const t0 = Date.now();
      try {
        const r = await adapter.complete(ctx(s.id), base('qual:code', s.prompt, s.maxTokens));
        record(s.id, t0, r.usage, s.maxTokens, C_ALLOWANCE, 'ok', null, r.requestId);
        if (r.finishReason === 'length') {
          check(
            s.id,
            false,
            true,
            'the answer was cut at the output ceiling (inconclusive: the code was not complete)',
          );
          continue;
        }
        const v = checkGeneratedCode(r.text, s);
        check(
          s.id,
          v.ok,
          true,
          v.ok
            ? 'the code block passed the static checks (it was not executed)'
            : `static checks failed: ${v.problems.join('; ')}`,
        );
      } catch (e) {
        record(s.id, t0, null, s.maxTokens, C_ALLOWANCE, 'error', codeOf(e));
        check(s.id, false, true, `the request failed (${codeOf(e)})`);
        fail(codeOf(e));
      }
    }
  }
  const anyFail = checks.some((c) => c.ran && !c.ok);
  const allOk = checks.length > 0 && checks.every((c) => c.ok && c.ran);
  const verdict: QualificationVerdict = anyFail
    ? 'FAIL'
    : allOk && !stopped
      ? target.mode === 'live'
        ? 'LIVE-VERIFIED'
        : 'SIMULATED'
      : 'NOT VERIFIED';
  return {
    schemaVersion: 1,
    track,
    trackName: QUALIFICATION_TRACKS[track].name,
    provider: adapter.id,
    model,
    contractVersion: adapter.contractVersion,
    mode: target.mode,
    verdict,
    approvalRef: approval.ref,
    startedAt,
    finishedAt: now().toISOString(),
    currency: price.currency,
    requests,
    totals: {
      requests: requests.length,
      tokensIn: inT,
      tokensOut: outT,
      costNano: costNow().toString(),
    },
    checks,
    ...(stopped ? { stoppedEarly: stopped } : {}),
    contentPolicy: CONTENT_POLICY,
  };
}
