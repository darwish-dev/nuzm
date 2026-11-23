import { Module } from '@nestjs/common';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { IdentityModule } from '../identity';
import { AdminKnowledgeProcessingController } from './admin-knowledge-processing.controller';
import { AdminKnowledgeResourcesController } from './admin-knowledge-resources.controller';
import { AdminKnowledgeRetrievalController } from './admin-knowledge-retrieval.controller';
import { AdminKnowledgeUploadsController } from './admin-knowledge-uploads.controller';
import { CustomerTemplatesController } from './customer-templates.controller';
import { CustomerTemplateService } from './internal/customer-templates.service';
import {
  KnowledgeCustomerTemplatesGuard,
  KnowledgeGenerationGuard,
  KnowledgeLibraryGuard,
} from './internal/flag';
import { KnowledgeObjectStore, createKnowledgeObjectStore } from './internal/object-store';
import { ResourceService } from './internal/resource.service';
import { RetrievalService } from './internal/retrieval.service';
import { ReviewService } from './internal/review.service';
import { UploadService } from './internal/upload.service';

/**
 * AI Intelligence Center (ADR-065, SCR-K-01/02), slices S-K1 (library foundation) and S-K2a (secure ingestion: jobs, findings, review gate, activation). Admin uploads (resumable, quarantined), resources, versions, metadata,
 * disable and archive, behind the platform-wide flag `knowledge.library` (default OFF). Ingestion, analysis, retrieval and the customer experience are later slices.
 * The object store is the development filesystem adapter outside production and "unconfigured" in production until the provider is chosen (D-42).
 */
@Module({
  imports: [IdentityModule],
  controllers: [
    AdminKnowledgeUploadsController,
    AdminKnowledgeResourcesController,
    AdminKnowledgeProcessingController,
    AdminKnowledgeRetrievalController,
    CustomerTemplatesController,
  ],
  providers: [
    KnowledgeLibraryGuard,
    KnowledgeCustomerTemplatesGuard,
    KnowledgeGenerationGuard,
    {
      provide: KnowledgeObjectStore,
      useFactory: (): KnowledgeObjectStore => createKnowledgeObjectStore(),
    },
    {
      provide: UploadService,
      useFactory: (db: Db, audit: AuditSink, store: KnowledgeObjectStore) =>
        new UploadService(db, audit, store),
      inject: [DB, AuditSink, KnowledgeObjectStore],
    },
    {
      provide: ReviewService,
      useFactory: (db: Db, audit: AuditSink) => new ReviewService(db, audit),
      inject: [DB, AuditSink],
    },
    {
      provide: RetrievalService,
      useFactory: (db: Db, audit: AuditSink) => new RetrievalService(db, audit),
      inject: [DB, AuditSink],
    },
    {
      provide: CustomerTemplateService,
      useFactory: (db: Db, audit: AuditSink, r: RetrievalService, store: KnowledgeObjectStore) =>
        new CustomerTemplateService(db, audit, r, store),
      inject: [DB, AuditSink, RetrievalService, KnowledgeObjectStore],
    },
    {
      provide: ResourceService,
      useFactory: (db: Db, audit: AuditSink) => new ResourceService(db, audit),
      inject: [DB, AuditSink],
    },
  ],
  exports: [
    ResourceService,
    ReviewService,
    RetrievalService,
    CustomerTemplateService,
    KnowledgeCustomerTemplatesGuard,
    KnowledgeGenerationGuard,
    UploadService,
    KnowledgeObjectStore,
  ],
})
export class KnowledgeModule {}
