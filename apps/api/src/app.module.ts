import { Module } from '@nestjs/common';
import { AccessModule } from './modules/access';
import { AdminModule } from './modules/admin';
import { AuditModule } from './modules/audit';
import { HealthModule } from './modules/health';
import { IdentityModule } from './modules/identity';
import { NotificationsModule } from './modules/notifications';
import { PlatformModule } from './modules/platform';
import { TenancyModule } from './modules/tenancy';

@Module({
  imports: [
    PlatformModule,
    AuditModule,
    IdentityModule,
    NotificationsModule,
    AccessModule,
    TenancyModule,
    AdminModule,
    HealthModule,
  ],
})
export class AppModule {}
