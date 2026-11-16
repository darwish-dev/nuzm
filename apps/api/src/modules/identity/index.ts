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
export { UserService } from './internal/user.service';
export type { UserRow } from './internal/user.service';
