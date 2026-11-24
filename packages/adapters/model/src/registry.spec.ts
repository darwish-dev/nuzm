import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicModelAdapter, CLAUDE_MODEL_ID } from './anthropic';
import {
  buildCapabilityRegistry,
  explainCapabilities,
  reconcileDiscovery,
  resolveCapabilities,
  type RegistryProviderInput,
} from './registry';
import { effectiveCapabilities, type ModelCapability, type ModelInfo } from './types';

const V10 = '1.0.0';
const V11 = '1.1.0';
const ALL: ModelCapability[] = ['chat', 'structured-output', 'long-context', 'tool-use', 'streaming-tool-calls', 'parallel-tool-calls'];
const none = () => undefined;

describe('resolveCapabilities (the rule the gateway relies on)', () => {
  it('a 1.0 adapter keeps exactly its 1.0 capabilities, whatever the model declares', () => {
    expect(resolveCapabilities({ contractVersion: V10, declared: ALL, devReference: false, verifiedContract: none })).toEqual(['chat', 'structured-output', 'long-context']);
    expect(resolveCapabilities({ contractVersion: V10, declared: ALL, devReference: true, verifiedContract: () => V11 })).toEqual(['chat', 'structured-output', 'long-context']);
  });
  it('a real 1.1 provider gets tool capabilities only from VERIFIED evidence for the CURRENT contract', () => {
    const r = (ev: (c: ModelCapability) => string | undefined) =>
      resolveCapabilities({ contractVersion: V11, declared: ALL, devReference: false, verifiedContract: ev });
    expect(r(none)).toEqual(['chat', 'structured-output', 'long-context']);
    expect(r((c) => (c === 'tool-use' ? V11 : undefined))).toEqual(['chat', 'structured-output', 'long-context', 'tool-use']);
    expect(r(() => V10)).toEqual(['chat', 'structured-output', 'long-context']); // evidence for an older contract does not count
    expect(r(() => V11)).toEqual(ALL);
  });
  it('streamed and parallel calls never count without tool-use, even with evidence', () => {
    const r = resolveCapabilities({
      contractVersion: V11,
      declared: ['chat', 'streaming-tool-calls', 'parallel-tool-calls'],
      devReference: false,
      verifiedContract: () => V11,
    });
    expect(r).toEqual(['chat']);
  });
  it('a development reference provider keeps what it declares under 1.1', () => {
    expect(resolveCapabilities({ contractVersion: V11, declared: ALL, devReference: true, verifiedContract: none })).toEqual(ALL);
  });
  it('agrees with effectiveCapabilities for every combination when no evidence filtering applies (dev reference)', () => {
    const subsets: ModelCapability[][] = [[], ['chat'], ['tool-use'], ['chat', 'tool-use'], ['parallel-tool-calls'], ALL];
    for (const contract of [V10, V11, 'garbage', '2.0.0'])
      for (const declared of subsets)
        expect(resolveCapabilities({ contractVersion: contract, declared, devReference: true, verifiedContract: none })).toEqual(
          effectiveCapabilities(contract, declared),
        );
  });
  it('explains every capability with a reason', () => {
    const e = explainCapabilities({ contractVersion: V11, declared: ['chat', 'tool-use', 'parallel-tool-calls'], devReference: false, verifiedContract: (c) => (c === 'tool-use' ? V11 : c === 'parallel-tool-calls' ? V10 : undefined) });
    const by = Object.fromEntries(e.map((x) => [x.capability, x]));
    expect(by['chat']).toMatchObject({ effective: true, basis: 'adapter_declared' });
    expect(by['tool-use']).toMatchObject({ effective: true, basis: 'evidence_verified' });
    expect(by['parallel-tool-calls']).toMatchObject({ effective: false, declared: true, basis: 'evidence_other_contract' });
    expect(by['streaming-tool-calls']).toMatchObject({ effective: false, declared: false, basis: 'not_declared' });
    expect(by['vision']).toMatchObject({ basis: 'not_declared' });
    const old = explainCapabilities({ contractVersion: V10, declared: ['tool-use'], devReference: false, verifiedContract: none });
    expect(old.find((x) => x.capability === 'tool-use')).toMatchObject({ effective: false, basis: 'contract_too_old' });
    const nt = explainCapabilities({ contractVersion: V11, declared: ['parallel-tool-calls'], devReference: false, verifiedContract: () => V11 });
    expect(nt.find((x) => x.capability === 'parallel-tool-calls')).toMatchObject({ effective: false, basis: 'needs_tool_use' });
    const none11 = explainCapabilities({ contractVersion: V11, declared: ['tool-use'], devReference: false, verifiedContract: none });
    expect(none11.find((x) => x.capability === 'tool-use')).toMatchObject({ basis: 'no_evidence' });
  });
});

describe('buildCapabilityRegistry', () => {
  const info = (modelId: string, capabilities: ModelCapability[]): ModelInfo => ({ modelId, capabilities, contextTokens: 1000, maxOutputTokens: 100, latencyClass: 'low' });
  const input: RegistryProviderInput[] = [
    { providerCode: 'claude', providerId: 'p1', contractVersion: V11, enabled: false, models: [info('m1', ALL)], rateCard: {}, evidence: new Map([['p1|m1|tool-use', V11]]) },
    { providerCode: 'mock-a', providerId: 'p0', contractVersion: V11, enabled: true, models: [info('z', ALL), info('a', ['chat'])], rateCard: { z: { creditsPerMillionInput: '1', creditsPerMillionOutput: '2' } }, evidence: new Map() },
  ];
  it('lists every model (priced or not, enabled or not) with effective and pending capabilities, sorted', () => {
    const r = buildCapabilityRegistry(input);
    expect(r.map((e) => `${e.providerCode}/${e.modelId}`)).toEqual(['claude/m1', 'mock-a/a', 'mock-a/z']);
    const claude = r[0]!;
    expect(claude).toMatchObject({ providerEnabled: false, priced: false });
    expect(claude.effective).toEqual(['chat', 'structured-output', 'long-context', 'tool-use']);
    expect(claude.pending).toEqual(['streaming-tool-calls', 'parallel-tool-calls']);
    expect(r[2]).toMatchObject({ priced: true, providerEnabled: true, pending: [] });
    expect(r[1]).toMatchObject({ priced: false });
  });
  it('an empty registry is empty', () => expect(buildCapabilityRegistry([])).toEqual([]));
});

describe('reconcileDiscovery', () => {
  it('separates confirmed, unlisted-by-vendor and not-declared models, and never offers the unknown ones', () => {
    const r = reconcileDiscovery(
      [{ modelId: 'a' }, { modelId: 'b' }],
      [{ modelId: 'b' }, { modelId: 'c', displayName: 'C' }, { modelId: 'a' }, { modelId: 'a0' }],
    );
    expect(r).toEqual({
      confirmed: ['a', 'b'],
      unlistedByVendor: [],
      notDeclared: [{ modelId: 'a0' }, { modelId: 'c', displayName: 'C' }],
    });
    expect(reconcileDiscovery([{ modelId: 'a' }], [])).toMatchObject({ unlistedByVendor: ['a'], confirmed: [], notDeclared: [] });
  });
});

describe('Claude model discovery (stubbed fetch, no real call)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const KEY = `test-only-${'q9Zx'.repeat(8)}`;
  const stub = (body: unknown, status = 200) => {
    const calls: { url: string; auth: string | null }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      }),
    );
    return calls;
  };
  const make = (liveEnabled?: () => boolean, key: string | null = KEY) =>
    new AnthropicModelAdapter({ getApiKey: async () => key, ...(liveEnabled ? { liveEnabled } : {}) });
  it('is refused before anything is sent while the live gate is closed', async () => {
    const calls = stub({ data: [] });
    await expect(make(() => false).discoverModels({ callId: 'd' })).rejects.toMatchObject({ code: 'unavailable', retryable: false });
    expect(calls).toHaveLength(0);
  });
  it('without a key it fails closed and sends nothing', async () => {
    const calls = stub({ data: [] });
    await expect(make(undefined, null).discoverModels({ callId: 'd' })).rejects.toMatchObject({ code: 'unavailable' });
    expect(calls).toHaveLength(0);
  });
  it('an aborted signal sends nothing', async () => {
    const calls = stub({ data: [] });
    const ac = new AbortController();
    ac.abort();
    await expect(make().discoverModels({ callId: 'd', signal: ac.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(calls).toHaveLength(0);
  });
  it('reads one bounded page from the fixed host, sanitises ids and clips names', async () => {
    const calls = stub({
      data: [
        { id: CLAUDE_MODEL_ID, display_name: 'Claude', created_at: '2026-01-01T00:00:00Z', type: 'model' },
        { id: 'bad id with spaces', display_name: 'x' },
        { id: 'new-model', display_name: 'n'.repeat(500) },
        { id: 42 },
      ],
      has_more: false,
    });
    const found = await make().discoverModels({ callId: 'd' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.startsWith('https://api.anthropic.com/v1/models')).toBe(true);
    expect(calls[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(found.map((m) => m.modelId)).toEqual([CLAUDE_MODEL_ID, 'new-model']);
    expect(found[1]!.displayName).toHaveLength(120);
    const rec = reconcileDiscovery(make().models(), found);
    expect(rec.confirmed).toEqual([CLAUDE_MODEL_ID]);
    expect(rec.notDeclared.map((m) => m.modelId)).toEqual(['new-model']);
  });
  it('maps provider errors without leaking the key or the upstream message', async () => {
    stub({ type: 'error', error: { type: 'x', message: `leak ${KEY}` } }, 401);
    const e = (await make().discoverModels({ callId: 'd' }).catch((x: unknown) => x)) as Error;
    expect(e).toMatchObject({ code: 'invalid_request' });
    expect(e.message).not.toContain(KEY);
  });
});
