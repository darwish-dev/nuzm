import { Module } from '@nestjs/common';
import { Db } from '@nuzm/platform';
import { Mailer } from '../../common/mailer';
import { DB } from '../../common/tokens';
import { IdentityModule } from '../identity';
import {
  AllowAllResidencyPolicy,
  NoopRetentionHook,
  ResidencyPolicy,
  RetentionHook,
} from './internal/hooks';
import { InvitationService } from './internal/invitation.service';
import { MemberService } from './internal/member.service';
import { OrgService } from './internal/org.service';
import { WorkspaceService } from './internal/workspace.service';
import { TenancyController } from './tenancy.controller';

@Module({
  imports: [IdentityModule],
  controllers: [TenancyController],
  providers: [
    { provide: ResidencyPolicy, useClass: AllowAllResidencyPolicy }, // NOT VERIFIED until M04
    { provide: RetentionHook, useClass: NoopRetentionHook },
    { provide: OrgService, useFactory: (db: Db) => new OrgService(db), inject: [DB] },
    { provide: MemberService, useFactory: (db: Db) => new MemberService(db), inject: [DB] },
    {
      provide: InvitationService,
      useFactory: (db: Db, m: Mailer) => new InvitationService(db, m),
      inject: [DB, Mailer],
    },
    {
      provide: WorkspaceService,
      useFactory: (db: Db, r: ResidencyPolicy, h: RetentionHook) => new WorkspaceService(db, r, h),
      inject: [DB, ResidencyPolicy, RetentionHook],
    },
  ],
  exports: [OrgService],
})
export class TenancyModule {}
