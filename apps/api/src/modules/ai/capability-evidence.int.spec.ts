import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  AnthropicModelAdapter,
  CLAUDE_MODEL_ID,
  KIT_TOOLS,
  probeWorstCase,
  type ClaudeClient,
  type ClaudeContentBlock,
} from '@nuzm/adapter-model';
import { AI_CONFIG, GatewayService, loadAiConfig, type AiConfig } from './index';
import { setupAiEnv, type AiEnv } from './testing/ai-harness';
import { Db } from '@nuzm/platform';
import { DB } from '../../common/tokens';

/**
 * S-AG4b (decision D8 approved 2026-11-22; SCR-K-11 items 1-4): a REAL provider's tool-calling capability counts only from recorded, verified evidence. Scripted client, no
 * network: this proves the recording, the gating, the invalidation and the audit trail, not any live behaviour.
 */
let e: AiEnv;
let gw: GatewayService;
const A = () => e.org.A!;
const CODE = 'acme-llm'; // a real (non dev-reference) provider code that the test ROPA knows
const ADMIN = '/v1/admin/ai/model-providers';
let providerId = '';
let upstream = 0;
let content: ClaudeContentBlock[] = [{ type: 'text', text: 'ok' }];
let stop = 'end_turn';

const client = (): ClaudeClient => ({
  messages: {
    create: async () => {
      upstream += 1;
      return { content, stop_reason: stop, usage: { input_tokens: 40, output_tokens: 12 } };
    },
    stream: () => {
      throw new Error('not used');
    },
  },
});
const adapter = (contract: '1.0' | '1.1' = '1.1', version?: string) => {
  const a = new AnthropicModelAdapter({
    getApiKey: async () => `test-only-${'k5Rv'.repeat(8)}`,
    contract,
    clientFactory: client,
  });
  if (version) Object.defineProperty(a, 'contractVersion', { value: version });
  return a;
};
const act = (body: object, who = 'padmin') => e.admin(who, 'POST', ADMIN, body);
const record = (capability: string, state: string, extra: object = {}, who = 'padmin') =>
  act(
    {
      action: 'record_capability_evidence',
      id: providerId,
      model: CLAUDE_MODEL_ID,
      capability,
      state,
      evidenceRef: 'probe-report-2026-11-22#1',
      ...extra,
    },
    who,
  );
const tools = [...KIT_TOOLS];
const call = (over: Partial<Parameters<GatewayService['invoke']>[0]> = {}) => ({
  orgId: A(),
  task: 'edit',
  capability: 'chat' as const,
  dataClass: 'customer-content' as const,
  messages: [{ role: 'user' as const, content: 'edit the page' }],
  maxTokens: 300,
  callId: `c-${uuidv7()}`,
  ...over,
});
const withTools = (over: Partial<Parameters<GatewayService['invoke']>[0]> = {}) =>
  call({ tools, ...over });
const publicModel = async () =>
  ((await e.call('alice', 'GET', '/v1/ai/models')).json().items as Record<string, unknown>[]).find(
    (m) => m.modelId === CLAUDE_MODEL_ID,
  );

async function enableWith(a: AnthropicModelAdapter) {
  e.registry.register(CODE, a);
  const c = await act({
    action: 'configure',
    code: CODE,
    adapter: 'acme',
    displayName: 'Acme LLM',
    region: 'sa-central',
    rateCard: {
      models: {
        [CLAUDE_MODEL_ID]: {
          creditsPerMillionInput: '1000000',
          creditsPerMillionOutput: '2000000',
        },
      },
    },
    rateCardVersion: 'ev-1',
  });
  expect(c.statusCode).toBe(200);
  providerId = c.json().id as string;
  await act({
    action: 'attest',
    id: providerId,
    attestationRef: 'TEST-ATTEST-EV',
    dataTerms: { retainsPrompts: false, trainsOnData: false },
  });
  await act({ action: 'request_enable', id: providerId });
  const en = await act({ action: 'enable', id: providerId }, 'padmin2');
  expect(en.statusCode).toBe(200);
}

beforeAll(async () => {
  e = await setupAiEnv();
  gw = e.app.get(GatewayService);
  await e.fund(A(), '50000000');
  const s = await e.h.platformUser(e.app, 'psupport', ['support']);
  e.jars.psupport = s.jar;
  await enableWith(adapter());
}, 120_000);
afterAll(() => e.h.close());

describe('no evidence, no declaration (unknown = unsupported)', () => {
  it('a real provider with a candidate 1.1 adapter is offered for ordinary calls but NOT for tools: 422, and the provider is never called', async () => {
    upstream = 0;
    await expect(gw.invoke(withTools())).rejects.toMatchObject({ code: 'unsupported_capability' });
    expect(upstream).toBe(0);
    await expect(gw.invoke(call())).resolves.toMatchObject({ finishReason: 'stop' });
    expect(upstream).toBe(1);
  });
  it('the public model list says so: supportsTools is false and no capability string leaks', async () => {
    const m = await publicModel();
    expect(m).toMatchObject({ providerCode: CODE, supportsTools: false });
    expect(JSON.stringify(m!.capabilities)).not.toMatch(/tool/);
  });
});

describe('recording evidence (admin:ai:approve, audited, append-only)', () => {
  it('is validated: unknown model, capability, state, thin reference; an adapter on 1.0 cannot be verified; a dependent capability needs tool-use first', async () => {
    for (const bad of [
      { model: 'nope' },
      { capability: 'vision' },
      { state: 'MAYBE' },
      { evidenceRef: 'x' },
    ])
      expect((await record('tool-use', 'VERIFIED', bad)).statusCode).toBe(422);
    const parallel = await record('parallel-tool-calls', 'VERIFIED');
    expect(parallel.statusCode).toBe(409);
    expect(parallel.json().code).toBe('invalid_state');
    expect((await act({ action: 'record_capability_evidence', id: uuidv7() })).statusCode).toBe(
      404,
    );
  });
  it('needs the approve permission: a read-only platform role and an organization user are refused; nothing is written', async () => {
    const before = Number(
      (await e.sql(`SELECT count(*)::int n FROM ai.model_capability_evidence`))[0]!.n,
    );
    expect((await record('tool-use', 'VERIFIED', {}, 'psupport')).statusCode).toBe(403);
    expect(
      (await e.call('alice', 'POST', ADMIN, { action: 'record_capability_evidence' })).statusCode,
    ).toBeGreaterThanOrEqual(401);
    expect(
      Number((await e.sql(`SELECT count(*)::int n FROM ai.model_capability_evidence`))[0]!.n),
    ).toBe(before);
  });
  it('a VERIFIED tool-use row turns tools on for that model: the call is served, the provider list shows the evidence, the public list says supportsTools, and it is audited', async () => {
    const r = await record('tool-use', 'VERIFIED');
    expect(r.statusCode).toBe(200);
    expect(r.json().capabilityEvidence).toEqual([
      expect.objectContaining({
        model: CLAUDE_MODEL_ID,
        capability: 'tool-use',
        state: 'VERIFIED',
        contractVersion: '1.1.0',
        evidenceRef: 'probe-report-2026-11-22#1',
      }),
    ]);
    expect(r.json()).toMatchObject({ contractVersion: '1.1.0', liveCallsApproved: false });
    content = [{ type: 'tool_use', id: 'toolu_1', name: 'echo', input: { text: 'hi' } }];
    stop = 'tool_use';
    const out = await gw.invoke(withTools({ maxToolCalls: 1 }));
    expect(out).toMatchObject({ finishReason: 'tool_calls', toolCalls: [{ name: 'echo' }] });
    expect(await publicModel()).toMatchObject({ supportsTools: true });
    const ev = e.sink.events.find((x) => x.action === 'ai.provider.capability_evidence_recorded');
    expect(ev).toMatchObject({
      outcome: 'success',
      detail: { capability: 'tool-use', state: 'VERIFIED', contractVersion: '1.1.0' },
    });
    expect(JSON.stringify(ev)).not.toMatch(/test-only/);
  });
  it('parallel calls need their own evidence: until then a request for two calls is refused, afterwards it is served', async () => {
    content = [
      { type: 'tool_use', id: 'toolu_a', name: 'echo', input: { text: 'a' } },
      { type: 'tool_use', id: 'toolu_b', name: 'lookup', input: { key: 'k' } },
    ];
    await expect(gw.invoke(withTools({ maxToolCalls: 2 }))).rejects.toMatchObject({
      code: 'unsupported_capability',
    });
    expect((await record('parallel-tool-calls', 'VERIFIED')).statusCode).toBe(200);
    const r = await gw.invoke(withTools({ maxToolCalls: 2 }));
    expect(r.toolCalls).toHaveLength(2);
  });
  it('the history is append-only: the latest row wins, the older rows stay, and the application role cannot change or delete them', async () => {
    expect(
      (await record('tool-use', 'VERIFIED', { evidenceRef: 'probe-report-2026-11-22#2' }))
        .statusCode,
    ).toBe(200);
    const rows = await e.sql(
      `SELECT state, evidence_ref FROM ai.model_capability_evidence WHERE provider_id=$1 AND capability='tool-use' ORDER BY recorded_at, id`,
      [providerId],
    );
    expect(rows.map((x) => x.evidence_ref)).toEqual([
      'probe-report-2026-11-22#1',
      'probe-report-2026-11-22#2',
    ]);
    const listed = (await e.admin('padmin', 'GET', ADMIN)).json();
    const row = (
      listed.items as {
        code: string;
        capabilityEvidence: { capability: string; evidenceRef: string }[];
      }[]
    ).find((x) => x.code === CODE)!;
    expect(row.capabilityEvidence.find((x) => x.capability === 'tool-use')!.evidenceRef).toBe(
      'probe-report-2026-11-22#2',
    );
    const db = e.app.get<Db>(DB);
    await expect(
      db.withPlatformScope((c) =>
        c.query(`UPDATE ai.model_capability_evidence SET state='VERIFIED'`),
      ),
    ).rejects.toThrow();
    await expect(
      db.withPlatformScope((c) => c.query(`DELETE FROM ai.model_capability_evidence`)),
    ).rejects.toThrow();
  });
});

describe('a declaration is withdrawn when the evidence says so or no longer applies', () => {
  it('a NOT VERIFIED tool-use row withdraws tools, and dependent capabilities stop counting with it', async () => {
    expect(
      (await record('tool-use', 'NOT VERIFIED', { evidenceRef: 'probe-report-2026-11-23#1' }))
        .statusCode,
    ).toBe(200);
    upstream = 0;
    await expect(gw.invoke(withTools({ maxToolCalls: 2 }))).rejects.toMatchObject({
      code: 'unsupported_capability',
    });
    await expect(gw.invoke(withTools())).rejects.toMatchObject({ code: 'unsupported_capability' });
    expect(upstream).toBe(0);
    expect(await publicModel()).toMatchObject({ supportsTools: false });
    expect(
      (await record('tool-use', 'VERIFIED', { evidenceRef: 'probe-report-2026-11-24#1' }))
        .statusCode,
    ).toBe(200);
    content = [{ type: 'tool_use', id: 'toolu_1', name: 'echo', input: { text: 'hi' } }];
    await expect(gw.invoke(withTools({ maxToolCalls: 1 }))).resolves.toMatchObject({
      finishReason: 'tool_calls',
    });
  });
  it('evidence is for one adapter contract: a different build of the adapter no longer inherits it', async () => {
    e.registry.register(CODE, adapter('1.1', '1.2.0'));
    upstream = 0;
    await expect(gw.invoke(withTools({ maxToolCalls: 1 }))).rejects.toMatchObject({
      code: 'unsupported_capability',
    });
    expect(upstream).toBe(0);
    e.registry.register(CODE, adapter());
    await expect(gw.invoke(withTools({ maxToolCalls: 1 }))).resolves.toMatchObject({
      finishReason: 'tool_calls',
    });
  });
  it('an adapter that implements only contract 1.0 can never be verified', async () => {
    e.registry.register(CODE, adapter('1.0'));
    const r = await record('tool-use', 'VERIFIED');
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('unsupported_capability');
    e.registry.register(CODE, adapter());
  });
});

describe('the live probe action is part of the contract but not available (D9)', () => {
  it('validates the request, audits the refusal and sends nothing', async () => {
    upstream = 0;
    const worst = probeWorstCase().totalTokens;
    expect((await act({ action: 'probe_tool_use', id: providerId })).statusCode).toBe(422);
    expect(
      (
        await act({
          action: 'probe_tool_use',
          id: providerId,
          approvalRef: 'D9-x',
          maxTotalTokens: worst - 1,
        })
      ).statusCode,
    ).toBe(422);
    const r = await act({
      action: 'probe_tool_use',
      id: providerId,
      approvalRef: 'D9-x',
      maxTotalTokens: worst,
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('unsupported_capability');
    expect(upstream).toBe(0);
    expect(
      e.sink.events.some(
        (x) => x.action === 'ai.provider.probe_refused' && x.outcome === 'failure',
      ),
    ).toBe(true);
    expect(
      (
        await act(
          { action: 'probe_tool_use', id: providerId, approvalRef: 'D9-x', maxTotalTokens: worst },
          'psupport',
        )
      ).statusCode,
    ).toBe(403);
  });
});

describe('the bounded probe wrapper (D9) runs only behind every gate, with the scripted client (no network)', () => {
  const worst = () => probeWorstCase().totalTokens;
  const approval = {
    ref: 'D9-test-approval',
    approvedBy: 'Test Owner',
    environment: 'non-production' as const,
    maxRequests: 8,
    maxTotalTokens: 20_000,
  };
  const probe = (extra: object = {}, who = 'padmin') =>
    act(
      {
        action: 'probe_tool_use',
        id: providerId,
        model: CLAUDE_MODEL_ID,
        approvalRef: approval.ref,
        maxTotalTokens: worst(),
        ...extra,
      },
      who,
    );
  const reasons = () =>
    e.sink.events
      .filter((x) => x.action === 'ai.provider.probe_refused')
      .map((x) => (x.detail as { reason?: string }).reason);
  let cfg: AiConfig;
  let saved: { probeApprovals: AiConfig['probeApprovals']; liveProviders: string[] };
  beforeAll(() => {
    cfg = e.app.get(AI_CONFIG);
    saved = { probeApprovals: cfg.probeApprovals, liveProviders: cfg.liveProviders };
  });
  afterAll(() => {
    cfg.probeApprovals = saved.probeApprovals;
    cfg.liveProviders = saved.liveProviders;
  });
  it('without a recorded approval (D9) it is refused, whatever else is open', async () => {
    cfg.probeApprovals = [];
    cfg.liveProviders = [CODE];
    upstream = 0;
    expect((await probe()).statusCode).toBe(422);
    expect(reasons()).toContain('not_approved_d9');
    expect(upstream).toBe(0);
  });
  it('with the approval but a closed live gate (D3) it is refused and nothing is sent', async () => {
    cfg.probeApprovals = [approval];
    cfg.liveProviders = [];
    upstream = 0;
    expect((await probe()).statusCode).toBe(422);
    expect(reasons()).toContain('live_gate_closed_d3');
    expect(upstream).toBe(0);
  });
  it('a read-only platform role is refused (403) even with every gate open', async () => {
    cfg.probeApprovals = [approval];
    cfg.liveProviders = [CODE];
    upstream = 0;
    expect((await probe({}, 'psupport')).statusCode).toBe(403);
    expect(upstream).toBe(0);
  });
  it('a real provider without a credential reference is refused (D4) even with the other gates open', async () => {
    cfg.probeApprovals = [approval];
    cfg.liveProviders = [CODE];
    upstream = 0;
    expect((await probe()).statusCode).toBe(422);
    expect(reasons()).toContain('no_credential_d4');
    expect(upstream).toBe(0);
  });
  it('with every gate open it runs the bounded script once, stays inside the approved caps, records NOT VERIFIED when the model does not call tools, and audits start and finish', async () => {
    cfg.probeApprovals = [approval];
    cfg.liveProviders = [CODE];
    upstream = 0;
    await e.sql(
      `UPDATE ai.model_providers SET vault_ref = 'vault://test/acme-probe' WHERE id = $1`,
      [providerId],
    ); // the credential reference of a stored key (the value is never in the row)
    const r = await probe();
    expect(r.statusCode).toBe(200);
    expect(upstream).toBeGreaterThan(0);
    expect(upstream).toBeLessThanOrEqual(approval.maxRequests); // no retries, never more than approved
    const rows = (await e.sql(
      `SELECT capability, state, evidence_ref FROM ai.model_capability_evidence WHERE provider_id = $1 ORDER BY recorded_at DESC LIMIT 3`,
      [providerId],
    )) as { capability: string; state: string; evidence_ref: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.state).toBe('NOT VERIFIED'); // the scripted client answers in plain text: nothing is claimed
      expect(row.evidence_ref).toContain(approval.ref);
    }
    const actions = e.sink.events.map((x) => x.action);
    expect(actions).toContain('ai.provider.probe_started');
    expect(actions).toContain('ai.provider.probe_finished');
    const finished = e.sink.events.find((x) => x.action === 'ai.provider.probe_finished')!;
    expect(JSON.stringify(finished.detail)).not.toMatch(/test-only|apiKey/); // no key, no content
    // the gateway still refuses tools: NOT VERIFIED evidence declares nothing
    await expect(gw.invoke(withTools())).rejects.toMatchObject({ code: 'unsupported_capability' });
  });
  it('the request can lower the token cap but not raise it above the approval, and a cap below the worst case is refused', async () => {
    cfg.probeApprovals = [{ ...approval, maxTotalTokens: worst() }];
    cfg.liveProviders = [CODE];
    upstream = 0;
    expect((await probe({ maxTotalTokens: worst() - 1 })).statusCode).toBe(422);
    expect(upstream).toBe(0);
  });
  it('AI_PROBE_APPROVALS is parsed fail-closed: malformed, partial or production values give no approval', async () => {
    expect(loadAiConfig({ AI_PROBE_APPROVALS: 'not json' } as never).probeApprovals).toEqual([]);
    expect(
      loadAiConfig({ AI_PROBE_APPROVALS: JSON.stringify([{ ref: 'x' }]) } as never).probeApprovals,
    ).toEqual([]);
    expect(
      loadAiConfig({
        NODE_ENV: 'production',
        AI_PROBE_APPROVALS: JSON.stringify([approval]),
      } as never).probeApprovals,
    ).toEqual([]);
    expect(
      loadAiConfig({ AI_PROBE_APPROVALS: JSON.stringify([approval]) } as never).probeApprovals,
    ).toHaveLength(1);
  });
});

describe('dev-reference providers keep what their adapter declares (no evidence needed)', () => {
  it('a mock-* provider still serves tools without any evidence row', async () => {
    const { MockModelAdapter, MOCK_TOOL_MODELS, mockToolArrange } =
      await import('@nuzm/adapter-model');
    const mock = new MockModelAdapter({
      id: 'mock-tools',
      models: [...new MockModelAdapter().models(), ...MOCK_TOOL_MODELS],
    });
    mockToolArrange(mock, 'single');
    await e.sql(
      `UPDATE ai.model_providers SET enabled=false, enabled_by=NULL, enabled_at=NULL, enable_requested_by=NULL`,
    );
    await e.enableMock('mock-model', { adapter: mock });
    await expect(gw.invoke(withTools())).resolves.toMatchObject({ finishReason: 'tool_calls' });
  });
});
