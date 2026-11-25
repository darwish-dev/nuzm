import { describe, expect, it } from 'vitest';
import type { Schema } from '@nuzm/domain';
import { runAgent, type AgentCallDeps } from './agent-call';
import { AgentOutputInvalid, type AgentCall, type RunRow } from './run-kinds';

const SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['businessName', 'languages'],
  properties: {
    businessName: { type: 'string', minLength: 1, maxLength: 80 },
    languages: { type: 'array', minItems: 1, items: { enum: ['ar', 'en'] } },
  },
};
const run = {
  id: 'r1',
  orgId: 'o1',
  projectId: 'p1',
  kind: 'website',
  budget: {},
  createdBy: null,
} as unknown as RunRow;

/** A recording stand-in for the gateway: it answers from a script and keeps what it was asked. */
function setup(answers: string[]) {
  const seen: { role: string; content: string }[][] = [];
  const events: string[] = [];
  let i = 0;
  const deps = {
    gateway: {
      invoke: async (c: { messages: { role: string; content: string }[] }) => {
        seen.push(c.messages.map((m) => ({ ...m })));
        return { text: answers[Math.min(i++, answers.length - 1)] };
      },
    },
    audit: { record: async () => undefined },
    cfg: { canaries: [] },
    emit: async (t: string) => void events.push(t),
  } as unknown as AgentCallDeps;
  return { deps, seen, events };
}
const call: AgentCall = {
  task: 'requirements',
  instruction: 'Do it.',
  schema: SCHEMA,
  maxTokens: 500,
};

describe('agent call prompt', () => {
  it('tells the model the exact shape of the result, so a real model need not guess the property names', async () => {
    const { deps, seen } = setup([
      '{"result":{"businessName":"Acme","languages":["ar"]},"toolCalls":[]}',
    ]);
    const out = await runAgent<{ businessName: string }>(
      deps,
      run,
      'website',
      call,
      () => 'c1',
      undefined,
    );
    expect(out.businessName).toBe('Acme');
    const system = seen[0]!.find((m) => m.role === 'system')!.content;
    expect(system).toContain('SCHEMA:');
    expect(system).toContain('"businessName"');
    expect(system).toContain('"additionalProperties":false');
    expect(system).toContain('add no other properties');
  });
  it('still repairs an answer with invented properties (up to two repairs), then fails', async () => {
    const bad = '{"result":{"projectSummary":"x"},"toolCalls":[]}';
    const { deps, events } = setup([bad, bad, bad]);
    const e = await runAgent(deps, run, 'website', call, () => 'c', undefined).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(AgentOutputInvalid);
    expect((e as AgentOutputInvalid).errors.join(' ')).toContain('projectSummary');
    expect(events.filter((e) => e === 'repair')).toHaveLength(3);
  });
  it('with repairs set to 0 the model is asked exactly once: an invalid answer fails without a second request', async () => {
    const bad = '{"result":{"projectSummary":"x"},"toolCalls":[]}';
    const { deps, seen } = setup([bad, bad, bad]);
    (deps.cfg as { repairAttempts?: number }).repairAttempts = 0;
    const e = await runAgent(deps, run, 'website', call, () => 'c', undefined).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(AgentOutputInvalid);
    expect(seen).toHaveLength(1);
  });
  it('feeds a caller-side check back through the repair loop, so the model fixes its own answer', async () => {
    const wrong = '{"result":{"businessName":"X","languages":["ar"]},"toolCalls":[]}';
    const right = '{"result":{"businessName":"Acme","languages":["ar"]},"toolCalls":[]}';
    const { deps, seen, events } = setup([wrong, right]);
    const out = await runAgent<{ businessName: string }>(
      deps,
      run,
      'website',
      {
        ...call,
        check: (r) =>
          (r as { businessName: string }).businessName.length < 2
            ? ['businessName is too short for this site']
            : [],
      },
      () => 'c',
      undefined,
    );
    expect(out.businessName).toBe('Acme');
    expect(events.filter((e) => e === 'repair')).toHaveLength(1);
    expect(seen[1]!.at(-1)!.content).toContain('businessName is too short for this site');
  });
});
