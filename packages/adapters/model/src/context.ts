import { estimateTokens, type ModelInfo, type ModelMessage } from './types';

/**
 * Context management (S-AG4, gap G6): fit a conversation into a model's window BEFORE the call, without breaking what the provider API requires.
 * PURE: no network, no model-specific tokenizer (the estimate is the contract's `estimateTokens`; a provider-reported count always wins at settlement).
 *
 * Rules:
 *  - system messages at the head, the FIRST user turn (the task statement) and the LAST turn (the newest user message and, when it answers tool calls, the assistant message that made them) are pinned: never dropped;
 *  - everything else is dropped OLDEST FIRST in atomic units: an assistant message with tool calls and the user message that carries their results go together,
 *    so the provider never sees an unanswered call or an orphan result (both are refused by the API);
 *  - the conversation must still start with a user message after the system head: leading assistant turns are dropped too;
 *  - nothing is rewritten except an optional clip of very long tool results (reported); a pinned part that alone does not fit is reported, never cut.
 */
export interface FitOptions {
  /** the model's total window (input + output) */
  contextTokens: number;
  /** the output tokens the call will ask for (`maxTokens`): they share the window */
  maxTokens: number;
  /** headroom for the estimate's error (default 3% of the window, at least 64 tokens) */
  safetyTokens?: number;
  /** token estimator (default: the contract's deterministic estimate) */
  count?: (messages: ModelMessage[]) => number;
  /** clip tool-result text longer than this many characters (keeps the start and the end); default: no clipping */
  maxToolResultChars?: number;
}
export interface FitResult {
  messages: ModelMessage[];
  /** `true` when `messages` fits `budgetTokens`; when `false` the pinned part alone is too large and `messages` is the pinned part */
  fits: boolean;
  promptTokens: number;
  budgetTokens: number;
  droppedMessages: number;
  clippedToolResults: number;
  /** why it does not fit, when it does not */
  reason?: 'no_room_for_prompt' | 'pinned_part_too_large';
}

/** The prompt budget of a call: window − requested output − safety. Never negative. */
export function promptBudget(
  model: Pick<ModelInfo, 'contextTokens' | 'maxOutputTokens'>,
  maxTokens: number,
  safetyTokens?: number,
): number {
  const safety = safetyTokens ?? Math.max(64, Math.ceil(model.contextTokens * 0.03));
  return Math.max(0, model.contextTokens - maxTokens - safety);
}

const hasCalls = (m: ModelMessage): boolean =>
  m.role === 'assistant' && (m.blocks ?? []).some((b) => b.type === 'tool_call');
const hasResults = (m: ModelMessage): boolean =>
  m.role === 'user' && (m.blocks ?? []).some((b) => b.type === 'tool_result');

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(0, max - 40);
  const head = Math.ceil(keep * 0.7);
  const tail = keep - head;
  return `${text.slice(0, head)}\n[… ${text.length - head - tail} characters clipped …]\n${tail > 0 ? text.slice(text.length - tail) : ''}`;
}

export function fitContext(messages: readonly ModelMessage[], o: FitOptions): FitResult {
  const count = o.count ?? estimateTokens;
  const safety = o.safetyTokens ?? Math.max(64, Math.ceil(o.contextTokens * 0.03));
  const budget = Math.max(0, o.contextTokens - o.maxTokens - safety);
  if (!Number.isInteger(o.contextTokens) || !Number.isInteger(o.maxTokens) || o.maxTokens < 1)
    throw new RangeError('contextTokens and maxTokens must be positive integers');

  let clipped = 0;
  const work: ModelMessage[] = messages.map((m) => {
    const max = o.maxToolResultChars;
    if (max === undefined || !m.blocks?.some((b) => b.type === 'tool_result' && b.content.length > max))
      return m;
    return {
      ...m,
      blocks: m.blocks.map((b) => {
        if (b.type !== 'tool_result' || b.content.length <= max) return b;
        clipped++;
        return { ...b, content: clip(b.content, max) };
      }),
    };
  });

  // head: the leading system messages (pinned)
  let h = 0;
  while (h < work.length && work[h]!.role === 'system') h++;
  const head = work.slice(0, h);
  const rest = work.slice(h);

  // atomic units, oldest first
  const units: ModelMessage[][] = [];
  for (let i = 0; i < rest.length; i++) {
    const m = rest[i]!;
    const next = rest[i + 1];
    if (hasCalls(m) && next && hasResults(next)) {
      units.push([m, next]);
      i++;
    } else units.push([m]);
  }
  if (units.length === 0) {
    const t = count(head);
    return { messages: head, fits: t <= budget, promptTokens: t, budgetTokens: budget, droppedMessages: 0, clippedToolResults: clipped, ...(t <= budget ? {} : { reason: 'pinned_part_too_large' as const }) };
  }

  const pinnedLast = units[units.length - 1]!;
  // the task statement (the first user turn) is pinned too, so a trimmed conversation still says what was asked and opens with a user message
  const pinnedFirst = units.length > 1 && units[0]![0]!.role === 'user' ? units[0]! : [];
  const droppable = units.slice(pinnedFirst.length > 0 ? 1 : 0, -1);
  const total = () => count([...head, ...pinnedFirst, ...droppable.flat(), ...pinnedLast]);

  let dropped = 0;
  while (droppable.length > 0 && total() > budget) dropped += droppable.shift()!.length;
  // without a pinned opening user turn the conversation must still open with a user turn: a leading assistant unit (its partner was dropped) goes too
  while (pinnedFirst.length === 0 && droppable.length > 0 && droppable[0]![0]!.role !== 'user')
    dropped += droppable.shift()!.length;

  const kept = [...head, ...pinnedFirst, ...droppable.flat(), ...pinnedLast];
  const tokens = count(kept);
  if (tokens <= budget)
    return {
      messages: kept,
      fits: true,
      promptTokens: tokens,
      budgetTokens: budget,
      droppedMessages: dropped,
      clippedToolResults: clipped,
    };
  const pinnedOnly = [...head, ...pinnedFirst, ...pinnedLast];
  const pt = count(pinnedOnly);
  return {
    messages: pinnedOnly,
    fits: false,
    promptTokens: pt,
    budgetTokens: budget,
    droppedMessages: dropped + droppable.reduce((n, u) => n + u.length, 0),
    clippedToolResults: clipped,
    reason: budget === 0 ? 'no_room_for_prompt' : 'pinned_part_too_large',
  };
}
