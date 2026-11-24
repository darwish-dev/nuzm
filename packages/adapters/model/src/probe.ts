import { KIT_TOOLS } from './conformance';
import { assembleStream, allowedToolCalls } from './tools';
import {
  MODEL_CONTRACT_VERSION_1_1,
  ModelAdapterError,
  contractAtLeast,
  type CompleteRequest,
  type CompleteResponse,
  type ModelAdapter,
  type ModelMessage,
  type ToolSpec,
} from './types';

/**
 * The bounded capability probe for contract 1.1 (S-AG4): a fixed script of a few small requests that records, from what a model ACTUALLY does, whether its tool-calling declarations
 * may stand. This file is the harness only. It is provider-neutral (it takes any `ModelAdapter`), it is NOT wired to any route, job, console action or environment variable, and it has
 * never been run against a live provider: the tests drive it with scripted clients. Running it live needs the owner's approval (D9) of an explicit `ProbeApproval`.
 *
 * Hard limits, all enforced here and not by the caller:
 *  - no approval, a production environment, or caps below the plan's WORST CASE → refused before anything is sent;
 *  - the prompts are constants of this file: no customer or organization data can reach a probe request;
 *  - at most `PROBE_PLAN.length` requests (8), each with its own small `maxTokens`, no retries;
 *  - a running token total stops the probe before a request that could exceed the approved cap;
 *  - a credential/availability error or a rate limit stops the probe at once (nothing is hammered);
 *  - nothing is ever executed: a returned tool call is only inspected.
 */
export type ProbeId =
  | 'auto_call'
  | 'forced_call'
  | 'parallel_calls'
  | 'streamed_call'
  | 'tool_round_trip'
  | 'tool_choice_none'
  | 'truncated_call'
  | 'cancelled_stream';
export type ProbedCapability = 'tool-use' | 'streaming-tool-calls' | 'parallel-tool-calls';

/** What the owner approves (D9): who, which reference, where, and the spending ceiling in tokens. */
export interface ProbeApproval {
  /** the recorded approval (a decision or ticket reference) */
  ref: string;
  approvedBy: string;
  environment: 'non-production';
  maxRequests: number;
  /** input + output tokens across the whole probe */
  maxTotalTokens: number;
}

interface PlanStep {
  id: ProbeId;
  /** the output ceiling of this request */
  maxTokens: number;
  prompt: string;
  stream?: boolean;
}
/** Generous per-request allowance for the prompt plus the tool schemas, used only to compute the worst case. */
export const PROBE_INPUT_ALLOWANCE = 1_200;
export const PROBE_PLAN: readonly PlanStep[] = [
  { id: 'auto_call', maxTokens: 300, prompt: "Use the echo tool with the text 'probe'." },
  { id: 'forced_call', maxTokens: 300, prompt: "Look up the key 'alpha' with the lookup tool." },
  {
    id: 'parallel_calls',
    maxTokens: 400,
    prompt: "In the same turn, call echo with the text 'a' and lookup with the key 'b'.",
  },
  {
    id: 'streamed_call',
    maxTokens: 300,
    stream: true,
    prompt: "Use the echo tool with the text 'stream'.",
  },
  { id: 'tool_round_trip', maxTokens: 300, prompt: "Use the echo tool with the text 'probe'." },
  {
    id: 'tool_choice_none',
    maxTokens: 200,
    prompt: "Use the echo tool with the text 'none'. If you cannot, say so in one short sentence.",
  },
  {
    id: 'truncated_call',
    maxTokens: 16,
    prompt: 'Use the echo tool with a text of 400 characters.',
  },
  {
    id: 'cancelled_stream',
    maxTokens: 300,
    stream: true,
    prompt: 'Write the numbers one to fifty in words, one per line.',
  },
];
export const PROBE_TOOLS: readonly ToolSpec[] = KIT_TOOLS;

/** The most a full probe can use: shown to the approver BEFORE approving. */
export function probeWorstCase(): {
  requests: number;
  totalTokens: number;
  perRequest: { id: ProbeId; tokens: number }[];
} {
  const perRequest = PROBE_PLAN.map((s) => ({
    id: s.id,
    tokens: s.maxTokens + PROBE_INPUT_ALLOWANCE,
  }));
  return {
    requests: PROBE_PLAN.length,
    totalTokens: perRequest.reduce((n, r) => n + r.tokens, 0),
    perRequest,
  };
}

export class ProbeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeRefused';
  }
}

export interface ProbeObservation {
  id: ProbeId;
  ok: boolean;
  /** false when the step did not run (the probe stopped first) */
  ran: boolean;
  tokensIn: number;
  tokensOut: number;
  /** a fixed sentence: never a provider message, never content */
  detail: string;
  errorCode?: string;
  /** wall-clock time of the step, ms (set by the harness) */
  latencyMs?: number;
  /** the provider's own request id, when it sent one (non-streamed steps) */
  requestId?: string;
}
export interface ProbeReport {
  adapterId: string;
  contractVersion: string;
  model: string;
  approvalRef: string;
  startedAt: string;
  finishedAt: string;
  requests: number;
  totalTokens: number;
  /** set when the probe stopped before the end, and why */
  stoppedEarly?: 'token_cap' | 'credential_or_availability' | 'rate_limited' | 'aborted';
  observations: ProbeObservation[];
  capabilities: Record<ProbedCapability, 'VERIFIED' | 'NOT VERIFIED'>;
  /** Not a claim about quality or about any other model: only what these requests showed, at this time. */
  scope: 'this model, this adapter build, these requests, this moment';
}

export interface ProbeOptions {
  signal?: AbortSignal;
  now?: () => Date;
}

function refuse(m: string): never {
  throw new ProbeRefused(m);
}

/** Refuses unless the approval and the target are in order. Pure; sends nothing. */
export function assertProbeAllowed(
  adapter: Pick<ModelAdapter, 'contractVersion' | 'models'>,
  model: string,
  approval: ProbeApproval | undefined,
): void {
  const w = probeWorstCase();
  if (!approval) refuse('a recorded approval is required (D9)');
  if (typeof approval.ref !== 'string' || approval.ref.length < 3 || approval.ref.length > 200)
    refuse('the approval needs a reference (3-200 characters)');
  if (typeof approval.approvedBy !== 'string' || approval.approvedBy.trim().length === 0)
    refuse('the approval needs the name of the approver');
  if (approval.environment !== 'non-production')
    refuse('a probe runs in a non-production environment only');
  if (process.env.NODE_ENV === 'production') refuse('a probe never runs in a production process');
  if (!Number.isInteger(approval.maxRequests) || approval.maxRequests < w.requests)
    refuse(`the approval must allow at least ${w.requests} requests`);
  if (!Number.isInteger(approval.maxTotalTokens) || approval.maxTotalTokens < w.totalTokens)
    refuse(`the approved token cap must cover the worst case (${w.totalTokens} tokens)`);
  if (!contractAtLeast(adapter.contractVersion, MODEL_CONTRACT_VERSION_1_1))
    refuse('the adapter under test must implement contract 1.1 (a candidate declaration)');
  const m = adapter.models().find((x) => x.modelId === model);
  if (!m) refuse('unknown model');
  if (!m.capabilities.includes('tool-use')) refuse('the candidate model does not declare tool-use');
}

const user = (text: string): ModelMessage => ({ role: 'user', content: text });

/**
 * Runs the probe. Never throws for a provider failure (it is recorded); throws `ProbeRefused` only before anything is sent.
 * Cancellation of `signal` stops the probe and the request in flight.
 */
export async function runCapabilityProbe(
  adapter: ModelAdapter,
  model: string,
  approval: ProbeApproval,
  opts: ProbeOptions = {},
): Promise<ProbeReport> {
  assertProbeAllowed(adapter, model, approval);
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const info = adapter.models().find((m) => m.modelId === model)!;
  const obs: ProbeObservation[] = [];
  let requests = 0;
  let total = 0;
  let stopped: ProbeReport['stoppedEarly'];
  const seen = new Map<ProbeId, ProbeObservation>();
  let firstCall: { id: string; name: string; args: unknown } | undefined;

  let stepT0 = Date.now();
  let stepRid: string | undefined;
  const record = (o: ProbeObservation) => {
    const full: ProbeObservation = {
      ...o,
      latencyMs: Math.max(0, Date.now() - stepT0),
      ...(stepRid ? { requestId: stepRid } : {}),
    };
    obs.push(full);
    seen.set(full.id, full);
  };
  const base = (s: PlanStep, extra: Partial<CompleteRequest> = {}): CompleteRequest => ({
    model,
    messages: [user(s.prompt)],
    maxTokens: s.maxTokens,
    task: 'probe',
    tools: [...PROBE_TOOLS],
    ...extra,
  });
  const use = (
    r: Pick<CompleteResponse, 'usage'> | null,
    s: PlanStep,
  ): { tin: number; tout: number } => {
    const tin = r?.usage?.inputTokens ?? PROBE_INPUT_ALLOWANCE; // an unreported count is charged at the allowance: the cap stays honest
    const tout = r?.usage?.outputTokens ?? s.maxTokens;
    total += tin + tout;
    return { tin, tout };
  };

  for (const s of PROBE_PLAN) {
    if (opts.signal?.aborted) {
      stopped = 'aborted';
      break;
    }
    if (total + s.maxTokens + PROBE_INPUT_ALLOWANCE > approval.maxTotalTokens) {
      stopped = 'token_cap';
      break;
    }
    requests += 1;
    stepT0 = Date.now();
    stepRid = undefined;
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const ctx = { callId: `probe-${s.id}`, signal: ac.signal };
    try {
      if (s.id === 'cancelled_stream') {
        let chunks = 0;
        let code: string | undefined;
        try {
          for await (const c of adapter.stream(ctx, base(s, { tools: undefined }))) {
            void c;
            chunks += 1;
            if (chunks === 2) ac.abort();
            if (chunks > 200) break; // a stream that ignores cancellation is the failure being looked for
          }
        } catch (e) {
          code = e instanceof ModelAdapterError ? e.code : 'unknown';
        }
        const u = use(null, s);
        record({
          id: s.id,
          ok: code === 'aborted' && chunks < 200,
          ran: true,
          tokensIn: u.tin,
          tokensOut: u.tout,
          detail:
            code === 'aborted'
              ? 'the stream stopped when cancelled'
              : 'the stream did not stop with the cancellation',
          ...(code ? { errorCode: code } : {}),
        });
        continue;
      }
      if (s.stream) {
        const a = await assembleStream(adapter.stream(ctx, base(s)), {
          tools: PROBE_TOOLS,
          maxCalls: 1,
        });
        const u = use(a, s);
        const ok = a.finishReason === 'tool_calls' && (a.toolCalls?.length ?? 0) >= 1;
        record({
          id: s.id,
          ok,
          ran: true,
          tokensIn: u.tin,
          tokensOut: u.tout,
          detail: ok
            ? 'a streamed tool call was assembled and valid'
            : 'the stream carried no valid tool call',
        });
        continue;
      }
      if (s.id === 'tool_round_trip') {
        if (!firstCall) {
          requests -= 1; // nothing was sent: there is no call to answer
          record({
            id: s.id,
            ok: false,
            ran: false,
            tokensIn: 0,
            tokensOut: 0,
            detail: 'skipped: no tool call to answer',
          });
          continue;
        }
        const r = await adapter.complete(
          ctx,
          base(s, {
            messages: [
              user(s.prompt),
              {
                role: 'assistant',
                content: '',
                blocks: [
                  {
                    type: 'tool_call',
                    id: firstCall.id,
                    name: firstCall.name,
                    args: firstCall.args,
                  },
                ],
              },
              {
                role: 'user',
                content: '',
                blocks: [{ type: 'tool_result', callId: firstCall.id, content: 'probe' }],
              },
            ],
          }),
        );
        stepRid = r.requestId;
        const u = use(r, s);
        const ok = r.finishReason === 'stop' && r.text.trim().length > 0 && !r.toolCalls?.length;
        record({
          id: s.id,
          ok,
          ran: true,
          tokensIn: u.tin,
          tokensOut: u.tout,
          detail: ok
            ? 'the model used the tool result and answered'
            : 'the model did not answer after the tool result',
        });
        continue;
      }
      const extra: Partial<CompleteRequest> =
        s.id === 'forced_call'
          ? { toolChoice: { name: 'lookup' }, maxToolCalls: 1 }
          : s.id === 'parallel_calls'
            ? { maxToolCalls: Math.min(2, allowedToolCalls(info, {})) }
            : s.id === 'tool_choice_none'
              ? { toolChoice: 'none' }
              : { maxToolCalls: 1 };
      const r = await adapter.complete(ctx, base(s, extra));
      stepRid = r.requestId;
      const u = use(r, s);
      const calls = r.toolCalls ?? [];
      if (s.id === 'auto_call' && calls[0]) firstCall = calls[0];
      let ok: boolean;
      let detail: string;
      switch (s.id) {
        case 'auto_call':
          ok = r.finishReason === 'tool_calls' && calls.length >= 1;
          detail = ok ? 'a valid tool call' : 'no tool call';
          break;
        case 'forced_call':
          ok = calls.length >= 1 && calls[0]!.name === 'lookup';
          detail = ok ? 'the forced tool was called' : 'the forced tool was not called';
          break;
        case 'parallel_calls':
          ok = calls.length >= 2 && new Set(calls.map((c) => c.id)).size === calls.length;
          detail = ok ? 'two calls in one response' : 'fewer than two calls in one response';
          break;
        case 'tool_choice_none':
          ok = calls.length === 0;
          detail = ok
            ? 'no call although tools were offered'
            : 'a call was made although toolChoice was none';
          break;
        default: // truncated_call
          ok = !(calls.length > 0 && r.finishReason === 'length');
          detail = ok ? 'no truncated call was returned' : 'a truncated tool call was returned';
      }
      record({ id: s.id, ok, ran: true, tokensIn: u.tin, tokensOut: u.tout, detail });
    } catch (e) {
      const code = e instanceof ModelAdapterError ? e.code : 'unknown';
      const u = use(null, s);
      // a refused cut-off answer is the SAFE outcome the truncated probe looks for
      const safeRefusal = s.id === 'truncated_call' && code === 'invalid_response';
      record({
        id: s.id,
        ok: safeRefusal,
        ran: true,
        tokensIn: u.tin,
        tokensOut: u.tout,
        detail: safeRefusal ? 'the cut-off answer was refused' : `the request failed (${code})`,
        errorCode: code,
      });
      // only a malformed or cut-off ANSWER (`invalid_response`) is informative and lets the probe go on; any other failure (credential, outage, timeout, refusal, rate limit) stops it
      if (code === 'aborted' && opts.signal?.aborted) stopped = 'aborted';
      else if (code === 'rate_limited') stopped = 'rate_limited';
      else if (code !== 'invalid_response') stopped = 'credential_or_availability';
      if (stopped) break;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
  // steps that never ran are listed, so a partial probe cannot be mistaken for a complete one
  for (const s of PROBE_PLAN)
    if (!seen.has(s.id))
      obs.push({ id: s.id, ok: false, ran: false, tokensIn: 0, tokensOut: 0, detail: 'not run' });

  const ok = (id: ProbeId) => seen.get(id)?.ok === true;
  const toolUse =
    ok('auto_call') &&
    ok('tool_round_trip') &&
    ok('tool_choice_none') &&
    ok('truncated_call') &&
    ok('cancelled_stream');
  const cap = (v: boolean) => (v ? ('VERIFIED' as const) : ('NOT VERIFIED' as const));
  return {
    adapterId: adapter.id,
    contractVersion: adapter.contractVersion,
    model,
    approvalRef: approval.ref,
    startedAt,
    finishedAt: now().toISOString(),
    requests,
    totalTokens: total,
    ...(stopped ? { stoppedEarly: stopped } : {}),
    observations: PROBE_PLAN.map((s) => obs.find((o) => o.id === s.id)!),
    capabilities: {
      'tool-use': cap(toolUse),
      'parallel-tool-calls': cap(toolUse && ok('parallel_calls')),
      'streaming-tool-calls': cap(toolUse && ok('streamed_call')),
    },
    scope: 'this model, this adapter build, these requests, this moment',
  };
}
