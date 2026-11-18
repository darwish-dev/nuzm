import type {
  AccountContext,
  DataAdapterBase,
  OperationResult,
  ProviderCostRecord,
} from '../upstream';
import type { MailboxCapabilityId } from './capabilities';
import type { RequiredDnsRecord, UsageWindow } from './common';

export interface MailboxSpec {
  domain: string;
  localPart: string;
  quotaMb: number;
  /** Plan reference from the provider catalog (when the provider sells plans). */
  planRef?: string;
  tags: Record<string, string>;
}
export interface MailboxRef {
  providerRef: string;
}
/** How the mailbox owner sets the password: a provider reset link (preferred) or a one-time secret. Nuzm never persists plaintext. */
export type PasswordSetup =
  | { kind: 'reset_link'; url: string; expiresAt: string }
  | { kind: 'one_time_secret'; secret: string };
export interface ProvisionedMailbox {
  providerRef: string;
  address: string;
  passwordSetup: PasswordSetup;
}
export interface MailboxInspection {
  providerRef: string;
  address: string;
  state: 'active' | 'suspended' | 'deleting' | 'deleted';
  quotaMb: number;
  aliases: string[];
  observedAt: string;
}
export interface MailboxUsageRow {
  providerRef: string;
  storageBytes: number | null;
}
export interface MailDomainStatus {
  domain: string;
  state: 'pending' | 'verified' | 'failed';
  requiredRecords: RequiredDnsRecord[];
  checkedAt: string;
}

/** docs/09 §5: `MailboxAdapter` (D-09; registrar-partner email or Google/Microsoft reseller: none selected). */
export interface MailboxAdapter extends DataAdapterBase<'mailbox', MailboxCapabilityId> {
  /** MX/SPF/DKIM/DMARC (+ ownership) returned declaratively; applied by M07 DNS linkage or shown as manual instructions. */
  dnsRequirements(ctx: AccountContext, domain: string): Promise<OperationResult<MailDomainStatus>>;
  checkDomain(ctx: AccountContext, domain: string): Promise<OperationResult<MailDomainStatus>>;
  provisionMailbox(
    ctx: AccountContext,
    req: MailboxSpec & { idempotencyToken: string },
  ): Promise<OperationResult<ProvisionedMailbox>>;
  findByToken(ctx: AccountContext, token: string): Promise<OperationResult<MailboxRef | null>>;
  inspectMailbox(ctx: AccountContext, ref: string): Promise<OperationResult<MailboxInspection>>;
  addAlias(
    ctx: AccountContext,
    ref: string,
    alias: string,
    idempotencyToken: string,
  ): Promise<OperationResult<void>>;
  removeAlias(ctx: AccountContext, ref: string, alias: string): Promise<OperationResult<void>>;
  setQuota(
    ctx: AccountContext,
    ref: string,
    quotaMb: number,
    idempotencyToken: string,
  ): Promise<OperationResult<void>>;
  suspendMailbox?(ctx: AccountContext, ref: string): Promise<OperationResult<void>>;
  deleteMailbox(
    ctx: AccountContext,
    ref: string,
    idempotencyToken: string,
  ): Promise<OperationResult<void>>;
  usage(ctx: AccountContext, window: UsageWindow): Promise<OperationResult<MailboxUsageRow[]>>;
  fetchBilling?(
    ctx: AccountContext,
    period: { from: string; to: string },
  ): Promise<ProviderCostRecord[]>;
}
