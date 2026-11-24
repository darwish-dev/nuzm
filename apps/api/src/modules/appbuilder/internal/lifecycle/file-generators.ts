import { builderTools } from '@nuzm/domain';
import { StepFailure, type FileGenerator, type FileOp, type Usage } from './lifecycle.types';

const L = builderTools.lifecycle;

/** The default generator: deterministic placeholder files, no model, no tokens. Its output is labelled (`SKELETON`) and every report says it was simulated. */
export class SkeletonGenerator implements FileGenerator {
  readonly kind = 'skeleton' as const;
  async generate(
    input: builderTools.lifecycle.GenerationInput,
    current: ReadonlyMap<string, string>,
  ): Promise<{ ops: FileOp[]; note?: string }> {
    return { ops: L.skeletonOps(input.task, new Set(current.keys())) };
  }
}

/**
 * A generator that asks a model. `complete` is the ONLY thing that talks to a model (the API wires it to the metered gateway, which applies residency, budget, secret scan and the
 * untrusted-content rules); it returns the model's text and the usage of the call. One repair of a reply that does not parse is allowed, then the task fails: a model cannot loop here.
 */
export class ModelFileGenerator implements FileGenerator {
  readonly kind = 'model' as const;
  constructor(
    private readonly fence: string,
    private readonly complete: (
      message: string,
      signal?: AbortSignal,
    ) => Promise<{ text: string; usage: Usage }>,
    private readonly onUsage: (u: Usage) => void,
  ) {}
  async generate(
    input: builderTools.lifecycle.GenerationInput,
    current: ReadonlyMap<string, string>,
    signal?: AbortSignal,
  ): Promise<{ ops: FileOp[]; note?: string }> {
    let message = L.generationMessage(this.fence, input);
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.complete(message, signal);
      this.onUsage(r.usage);
      const ops = L.opsFromGeneration(r.text, input.task, current);
      if (ops.ok) return { ops: ops.ops, note: ops.note };
      message = `${L.generationMessage(this.fence, input)}\n\nYour previous reply was rejected: ${ops.errors.slice(0, 3).join('; ')}. Reply with the JSON proposal only.`;
    }
    throw new StepFailure('invalid_model_output');
  }
}
