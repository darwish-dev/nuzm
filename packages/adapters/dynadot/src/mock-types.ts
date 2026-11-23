export type { DnsRecordData } from '@nuzm/registrar-contracts';
import type { DnsRecordData } from '@nuzm/registrar-contracts';

// Structural copy of the conformance kit's control surface (kept here so the adapter package does not depend on the kit at build time).
export type FaultKind =
  | 'timeout_after_side_effect'
  | 'timeout_before_side_effect'
  | 'rate_limit'
  | 'outage'
  | 'auth_failure';
export type FaultOp =
  'search' | 'register' | 'renew' | 'inspect' | 'findByToken' | 'transferIn' | 'dns.apply';
export interface RegistrarControls {
  registrationCount(): number;
  registrationsByName(name: string): number;
  inject(op: FaultOp, kind: FaultKind, times?: number): void;
  seedTaken(name: string): void;
  injectDnsFailureAt?(k: number): void;
  dnsRecords?(zone: string): DnsRecordData[];
  signWebhook?(body: string, at: Date): { headers: Record<string, string>; secret: string };
  lastRequestBodies(): string[];
}
