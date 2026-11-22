import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicModelAdapter,
  CLAUDE_MODEL_ID,
  MOCK_TOOL_MODELS,
  MockModelAdapter,
  ModelAdapterError,
  PROBE_PLAN,
  PROBE_TOOLS,
  ProbeRefused,
  probeWorstCase,
  runCapabilityProbe,
  type ClaudeClient,
  type ClaudeContentBlock,
  type ClaudeMessage,
  type ClaudeStreamEvent,
  type ProbeApproval,
} from './index';

/**
 * The probe harness is exercised ONLY with scripted clients: it has never run against a live provider and nothing here opens a socket (a counting `fetch` proves it).
 */
const W = probeWorstCase();
const approval = (o: Partial<ProbeApproval> = {}): ProbeApproval => ({
  ref: 'D9-test-approval',
  approvedBy: 'owner',
  environment: 'non-production',
  maxRequests: W.requests,
  maxTotalTokens: W.totalTokens,
  ...o,
});

interface Behaviour {
  /** serial-only model: never more than one call */
  serial?: boolean;
  /** never calls a tool */
  noTools?: boolean;
  /** ignores tool_choice none */
  ignoresNone?: boolean;
  /** tokens reported per call */
  usage?: { in: number; out: number };
  /** throw on the n-th request (1-based) */
  failAt?: { n: number; error: unknown };
  /** a stream that ignores cancellation */
  streamIgnoresAbort?: boolean;
}
const seenPrompts: string[] = [];
let requestsMade = 0;
function model(b: Behaviour = {}) {
  const reply = (params: Record<string, unknown>): ClaudeMessage => {
    requestsMade += 1;
    if (b.failAt && requestsMade === b.failAt.n) throw b.failAt.error;
    const messages = params.messages as { role: string; content: unknown }[];
    const first = messages[0]!.content;
    seenPrompts.push(typeof first === 'string' ? first : JSON.stringify(first));
    const last = messages.at(-1)!.content as ClaudeContentBlock[] | string;
    const choice = params.tool_choice as
      { type?: string; name?: string; disable_parallel_tool_use?: boolean } | undefined;
    const max = params.max_tokens as number;
    const usage = { input_tokens: b.usage?.in ?? 300, output_tokens: b.usage?.out ?? 40 };
    const text = (t: string, stop = 'end_turn'): ClaudeMessage => ({
      content: [{ type: 'text', text: t }],
      stop_reason: stop,
      usage,
    });
    const call = (id: string, name: string, input: unknown): ClaudeContentBlock => ({
      type: 'tool_use',
      id,
      name,
      input,
    });
    if (Array.isArray(last) && last.some((x) => x.type === 'tool_result'))
      return text('The tool returned probe.');
    if (b.noTools || (choice?.type === 'none' && !b.ignoresNone))
      return text('I will not call a tool.');
    if (max <= 16) return text('Using the', 'max_tokens'); // cut off: a real model never completes a call here
    if (choice?.type === 'tool')
      return {
        content: [call('toolu_f', choice.name!, { key: 'alpha' })],
        stop_reason: 'tool_use',
        usage,
      };
    if (
      String(typeof first === 'string' ? first : '').includes('same turn') &&
      !b.serial &&
      !choice?.disable_parallel_tool_use
    )
      return {
        content: [
          call('toolu_p1', 'echo', { text: 'a' }),
          call('toolu_p2', 'lookup', { key: 'b' }),
        ],
        stop_reason: 'tool_use',
        usage,
      };
    if (String(typeof first === 'string' ? first : '').includes('numbers'))
      return text('one two three four five six seven eight nine ten '.repeat(3));
    return {
      content: [call('toolu_1', 'echo', { text: 'probe' })],
      stop_reason: 'tool_use',
      usage,
    };
  };
  const events = (m: ClaudeMessage): ClaudeStreamEvent[] =>
    m.content.flatMap((blk, index): ClaudeStreamEvent[] =>
      blk.type === 'text'
        ? [
            { type: 'content_block_start', index, content_block: { type: 'text' } },
            ...(blk.text ?? '').match(/.{1,3}/g)!.map((t): ClaudeStreamEvent => ({
              type: 'content_block_delta',
              index,
              delta: { type: 'text_delta', text: t },
            })),
            { type: 'content_block_stop', index },
          ]
        : [
            {
              type: 'content_block_start',
              index,
              content_block: { type: 'tool_use', id: blk.id, name: blk.name },
            },
            {
              type: 'content_block_delta',
              index,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(blk.input) },
            },
            { type: 'content_block_stop', index },
          ],
    );
  const client: ClaudeClient = {
    messages: {
      create: async (p) => reply(p),
      stream: (p, o) => {
        const m = reply(p);
        const it = (async function* () {
          for (const e of events(m)) {
            if (o?.signal?.aborted && !b.streamIgnoresAbort)
              throw Object.assign(new Error('x'), { name: 'APIUserAbortError' });
            await new Promise((r) => setTimeout(r, 1));
            yield e;
          }
        })();
        return Object.assign(it, { finalMessage: async () => m });
      },
    },
  };
  return new AnthropicModelAdapter({
    getApiKey: async () => 'test-only-key-0123456789abcdef',
    contract: '1.1',
    clientFactory: () => client,
  });
}

describe('the plan and its worst case (shown to the approver)', () => {
  it('is eight small requests, no retries, and the worst case is a computable number', () => {
    expect(PROBE_PLAN).toHaveLength(8);
    expect(W.requests).toBe(8);
    expect(W.totalTokens).toBe(PROBE_PLAN.reduce((n, s) => n + s.maxTokens + 1200, 0));
    expect(Math.max(...PROBE_PLAN.map((s) => s.maxTokens))).toBeLessThanOrEqual(400);
  });
  it('the prompts and tools are constants of the module: nothing of a customer can be in a probe request', async () => {
    requestsMade = 0;
    seenPrompts.length = 0;
    await runCapabilityProbe(model(), CLAUDE_MODEL_ID, approval());
    const allowed = new Set(PROBE_PLAN.map((s) => s.prompt));
    for (const p of seenPrompts) expect([...allowed].some((a) => p.includes(a))).toBe(true);
    expect(PROBE_TOOLS.map((t) => t.name)).toEqual(['echo', 'lookup']);
    const src = readFileSync(join(__dirname, 'probe.ts'), 'utf8');
    expect(src).not.toMatch(/process\.env\.(?!NODE_ENV)/); // no environment switch can start it
    expect(src).not.toMatch(/\bfetch\s*\(|require\(|child_process/); // no network, no process
  });
});

describe('refusals happen before anything is sent', () => {
  const sendsNothing = async (
    a: Parameters<typeof runCapabilityProbe>[0],
    m: string,
    ap: ProbeApproval | undefined,
  ) => {
    requestsMade = 0;
    await expect(runCapabilityProbe(a, m, ap as ProbeApproval)).rejects.toBeInstanceOf(
      ProbeRefused,
    );
    expect(requestsMade).toBe(0);
  };
  it('no approval, a thin reference, no approver, a production environment, caps below the worst case', async () => {
    const a = model();
    await sendsNothing(a, CLAUDE_MODEL_ID, undefined);
    await sendsNothing(a, CLAUDE_MODEL_ID, approval({ ref: 'x' }));
    await sendsNothing(a, CLAUDE_MODEL_ID, approval({ approvedBy: ' ' }));
    await sendsNothing(a, CLAUDE_MODEL_ID, approval({ environment: 'production' as never }));
    await sendsNothing(a, CLAUDE_MODEL_ID, approval({ maxRequests: 7 }));
    await sendsNothing(a, CLAUDE_MODEL_ID, approval({ maxTotalTokens: W.totalTokens - 1 }));
    await sendsNothing(a, 'unknown-model', approval());
  });
  it('a production process never runs it, even with an approval', async () => {
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await sendsNothing(model(), CLAUDE_MODEL_ID, approval());
    } finally {
      process.env.NODE_ENV = was;
    }
  });
  it('an adapter on contract 1.0 (no candidate declaration) is refused', async () => {
    const old = new AnthropicModelAdapter({ getApiKey: async () => 'k'.repeat(24) });
    await expect(runCapabilityProbe(old, CLAUDE_MODEL_ID, approval())).rejects.toBeInstanceOf(
      ProbeRefused,
    );
  });
});

describe('what it records', () => {
  it('a model that behaves: all three capabilities VERIFIED within the approved bounds, eight requests, no retry', async () => {
    requestsMade = 0;
    const r = await runCapabilityProbe(model(), CLAUDE_MODEL_ID, approval());
    expect(r.observations.map((o) => [o.id, o.ok])).toEqual(PROBE_PLAN.map((s) => [s.id, true]));
    expect(r.capabilities).toEqual({
      'tool-use': 'VERIFIED',
      'parallel-tool-calls': 'VERIFIED',
      'streaming-tool-calls': 'VERIFIED',
    });
    expect(r.requests).toBe(8);
    expect(requestsMade).toBe(8);
    expect(r.totalTokens).toBeLessThanOrEqual(W.totalTokens);
    expect(r.stoppedEarly).toBeUndefined();
    expect(r.approvalRef).toBe('D9-test-approval');
    expect(r.scope).toMatch(/this moment/);
  });
  it('a serial-only model keeps tool-use but not parallel calls; one that never calls tools verifies nothing; one that ignores "none" verifies nothing', async () => {
    expect(
      (await runCapabilityProbe(model({ serial: true }), CLAUDE_MODEL_ID, approval())).capabilities,
    ).toEqual({
      'tool-use': 'VERIFIED',
      'parallel-tool-calls': 'NOT VERIFIED',
      'streaming-tool-calls': 'VERIFIED',
    });
    expect(
      (await runCapabilityProbe(model({ noTools: true }), CLAUDE_MODEL_ID, approval()))
        .capabilities['tool-use'],
    ).toBe('NOT VERIFIED');
    expect(
      (await runCapabilityProbe(model({ ignoresNone: true }), CLAUDE_MODEL_ID, approval()))
        .capabilities['tool-use'],
    ).toBe('NOT VERIFIED');
  });
  it('a stream that ignores cancellation is a failure that blocks tool-use', async () => {
    const r = await runCapabilityProbe(
      model({ streamIgnoresAbort: true }),
      CLAUDE_MODEL_ID,
      approval(),
    );
    expect(r.observations.find((o) => o.id === 'cancelled_stream')!.ok).toBe(false);
    expect(r.capabilities['tool-use']).toBe('NOT VERIFIED');
  });
  it('the token total is enforced while running: a model that reports huge usage stops the probe, and a partial probe verifies nothing', async () => {
    const r = await runCapabilityProbe(
      model({ usage: { in: 4000, out: 3000 } }),
      CLAUDE_MODEL_ID,
      approval(),
    );
    expect(r.stoppedEarly).toBe('token_cap');
    expect(r.requests).toBeLessThan(8);
    expect(r.totalTokens).toBeLessThanOrEqual(approval().maxTotalTokens + 7000);
    expect(r.observations.filter((o) => !o.ran).length).toBeGreaterThan(0);
    expect(Object.values(r.capabilities)).toEqual(['NOT VERIFIED', 'NOT VERIFIED', 'NOT VERIFIED']);
  });
  it('a credential problem or a rate limit stops it at once: nothing is hammered, nothing is thrown', async () => {
    requestsMade = 0;
    const r1 = await runCapabilityProbe(
      model({ failAt: { n: 1, error: Object.assign(new Error('x'), { status: 400 }) } }),
      CLAUDE_MODEL_ID,
      approval(),
    );
    expect(r1.stoppedEarly).toBe('credential_or_availability');
    expect(requestsMade).toBe(1);
    requestsMade = 0;
    const r2 = await runCapabilityProbe(
      model({
        failAt: {
          n: 2,
          error: Object.assign(new Error('rate'), { status: 429, name: 'RateLimitError' }),
        },
      }),
      CLAUDE_MODEL_ID,
      approval(),
    );
    expect(
      r2.stoppedEarly === 'rate_limited' || r2.stoppedEarly === 'credential_or_availability',
    ).toBe(true);
    expect(requestsMade).toBeLessThanOrEqual(2);
    expect(JSON.stringify(r2)).not.toContain('rate'.repeat(2));
  });
  it('a closed live gate (the adapter refuses) is recorded as a stop, and no request was sent', async () => {
    const closed = new AnthropicModelAdapter({
      getApiKey: async () => 'k'.repeat(24),
      contract: '1.1',
      liveEnabled: () => false,
      clientFactory: () => {
        throw new Error('must not be built');
      },
    });
    const r = await runCapabilityProbe(closed, CLAUDE_MODEL_ID, approval());
    expect(r.stoppedEarly).toBe('credential_or_availability');
    expect(r.requests).toBe(1);
    expect(r.capabilities['tool-use']).toBe('NOT VERIFIED');
  });
  it('an abort signal stops the probe', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runCapabilityProbe(model(), CLAUDE_MODEL_ID, approval(), { signal: ac.signal });
    expect(r.stoppedEarly).toBe('aborted');
    expect(r.requests).toBe(0);
  });
  it('the report carries fixed sentences only: no provider message, no key', async () => {
    const r = await runCapabilityProbe(
      model({
        failAt: {
          n: 3,
          error: Object.assign(new Error('SECRET provider text sk-ant-xyz'), { status: 500 }),
        },
      }),
      CLAUDE_MODEL_ID,
      approval(),
    );
    expect(JSON.stringify(r)).not.toMatch(/SECRET|sk-ant|test-only-key/);
  });
});

describe('provider-neutral: the same harness drives any adapter (here the scripted mock)', () => {
  it('a mock that scripts every step passes it, and no network is touched', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    try {
      const mock = new MockModelAdapter({
        models: MOCK_TOOL_MODELS,
        toolHandler: (req) => {
          const msgs = req.messages;
          const lastBlocks = msgs.at(-1)!.blocks ?? [];
          if (lastBlocks.some((b) => b.type === 'tool_result')) return { text: 'ok' };
          if (req.maxTokens <= 16) return { text: 'cut' };
          if (typeof req.toolChoice === 'object')
            return { calls: [{ name: req.toolChoice.name, args: { key: 'alpha' } }] };
          if (msgs[0]!.content.includes('same turn'))
            return {
              calls: [
                { name: 'echo', args: { text: 'a' } },
                { name: 'lookup', args: { key: 'b' } },
              ],
            };
          if (msgs[0]!.content.includes('numbers'))
            return { text: 'one two three four five six seven eight nine ten '.repeat(5) };
          return { calls: [{ name: 'echo', args: { text: 'probe' } }] };
        },
        chunkDelayMs: 1,
      });
      const r = await runCapabilityProbe(mock, 'mock-tools-1', approval());
      expect(r.capabilities['tool-use']).toBe('VERIFIED');
      expect(f).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('ModelAdapterError is the only failure shape it interprets', () => {
    expect(new ModelAdapterError('timeout', 'x').retryable).toBe(true);
  });
});
