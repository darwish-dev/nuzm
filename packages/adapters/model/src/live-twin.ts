import { MockModelAdapter, MOCK_TOOL_MODELS, MOCK_TOOL_MODEL_ID } from './mock';
import type { CompleteRequest } from './types';
import type { LiveTarget, VendorUsage } from './live-verification';

/**
 * The MOCK TWIN of the live-verification suite: a scripted `MockModelAdapter` that answers the suite's constant prompts the way a well-behaved provider would. The SAME suite
 * (`runLiveVerification`) runs against this twin now and against the real adapter later; a pass here proves the suite and our plumbing, NEVER anything about a real provider, and every
 * result it produces is labelled `simulated`. The prices are SYNTHETIC (they exercise the money arithmetic; they are not the vendor's).
 */
export const TWIN_PRICING = {
  currency: 'USD',
  inputPerMillion: '4.00',
  outputPerMillion: '20.00',
} as const;

function lastText(req: CompleteRequest): string {
  const m = req.messages[0];
  return m?.content ?? '';
}
const hasToolResult = (req: CompleteRequest) =>
  req.messages.some((m) => m.blocks?.some((b) => b.type === 'tool_result'));

export function createLiveTwin(id = 'mock-live-twin'): MockModelAdapter {
  const a = new MockModelAdapter({
    id,
    models: MOCK_TOOL_MODELS,
    pricing: TWIN_PRICING,
    handler: (req) => {
      const t = lastText(req);
      if (req.responseFormat === 'json') return '{"ok":true}';
      if (t.includes('slugify'))
        return "```ts\nexport function slugify(input: string): string {\n  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n}\n```";
      if (t.includes('`sum('))
        return '```ts\nexport function sum(values: number[]): number {\n  let total = 0;\n  for (const v of values) total += v;\n  return total;\n}\n```';
      if (t.includes('numbers'))
        return 'one two three four five six seven eight nine ten '.repeat(8);
      if (t.includes('exactly the word')) return 'ok';
      return `mock reply (${req.task ?? 'chat'})`;
    },
    toolHandler: (req) => {
      const t = lastText(req);
      if (hasToolResult(req)) return { text: 'The tool returned probe.' };
      if (req.maxTokens <= 16)
        return { calls: [{ name: 'echo', args: { text: 'y'.repeat(400) } }] }; // cut off at the ceiling: the mock drops the call
      if (req.toolChoice && typeof req.toolChoice === 'object')
        return { calls: [{ name: req.toolChoice.name, args: { key: 'alpha' } }] };
      if (t.includes('same turn'))
        return {
          calls: [
            { name: 'echo', args: { text: 'a' } },
            { name: 'lookup', args: { key: 'b' } },
          ],
        };
      return { calls: [{ name: 'echo', args: { text: 'probe' } }] };
    },
  });
  a.chunkDelayMs = 0;
  return a;
}

/** A target wired for the twin; `fallback` is a second twin (an approved stand-in), `vendorUsage` sums what the twin itself reported. */
export function twinTarget(
  opts: { withFallback?: boolean; vendorUsage?: () => Promise<VendorUsage | null> } = {},
): { target: LiveTarget; primary: MockModelAdapter; fallback: MockModelAdapter } {
  const primary = createLiveTwin('mock-live-twin');
  const fallback = createLiveTwin('mock-live-twin-b');
  const target: LiveTarget = {
    adapter: primary,
    model: MOCK_TOOL_MODEL_ID,
    mode: 'mock',
    ...(opts.withFallback === false
      ? {}
      : { fallback: { adapter: fallback, model: MOCK_TOOL_MODEL_ID } }),
    ...(opts.vendorUsage ? { vendorUsage: opts.vendorUsage } : {}),
  };
  return { target, primary, fallback };
}
