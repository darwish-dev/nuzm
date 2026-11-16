/**
 * Extension points that later milestones fill. Defaults are explicit stand-ins, flagged NOT VERIFIED.
 */
export abstract class ResidencyPolicy {
  /** M04 enforces real data-residency rules. Until then every region is allowed (NOT VERIFIED — M04). */
  abstract evaluate(
    orgId: string,
    dataRegion: string,
  ): Promise<{ allowed: boolean; reason?: string }>;
}
export class AllowAllResidencyPolicy extends ResidencyPolicy {
  async evaluate() {
    return { allowed: true as const };
  }
}

export abstract class RetentionHook {
  /** M04 schedules purge/legal-hold checks for soft-deleted resources. No-op until then. */
  abstract onSoftDelete(orgId: string, kind: string, id: string): Promise<void>;
}
export class NoopRetentionHook extends RetentionHook {
  async onSoftDelete() {}
}
