import { builderTools } from '@nuzm/domain';
import { describe, expect, it } from 'vitest';
import { ModelFileGenerator, SkeletonGenerator } from './file-generators';
import { StepFailure, type Usage } from './lifecycle.types';

const plan = builderTools.planning.planFromText(
  'A booking site for a barber shop with a contact form',
);
const task = plan.tasks.find((t) => t.files.length >= 1)!;
const input = { plan, task, existingPaths: [], excerpts: [], memory: '', requirement: 'x' };
const reply = (paths: string[]) =>
  JSON.stringify({
    summary: 'ok',
    patches: paths.map((p) => ({ op: 'add', path: p, content: 'export {};\n' })),
  });

describe('SkeletonGenerator', () => {
  it('writes labelled placeholders for missing paths only and uses no tokens', async () => {
    const g = new SkeletonGenerator();
    expect(g.kind).toBe('skeleton');
    const out = await g.generate(input, new Map([[task.files[0]!, 'keep']]));
    expect(out.ops.map((o) => o.path)).not.toContain(task.files[0]);
    expect(out.ops.every((o) => o.op === 'add' && o.content!.length > 0)).toBe(true);
  });
});

describe('ModelFileGenerator', () => {
  it('asks once, reports the usage, and returns only the ops inside the task', async () => {
    const usage: Usage[] = [];
    const g = new ModelFileGenerator(
      'FENCE',
      async () => ({
        text: reply([task.files[0]!, 'src/not-mine.ts']),
        usage: { tokensIn: 10, tokensOut: 5, credits: '2' },
      }),
      (u) => usage.push(u),
    );
    const out = await g.generate(input, new Map());
    expect(out.ops.map((o) => o.path)).toEqual([task.files[0]]);
    expect(usage).toEqual([{ tokensIn: 10, tokensOut: 5, credits: '2' }]);
  });
  it('one repair of a reply that does not parse (both calls are accounted), then a non-transient failure', async () => {
    const usage: Usage[] = [];
    let calls = 0;
    const messages: string[] = [];
    const fixing = new ModelFileGenerator(
      'F',
      async (m) => {
        messages.push(m);
        return {
          text: ++calls === 1 ? 'not json' : reply([task.files[0]!]),
          usage: { tokensIn: 1, tokensOut: 1 },
        };
      },
      (u) => usage.push(u),
    );
    expect((await fixing.generate(input, new Map())).ops).toHaveLength(1);
    expect(calls).toBe(2);
    expect(usage).toHaveLength(2);
    expect(messages[1]).toContain('rejected');
    // the rejection text is fixed wording, never the model's own output
    expect(messages[1]).not.toContain('not json');

    const stuck = new ModelFileGenerator(
      'F',
      async () => ({ text: 'nope', usage: {} }),
      () => undefined,
    );
    await expect(stuck.generate(input, new Map())).rejects.toMatchObject({
      code: 'invalid_model_output',
    });
    await expect(stuck.generate(input, new Map())).rejects.toBeInstanceOf(StepFailure);
  });
  it('a failing model call is not swallowed', async () => {
    const g = new ModelFileGenerator(
      'F',
      async () => Promise.reject(new Error('down')),
      () => undefined,
    );
    await expect(g.generate(input, new Map())).rejects.toThrow('down');
  });
});
