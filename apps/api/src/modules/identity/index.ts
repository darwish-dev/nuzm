// Public surface of the identity module.
export { IdentityModule } from './identity.module';
export {
  SessionGuard,
  Public,
  RealmOnly,
  StepUp,
  AllowPreMfa,
  CurrentPrincipal,
  SESSION_COOKIE,
  CSRF_COOKIE,
} from './session.guard';
export type { Principal, Realm } from './internal/session.service';
export {
  ApiKeyService,
  permissionCovers,
  scopesExceeding,
  ipAllowed,
} from './internal/api-key.service';
export type { ApiKeyPrincipal } from './internal/api-key.service';
