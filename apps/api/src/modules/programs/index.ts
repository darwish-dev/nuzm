// Public surface of the programs module (M11 S54).
export { ProgramsModule } from './programs.module';
export { AgencyService } from './internal/agency.service';
export type { AgencyDto, LinkDto, GrantDto } from './internal/agency.service';
export { ActingOrgService } from './internal/acting.service';
export { ResellerService } from './internal/reseller.service';
export { StatementService } from './internal/statement.service';
export type { StatementDto } from './internal/statement.service';
export {
  IssuerModelGate,
  resolveIssuerModel,
  APPROVED_ISSUER_MODEL,
  scenarioPack,
} from './internal/issuer';
export { DELEGABLE_SCOPES, effectivePermissions, validateGrant } from './internal/delegation';
export { retailAmount, ruleAt, validateRules } from './internal/pricing';
