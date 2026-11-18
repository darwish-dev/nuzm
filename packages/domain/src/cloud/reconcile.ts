/**
 * Reconciliation rules (M05 task 11). The central safety rule: a provision is NEVER retried unless `findByToken` PROVES the resource is
 * absent. One "not found" is not proof (eventual consistency): proof needs at least two absent observations made after the provider's
 * consistency window has elapsed since the uncertain attempt, spaced apart, with no sighting in between.
 */
export interface Observation {
  at: number;
  found: boolean;
}
export interface AbsenceRule {
  /** Provider consistency window (ms) after the attempt before ANY observation counts. */
  windowMs: number;
  /** Minimum spacing (ms) between two counted observations. */
  gapMs: number;
  minObservations: number;
}
export const DEFAULT_ABSENCE_RULE: AbsenceRule = {
  windowMs: 120_000,
  gapMs: 30_000,
  minObservations: 2,
};

export function absenceProven(
  attemptAt: number,
  observations: readonly Observation[],
  rule: AbsenceRule = DEFAULT_ABSENCE_RULE,
): boolean {
  if (observations.some((o) => o.found && o.at >= attemptAt)) return false;
  const counted = observations
    .filter((o) => !o.found && o.at >= attemptAt + rule.windowMs)
    .sort((a, b) => a.at - b.at);
  if (counted.length < rule.minObservations) return false;
  // greedy: pick observations spaced at least gapMs apart
  let n = 1;
  let last = counted[0]!.at;
  for (const o of counted.slice(1)) {
    if (o.at - last >= rule.gapMs) {
      n++;
      last = o.at;
    }
  }
  return n >= rule.minObservations;
}

export type DriftState = 'in_sync' | 'drift' | 'orphan_suspected' | 'missing';
export type Observed =
  { kind: 'found'; status: string; planRef: string } | { kind: 'absent' } | { kind: 'unreadable' };

/** Compare what we believe (`expected`) with what the provider shows. `unreadable` never changes the drift state (no evidence either way). */
export function classifyObservation(
  expected: { status: string; planRef: string },
  observed: Observed,
): DriftState | 'unchanged' {
  if (observed.kind === 'unreadable') return 'unchanged';
  if (observed.kind === 'absent') return 'missing';
  return observed.status === expected.status && observed.planRef === expected.planRef
    ? 'in_sync'
    : 'drift';
}
