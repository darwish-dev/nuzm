import { describe, expect, it } from 'vitest';
import { routeModels, validateToolCalls, type Candidate } from './index';

const decls = [
  {
    name: 'echo',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string', maxLength: 5 } },
    },
  },
  { name: 'ping', inputSchema: { type: 'object' } },
];

describe('validateToolCalls', () => {
  it('passes calls whose tool is declared and whose arguments satisfy its schema', () => {
    const r = validateToolCalls(decls, [
      { id: '1', name: 'echo', args: { text: 'hi' } },
      { id: '2', name: 'ping', args: {} },
    ]);
    expect(r.rejected).toEqual([]);
    expect(r.valid.map((c) => c.id)).toEqual(['1', '2']);
  });
  it('rejects, with reasons and without throwing: an undeclared tool, a missing or wrong-typed or oversized argument, an extra member', () => {
    const r = validateToolCalls(decls, [
      { id: 'a', name: 'rm_rf', args: {} },
      { id: 'b', name: 'echo', args: {} },
      { id: 'c', name: 'echo', args: { text: 5 } },
      { id: 'd', name: 'echo', args: { text: 'toolong' } },
      { id: 'e', name: 'echo', args: { text: 'ok', extra: 1 } },
      { id: 'f', name: 'echo', args: 'not an object' },
      { id: 'g', name: 'echo', args: { text: 'ok' } },
    ]);
    expect(r.valid.map((c) => c.id)).toEqual(['g']);
    expect(r.rejected.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(r.rejected[0]!.reasons[0]).toMatch(/not declared/);
    expect(r.rejected.every((c) => c.reasons.length >= 1 && c.reasons.length <= 5)).toBe(true);
  });
  it('a tool declared with a prototype-like name is just a name', () => {
    expect(
      validateToolCalls(
        [{ name: 'constructor', inputSchema: { type: 'object' } }],
        [
          { id: '1', name: 'constructor', args: {} },
          { id: '2', name: '__proto__', args: {} },
        ],
      ).valid.map((c) => c.id),
    ).toEqual(['1']);
  });
  it('an empty request has nothing valid and nothing rejected', () => {
    expect(validateToolCalls(decls, [])).toEqual({ valid: [], rejected: [] });
  });
});

describe('routing with additional required capabilities', () => {
  const cand = (id: string, caps: Candidate['capabilities']): Candidate => ({
    providerCode: 'p',
    modelId: id,
    region: 'sa',
    capabilities: caps,
    contextTokens: 10_000,
    maxOutputTokens: 1_000,
    latencyClass: 'low',
    dataTerms: { attested: true, retainsPrompts: false, trainsOnData: false },
    rate: { creditsPerMillionInput: '1', creditsPerMillionOutput: '1' } as Candidate['rate'],
  });
  const req = {
    capability: 'chat' as const,
    promptTokens: 10,
    maxTokens: 10,
    dataClass: 'public' as const,
    residency: { p: 'allow' as const },
    reservableCredits: null,
  };
  const reserve = () => 1n;
  it('without alsoRequires nothing changes for any existing caller', () => {
    const r = routeModels(req, [cand('a', ['chat'])], reserve);
    expect(r.ranked).toHaveLength(1);
  });
  it('a model must declare every additional capability, otherwise it is excluded for capability', () => {
    const r = routeModels(
      { ...req, alsoRequires: ['tool-use'] },
      [cand('a', ['chat']), cand('b', ['chat', 'tool-use'])],
      reserve,
    );
    expect(r.ranked.map((x) => x.candidate.modelId)).toEqual(['b']);
    expect(r.excluded).toEqual([{ providerCode: 'p', modelId: 'a', reason: 'capability' }]);
    const both = routeModels(
      { ...req, alsoRequires: ['tool-use', 'streaming-tool-calls'] },
      [cand('b', ['chat', 'tool-use'])],
      reserve,
    );
    expect(both.ranked).toEqual([]);
  });
});
