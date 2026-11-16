// Public surface of the invoicing module.
export { InvoicingModule } from './invoicing.module';
export { TaxService } from './internal/tax.service';
export type { TaxEstimate } from './internal/tax.service';
export { TaxProfileService } from './internal/tax-profile.service';
export type { TaxProfileDto } from './internal/tax-profile.service';
export { SequenceService } from './internal/sequence.service';
export { computeTax, resolveRate, divRound } from './internal/tax-engine';
export type { TaxRate, TaxScope, BuyerType, RoundingMode } from './internal/tax-engine';
