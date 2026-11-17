// Public surface of the billing module.
export { BillingModule } from './billing.module';
export { LedgerPostingService } from './internal/ledger.service';
export type { PostResult } from './internal/ledger.service';
export { EntitlementService, DEFAULT_PLAN_KEY } from './internal/entitlement.service';
export type { EffectiveEntitlements } from './internal/entitlement.service';
export * as recipes from './internal/recipes';
export { PriceBookService } from './internal/price-book.service';
export type { PriceItemDto, PriceVersionDto } from './internal/price-book.service';
export { QuotaService } from './internal/quota.service';
export type { QuotaItem, QuotaReport, QuotaCheck } from './internal/quota.service';
export { SpendService } from './internal/spend.service';
export type { SpendDecision, SpendApprovalDto, SpendingLimitDto } from './internal/spend.service';
export { WalletTopupService, walletPolicyFromEnv } from './internal/wallet-topup.service';
export type { WalletTopupDto, WalletPolicy } from './internal/wallet-topup.service';
export {
  SubscriptionService,
  subscriptionPolicyFromEnv,
  planFeeMeter,
  amountOf,
} from './internal/subscription.service';
export type {
  SubscriptionDto,
  SubscriptionPorts,
  SubscriptionItem,
  ChangePreview,
} from './internal/subscription.service';
export { DunningService } from './internal/dunning.service';
export type { DunningDto, DunningRunResult } from './internal/dunning.service';
export {
  loadDunningPolicy,
  parseDunningPolicy,
  STAGES as DUNNING_STAGES,
} from './internal/dunning-policy';
export type { DunningPolicy, DunningStage } from './internal/dunning-policy';
