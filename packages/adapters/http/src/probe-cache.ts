import type { CapabilityId, CapabilityReport, CapabilityState } from '@nuzm/adapter-contracts';

/**
 * Per-account result of the last probe. Mutating operations consult it: an action that the last probe did not mark `supported` is
 * rejected as `unsupported` (docs/09 §1 rule 7). With no probe yet the caller probes first.
 */
export class ProbeCache {
  private readonly byAccount = new Map<string, Record<CapabilityId, CapabilityState>>();
  set(accountId: string, r: CapabilityReport): void {
    this.byAccount.set(accountId, { ...r.capabilities });
  }
  get(accountId: string): Record<CapabilityId, CapabilityState> | undefined {
    return this.byAccount.get(accountId);
  }
  clear(accountId?: string): void {
    if (accountId) this.byAccount.delete(accountId);
    else this.byAccount.clear();
  }
}
