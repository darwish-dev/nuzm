import { Module } from '@nestjs/common';
import { Db } from '@nuzm/platform';
import { configuredSecretStore, SecretStore } from '../../common/secrets';
import { AuditSink } from '../../common/audit';
import { DB, IDENTITY_CONFIG } from '../../common/tokens';
import { IdentityController } from './identity.controller';
import { CredentialsController } from './credentials.controller';
import { CredentialsService } from './internal/credentials.service';
import { Mailer } from '../../common/mailer';
import { loadIdentityConfig, type IdentityConfig } from './internal/config';
import { OidcClient } from './internal/oidc';
import { ApiKeyService } from './internal/api-key.service';
import { MfaService, derivePepper } from './internal/mfa.service';
import { SessionService } from './internal/session.service';
import { UserService } from './internal/user.service';
import { SessionAuthenticator } from './session.guard';

@Module({
  controllers: [IdentityController, CredentialsController],
  providers: [
    { provide: IDENTITY_CONFIG, useFactory: () => loadIdentityConfig() },
    {
      provide: OidcClient,
      useFactory: (c: IdentityConfig) => new OidcClient(c),
      inject: [IDENTITY_CONFIG],
    },
    {
      provide: SessionService,
      useFactory: (db: Db, c: IdentityConfig) => new SessionService(db, c),
      inject: [DB, IDENTITY_CONFIG],
    },
    { provide: UserService, useFactory: (db: Db) => new UserService(db), inject: [DB] },
    {
      provide: SecretStore,
      useFactory: () => configuredSecretStore(),
      inject: [IDENTITY_CONFIG],
    },
    {
      provide: MfaService,
      useFactory: (db: Db, s: SecretStore, c: IdentityConfig) =>
        new MfaService(db, s, {
          pepper: derivePepper(c.sealKey),
          lockThreshold: c.mfaLockThreshold,
          lockSeconds: c.mfaLockSeconds,
          pendingTtlSeconds: 600,
          issuerLabel: 'Nuzm',
        }),
      inject: [DB, SecretStore, IDENTITY_CONFIG],
    },
    {
      provide: ApiKeyService,
      useFactory: (db: Db, a: AuditSink) => new ApiKeyService(db, 30_000, a),
      inject: [DB, AuditSink],
    },
    {
      provide: CredentialsService,
      useFactory: (db: Db, c: IdentityConfig, s: SessionService, m: Mailer, a: AuditSink) =>
        new CredentialsService(db, c, s, m, a),
      inject: [DB, IDENTITY_CONFIG, SessionService, Mailer, AuditSink],
    },
    SessionAuthenticator,
  ],
  exports: [
    SessionAuthenticator,
    SessionService,
    CredentialsService,
    UserService,
    MfaService,
    ApiKeyService,
    SecretStore,
    IDENTITY_CONFIG,
  ],
})
export class IdentityModule {}
