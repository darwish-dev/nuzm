import { Module } from '@nestjs/common';
import { AccessModule } from './modules/access';
import { AdminModule } from './modules/admin';
import { AuditModule } from './modules/audit';
import { CloudModule } from './modules/cloud';
import { CloudVendorsModule } from './modules/cloud-vendors';
import { BillingModule } from './modules/billing';
import { HealthModule } from './modules/health';
import { IdentityModule } from './modules/identity';
import { NotificationsModule } from './modules/notifications';
import { CommerceModule } from './modules/commerce';
import { InvoicingModule } from './modules/invoicing';
import { MeteringModule } from './modules/metering';
import { ComplianceModule } from './modules/compliance';
import { DataModule } from './modules/data';
import { EmailModule } from './modules/email';
import { DomainsModule } from './modules/domains';
import { FinrecModule } from './modules/finrec';
import { PaymentsModule } from './modules/payments';
import { SubscriptionsModule } from './modules/subscriptions';
import { HostingModule } from './modules/hosting';
import { PlatformModule } from './modules/platform';
// M10A (app builder): append-only block
import { AppBuilderModule } from './modules/appbuilder';
import { KnowledgeModule } from './modules/knowledge';
import { MobileModule } from './modules/mobile';
// >>> M09 modules
import { AiModule } from './modules/ai';
import { BuilderModule } from './modules/builder';
import { DeployModule } from './modules/deploy';
// S-AG5 benchmarks (inert while the platform flag ai.benchmarks is off)
import { BenchmarksModule } from './modules/benchmarks';
// <<< M09 modules
import { TenancyModule } from './modules/tenancy';
// >>> M12
import { EnterpriseModule } from './modules/enterprise';
import { OpsModule } from './modules/ops';
// <<< M12
// M11 (appended): automation, marketplace, programs
import { AutomationModule } from './modules/automation';
import { MarketplaceModule } from './modules/marketplace';
import { ProgramsModule } from './modules/programs';

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
    DomainsModule,
    CloudModule,
    CloudVendorsModule,
    DataModule,
    EmailModule,
    HostingModule,
    // >>> M09 modules
    AiModule,
    BuilderModule,
    DeployModule,
    BenchmarksModule,
    // <<< M09 modules
    IdentityModule,
    NotificationsModule,
    AccessModule,
    TenancyModule,
    AdminModule,
    HealthModule,
    EnterpriseModule, // M12
    OpsModule, // M12
    // M11 (appended)
    AutomationModule,
    MarketplaceModule,
    ProgramsModule,
    AppBuilderModule, // M10A
    MobileModule, // M10B
    KnowledgeModule, // AI Intelligence Center (ADR-065)
  ],
})
export class AppModule {}
