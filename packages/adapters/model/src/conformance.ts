import {
  MODEL_CONTRACT_VERSION_1_1,
  ModelAdapterError,
  V1_1_CAPABILITIES,
  contractAtLeast,
  type CallContext,
  type CompleteRequest,
  type ModelAdapter,
  type ModelInfo,
  type ModelMessage,
  type ToolSpec,
} from './types';
import { StreamAssembler, allowedToolCalls, normalizeModelError } from './tools';

export interface ConformanceCase {
  name: string;
  ok: boolean;
  detail?: string;
  /** a case that could not run (e.g. tool behaviour without a scenario driver): reported, never counted as a pass of the behaviour */
  skipped?: boolean;
}

/** The tool calling scenarios of contract 1.1 the kit drives. A scenario driver (`arrange`) makes the adapter under test behave accordingly: a scripted mock sets its handler, a LIVE provider driver (S-AG4) prompts the real model with a forced tool choice. */
export type ToolScenario = 'single' | 'parallel' | 'none' | 'malformed' | 'undeclared' | 'long';
export interface ConformanceOptions {
  tools?: {
    arrange(
      adapter: ModelAdapter,
      scenario: ToolScenario,
      tools: readonly ToolSpec[],
    ): void | Promise<void>;
  };
}
/** The tools the kit offers; any adapter's scenario driver must make the model call these by name. */
export const KIT_TOOLS: readonly ToolSpec[] = [
  {
    name: 'echo',
    description: 'Return the given text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'lookup',
    description: 'Look a key up.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
      additionalProperties: false,
    },
  },
];
const DEC = /^\d+(\.\d+)?$/;

/**
 * Conformance suite for any `ModelAdapter` (mock or real). Returns every case with its outcome; the caller asserts that all passed.
 * A real provider additionally needs a LIVE-VERIFIED probe: this suite proves the CONTRACT shape only (it never proves quality or live availability).
 */
export async function runModelConformance(
  make: () => ModelAdapter,
  opts: ConformanceOptions = {},
): Promise<ConformanceCase[]> {
  const out: ConformanceCase[] = [];
  const check = async (name: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
      out.push({ name, ok: true });
    } catch (e) {
      out.push({ name, ok: false, detail: (e as Error).message });
    }
  };
  const need = (c: boolean, m: string) => {
    if (!c) throw new Error(m);
  };
  const a = make();
  const model = a.models()[0]?.modelId ?? '';
  const ctx = (id: string): CallContext => ({ callId: id });
  const req = { model, messages: [{ role: 'user' as const, content: 'hello' }], maxTokens: 64 };

  await check('declares id, kind, contract version, region', () => {
    need(
      a.kind === 'model' && !!a.id && !!a.contractVersion && !!a.region,
      'identity fields missing',
    );
  });
  await check('declares data terms with explicit flags (unknown allowed, absent not)', () => {
    const t = a.dataTerms;
    need(typeof t.attested === 'boolean', 'attested');
    need(
      t.retainsPrompts === true || t.retainsPrompts === false || t.retainsPrompts === 'unknown',
      'retainsPrompts',
    );
    need(
      t.trainsOnData === true || t.trainsOnData === false || t.trainsOnData === 'unknown',
      'trainsOnData',
    );
    need(!t.attested || !!t.attestationRef, 'attested terms need an attestation reference');
    need(!!t.processingRegion, 'processingRegion');
  });
  await check('pricing is decimal strings, never floats', () => {
    need(
      DEC.test(a.pricing.inputPerMillion) && DEC.test(a.pricing.outputPerMillion),
      'pricing must be decimal strings',
    );
  });
  await check('lists at least one model with positive limits', () => {
    const m = a.models();
    need(m.length > 0, 'no models');
    for (const x of m)
      need(
        x.contextTokens > 0 && x.maxOutputTokens > 0 && x.maxOutputTokens <= x.contextTokens,
        `limits of ${x.modelId}`,
      );
  });
  await check(
    'complete returns text, finish reason and usage-or-null within maxTokens',
    async () => {
      const r = await a.complete(ctx('c1'), req);
      need(typeof r.text === 'string' && r.model === model, 'shape');
      need(['stop', 'length', 'refusal'].includes(r.finishReason), 'finishReason');
      if (r.usage)
        need(
          r.usage.outputTokens <= req.maxTokens && r.usage.inputTokens >= 0,
          'usage within maxTokens',
        );
    },
  );
  await check('maxTokens is a hard ceiling', async () => {
    const r = await a.complete(ctx('c2'), { ...req, maxTokens: 1 });
    if (r.usage) need(r.usage.outputTokens <= 1, 'output exceeded maxTokens');
  });
  await check('stream ends with exactly one done chunk and equals complete text', async () => {
    let text = '';
    let dones = 0;
    for await (const ch of a.stream(ctx('c3'), req)) {
      if ('delta' in ch) text += ch.delta;
      else dones++;
    }
    need(dones === 1, 'exactly one done chunk');
    const r = await a.complete(ctx('c4'), req);
    need(text === r.text, 'stream text differs from complete text for the same request');
  });
  await check('tokenCount is non-negative and monotonic', () => {
    const s = a.tokenCount(model, [{ role: 'user', content: 'a' }]);
    const l = a.tokenCount(model, [{ role: 'user', content: 'a'.repeat(4000) }]);
    need(s >= 0 && l > s, 'monotonic');
  });
  await check('an unknown model is a non-retryable invalid_request', async () => {
    try {
      await a.complete(ctx('c5'), { ...req, model: 'does-not-exist' });
      throw new Error('accepted an unknown model');
    } catch (e) {
      need(
        e instanceof ModelAdapterError && e.code === 'invalid_request' && !e.retryable,
        'must be invalid_request, not retryable',
      );
    }
  });
  await check('an aborted signal stops the call', async () => {
    const ac = new AbortController();
    ac.abort();
    try {
      await a.complete({ callId: 'c6', signal: ac.signal }, req);
      throw new Error('ignored the abort signal');
    } catch (e) {
      need(e instanceof ModelAdapterError && e.code === 'aborted', 'must be aborted');
    }
  });
  await contractV11Cases(make, opts, out, check, need);
  return out;
}

/** Contract 1.1 cases (D-46, SCR-K-10 §2). A 1.0 adapter must only satisfy the first group; the rest need a 1.1 adapter and, for behaviour, a scenario driver. */
async function contractV11Cases(
  make: () => ModelAdapter,
  opts: ConformanceOptions,
  out: ConformanceCase[],
  check: (name: string, fn: () => Promise<void> | void) => Promise<void>,
  need: (c: boolean, m: string) => void,
): Promise<void> {
  const a = make();
  const v11 = contractAtLeast(a.contractVersion, MODEL_CONTRACT_VERSION_1_1);
  const models = a.models();
  const toolModel: ModelInfo | undefined = models.find((m) => m.capabilities.includes('tool-use'));
  const plain = (id: string): CompleteRequest => ({
    model: models[0]!.modelId,
    messages: [{ role: 'user', content: `hello ${id}` }],
    maxTokens: 256,
  });

  await check('contract version is well-formed (major.minor.patch)', () => {
    need(/^\d+\.\d+\.\d+$/.test(a.contractVersion), `contractVersion ${a.contractVersion}`);
  });
  await check('capabilities are consistent with the declared contract', () => {
    for (const m of models) {
      const v = m.capabilities.filter((c) => V1_1_CAPABILITIES.includes(c));
      need(
        v11 || v.length === 0,
        `${m.modelId} declares ${v.join(',')} on contract ${a.contractVersion}`,
      );
      need(
        !(
          m.capabilities.includes('streaming-tool-calls') ||
          m.capabilities.includes('parallel-tool-calls')
        ) || m.capabilities.includes('tool-use'),
        `${m.modelId}: streaming or parallel tool calls without tool-use`,
      );
    }
  });
  if (!v11) {
    out.push({
      name: 'contract 1.1 behaviour',
      ok: true,
      skipped: true,
      detail: `the adapter implements ${a.contractVersion}; tool calling is not used with it`,
    });
    return;
  }
  const noTools = models.find((m) => !m.capabilities.includes('tool-use'));
  if (noTools)
    await check(
      'a tool request to a model without tool-use is a non-retryable unsupported_capability',
      async () => {
        try {
          await make().complete(
            { callId: 'k1' },
            { ...plain('x'), model: noTools.modelId, tools: [...KIT_TOOLS] },
          );
          throw new Error('accepted tools for a model that does not declare tool-use');
        } catch (e) {
          need(
            e instanceof ModelAdapterError && e.code === 'unsupported_capability' && !e.retryable,
            'must be unsupported_capability, not retryable',
          );
        }
      },
    );
  if (!toolModel) {
    out.push({
      name: 'tool calling behaviour',
      ok: true,
      skipped: true,
      detail: 'no model declares tool-use',
    });
    return;
  }
  const withTools = (extra: Partial<CompleteRequest> = {}): CompleteRequest => ({
    ...plain('t'),
    model: toolModel.modelId,
    tools: [...KIT_TOOLS],
    ...extra,
  });
  const rejects = async (req: CompleteRequest, code: string) => {
    try {
      await make().complete({ callId: 'kr' }, req);
      throw new Error('accepted an invalid tool request');
    } catch (e) {
      need(
        e instanceof ModelAdapterError && e.code === code && !e.retryable,
        `must be a non-retryable ${code}`,
      );
    }
  };
  await check('a malformed tool spec is a non-retryable invalid_request', async () => {
    await rejects(
      withTools({
        tools: [{ name: 'Bad Name', description: 'x', inputSchema: { type: 'object' } }],
      }),
      'invalid_request',
    );
    await rejects(
      withTools({ tools: [{ name: 'ok', description: '', inputSchema: { type: 'object' } }] }),
      'invalid_request',
    );
    await rejects(
      withTools({
        tools: [{ name: 'ok', description: 'x', inputSchema: { type: 'string' } as never }],
      }),
      'invalid_request',
    );
    await rejects(withTools({ tools: [KIT_TOOLS[0]!, KIT_TOOLS[0]!] }), 'invalid_request');
  });
  await check(
    'a toolChoice that names an undeclared tool is a non-retryable invalid_request',
    async () => {
      await rejects(withTools({ toolChoice: { name: 'nope' } }), 'invalid_request');
    },
  );
  const serial = models.find(
    (m) => m.capabilities.includes('tool-use') && !m.capabilities.includes('parallel-tool-calls'),
  );
  if (serial)
    await check(
      'asking for parallel calls from a model without parallel-tool-calls is unsupported_capability',
      async () => {
        await rejects(
          withTools({ model: serial.modelId, maxToolCalls: 2 }),
          'unsupported_capability',
        );
      },
    );

  const drive = opts.tools?.arrange;
  if (!drive) {
    out.push({
      name: 'tool calling behaviour',
      ok: true,
      skipped: true,
      detail: 'no scenario driver supplied (a live provider needs one: S-AG4)',
    });
    return;
  }
  const scenario = async (s: ToolScenario, model = toolModel) => {
    const ad = make();
    await drive(ad, s, KIT_TOOLS);
    return { ad, req: withTools({ model: model.modelId }) };
  };
  const sameCalls = (x: { name: string; args: unknown }[], y: { name: string; args: unknown }[]) =>
    JSON.stringify(x.map((c) => [c.name, c.args])) ===
    JSON.stringify(y.map((c) => [c.name, c.args]));

  await check(
    'a single tool call: declared tool, object arguments, unique id, finishReason tool_calls',
    async () => {
      const { ad, req } = await scenario('single');
      const r = await ad.complete({ callId: 'k-single' }, req);
      need(
        r.finishReason === 'tool_calls' && !!r.toolCalls && r.toolCalls.length === 1,
        'one tool call and finishReason tool_calls',
      );
      const c = r.toolCalls![0]!;
      need(
        KIT_TOOLS.some((t) => t.name === c.name) &&
          !!c.id &&
          typeof c.args === 'object' &&
          c.args !== null &&
          !Array.isArray(c.args),
        'declared name, id, object arguments',
      );
    },
  );
  await check('a stream assembles into the same tool calls as complete', async () => {
    const s1 = await scenario('single');
    const done = await s1.ad.complete({ callId: 'k-s1' }, s1.req);
    const s2 = await scenario('single');
    const asm = new StreamAssembler(KIT_TOOLS, allowedToolCalls(toolModel, s2.req));
    let dones = 0;
    for await (const ch of s2.ad.stream({ callId: 'k-s2' }, s2.req)) {
      asm.push(ch);
      if ('done' in ch) dones++;
    }
    need(dones === 1, 'exactly one done chunk');
    const r = asm.result();
    need(
      r.finishReason === 'tool_calls' && sameCalls(r.toolCalls ?? [], done.toolCalls ?? []),
      'the assembled calls differ from complete',
    );
  });
  await check('parallel calls: within the number the model allows, unique ids', async () => {
    const { ad, req } = await scenario('parallel');
    const r = await ad.complete({ callId: 'k-par' }, req);
    const n = r.toolCalls?.length ?? 0;
    need(
      n >= 1 && n <= allowedToolCalls(toolModel, req),
      `${n} calls where ${allowedToolCalls(toolModel, req)} are allowed`,
    );
    need(new Set((r.toolCalls ?? []).map((c) => c.id)).size === n, 'duplicate ids');
  });
  if (serial)
    await check('a model without parallel-tool-calls returns at most one call', async () => {
      const { ad, req } = await scenario('parallel', serial);
      const r = await ad.complete({ callId: 'k-ser' }, req);
      need((r.toolCalls?.length ?? 0) <= 1, 'more than one call from a serial model');
    });
  await check('no tool needed: a text answer without calls', async () => {
    const { ad, req } = await scenario('none');
    const r = await ad.complete({ callId: 'k-none' }, req);
    need(
      r.finishReason === 'stop' && !r.toolCalls?.length && typeof r.text === 'string',
      'text answer expected',
    );
  });
  await check('toolChoice none: no calls', async () => {
    const { ad, req } = await scenario('single');
    const r = await ad.complete({ callId: 'k-nochoice' }, { ...req, toolChoice: 'none' });
    need(
      !r.toolCalls?.length && r.finishReason !== 'tool_calls',
      'a call was made although toolChoice is none',
    );
  });
  await check(
    'malformed arguments are an invalid_response, in complete and in a stream',
    async () => {
      const m1 = await scenario('malformed');
      try {
        await m1.ad.complete({ callId: 'k-bad1' }, m1.req);
        throw new Error('accepted malformed arguments');
      } catch (e) {
        need(
          e instanceof ModelAdapterError && e.code === 'invalid_response' && !e.retryable,
          'complete must reject with invalid_response',
        );
      }
      const m2 = await scenario('malformed');
      const asm = new StreamAssembler(KIT_TOOLS);
      try {
        for await (const ch of m2.ad.stream({ callId: 'k-bad2' }, m2.req)) asm.push(ch);
        asm.result();
        throw new Error('the assembler accepted malformed arguments');
      } catch (e) {
        need(
          e instanceof ModelAdapterError && e.code === 'invalid_response',
          'the stream must end in invalid_response',
        );
      }
    },
  );
  await check('a call to an undeclared tool is an invalid_response', async () => {
    const u = await scenario('undeclared');
    try {
      await u.ad.complete({ callId: 'k-und' }, u.req);
      throw new Error('accepted a call to an undeclared tool');
    } catch (e) {
      need(
        e instanceof ModelAdapterError && e.code === 'invalid_response',
        'must be invalid_response',
      );
    }
  });
  await check('a tool-call and tool-result round trip is accepted and answered', async () => {
    const { ad, req } = await scenario('none');
    const messages: ModelMessage[] = [
      { role: 'user', content: 'use the tool' },
      {
        role: 'assistant',
        content: '',
        blocks: [{ type: 'tool_call', id: 'call_1', name: 'echo', args: { text: 'hi' } }],
      },
      {
        role: 'user',
        content: '',
        blocks: [{ type: 'tool_result', callId: 'call_1', content: 'hi' }],
      },
    ];
    const r = await ad.complete({ callId: 'k-rt' }, { ...req, messages });
    need(
      typeof r.text === 'string' && ['stop', 'length', 'tool_calls'].includes(r.finishReason),
      'shape',
    );
  });
  await check('cancelling in the middle of a stream ends it with aborted', async () => {
    const { ad, req } = await scenario('single');
    const ac = new AbortController();
    let chunks = 0;
    try {
      for await (const _ of ad.stream({ callId: 'k-cancel', signal: ac.signal }, req)) {
        if (++chunks === 1) ac.abort();
      }
      throw new Error('the stream ignored the abort');
    } catch (e) {
      need(e instanceof ModelAdapterError && e.code === 'aborted', 'must end with aborted');
    }
  });
  await check(
    'usage: within maxTokens when reported, and a response cut at the ceiling carries no tool call',
    async () => {
      const { ad, req } = await scenario('long');
      const r = await ad.complete({ callId: 'k-long' }, { ...req, maxTokens: 2 });
      if (r.usage) need(r.usage.outputTokens <= 2, 'output exceeded maxTokens');
      need(
        r.finishReason !== 'length' || !r.toolCalls?.length,
        'a truncated response must not carry tool calls',
      );
      const full = await scenario('single');
      const f = await full.ad.complete({ callId: 'k-use' }, full.req);
      if (f.usage)
        need(
          f.usage.inputTokens > 0 && f.usage.outputTokens > 0,
          'usage of a tool call must count tool tokens',
        );
    },
  );
  await check('error normalisation maps provider failures onto the contract codes', () => {
    const code = (e: unknown) => normalizeModelError(e).code;
    need(code({ name: 'AbortError' }) === 'aborted', 'abort');
    need(code({ status: 429 }) === 'rate_limited', '429');
    need(code({ status: 503 }) === 'unavailable', '503');
    need(code({ status: 400 }) === 'invalid_request', '400');
    need(code({ status: 408 }) === 'timeout', '408');
    need(
      normalizeModelError({ status: 429 }).retryable &&
        !normalizeModelError({ status: 400 }).retryable,
      'retry rules',
    );
    need(
      !normalizeModelError({ status: 500, message: 'sk-secret-123' }).message.includes('sk-secret'),
      'a provider message must not be carried',
    );
  });
}
