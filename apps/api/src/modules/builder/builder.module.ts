import { Global, Inject, Module, type OnApplicationBootstrap } from '@nestjs/common';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { FieldCipher } from '../../common/field-crypto';
import { DB } from '../../common/tokens';
import { AI_CONFIG, AiJobs, BudgetService, RunKindRegistry, type AiConfig } from '../ai';
import { ResidencyService } from '../compliance';
import { BUILDER_CONFIG, loadBuilderConfig, type BuilderConfig } from './internal/model';
import { CmsService } from './internal/cms.service';
import { EditRunHandler } from './internal/edit.handler';
import { FormNotifier, FormsService, NoopFormNotifier } from './internal/forms.service';
import { MobileProjectService } from './internal/mobile-project.service';
import { PreviewService } from './internal/preview.service';
import { ProjectService } from './internal/project.service';
import { WebsiteRunHandler } from './internal/website.handler';
import { ProjectsController } from './projects.controller';
import { PublicFormsController } from './public-forms.controller';
import { PreviewServeController } from './public.controller';

/** Website builder (M09): projects, versions, changes, previews on an isolated origin, forms, CMS and the `website`/`edit` run kinds. */
@Global()
@Module({
  controllers: [ProjectsController, PreviewServeController, PublicFormsController],
  providers: [
    { provide: BUILDER_CONFIG, useFactory: () => loadBuilderConfig() },
    { provide: FormNotifier, useClass: NoopFormNotifier },
    {
      provide: MobileProjectService,
      useFactory: (db: Db, a: AuditSink, r: ResidencyService, c: BuilderConfig) =>
        new MobileProjectService(db, a, r, c),
      inject: [DB, AuditSink, ResidencyService, BUILDER_CONFIG],
    },
    {
      provide: ProjectService,
      useFactory: (
        db: Db,
        a: AuditSink,
        r: ResidencyService,
        c: BuilderConfig,
        m: MobileProjectService,
      ) => new ProjectService(db, a, r, c, m),
      inject: [DB, AuditSink, ResidencyService, BUILDER_CONFIG, MobileProjectService],
    },
    {
      provide: PreviewService,
      useFactory: (db: Db, a: AuditSink, c: BuilderConfig) => new PreviewService(db, a, c),
      inject: [DB, AuditSink, BUILDER_CONFIG],
    },
    {
      provide: FormsService,
      useFactory: (db: Db, a: AuditSink, ci: FieldCipher, n: FormNotifier, c: BuilderConfig) =>
        new FormsService(db, a, ci, n, c),
      inject: [DB, AuditSink, FieldCipher, FormNotifier, BUILDER_CONFIG],
    },
    {
      provide: CmsService,
      useFactory: (db: Db, a: AuditSink) => new CmsService(db, a),
      inject: [DB, AuditSink],
    },
  ],
  exports: [ProjectService, MobileProjectService, PreviewService, FormsService, CmsService, BUILDER_CONFIG],
})
export class BuilderModule implements OnApplicationBootstrap {
  constructor(
    @Inject(RunKindRegistry) private readonly registry: RunKindRegistry,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(BudgetService) private readonly budgets: BudgetService,
    @Inject(FormsService) private readonly forms: FormsService,
    @Inject(AiJobs) private readonly jobs: AiJobs,
    @Inject(AI_CONFIG) private readonly cfg: AiConfig,
  ) {}
  onApplicationBootstrap() {
    this.registry.register(new WebsiteRunHandler(this.projects));
    this.registry.register(new EditRunHandler(this.projects, this.budgets));
    this.jobs.addTask('formRetention', () => this.forms.purgeExpired());
    void this.cfg;
  }
}
