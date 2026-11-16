import { Module } from '@nestjs/common';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { IdentityModule, SessionService } from '../identity';
import { NotificationService } from '../notifications';
import { TenancyModule } from '../tenancy';
import { AdminController } from './admin.controller';
import { AdminReadService } from './internal/admin-read.service';
import { FeatureFlagService } from './internal/feature-flag.service';
import { ImpersonationService } from './internal/impersonation.service';

@Module({
  imports: [IdentityModule, TenancyModule],
  controllers: [AdminController],
  providers: [
    { provide: AdminReadService, useFactory: (db: Db) => new AdminReadService(db), inject: [DB] },
    {
      provide: FeatureFlagService,
      useFactory: (db: Db) => new FeatureFlagService(db),
      inject: [DB],
    },
    {
      provide: ImpersonationService,
      useFactory: (s: SessionService, r: AdminReadService, n: NotificationService, a: AuditSink) =>
        new ImpersonationService(s, r, n, a),
      inject: [SessionService, AdminReadService, NotificationService, AuditSink],
    },
  ],
})
export class AdminModule {}
