import type { RequiredDnsRecord } from '@nuzm/adapter-data';

/**
 * `DnsLinkagePort` (M07 → M08): when the domain's DNS is a Nuzm-managed zone (M07), email verification can apply the required records in one click
 * (`managed_by='email-verification'`); otherwise the console shows manual instructions. The default implementation knows no zones (M07 is not on this base:
 * assumptions doc U-09); M07 supplies the real one. Applying is idempotent and only ever writes records the adapters declared plus the ownership TXT.
 */
export interface DnsLinkageResult {
  zoneId: string;
  applied: number;
}
export abstract class DnsLinkagePort {
  /** The Nuzm zone that serves `domain` for this organization, or null. */
  abstract findZone(orgId: string, domain: string): Promise<{ zoneId: string } | null>;
  abstract applyRecords(
    orgId: string,
    domain: string,
    records: RequiredDnsRecord[],
    managedBy: 'email-verification',
  ): Promise<DnsLinkageResult>;
}
export class NoDnsLinkage extends DnsLinkagePort {
  async findZone(): Promise<null> {
    return null;
  }
  async applyRecords(): Promise<DnsLinkageResult> {
    throw new Error('no DNS zone linkage is available');
  }
}
/** In-memory implementation for tests: a map of organization+domain to a zone, and the records "applied" to it. */
export class MemoryDnsLinkage extends DnsLinkagePort {
  readonly zones = new Map<string, string>();
  readonly applied: {
    orgId: string;
    domain: string;
    records: RequiredDnsRecord[];
    managedBy: string;
  }[] = [];
  /** Called after records are applied so a test can make the fake resolvers "see" them. */
  onApply: (records: RequiredDnsRecord[]) => void = () => undefined;
  async findZone(orgId: string, domain: string) {
    const z = this.zones.get(`${orgId}|${domain}`);
    return z ? { zoneId: z } : null;
  }
  async applyRecords(
    orgId: string,
    domain: string,
    records: RequiredDnsRecord[],
    managedBy: 'email-verification',
  ) {
    const zoneId = this.zones.get(`${orgId}|${domain}`);
    if (!zoneId) throw new Error('no zone');
    this.applied.push({ orgId, domain, records, managedBy });
    this.onApply(records);
    return { zoneId, applied: records.length };
  }
}
