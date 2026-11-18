import { Module } from '@nestjs/common';
import { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
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
    {
      provide: OrgService,
      useFactory: (db: Db, a: AuditSink) => new OrgService(db, a),
      inject: [DB, AuditSink],
    },
    {
      provide: MemberService,
      useFactory: (db: Db, a: AuditSink) => new MemberService(db, a),
      inject: [DB, AuditSink],
    },
    {
      provide: InvitationService,
      useFactory: (db: Db, m: Mailer, a: AuditSink) => new InvitationService(db, m, a),
      inject: [DB, Mailer, AuditSink],
    },
    {
      provide: WorkspaceService,
      useFactory: (db: Db, r: ResidencyPolicy, h: RetentionHook, a: AuditSink) =>
        new WorkspaceService(db, r, h, a),
      inject: [DB, ResidencyPolicy, RetentionHook, AuditSink],
    },
  ],
  exports: [OrgService, MemberService],
})
export class TenancyModule {}
