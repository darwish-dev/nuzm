import { Module } from '@nestjs/common';
import { AccessModule } from './modules/access';
import { AdminModule } from './modules/admin';
import { AuditModule } from './modules/audit';
import { CloudModule } from './modules/cloud';
import { BillingModule } from './modules/billing';
import { HealthModule } from './modules/health';
import { IdentityModule } from './modules/identity';
import { NotificationsModule } from './modules/notifications';
import { CommerceModule } from './modules/commerce';
import { InvoicingModule } from './modules/invoicing';
import { MeteringModule } from './modules/metering';
import { ComplianceModule } from './modules/compliance';
import { FinrecModule } from './modules/finrec';
import { PaymentsModule } from './modules/payments';
import { SubscriptionsModule } from './modules/subscriptions';
import { PlatformModule } from './modules/platform';
import { TenancyModule } from './modules/tenancy';

@Module({
  imports: [
    PlatformModule,
    AuditModule,
    BillingModule,
    MeteringModule,
    InvoicingModule,
    CommerceModule,
    PaymentsModule,
    SubscriptionsModule,
    FinrecModule,
    ComplianceModule,
    CloudModule,
    IdentityModule,
    NotificationsModule,
    AccessModule,
    TenancyModule,
    AdminModule,
    HealthModule,
  ],
})
export class AppModule {}
