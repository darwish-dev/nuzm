// Public surface of the billing module.
export { BillingModule } from './billing.module';
export { LedgerPostingService } from './internal/ledger.service';
export type { PostResult } from './internal/ledger.service';
export { EntitlementService, DEFAULT_PLAN_KEY } from './internal/entitlement.service';
export type { EffectiveEntitlements } from './internal/entitlement.service';
export * as recipes from './internal/recipes';
export { PriceBookService } from './internal/price-book.service';
export type { PriceItemDto, PriceVersionDto } from './internal/price-book.service';
