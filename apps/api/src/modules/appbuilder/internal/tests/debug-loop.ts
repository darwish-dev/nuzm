/**
 * Bounded debugging loop (`test-fix` runs, M10 §9, AC-M10-04): at most 5 CONSECUTIVE fix iterations per failing test group, at most 15 per run, and a stop after 3
 * IDENTICAL failure signatures in a row; then the run escalates to a human. Pure arithmetic: the caller does the work.
 */
export const DEBUG_LIMITS = { perGroup: 5, perRun: 15, identicalSignatures: 3 } as const;
export type StopReason = 'group_limit' | 'run_limit' | 'repeated_failure';
export interface Verdict {
  proceed: boolean;
  reason?: StopReason;
  group?: string;
}
export class DebugLoopGuard {
  private total = 0;
  private readonly perGroup = new Map<string, number>();
  private readonly lastSignature = new Map<string, { sig: string; count: number }>();
  /** Call BEFORE each fix attempt for a failing group with the current failure signature. */
  attempt(group: string, signature: string): Verdict {
    if (this.total >= DEBUG_LIMITS.perRun) return { proceed: false, reason: 'run_limit', group };
    const last = this.lastSignature.get(group);
    const same = last && last.sig === signature ? last.count + 1 : 1;
    if (same >= DEBUG_LIMITS.identicalSignatures) return { proceed: false, reason: 'repeated_failure', group };
    if ((this.perGroup.get(group) ?? 0) >= DEBUG_LIMITS.perGroup) return { proceed: false, reason: 'group_limit', group };
    this.lastSignature.set(group, { sig: signature, count: same });
    this.perGroup.set(group, (this.perGroup.get(group) ?? 0) + 1);
    this.total++;
    return { proceed: true, group };
  }
  /** A group whose tests pass again starts from zero next time (the limit is on CONSECUTIVE attempts). */
  fixed(group: string): void {
    this.perGroup.delete(group);
    this.lastSignature.delete(group);
  }
  get used(): { total: number; perGroup: Record<string, number> } {
    return { total: this.total, perGroup: Object.fromEntries(this.perGroup) };
  }
}
