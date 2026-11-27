// Public surface of the identity module.
export { IdentityModule } from './identity.module';
export {
  PUBLIC,
  SessionAuthenticator,
  Public,
  RealmOnly,
  StepUp,
  AllowPreMfa,
  DenyImpersonation,
  CurrentPrincipal,
  SESSION_COOKIE,
  CSRF_COOKIE,
} from './session.guard';
export type { IdentityConfig as IdentityConfigLike } from './internal/config';
export { SessionService } from './internal/session.service';
export type { Principal, Realm, Impersonation } from './internal/session.service';
export {
  ApiKeyService,
  permissionCovers,
  scopesExceeding,
  ipAllowed,
} from './internal/api-key.service';
export type { ApiKeyPrincipal } from './internal/api-key.service';
export { MfaService } from './internal/mfa.service';
export { UserService } from './internal/user.service';
export { CredentialsService } from './internal/credentials.service';
export type { UserRow } from './internal/user.service';
export { hashPassword, passwordProblem, verifyPassword } from './internal/password';
