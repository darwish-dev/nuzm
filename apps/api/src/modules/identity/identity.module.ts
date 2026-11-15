import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Db } from '@nuzm/platform';
import { AuditSink, LogAuditSink } from '../../common/audit';
import { FileDevSecretStore, SecretStore } from '../../common/secrets';
import { DB, IDENTITY_CONFIG } from '../../common/tokens';
import { IdentityController } from './identity.controller';
import { loadIdentityConfig, type IdentityConfig } from './internal/config';
import { OidcClient } from './internal/oidc';
import { ApiKeyService } from './internal/api-key.service';
import { MfaService, derivePepper } from './internal/mfa.service';
import { SessionService } from './internal/session.service';
import { UserService } from './internal/user.service';
import { SessionGuard } from './session.guard';

@Module({
  controllers: [IdentityController],
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
    { provide: AuditSink, useClass: LogAuditSink },
    // DEV-ONLY secret store until D-12 (production vault) is decided; refuses to start in production.
    {
      provide: SecretStore,
      useFactory: (c: IdentityConfig) => new FileDevSecretStore(c.sealKey),
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
    { provide: ApiKeyService, useFactory: (db: Db) => new ApiKeyService(db), inject: [DB] },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
  exports: [
    SessionService,
    UserService,
    MfaService,
    ApiKeyService,
    AuditSink,
    SecretStore,
    IDENTITY_CONFIG,
  ],
})
export class IdentityModule {}
