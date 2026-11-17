import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * Dunning policy (docs/11 §8): configuration, validated at load. A bad file refuses to start the process instead of silently changing when
 * customers are restricted. The stages are a closed list: the policy can move WHEN a stage happens, never add an action (in particular no
 * deletion: billing only emits requests that owning modules may act on).
 */
export const STAGES = [
  'overdue',
  'reminder_1',
  'reminder_2',
  'restricted',
  'suspended',
  'terminated_pending',
] as const;
export type DunningStage = (typeof STAGES)[number];
export const stageIndex = (s: DunningStage) => STAGES.indexOf(s);

export interface DunningPolicy {
  version: number;
  status: string;
  retryAfterDays: number[];
  stages: { stage: Exclude<DunningStage, 'overdue'>; afterDays: number }[];
}

export function parseDunningPolicy(text: string): DunningPolicy {
  const raw = parse(text) as Record<string, unknown> | null;
  const fail = (m: string): never => {
    throw new Error(`dunning policy: ${m}`);
  };
  if (!raw || typeof raw !== 'object') return fail('not a mapping');
  if (!Number.isInteger(raw.version) || (raw.version as number) < 1)
    fail('version must be a positive integer');
  if (typeof raw.status !== 'string' || raw.status.length < 3) fail('status is required');
  const retries = (raw.retries as { afterDays?: unknown } | undefined)?.afterDays;
  if (!Array.isArray(retries) || retries.length > 10)
    fail('retries.afterDays must be a list of at most 10 days');
  const retryDays = retries as unknown[];
  for (const d of retryDays)
    if (!Number.isInteger(d) || (d as number) < 1 || (d as number) > 90)
      fail('retry days must be integers 1..90');
  for (let i = 1; i < retryDays.length; i++)
    if ((retryDays[i] as number) <= (retryDays[i - 1] as number))
      fail('retry days must be strictly ascending');
  const stages = raw.stages;
  if (!Array.isArray(stages)) return fail('stages must be a list');
  const expected = STAGES.slice(1);
  if (stages.length !== expected.length)
    fail(`stages must be exactly: ${expected.join(', ')}, in that order`);
  let prev = 0;
  const out: DunningPolicy['stages'] = [];
  stages.forEach((s: { stage?: unknown; afterDays?: unknown }, i) => {
    if (s.stage !== expected[i]) fail(`stage ${i + 1} must be ${expected[i]}`);
    if (
      !Number.isInteger(s.afterDays) ||
      (s.afterDays as number) <= prev ||
      (s.afterDays as number) > 365
    )
      fail(`afterDays of ${String(s.stage)} must be an integer, ascending, at most 365`);
    for (const k of Object.keys(s))
      if (k !== 'stage' && k !== 'afterDays')
        fail(`unknown key ${k} in stage ${String(s.stage)} (a policy cannot add actions)`);
    prev = s.afterDays as number;
    out.push({ stage: s.stage as DunningPolicy['stages'][number]['stage'], afterDays: prev });
  });
  const restricted = out.find((s) => s.stage === 'restricted')!.afterDays;
  if (retryDays.some((d) => (d as number) > restricted))
    fail('a retry after the restriction day is pointless; retries must come first');
  return {
    version: raw.version as number,
    status: raw.status as string,
    retryAfterDays: retryDays as number[],
    stages: out,
  };
}

/** Find `spec/billing/dunning-policy.yaml` from the running code upwards (works from src, dist and the repository root), or DUNNING_POLICY_PATH. */
export function loadDunningPolicy(env: NodeJS.ProcessEnv = process.env): DunningPolicy {
  if (env.DUNNING_POLICY_PATH)
    return parseDunningPolicy(readFileSync(env.DUNNING_POLICY_PATH, 'utf8'));
  let dir = resolve(__dirname);
  for (let i = 0; i < 12; i++) {
    const f = join(dir, 'spec', 'billing', 'dunning-policy.yaml');
    if (existsSync(f)) return parseDunningPolicy(readFileSync(f, 'utf8'));
    dir = dirname(dir);
  }
  throw new Error(
    'dunning policy: spec/billing/dunning-policy.yaml not found (set DUNNING_POLICY_PATH)',
  );
}
